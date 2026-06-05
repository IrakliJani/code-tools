import { createMCPClient } from "@ai-sdk/mcp";
import { openai } from "@ai-sdk/openai";
import { stepCountIs, streamText } from "ai";
import boxen from "boxen";
import { highlight } from "cli-highlight";
import wrapAnsi from "wrap-ansi";
import { createCodeTools } from "../src/index.js";

const openaiApiKey = requireEnv("OPENAI_API_KEY");
const modelId = requireEnv("OPENAI_MODEL");
const githubToken = requireEnv("GITHUB_PERSONAL_ACCESS_TOKEN");

const mcpUrl = process.env.GITHUB_MCP_URL ?? "https://api.githubcopilot.com/mcp/";
const maxDisplayLines = 150;

// Keep the demo focused enough for generated SDK exploration.
// Override with GITHUB_MCP_TOOLS or GITHUB_MCP_TOOLSETS in .env if you want more.
const githubMcpTools =
  process.env.GITHUB_MCP_TOOLS ??
  "get_me,search_pull_requests,search_issues,search_repositories,search_commits,list_commits";
const githubMcpToolsets = process.env.GITHUB_MCP_TOOLSETS;
const githubMcpReadonly = process.env.GITHUB_MCP_READONLY ?? "true";

const headers: Record<string, string> = {
  Authorization: `Bearer ${githubToken}`,
  "X-MCP-Readonly": githubMcpReadonly,
};
if (githubMcpTools) headers["X-MCP-Tools"] = githubMcpTools;
if (githubMcpToolsets) headers["X-MCP-Toolsets"] = githubMcpToolsets;

const mcpClient = await createMCPClient({
  transport: {
    type: "http",
    url: mcpUrl,
    headers,
  },
});

