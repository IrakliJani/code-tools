import path from "node:path";
import type { BashInput, BashResult, VirtualFileSystem } from "./types.js";

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class MiniBash {
  constructor(private readonly fs: VirtualFileSystem) {}

  run(input: BashInput): BashResult {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let exitCode = 0;

    const lines = input.command.replace(/\r\n?/g, "\n").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (!line.trim() || line.trimStart().startsWith("#")) continue;

      const tokens = tokenize(line);
      const heredoc = this.parseHeredoc(tokens);
      if (heredoc) {
        const body: string[] = [];
        i++;
        while (i < lines.length && (lines[i] ?? "") !== heredoc.delimiter) {
          body.push(lines[i] ?? "");
          i++;
        }
        if (i >= lines.length) {
          stderr.push(`heredoc delimiter not found: ${heredoc.delimiter}`);
          exitCode = 1;
          break;
        }
        try {
          const previous = heredoc.append && this.fs.exists(heredoc.file) ? this.fs.readFile(heredoc.file) : "";
          this.fs.writeFile(heredoc.file, `${previous}${body.join("\n")}${body.length ? "\n" : ""}`);
        } catch (error) {
          stderr.push(errorMessage(error));
          exitCode = 1;
          break;
        }
        continue;
      }

      for (const segment of splitTokens(tokens, ";")) {
        if (segment.length === 0) continue;
        const result = this.runConditionalList(segment);
        if (result.stdout) stdout.push(result.stdout.replace(/\n$/, ""));
        if (result.stderr) stderr.push(result.stderr.replace(/\n$/, ""));
        exitCode = result.exitCode;
      }
    }

    return {
      stdout: stdout.filter(Boolean).join("\n") + (stdout.length ? "\n" : ""),
      stderr: stderr.filter(Boolean).join("\n") + (stderr.length ? "\n" : ""),
      exitCode,
      cwd: this.fs.cwd,
    };
  }

  private parseHeredoc(tokens: string[]): { file: string; delimiter: string; append: boolean } | undefined {
    if (tokens[0] !== "cat") return undefined;
    const heredocIndex = tokens.indexOf("<<");
    if (heredocIndex < 0) return undefined;
    const delimiter = tokens[heredocIndex + 1];
    const redirectIndex = tokens.findIndex((token) => token === ">" || token === ">>");
    const file = redirectIndex >= 0 ? tokens[redirectIndex + 1] : undefined;
    if (!delimiter || !file) return undefined;
    return { file, delimiter, append: tokens[redirectIndex] === ">>" };
  }

  private runConditionalList(tokens: string[]): CommandResult {
    const parts = splitConditionalTokens(tokens);
    const stdout: string[] = [];
    const stderr: string[] = [];
    let last: CommandResult = { stdout: "", stderr: "", exitCode: 0 };

    for (const part of parts) {
      if (part.tokens.length === 0) continue;
      if (part.operator === "&&" && last.exitCode !== 0) continue;
      if (part.operator === "||" && last.exitCode === 0) continue;

      last = this.runPipeline(part.tokens);
      if (last.stdout) stdout.push(last.stdout.replace(/\n$/, ""));
      if (last.stderr) stderr.push(last.stderr.replace(/\n$/, ""));
    }

    return {
      stdout: stdout.filter(Boolean).join("\n") + (stdout.length ? "\n" : ""),
      stderr: stderr.filter(Boolean).join("\n") + (stderr.length ? "\n" : ""),
      exitCode: last.exitCode,
    };
  }

  private runPipeline(tokens: string[]): CommandResult {
    const commands = splitTokens(tokens, "|");
    let input = "";
    let last: CommandResult = { stdout: "", stderr: "", exitCode: 0 };

    for (let i = 0; i < commands.length; i++) {
      const isLast = i === commands.length - 1;
      const { tokens: commandTokens, redirect } = isLast ? extractRedirect(commands[i] ?? []) : { tokens: commands[i] ?? [], redirect: undefined };
      last = this.runCommand(commandTokens, input);
      if (last.exitCode !== 0) return last;
      input = last.stdout;

      if (isLast && redirect) {
        try {
          const previous = redirect.append && this.fs.exists(redirect.file) ? this.fs.readFile(redirect.file) : "";
          this.fs.writeFile(redirect.file, previous + last.stdout);
          last = { ...last, stdout: "" };
        } catch (error) {
          last = { stdout: "", stderr: `${errorMessage(error)}\n`, exitCode: 1 };
        }
      }
    }
    return last;
  }

  private runCommand(tokens: string[], input: string): CommandResult {
    if (tokens.length === 0) return { stdout: input, stderr: "", exitCode: 0 };

    const [command, ...args] = tokens;
    try {
      switch (command) {
        case "pwd":
          return ok(`${this.fs.cwd}\n`);
        case "cd":
          return this.cd(args[0] ?? "/workspace");
        case "ls":
          return ok(this.ls(args));
        case "tree":
          return ok(this.tree(args[0] ?? "."));
        case "cat":
          return ok(this.cat(args, input));
        case "head":
          return ok(this.headTail(args, input, "head"));
        case "tail":
          return ok(this.headTail(args, input, "tail"));
        case "grep":
          return this.grep(args, input);
        case "find":
          return ok(this.find(args));
        case "echo":
          return ok(this.echo(args));
        case "printf":
          return ok(this.printf(args));
        case "mkdir":
          return this.mkdir(args);
        case "touch":
          return this.touch(args);
        case "rm":
          return this.rm(args);
        case "cp":
          return this.cp(args);
        case "mv":
          return this.mv(args);
        case "true":
          return ok("");
        case "false":
          return { stdout: "", stderr: "", exitCode: 1 };
        case "help":
          return ok(helpText());
        default:
          return { stdout: "", stderr: `${command}: command not found\n`, exitCode: 127 };
      }
    } catch (error) {
      return { stdout: "", stderr: `${errorMessage(error)}\n`, exitCode: 1 };
    }
  }

  private cd(target: string): CommandResult {
    const normalized = this.fs.normalize(target);
    const stat = this.fs.stat(normalized);
    if (stat.type !== "directory") throw new Error(`Not a directory: ${normalized}`);
    this.fs.cwd = normalized;
    return ok("");
  }

  private ls(args: string[]): string {
    const flags = parseFlags(args);
    const targets = args.filter((arg) => !arg.startsWith("-"));
    const long = flags.has("l");
    const all = flags.has("a");
    const paths = targets.length ? targets : ["."];
    const chunks: string[] = [];

    for (const target of paths) {
      const stat = this.fs.stat(target);
      if (paths.length > 1) chunks.push(`${this.fs.normalize(target)}:`);
      if (stat.type === "file") {
        chunks.push(long ? formatLong(stat.type, stat.size, path.posix.basename(stat.path)) : path.posix.basename(stat.path));
      } else {
        for (const entry of this.fs.readdir(target)) {
          if (!all && entry.name.startsWith(".")) continue;
          chunks.push(long ? formatLong(entry.type, entry.size, entry.name) : entry.name);
        }
      }
    }
    return chunks.join("\n") + (chunks.length ? "\n" : "");
  }

  private tree(target: string): string {
    const root = this.fs.normalize(target);
    const entries = this.fs.walk(root);
    const lines = [root];
    for (const entry of entries.slice(1)) {
      const relative = path.posix.relative(root, entry.path);
      const depth = relative.split("/").length - 1;
      lines.push(`${"  ".repeat(depth)}${entry.type === "directory" ? "📁" : "📄"} ${entry.name}`);
    }
    return `${lines.join("\n")}\n`;
  }

  private cat(args: string[], input: string): string {
    if (args.length === 0) return input;
    return args.map((file) => this.fs.readFile(file)).join("");
  }

  private headTail(args: string[], input: string, mode: "head" | "tail"): string {
    let count = 10;
    const files: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] ?? "";
      if (arg === "-n") count = Number(args[++i] ?? "10");
      else if (arg.startsWith("-n")) count = Number(arg.slice(2));
      else files.push(arg);
    }
    const text = files.length ? files.map((file) => this.fs.readFile(file)).join("") : input;
    const lines = text.split(/\n/);
    const selected = mode === "head" ? lines.slice(0, count) : lines.slice(Math.max(0, lines.length - count));
    return selected.join("\n") + (selected.length ? "\n" : "");
  }

  private grep(args: string[], input: string): CommandResult {
    const flags = parseFlags(args);
    const positional = args.filter((arg) => !arg.startsWith("-"));
    if (positional.length === 0) return { stdout: "", stderr: "grep: missing pattern\n", exitCode: 2 };

    const pattern = positional[0] ?? "";
    const paths = positional.slice(1);
    const regex = compilePattern(pattern, flags.has("i"));
    const recursive = flags.has("r") || flags.has("R");
    const withLineNumbers = flags.has("n");
    const matches: string[] = [];

    const scan = (label: string, text: string, showLabel: boolean) => {
      const lines = text.split(/\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (regex.test(line)) {
          regex.lastIndex = 0;
          const prefix = `${showLabel ? `${label}:` : ""}${withLineNumbers ? `${i + 1}:` : ""}`;
          matches.push(`${prefix}${line}`);
        }
      }
    };

    if (paths.length === 0) {
      scan("", input, false);
    } else {
      const files = paths.flatMap((target) => {
        const stat = this.fs.stat(target);
        if (stat.type === "file") return [stat.path];
        if (!recursive) return [];
        return this.fs.walk(stat.path).filter((entry) => entry.type === "file").map((entry) => entry.path);
      });
      for (const file of files) scan(file, this.fs.readFile(file), files.length > 1 || recursive);
    }

    return { stdout: matches.join("\n") + (matches.length ? "\n" : ""), stderr: "", exitCode: matches.length ? 0 : 1 };
  }

  private find(args: string[]): string {
    const root = args[0] && !args[0].startsWith("-") ? args[0] : ".";
    const rootIndexOffset = root === "." && args[0]?.startsWith("-") ? 0 : 1;
    let type: "file" | "directory" | undefined;
    let namePattern: RegExp | undefined;
    let maxDepth = Number.POSITIVE_INFINITY;

    for (let i = rootIndexOffset; i < args.length; i++) {
      const arg = args[i];
      if (arg === "-type") {
        const value = args[++i];
        type = value === "f" ? "file" : value === "d" ? "directory" : undefined;
      } else if (arg === "-name") {
        namePattern = globToRegex(args[++i] ?? "*");
      } else if (arg === "-maxdepth") {
        maxDepth = Number(args[++i] ?? "Infinity");
      }
    }

    const normalizedRoot = this.fs.normalize(root);
    const entries = this.fs.walk(normalizedRoot).filter((entry) => {
      const depth = path.posix.relative(normalizedRoot, entry.path).split("/").filter(Boolean).length;
      return depth <= maxDepth && (!type || entry.type === type) && (!namePattern || namePattern.test(entry.name));
    });
    return entries.map((entry) => entry.path).join("\n") + (entries.length ? "\n" : "");
  }

  private echo(args: string[]): string {
    const noNewline = args[0] === "-n";
    const values = noNewline ? args.slice(1) : args;
    return `${values.join(" ")}${noNewline ? "" : "\n"}`;
  }

  private printf(args: string[]): string {
    if (args.length === 0) return "";
    let format = unescapePrintf(args[0] ?? "");
    for (const value of args.slice(1)) format = format.replace(/%s|%d|%j/, value);
    return format;
  }

  private mkdir(args: string[]): CommandResult {
    const recursive = args.includes("-p");
    const dirs = args.filter((arg) => !arg.startsWith("-"));
    for (const dir of dirs) this.fs.mkdir(dir, { recursive });
    return ok("");
  }

  private touch(args: string[]): CommandResult {
    for (const file of args) {
      if (file.startsWith("-")) continue;
      const normalized = this.fs.normalize(file);
      this.fs.writeFile(normalized, this.fs.exists(normalized) ? this.fs.readFile(normalized) : "");
    }
    return ok("");
  }

  private rm(args: string[]): CommandResult {
    const flags = parseFlags(args);
    for (const target of args.filter((arg) => !arg.startsWith("-"))) {
      this.fs.rm(target, { recursive: flags.has("r") || flags.has("R"), force: flags.has("f") });
    }
    return ok("");
  }

  private cp(args: string[]): CommandResult {
    const flags = parseFlags(args);
    const positional = args.filter((arg) => !arg.startsWith("-"));
    if (positional.length < 2) return { stdout: "", stderr: "cp: missing operand\n", exitCode: 1 };
    const to = positional[positional.length - 1] ?? ".";
    for (const from of positional.slice(0, -1)) this.fs.copy(from, to, { recursive: flags.has("r") || flags.has("R") });
    return ok("");
  }

  private mv(args: string[]): CommandResult {
    const positional = args.filter((arg) => !arg.startsWith("-"));
    if (positional.length < 2) return { stdout: "", stderr: "mv: missing operand\n", exitCode: 1 };
    const to = positional[positional.length - 1] ?? ".";
    for (const from of positional.slice(0, -1)) this.fs.rename(from, to);
    return ok("");
  }
}

