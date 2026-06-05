import { safeValidateTypes } from "@ai-sdk/provider-utils";
import type { AnyToolSet, ToolCallRecord } from "./types.js";

export class ToolRegistry {
  readonly history: ToolCallRecord[] = [];
  private counter = 0;

  constructor(
    private readonly tools: AnyToolSet,
    private readonly options: { sessionId: string },
  ) {}

  async callTool(name: string, input: unknown, executionOptions: any = {}): Promise<unknown> {
    const sourceTool = this.tools[name];
    if (!sourceTool) throw new Error(`Unknown tool: ${name}`);
    if (typeof sourceTool.execute !== "function") throw new Error(`Tool is not executable: ${name}`);

    const record: ToolCallRecord = {
      id: `${this.options.sessionId}:${++this.counter}`,
      name,
      input,
      startedAt: Date.now(),
    };
    this.history.push(record);

    try {
      const validated = await safeValidateTypes({ value: input, schema: sourceTool.inputSchema, context: { toolName: name } as any });
      if (!validated.success) throw validated.error;

      const result = sourceTool.execute(validated.value, {
        ...executionOptions,
        toolCallId: record.id,
        messages: executionOptions.messages ?? [],
      });
      const output = await collectMaybeAsyncIterable(result);

      if (sourceTool.outputSchema) {
        const outputValidation = await safeValidateTypes({ value: output, schema: sourceTool.outputSchema, context: { toolName: name } as any });
        if (!outputValidation.success) throw outputValidation.error;
        record.output = outputValidation.value;
      } else {
        record.output = output;
      }

      record.finishedAt = Date.now();
      return record.output;
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
      record.finishedAt = Date.now();
      throw error;
    }
  }
}

async function collectMaybeAsyncIterable(value: unknown): Promise<unknown> {
  const awaited = await value;
  if (isAsyncIterable(awaited)) {
    const chunks: unknown[] = [];
    for await (const chunk of awaited) chunks.push(chunk);
    return chunks;
  }
  return awaited;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return Boolean(value) && typeof (value as any)[Symbol.asyncIterator] === "function";
}
