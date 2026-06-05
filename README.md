# code-tools

Local-first Vercel AI SDK adapter that compresses many source tools into exactly two model-visible tools: `bash` and `code`.

- Original AI SDK tools stay hidden on the host.
- Input and output schemas are converted into generated TypeScript declarations in a virtual filesystem.
- The model can inspect the generated SDK with `bash` and call hidden tools from isolated TypeScript/JavaScript with `code`.
- `bash` and `code` share one persistent virtual filesystem.
- Host network/API access only happens inside original tool `execute` functions.

## Install

```bash
npm install code-tools ai zod
```

For the local Node adapter you also need a Node version supported by `isolated-vm` and `oxc-transform`.

## Usage

```ts
import { streamText, tool } from "ai";
import { z } from "zod";
import { createCodeTools } from "code-tools";

const sourceTools = {
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

const codeTools = await createCodeTools({ tools: sourceTools });

const result = streamText({
  model,
  system: `You are helpful.\n\n${codeTools.prompt}`,
  messages,
  tools: codeTools.tools, // only { bash, code } is exposed
});
```

Inside the code sandbox the model can use top-level generated functions:

```ts
const weather = await getWeather({ location: "Tbilisi" });
await sendEmail({
  to: "x@example.com",
  subject: "Weather",
  body: weather,
});
```

Or import explicitly:

```ts
import { getWeather } from "tools";
import { writeFile } from "sandbox:fs";

const weather = await getWeather({ location: "Tbilisi" });
await writeFile("/workspace/weather.txt", weather);
```

## Virtual filesystem

Generated files:

```txt
/sdk/README.md
/sdk/tools.d.ts
/sdk/tools.js
/sdk/globals.d.ts
/sdk/fs.d.ts
/sdk/fs.js
/workspace/README.md
```

`bash` and `code` share the same virtual filesystem. `/workspace` persists between calls.

`bash` is powered by `just-bash` over the shared VFS. No host shell or host filesystem is exposed.

## Network boundary

Sandboxed code cannot use `fetch`, Node built-ins, npm packages, or the host filesystem. If a hidden source tool performs network I/O, that happens on the host side:

```txt
sandbox code -> generated tool wrapper -> host ToolRegistry -> original tool.execute() -> network/API
```

So tools are the capability boundary.

## Nix + direnv

```bash
cp .env.example .env
# edit .env, then:
direnv allow
```

The `.envrc` enters the Nix flake dev shell and loads `.env` via direnv. `.env` is gitignored.

## Examples

Basic scripted example:

```bash
npm run example:basic
```

Real LLM example:

```bash
# .env must contain OPENAI_API_KEY and OPENAI_MODEL
npm run example:llm
```

`examples/llm-weather-email.ts` uses Vercel AI SDK `streamText` with `@ai-sdk/openai` and requires `OPENAI_MODEL` from `.env` (for example `gpt-5.5`). The model only receives the exposed `bash` and `code` tools. It inspects `/sdk` with bash, then writes TypeScript in the code sandbox to call the hidden IP-location, weather, and email tools.

GitHub MCP example:

```bash
# .env must contain OPENAI_API_KEY, OPENAI_MODEL, and GITHUB_PERSONAL_ACCESS_TOKEN
npm run example:mcp:github
```

`examples/mcp-github.ts` connects to the official remote GitHub MCP server at `GITHUB_MCP_URL` (default `https://api.githubcopilot.com/mcp/`), loads selected MCP tools as AI SDK tools, passes those into `createCodeTools`, and still exposes only `bash` and `code` to the model. The model discovers the authenticated GitHub user through MCP and writes a report to the virtual workspace. Tool-call code and bash snippets are syntax-highlighted and boxed in the CLI output. By default it uses read-only MCP tools:

```env
GITHUB_MCP_TOOLS=get_me,search_pull_requests,search_issues,search_repositories,search_commits,list_commits
GITHUB_MCP_READONLY=true
```

## Runtime choices

`createCodeTools` uses `NodeLocalAdapter` by default. You can pass an adapter object or adapter factory later for Workers/WASI/etc. The adapter receives the shared VFS, generated metadata, limits, and hidden tool registry.

- Bash: `just-bash` over the shared code-tools VFS.
- Code isolation: `isolated-vm`.
- Runtime TS/JS transform: `oxc-transform` from VoidZero/Oxc.
- Package bundling: `tsdown`/Rolldown.
- Typecheck script: `tsgo` via `@typescript/native-preview`.

## Development

```bash
npm install
npm run typecheck:tsc
npm run typecheck
npm test
npm run build
```
