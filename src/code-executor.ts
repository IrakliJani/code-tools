import { Buffer } from "node:buffer";
import path from "node:path";
import ivm from "isolated-vm";
import type { CodeInput, CodeResult, HiddenToolRegistry, Limits, ToolMetadata, VirtualFileSystem } from "./types.js";
import { transpileForSandbox } from "./transpile.js";

export interface CodeExecutorOptions {
  fs: VirtualFileSystem;
  registry: HiddenToolRegistry;
  metadata: ToolMetadata[];
  limits: Limits;
  sdkDir: string;
  workdir: string;
}

export class IsolatedVmCodeExecutor {
  constructor(private readonly options: CodeExecutorOptions) {}

  async run(input: CodeInput, executionOptions: any = {}): Promise<CodeResult> {
    const filename = this.options.fs.normalize(input.filename ?? "/workspace/main.ts", this.options.workdir);
    if (input.code !== undefined) {
      const parent = path.posix.dirname(filename);
      this.options.fs.mkdir(parent, { recursive: true });
      this.options.fs.writeFile(filename, input.code);
    }

    const entry = this.options.fs.normalize(input.entry ?? filename, this.options.workdir);
    const stdout = new OutputBuffer(this.options.limits.maxOutputBytes);
    const stderr = new OutputBuffer(this.options.limits.maxOutputBytes);

    let timedOut = false;
    const isolate = new ivm.Isolate({ memoryLimit: this.options.limits.memoryMb });

    try {
      const context = await isolate.createContext();
      context.global.setSync("globalThis", context.global.derefInto());
      this.installGlobals(context, stdout, stderr, executionOptions);

      const modules = new ModuleGraph({
        isolate,
        fs: this.options.fs,
        sdkDir: this.options.sdkDir,
      });
      const root = modules.compile(entry);
      await root.instantiate(context, (specifier, referrer) => modules.resolveAndCompile(specifier, referrer));

      const value = await withWallTimeout(
        root.evaluate({ timeout: this.options.limits.timeoutMs, promise: true, copy: true }),
        this.options.limits.timeoutMs,
        () => {
          timedOut = true;
          isolate.dispose();
        },
      );

      context.release();
      isolate.dispose();
      return { stdout: stdout.value, stderr: stderr.value, exitCode: 0, entry, value, timedOut };
    } catch (error) {
      if (!isolate.isDisposed) isolate.dispose();
      stderr.write(`${formatError(error)}\n`);
      return { stdout: stdout.value, stderr: stderr.value, exitCode: 1, entry, timedOut };
    }
  }