function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;

  const push = () => {
    if (current !== "") {
      tokens.push(current);
      current = "";
    }
  };

  for (let i = 0; i < line.length; i++) {
    const char = line[i] ?? "";
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === '"' && i + 1 < line.length) current += line[++i];
      else current += char;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
    } else if (/\s/.test(char)) {
      push();
    } else if (char === ">" || char === "<") {
      push();
      if (line[i + 1] === char) {
        tokens.push(`${char}${char}`);
        i++;
      } else {
        tokens.push(char);
      }
    } else if (char === "&" && line[i + 1] === "&") {
      push();
      tokens.push("&&");
      i++;
    } else if (char === "|" && line[i + 1] === "|") {
      push();
      tokens.push("||");
      i++;
    } else if (char === "|" || char === ";") {
      push();
      tokens.push(char);
    } else if (char === "\\" && i + 1 < line.length) {
      current += line[++i];
    } else {
      current += char;
    }
  }
  push();
  return tokens;
}

function splitTokens(tokens: string[], separator: string): string[][] {
  const groups: string[][] = [[]];
  for (const token of tokens) {
    if (token === separator) groups.push([]);
    else groups[groups.length - 1]?.push(token);
  }
  return groups;
}

function splitConditionalTokens(tokens: string[]): Array<{ operator?: "&&" | "||"; tokens: string[] }> {
  const parts: Array<{ operator?: "&&" | "||"; tokens: string[] }> = [{ tokens: [] }];
  for (const token of tokens) {
    if (token === "&&" || token === "||") {
      parts.push({ operator: token, tokens: [] });
    } else {
      parts[parts.length - 1]?.tokens.push(token);
    }
  }
  return parts;
}

