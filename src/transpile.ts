import { transformSync } from "oxc-transform";

export interface TranspileResult {
  code: string;
  warnings: string[];
}

export function transpileForSandbox(filename: string, source: string): TranspileResult {
  const lang = filename.endsWith(".tsx") ? "tsx" : filename.endsWith(".jsx") ? "jsx" : filename.endsWith(".ts") ? "ts" : "js";
  const result = transformSync(filename, source, {
    lang,
    sourceType: "module",
    target: "es2022",
    sourcemap: false,
    typescript: {
      onlyRemoveTypeImports: true,
    },
  });

  const errors = result.errors.filter((error) => error.severity === "Error");
  if (errors.length > 0) {
    const message = errors.map((error) => error.codeframe || error.message).join("\n");
    throw new Error(message);
  }

  return {
    code: result.code,
    warnings: result.errors.map((error) => error.codeframe || error.message),
  };
}