try {
  const githubTools = await mcpClient.tools();
  const toolNames = Object.keys(githubTools);

  const session = await createCodeTools({
    tools: githubTools,
    limits: {
      timeoutMs: 60_000,
      maxOutputBytes: 512_000,
    },
  });

  console.log(`[example:mcp] model=${modelId}`);
  console.log(`[example:mcp] mcpUrl=${mcpUrl}`);
  console.log(`[example:mcp] loaded MCP tools: ${toolNames.join(", ")}`);
  console.log(`[example:mcp] exposing only tools: ${Object.keys(session.tools).join(", ")}\n`);

  const result = streamText({
    model: openai(modelId),
    system: session.prompt,
    prompt:
      "For the authenticated GitHub user, find their top PR repo. Report up to 3 PRs and 3 issues they created there on the calendar day 3 days ago.",
    tools: session.tools,
    stopWhen: stepCountIs(10),
  });

  let finalText = "";
  for await (const part of result.fullStream) {
    switch (part.type) {
      case "text-delta":
        finalText += part.text;
        process.stdout.write(part.text);
        break;
      case "tool-call":
        console.log(`\n${formatToolCall(part.toolName, part.input)}`);
        break;
      case "tool-result":
        console.log(`\n${formatToolResult(part.toolName, part.output)}`);
        break;
      case "tool-error":
        console.log(`\n[tool-error] ${part.toolName}`);
        console.log(part.error);
        break;
      case "finish-step":
        console.log(`\n[finish-step] ${part.finishReason}`);
        break;
      case "finish":
        console.log(`\n[finish] ${part.finishReason}`);
        break;
    }
  }

  console.log("\n\n[final text]\n" + finalText.trim());
} finally {
  await mcpClient.close();
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}. Add it to .env.`);
    process.exit(1);
  }
  return value;
}

function formatToolCall(toolName: string, input: unknown): string {
  const record = isRecord(input) ? input : undefined;

  if (toolName === "code" && record && typeof record.code === "string") {
    const filename = typeof record.filename === "string" ? record.filename : "/workspace/main.ts";
    const entry = typeof record.entry === "string" ? record.entry : filename;
    const code = highlight(truncateDisplay(record.code, 24_000), { language: "typescript", ignoreIllegals: true });
    return framed(code, {
      title: `llm generated TypeScript  ${filename}${entry !== filename ? ` -> ${entry}` : ""}`,
      borderColor: "cyan",
      backgroundColor: "black",
      wrap: true,
    });
  }

  if (toolName === "bash" && record && typeof record.command === "string") {
    return framed(highlight(record.command, { language: "bash", ignoreIllegals: true }), {
      title: "llm bash",
      borderColor: "yellow",
      backgroundColor: "black",
      wrap: true,
    });
  }

  return framed(formatJson(input, 4_000), {
    title: `llm tool-call  ${toolName}`,
    borderColor: "magenta",
    backgroundColor: "black",
  });
}

function formatToolResult(toolName: string, output: unknown): string {
  const record = isRecord(output) ? output : undefined;

  if ((toolName === "code" || toolName === "bash") && record) {
    const chunks: string[] = [];
    const exitCode = typeof record.exitCode === "number" ? record.exitCode : undefined;
    const statusColor = exitCode === 0 ? "green" : "red";
    const title = `tool-result  ${toolName}${exitCode === undefined ? "" : `  exit ${exitCode}`}`;

    if (typeof record.stdout === "string" && record.stdout.length > 0) {
      chunks.push(
        framed(formatStdout(record.stdout, 12_000), {
          title: `${title} stdout`,
          borderColor: statusColor,
          backgroundColor: "black",
          wrap: true,
        }),
      );
    }

    if (typeof record.stderr === "string" && record.stderr.length > 0) {
      chunks.push(
        framed(highlight(truncateDisplay(record.stderr, 8_000), { language: "bash", ignoreIllegals: true }), {
          title: `${title} stderr`,
          borderColor: "red",
          backgroundColor: "black",
          wrap: true,
        }),
      );
    }

    if (chunks.length > 0) return chunks.join("\n");
  }

  return framed(formatJson(output, 12_000), {
    title: `tool-result  ${toolName}`,
    borderColor: "gray",
    backgroundColor: "black",
  });
}

function framed(
  content: string,
  options: {
    title: string;
    borderColor: "cyan" | "yellow" | "magenta" | "green" | "red" | "gray";
    backgroundColor?: "black";
    wrap?: boolean;
  },
): string {
  const width = frameWidth();
  const body = options.wrap ? wrapAnsi(content, Math.max(40, width - 4), { hard: true, trim: false }) : content;

  return boxen(body, {
    title: options.title,
    titleAlignment: "left",
    borderStyle: "round",
    borderColor: options.borderColor,
    backgroundColor: options.backgroundColor,
    width: options.wrap ? width : undefined,
    padding: { top: 0, bottom: 0, left: 1, right: 1 },
    margin: { top: 1, bottom: 1 },
  });
}

function frameWidth(): number {
  const columns = process.stdout.columns ?? 120;
  return Math.max(60, Math.min(columns - 2, 140));
}

function formatJson(value: unknown, maxLength: number): string {
  return highlight(truncateDisplay(JSON.stringify(value, null, 2), maxLength), {
    language: "json",
    ignoreIllegals: true,
  });
}

function formatStdout(value: string, maxLength: number): string {
  const parsed = parseJson(value);
  if (parsed !== undefined) {
    const mcpText = getMcpText(parsed);
    if (mcpText !== undefined) return formatPossiblyJsonText(mcpText, maxLength);
    return formatJson(parsed, maxLength);
  }

  const extractedMcpText = extractFirstJsonStringProperty(value, "text");
  if (extractedMcpText !== undefined) return formatPossiblyJsonText(extractedMcpText, maxLength);

  return highlight(truncateDisplay(value, maxLength), {
    language: guessOutputLanguage(value),
    ignoreIllegals: true,
  });
}

function formatPossiblyJsonText(value: string, maxLength: number): string {
  const parsed = parseJson(value);
  if (parsed !== undefined) return formatJson(parsed, maxLength);

  return highlight(truncateDisplay(value, maxLength), {
    language: guessOutputLanguage(value),
    ignoreIllegals: true,
  });
}

function getMcpText(value: unknown): string | undefined {
  if (!isRecord(value) || !Array.isArray(value.content)) return undefined;
  const textParts = value.content
    .filter(isRecord)
    .map((part) => (typeof part.text === "string" ? part.text : undefined))
    .filter((part): part is string => part !== undefined);
  return textParts.length > 0 ? textParts.join("\n") : undefined;
}

function extractFirstJsonStringProperty(value: string, key: string): string | undefined {
  const keyIndex = value.indexOf(JSON.stringify(key));
  if (keyIndex < 0) return undefined;

  const colonIndex = value.indexOf(":", keyIndex);
  if (colonIndex < 0) return undefined;

  let i = colonIndex + 1;
  while (/\s/.test(value[i] ?? "")) i++;
  if (value[i] !== '"') return undefined;
  i++;

  let raw = "";
  let escaped = false;
  for (; i < value.length; i++) {
    const char = value[i] ?? "";
    if (escaped) {
      raw += `\\${char}`;
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === '"') {
      return decodeJsonStringLiteral(raw);
    } else {
      raw += char;
    }
  }

  if (escaped) raw += "\\";
  return decodeJsonStringLiteral(raw);
}

function decodeJsonStringLiteral(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
}

function parseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value.trim());
  } catch {
    return undefined;
  }
}

function guessOutputLanguage(value: string): string {
  const trimmed = value.trimStart();
  if (trimmed.startsWith("#") || trimmed.includes("\n|")) return "markdown";
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json";
  return "plaintext";
}

function truncateDisplay(value: string, maxLength: number, maxLines = maxDisplayLines): string {
  let output = value;
  const lines = output.split("\n");
  if (lines.length > maxLines) {
    output = `${lines.slice(0, maxLines).join("\n")}\n...[truncated ${lines.length - maxLines} lines]`;
  }

  if (output.length > maxLength) {
    output = `${output.slice(0, maxLength)}\n...[truncated ${output.length - maxLength} chars]`;
  }

  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

void openaiApiKey;