  private installGlobals(context: ivm.Context, stdout: OutputBuffer, stderr: OutputBuffer, executionOptions: any): void {
    const logRef = (stream: "stdout" | "stderr", text: string) => {
      if (stream === "stderr") stderr.write(text);
      else stdout.write(text);
    };
    const callToolRef = async (name: string, input: unknown) => {
      try {
        return bridgeOk(await this.options.registry.callTool(name, input, executionOptions));
      } catch (error) {
        return bridgeError(error);
      }
    };
    const fsRef = async (op: string, args: unknown[]) => {
      try {
        return bridgeOk(this.fsOperation(op, args));
      } catch (error) {
        return bridgeError(error);
      }
    };

    const entries = this.options.metadata.map((tool) => [tool.originalName, tool.identifier]);

    context.evalClosureSync(
      `
      const __sendLog = $0;
      const __callToolHost = $1;
      const __fsHost = $2;
      const __toolEntries = ${JSON.stringify(entries)};

      function __formatConsole(value) {
        if (typeof value === "string") return value;
        if (typeof value === "undefined") return "undefined";
        if (typeof value === "function") return "[Function " + (value.name || "anonymous") + "]";
        try { return JSON.stringify(value); } catch { return String(value); }
      }

      function __log(stream, args) {
        __sendLog.applySync(undefined, [stream, Array.from(args).map(__formatConsole).join(" ") + "\\n"], { arguments: { copy: true } });
      }

      Object.defineProperty(globalThis, "console", {
        value: Object.freeze({
          log: (...args) => __log("stdout", args),
          info: (...args) => __log("stdout", args),
          warn: (...args) => __log("stderr", args),
          error: (...args) => __log("stderr", args),
          debug: (...args) => __log("stderr", args),
        }),
        configurable: false,
        enumerable: false,
        writable: false,
      });

      function __decodeBridge(packet) {
        const decoded = JSON.parse(packet);
        if (!decoded.ok) throw new Error(decoded.error || "Host operation failed");
        return decoded.value;
      }

      Object.defineProperty(globalThis, "__codeTools", {
        value: Object.freeze({
          callTool(name, input) {
            return __decodeBridge(__callToolHost.applySyncPromise(undefined, [name, input], {
              arguments: { copy: true },
            }));
          },
          fs(op, args) {
            return __decodeBridge(__fsHost.applySyncPromise(undefined, [op, args], {
              arguments: { copy: true },
            }));
          },
        }),
        configurable: false,
        enumerable: false,
        writable: false,
      });

      const __toolsObject = {};
      for (const [originalName, identifier] of __toolEntries) {
        const fn = (input) => globalThis.__codeTools.callTool(originalName, input);
        Object.defineProperty(globalThis, identifier, { value: fn, configurable: false, enumerable: false, writable: false });
        Object.defineProperty(__toolsObject, originalName, { value: fn, configurable: false, enumerable: true, writable: false });
      }
      Object.defineProperty(globalThis, "tools", { value: Object.freeze(__toolsObject), configurable: false, enumerable: false, writable: false });

      // Local sandbox only. These names should not exist, but make denial explicit.
      globalThis.process = undefined;
      globalThis.require = undefined;
      globalThis.fetch = undefined;
      globalThis.WebSocket = undefined;
      globalThis.EventSource = undefined;
      globalThis.WebAssembly = undefined;
      `,
      [logRef, callToolRef, fsRef],
      { arguments: { reference: true }, timeout: this.options.limits.timeoutMs },
    );
  }

  private fsOperation(op: string, args: unknown[]): unknown {
    const [first, second, third] = args;
    switch (op) {
      case "cwd":
        return this.options.fs.cwd;
      case "chdir": {
        const next = this.options.fs.normalize(String(first));
        if (this.options.fs.stat(next).type !== "directory") throw new Error(`Not a directory: ${next}`);
        this.options.fs.cwd = next;
        return this.options.fs.cwd;
      }
      case "exists":
        return this.options.fs.exists(String(first));
      case "stat":
        return this.options.fs.stat(String(first));
      case "readFile":
        return this.options.fs.readFile(String(first));
      case "writeFile":
        this.options.fs.writeFile(String(first), String(second ?? ""));
        return undefined;
      case "readdir":
        return this.options.fs.readdir(first === undefined ? "." : String(first));
      case "mkdir":
        this.options.fs.mkdir(String(first), normalizeOptions(second));
        return undefined;
      case "rm":
        this.options.fs.rm(String(first), normalizeOptions(second));
        return undefined;
      case "rename":
        this.options.fs.rename(String(first), String(second));
        return undefined;
      case "copy":
        this.options.fs.copy(String(first), String(second), normalizeOptions(third));
        return undefined;
      default:
        throw new Error(`Unknown sandbox fs operation: ${op}`);
    }
  }
}

class ModuleGraph {
  private readonly cache = new Map<string, ivm.Module>();
  private readonly paths = new WeakMap<ivm.Module, string>();

  constructor(private readonly options: { isolate: ivm.Isolate; fs: VirtualFileSystem; sdkDir: string }) {}

