import { Buffer } from "node:buffer";
import type { ToolExecutionOptions } from "ai";
import { IsolatedVmCodeExecutor } from "./code-executor.js";
import { JustBashRunner } from "./just-bash.js";
import type { BashInput, BashResult, CodeInput, CodeResult, RuntimeAdapter, RuntimeAdapterContext, VirtualFileSystem } from "./types.js";

export type NodeLocalAdapterOptions = RuntimeAdapterContext;

export class NodeLocalAdapter implements RuntimeAdapter {
  readonly fs: VirtualFileSystem;

  private readonly bash: JustBashRunner;
  private readonly code: IsolatedVmCodeExecutor;

  constructor(private readonly options: NodeLocalAdapterOptions) {
    this.fs = options.fs;
    this.bash = new JustBashRunner(options.fs, options.limits);
    this.code = new IsolatedVmCodeExecutor(options);
  }

  async runBash(input: BashInput, _options?: ToolExecutionOptions): Promise<BashResult> {
    try {
      const result = await this.bash.run(input);
      return {
        ...result,
        stdout: clamp(result.stdout, this.options.limits.maxOutputBytes),
        stderr: clamp(result.stderr, this.options.limits.maxOutputBytes),
      };
    } catch (error) {
      return {
        stdout: "",
        stderr: `${error instanceof Error ? error.message : String(error)}\n`,
        exitCode: 1,
        cwd: this.fs.cwd,
      };
    }
  }

  async runCode(input: CodeInput, options?: ToolExecutionOptions): Promise<CodeResult> {
    return this.code.run(input, options);
  }
}

function clamp(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  return `${Buffer.from(value).subarray(0, maxBytes).toString("utf8")}\n[output truncated]\n`;
}
