import { describe, expect, it } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import { createCodeTools } from "../src/index.js";

describe("code-tools", () => {
  it("generates SDK files explorable by bash", async () => {
    const session = await createCodeTools({
      tools: {
        getWeather: tool({
          description: "Get weather",
          inputSchema: z.object({ location: z.string() }),
          outputSchema: z.string(),
          execute: async ({ location }) => `Weather in ${location}`,
        }),
      },
    });

    const result = await session.adapter.runBash({ command: "cat /sdk/tools.d.ts" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("GetWeatherInput");
    expect(result.stdout).toContain("declare function getWeather");
  });

  it("calls hidden tools from code and shares filesystem state", async () => {
    const session = await createCodeTools({
      tools: {
        add: tool({
          inputSchema: z.object({ a: z.number(), b: z.number() }),
          outputSchema: z.number(),
          execute: ({ a, b }) => a + b,
        }),
      },
    });

    const code = await session.adapter.runCode({
      code: `
import { writeFile } from "sandbox:fs";
const value = await add({ a: 2, b: 3 });
await writeFile("sum.txt", String(value));
console.log(value);
`,
    });
    expect(code.exitCode).toBe(0);
    expect(code.stdout).toBe("5\n");

    const bash = await session.adapter.runBash({ command: "cat sum.txt" });
    expect(bash.stdout).toBe("5");
  });

  it("supports bash && and || conditionals", async () => {
    const session = await createCodeTools({
      tools: {
        noop: tool({ inputSchema: z.object({}), execute: () => null }),
      },
    });

    const andResult = await session.adapter.runBash({ command: "cat /sdk/README.md && printf '\\n--- tools.d.ts ---\\n' && cat /sdk/tools.d.ts" });
    expect(andResult.exitCode).toBe(0);
    expect(andResult.stdout).toContain("# code-tools generated SDK");
    expect(andResult.stdout).toContain("--- tools.d.ts ---");

    const orResult = await session.adapter.runBash({ command: "false && echo nope || echo recovered" });
    expect(orResult.exitCode).toBe(0);
    expect(orResult.stdout).toBe("recovered\n");
  });

  it("blocks Node built-in imports", async () => {
    const session = await createCodeTools({
      tools: {
        noop: tool({ inputSchema: z.object({}), execute: () => null }),
      },
    });

    const result = await session.adapter.runCode({ code: 'import fs from "fs"; console.log(fs);' });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Import is not allowed");
  });
});