  compile(pathname: string): ivm.Module {
    const resolved = this.options.fs.normalize(pathname);
    const cached = this.cache.get(resolved);
    if (cached) return cached;

    const code = this.loadModuleCode(resolved);
    const module = this.options.isolate.compileModuleSync(code, { filename: `vfs://${resolved}` });
    this.cache.set(resolved, module);
    this.paths.set(module, resolved);
    return module;
  }

  resolveAndCompile(specifier: string, referrer: ivm.Module): ivm.Module {
    return this.compile(this.resolve(specifier, this.paths.get(referrer)));
  }

  private resolve(specifier: string, referrerPath: string | undefined): string {
    if (specifier === "tools") return `${this.options.sdkDir}/tools.js`;
    if (specifier === "sandbox:fs") return `${this.options.sdkDir}/fs.js`;

    if (specifier.startsWith("node:") || forbiddenBareSpecifiers.has(specifier)) {
      throw new Error(`Import is not allowed in the sandbox: ${specifier}`);
    }

    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      const base = specifier.startsWith("/")
        ? this.options.fs.normalize(specifier)
        : this.options.fs.normalize(specifier, path.posix.dirname(referrerPath ?? "/workspace/main.ts"));
      return this.resolveExistingPath(base);
    }

    throw new Error(`Bare import is not allowed in the sandbox: ${specifier}. Use "tools", "sandbox:fs", or relative files.`);
  }

  private resolveExistingPath(base: string): string {
    const candidates = [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.js`,
      `${base}.mjs`,
      `${base}.cjs`,
      `${base}.json`,
      `${base}/index.ts`,
      `${base}/index.tsx`,
      `${base}/index.js`,
      `${base}/index.mjs`,
      `${base}/index.cjs`,
    ];

    for (const candidate of candidates) {
      if (!this.options.fs.exists(candidate)) continue;
      const stat = this.options.fs.stat(candidate);
      if (stat.type === "file") return stat.path;
    }
    throw new Error(`Cannot resolve module: ${base}`);
  }

  private loadModuleCode(pathname: string): string {
    if (pathname.endsWith(".json")) {
      return `export default ${this.options.fs.readFile(pathname)};`;
    }

    if (pathname.endsWith(".d.ts")) {
      throw new Error(`Cannot execute declaration file: ${pathname}`);
    }

    const source = this.options.fs.readFile(pathname);
    return transpileForSandbox(pathname, source).code;
  }
}

class OutputBuffer {
  private chunks: string[] = [];
  private bytes = 0;
  private truncated = false;

  constructor(private readonly maxBytes: number) {}

  get value(): string {
    return this.chunks.join("");
  }

  write(value: string): void {
    if (this.truncated) return;
    const bytes = Buffer.byteLength(value, "utf8");
    if (this.bytes + bytes <= this.maxBytes) {
      this.chunks.push(value);
      this.bytes += bytes;
      return;
    }

    const remaining = Math.max(0, this.maxBytes - this.bytes);
    if (remaining > 0) {
      this.chunks.push(Buffer.from(value).subarray(0, remaining).toString("utf8"));
    }
    this.chunks.push("\n[output truncated]\n");
    this.truncated = true;
  }
}

const forbiddenBareSpecifiers = new Set([
  "fs",
  "fs/promises",
  "path",
  "child_process",
  "worker_threads",
  "net",
  "tls",
  "http",
  "https",
  "dns",
  "dgram",
  "os",
  "process",
  "module",
  "vm",
]);

function normalizeOptions(value: unknown): any {
  return value && typeof value === "object" ? value : {};
}

async function withWallTimeout<T>(promise: Promise<T> | T, timeoutMs: number, onTimeout: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new Error(`Sandbox timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function bridgeOk(value: unknown): string {
  try {
    return JSON.stringify({ ok: true, value });
  } catch (error) {
    return bridgeError(error);
  }
}

function bridgeError(error: unknown): string {
  return JSON.stringify({ ok: false, error: formatError(error) });
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}
