import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  deps: {
    neverBundle: ["ai", "zod", "@ai-sdk/provider-utils", "isolated-vm", "just-bash", "oxc-transform"],
  },
});
