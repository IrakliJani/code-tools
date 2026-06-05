import { tool } from "ai";
import { z } from "zod";
import { createCodeTools } from "../src/index.js";

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
    execute: async ({ to }) => `Email sent to ${to}`,
  }),
};

const session = await createCodeTools({ tools: sourceTools });

console.log(session.prompt);
console.log(await session.tools.bash.execute?.({ command: "cat /sdk/tools.d.ts" }, {} as any));
console.log(
  await session.tools.code.execute?.(
    {
      code: `
const location = await getLocationFromIp({});
const weatherLocation = location.city ?? location.region ?? location.country ?? "Tbilisi";
console.log(JSON.stringify(location));

const weather = await getWeather({ location: weatherLocation });
console.log(weather);

const sent = await sendEmail({
  to: "x@example.com",
  subject: \`Weather for \${weatherLocation}\`,
  body: \`IP location: \${JSON.stringify(location)}\\n\${weather}\`,
});
console.log(sent);
`,
    },
    {} as any,
  ),
);

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : null;
}
