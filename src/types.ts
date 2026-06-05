import type { Tool, ToolExecutionOptions } from "ai";

export type AnyAiTool = Tool<any, any> & {
  execute?: (input: any, options: ToolExecutionOptions) => any;
};

export type AnyToolSet = Record<string, AnyAiTool>;

export type JsonSchema = Record<string, any>;

export interface Limits {
  /** Wall-clock timeout for a bash/code invocation. */
  timeoutMs: number;
  /** V8 isolate memory limit in MB. */
  memoryMb: number;
  /** Maximum captured stdout/stderr bytes per invocation. */
  maxOutputBytes: number;
  /** Maximum size of one virtual file in bytes. */
  maxFileSizeBytes: number;
  /** Maximum aggregate virtual filesystem size in bytes. */
  maxTotalFsBytes: number;
}

export const defaultLimits: Limits = {
  timeoutMs: 10_000,
  memoryMb: 128,
  maxOutputBytes: 128_000,
  maxFileSizeBytes: 2_000_000,
  maxTotalFsBytes: 20_000_000,
};

export interface BashInput {
  command: string;
}

export interface BashResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  cwd: string;
  timedOut?: boolean;
}

export interface CodeInput {
  /** TypeScript/JavaScript source to write before execution. If omitted, an existing entry file is executed. */
  code?: string;
  /** Where to write `code`. Defaults to /workspace/main.ts. Relative paths resolve under /workspace. */
  filename?: string;
  /** Entry file to execute. Defaults to `filename`, then /workspace/main.ts. */
  entry?: string;
}

export interface CodeResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  entry: string;
  value?: unknown;
  timedOut?: boolean;
}

export interface ToolMetadata {
  originalName: string;
  identifier: string;
  inputTypeName: string;
  outputTypeName: string;
  description?: string;
  inputJsonSchema: JsonSchema;
  outputJsonSchema?: JsonSchema;
}

export interface ToolCallRecord {
  id: string;
  name: string;
  input: unknown;
  output?: unknown;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

export interface VirtualFileSystem {
  cwd: string;
  normalize(pathname: string, base?: string): string;
  exists(pathname: string): boolean;
  stat(pathname: string): FsStat;
  readFile(pathname: string): string;
  writeFile(pathname: string, contents: string): void;
  mkdir(pathname: string, options?: { recursive?: boolean }): void;
  readdir(pathname: string): FsDirent[];
  rm(pathname: string, options?: { recursive?: boolean; force?: boolean }): void;
  rename(from: string, to: string): void;
  copy(from: string, to: string, options?: { recursive?: boolean }): void;
  walk(pathname: string): FsDirent[];
}

export interface FsStat {
  path: string;
  type: "file" | "directory";
  size: number;
}

export interface FsDirent extends FsStat {
  name: string;
}

export interface RuntimeAdapter {
  fs: VirtualFileSystem;
  runBash(input: BashInput, options?: ToolExecutionOptions): Promise<BashResult>;
  runCode(input: CodeInput, options?: ToolExecutionOptions): Promise<CodeResult>;
}

export interface HiddenToolRegistry {
  readonly history: ToolCallRecord[];
  callTool(name: string, input: unknown, executionOptions?: unknown): Promise<unknown>;
}

export interface RuntimeAdapterContext {
  fs: VirtualFileSystem;
  registry: HiddenToolRegistry;
  metadata: ToolMetadata[];
  limits: Limits;
  sdkDir: string;
  workdir: string;
}

export interface CreateCodeToolsOptions<Tools extends AnyToolSet = AnyToolSet> {
  tools: Tools;
  /** Existing adapter or adapter factory. If omitted, NodeLocalAdapter is created. */
  adapter?: RuntimeAdapter | ((context: RuntimeAdapterContext) => RuntimeAdapter | Promise<RuntimeAdapter>);
  /** Existing virtual filesystem. Ignored when a prebuilt `adapter` object is provided. */
  fs?: VirtualFileSystem;
  /** Directory for generated read-only SDK files. */
  sdkDir?: string;
  /** Writable model workspace. */
  workdir?: string;
  /** Session id used in internal tool call ids/history. */
  sessionId?: string;
  /** Sandbox/resource limits. */
  limits?: Partial<Limits>;
  /** Extra text appended to generated prompt. */
  promptSuffix?: string;
}

export interface CodeToolsSession<Tools extends AnyToolSet = AnyToolSet> {
  /** Pass this object to streamText/generateText as the only exposed tools. */
  tools: {
    bash: Tool<BashInput, BashResult>;
    code: Tool<CodeInput, CodeResult>;
  };
  /** Add this to your system prompt so the model knows the generated SDK exists. */
  prompt: string;
  /** Shared virtual filesystem used by bash and code. */
  fs: VirtualFileSystem;
  /** Runtime adapter backing the two tools. */
  adapter: RuntimeAdapter;
  /** Metadata for hidden source tools. */
  toolMetadata: ToolMetadata[];
  /** Hidden source tools, preserved for generic typing/debugging. */
  sourceTools: Tools;
}