function extractRedirect(tokens: string[]): { tokens: string[]; redirect?: { file: string; append: boolean } } {
  const output: string[] = [];
  let redirect: { file: string; append: boolean } | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === ">" || token === ">>") {
      const file = tokens[++i];
      if (!file) throw new Error("missing redirect target");
      redirect = { file, append: token === ">>" };
    } else {
      output.push(token ?? "");
    }
  }
  return { tokens: output, redirect };
}

function parseFlags(args: string[]): Set<string> {
  const flags = new Set<string>();
  for (const arg of args) {
    if (!arg.startsWith("-") || arg === "-") continue;
    for (const flag of arg.slice(1)) flags.add(flag);
  }
  return flags;
}

function ok(stdout: string): CommandResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function formatLong(type: string, size: number, name: string): string {
  return `${type === "directory" ? "d" : "-"}rw-r--r-- ${String(size).padStart(8)} ${name}`;
}

function compilePattern(pattern: string, insensitive: boolean): RegExp {
  try {
    return new RegExp(pattern, insensitive ? "i" : undefined);
  } catch {
    return new RegExp(escapeRegex(pattern), insensitive ? "i" : undefined);
  }
}

function globToRegex(glob: string): RegExp {
  return new RegExp(`^${escapeRegex(glob).replace(/\\\*/g, ".*").replace(/\\\?/g, ".")}$`);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unescapePrintf(value: string): string {
  return value.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\r/g, "\r");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function helpText(): string {
  return `Mini bash commands: pwd, cd, ls, tree, cat, head, tail, grep, find, echo, printf, mkdir, touch, rm, cp, mv, true, false.\nSupports simple pipes, && / || conditionals, ; separators, > / >> redirects, and cat > file <<EOF heredocs.\n`;
}
