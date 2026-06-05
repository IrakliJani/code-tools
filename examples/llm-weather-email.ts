import { openai } from "@ai-sdk/openai";
import { stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
import { createCodeTools } from "../src/index.js";

if (!process.env.OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY. Add it to .env or run: OPENAI_API_KEY=... npm run example:llm");
  process.exit(1);
}

if (!process.env.OPENAI_MODEL) {
  console.error("Missing OPENAI_MODEL. Add it to .env, e.g. OPENAI_MODEL=gpt-5.5");
  process.exit(1);
}

const modelId = process.env.OPENAI_MODEL;
const emailTo = "x@example.com";

const ipLocationSchema = z.object({
  ip: z.string(),
  city: z.string().nullable(),
  region: z.string().nullable(),
  country: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  timezone: z.string().nullable(),
});

const sourceTools = {
  getLocationFromIp: tool({
    description: "Get approximate location based on the current public IP address, or a provided IP address.",
    inputSchema: z.object({
      ip: z.string().optional().describe("Optional IP address. Omit to use the host's current public IP address."),
    }),
    outputSchema: ipLocationSchema,
    execute: async ({ ip }) => {
      const url = ip ? `https://ipapi.co/${encodeURIComponent(ip)}/json/` : "https://ipapi.co/json/";
      const response = await fetch(url, {
        headers: { "user-agent": "code-tools-example/0.1" },
      });

      if (!response.ok) {
        throw new Error(`IP location lookup failed: HTTP ${response.status}`);
      }

      const data = (await response.json()) as Record<string, unknown>;
      if (data.error) {
        throw new Error(`IP location lookup failed: ${String(data.reason ?? data.message ?? "unknown error")}`);
      }

      return {
        ip: String(data.ip ?? ip ?? ""),
        city: stringOrNull(data.city),
        region: stringOrNull(data.region),
        country: stringOrNull(data.country_name ?? data.country),
        latitude: numberOrNull(data.latitude),
        longitude: numberOrNull(data.longitude),
        timezone: stringOrNull(data.timezone),
      };
    },
  }),
  getWeather: tool({
    description: "Get weather for a location",
    inputSchema: z.object({ location: z.string() }),
    outputSchema: z.string(),
    execute: async ({ location }) => `Weather in ${location}: 72°F, sunny`,
  }),
  sendEmail: tool({
    description: "Send an email",
    inputSchema: z.object({
      to: z.string().email(),
      subject: z.string(),
      body: z.string(),
    }),
    outputSchema: z.string(),
    execute: async ({ to, subject, body }) => {
      console.log("\n[host sendEmail]", JSON.stringify({ to, subject, body }, null, 2));
      return `Email sent to ${to}`;
    },
  }),
};

const session = await createCodeTools({ tools: sourceTools });

console.log(`[example] model=${modelId}`);
console.log(`[example] exposing only tools: ${Object.keys(session.tools).join(", ")}`);
console.log("[example] hidden tool SDK prompt injected into system prompt\n");

const result = streamText({
  model: openai(modelId),
  system: [
    "You are a coding agent using code-tools.",
    session.prompt,
    "Important workflow:",
    "1. First call bash to inspect /sdk/README.md and /sdk/tools.d.ts.",
    "2. Then call code with TypeScript that uses the generated SDK to complete the task.",
    "3. The sandbox has no network. Network/API work only happens through hidden host tools.",
    "4. After the tool work succeeds, summarize exactly what happened.",
  ].join("\n\n"),
  prompt: [
    "Look up my approximate location from my public IP address.",
    "Choose the best weather location from city, region, or country.",
    "Get the weather for that location.",
    `Send an email to ${emailTo} with subject \"Weather for <location>\" and a body containing the IP location JSON plus the weather result.`,
    "You write the TypeScript yourself; do not ask me for code.",
  ].join("\n"),
  tools: session.tools,
  stopWhen: stepCountIs(8),
});

let finalText = "";
for await (const part of result.fullStream) {
  switch (part.type) {
    case "text-delta":
      finalText += part.text;
      process.stdout.write(part.text);
      break;
    case "tool-call":
      console.log(`\n\n[llm tool-call] ${part.toolName}`);
      console.log(truncate(JSON.stringify(part.input, null, 2), 2_000));
      break;
    case "tool-result":
      console.log(`\n[tool-result] ${part.toolName}`);
      console.log(truncate(JSON.stringify(part.output, null, 2), 4_000));
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

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}\n...[truncated]`;
}
