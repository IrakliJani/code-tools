import { tool } from "ai";
import { z } from "zod";
import { NodeLocalAdapter } from "./local-adapter.js";
import { collectToolMetadata } from "./schema.js";
import { generateSdk, installSdk } from "./sdk.js";
import { ToolRegistry } from "./tool-registry.js";
import type { AnyToolSet, CodeToolsSession, CreateCodeToolsOptions, Limits } from "./types.js";
import { defaultLimits } from "./types.js";
import { InMemoryFileSystem } from "./vfs.js";

export async function createCodeTools<Tools extends AnyToolSet>(options: CreateCodeToolsOptions<Tools>): Promise<CodeToolsSession<Tools>> {
  const limits: Limits = { ...defaultLimits, ...options.limits };
  const rawWorkdir = options.workdir ?? "/workspace";
  const rawSdkDir = options.sdkDir ?? "/sdk";
  const sessionId = options.sessionId ?? `code-tools-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  const providedAdapter = typeof options.adapter === "function" ? undefined : options.adapter;
  const fs = providedAdapter?.fs ?? options.fs ?? new InMemoryFileSystem({ cwd: rawWorkdir, limits });
  const workdir = fs.normalize(rawWorkdir, "/");
  const sdkDir = fs.normalize(rawSdkDir, "/");
  fs.mkdir(workdir, { recursive: true });
  fs.mkdir(sdkDir, { recursive: true });
  fs.cwd = workdir;

  const toolMetadata = await collectToolMetadata(options.tools);
  const generated = generateSdk(toolMetadata, { sdkDir, workdir, promptSuffix: options.promptSuffix });
  installSdk(fs, generated);

  const registry = new ToolRegistry(options.tools, { sessionId });
  const adapterContext = {
    fs,
    registry,
    metadata: toolMetadata,
    limits,
    sdkDir,
    workdir,
  };
  const adapter =
    typeof options.adapter === "function"
      ? await options.adapter(adapterContext)
      : providedAdapter ?? new NodeLocalAdapter(adapterContext);

  const bash = tool({
    description:
      "Run a mini-bash command in the shared virtual filesystem. Supports ls/cat/grep/find/tree, simple pipes, redirects, heredocs, and file mutation under the virtual FS.",
    inputSchema: z.object({
      command: z.string().describe("Mini-bash command to execute in the shared virtual filesystem."),
    }),
    outputSchema: z.object({
      stdout: z.string(),
      stderr: z.string(),
      exitCode: z.number(),
      cwd: z.string(),
      timedOut: z.boolean().optional(),
    }),
    execute: async (input, executionOptions) => adapter.runBash(input, executionOptions),
  });

  const code = tool({
    description:
      "Write and/or execute TypeScript/JavaScript in a local isolated VM. Hidden source tools are available as typed top-level async functions and from the virtual module `tools`. No network, npm, Node built-ins, or host filesystem.",
    inputSchema: z.object({
      code: z
        .string()
        .optional()
        .describe("TypeScript/JavaScript source to write before execution. If omitted, an existing entry file is executed."),
      filename: z
        .string()
        .optional()
        .describe("Where to write `code`. Defaults to /workspace/main.ts. Relative paths resolve under /workspace."),
      entry: z
        .string()
        .optional()
        .describe("Entry file to execute. Defaults to `filename`, then /workspace/main.ts. Can be an existing workspace file."),
    }),
    outputSchema: z.object({
      stdout: z.string(),
      stderr: z.string(),
      exitCode: z.number(),
      entry: z.string(),
      value: z.unknown().optional(),
      timedOut: z.boolean().optional(),
    }),
    execute: async (input, executionOptions) => adapter.runCode(input, executionOptions),
  });

  return {
    tools: { bash, code },
    prompt: generated.prompt,
    fs,
    adapter,
    toolMetadata,
    sourceTools: options.tools,
  };
}
