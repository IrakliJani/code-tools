import { asSchema } from "@ai-sdk/provider-utils";
import type { AnyToolSet, JsonSchema, ToolMetadata } from "./types.js";

const reserved = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "as",
  "implements",
  "interface",
  "let",
  "package",
  "private",
  "protected",
  "public",
  "static",
  "yield",
  "any",
  "boolean",
  "constructor",
  "declare",
  "get",
  "module",
  "require",
  "number",
  "set",
  "string",
  "symbol",
  "type",
  "from",
  "of",
]);

export function toIdentifier(name: string, used = new Set<string>()): string {
  const raw = name
    .replace(/^[^A-Za-z_$]+/, "")
    .replace(/[^A-Za-z0-9_$]+(.)?/g, (_match, next: string | undefined) => (next ? next.toUpperCase() : ""));
  const base = raw && /^[A-Za-z_$]/.test(raw) ? raw : "tool";
  const safeBase = reserved.has(base) ? `${base}Tool` : base;

  let candidate = safeBase;
  let i = 2;
  while (used.has(candidate)) candidate = `${safeBase}${i++}`;
  used.add(candidate);
  return candidate;
}

export function toPascalIdentifier(name: string, suffix: string, used = new Set<string>()): string {
  const id = toIdentifier(name, new Set());
  const pascal = `${id.charAt(0).toUpperCase()}${id.slice(1)}${suffix}`;
  return toIdentifier(pascal, used);
}

export async function resolveJsonSchema(schema: unknown | undefined): Promise<JsonSchema> {
  if (!schema) return {};
  const normalized = asSchema(schema as any) as any;
  const raw = typeof normalized.jsonSchema === "function" ? normalized.jsonSchema() : normalized.jsonSchema;
  const json = await raw;
  return (json ?? {}) as JsonSchema;
}

export async function collectToolMetadata(tools: AnyToolSet): Promise<ToolMetadata[]> {
  const identifiers = new Set<string>();
  const typeNames = new Set<string>();

  const metadata: ToolMetadata[] = [];
  for (const [originalName, sourceTool] of Object.entries(tools)) {
    const identifier = toIdentifier(originalName, identifiers);
    metadata.push({
      originalName,
      identifier,
      inputTypeName: toPascalIdentifier(identifier, "Input", typeNames),
      outputTypeName: toPascalIdentifier(identifier, "Output", typeNames),
      description: sourceTool.description,
      inputJsonSchema: await resolveJsonSchema(sourceTool.inputSchema),
      outputJsonSchema: sourceTool.outputSchema ? await resolveJsonSchema(sourceTool.outputSchema) : undefined,
    });
  }
  return metadata;
}

export function jsonSchemaToType(schema: JsonSchema | boolean | undefined, root: JsonSchema = (schema ?? {}) as JsonSchema): string {
  if (schema === true) return "unknown";
  if (schema === false) return "never";
  if (!schema || typeof schema !== "object") return "unknown";

  if (typeof schema.$ref === "string") {
    const resolved = resolveRef(root, schema.$ref);
    if (resolved && resolved !== schema) return jsonSchemaToType(resolved, root);
    return "unknown";
  }

  if ("const" in schema) return literal(schema.const);
  if (Array.isArray(schema.enum)) return schema.enum.map(literal).join(" | ") || "never";

  if (Array.isArray(schema.oneOf)) return union(schema.oneOf.map((part) => jsonSchemaToType(part, root)));
  if (Array.isArray(schema.anyOf)) return union(schema.anyOf.map((part) => jsonSchemaToType(part, root)));
  if (Array.isArray(schema.allOf)) return intersection(schema.allOf.map((part) => jsonSchemaToType(part, root)));

  const type = schema.type;
  if (Array.isArray(type)) return union(type.map((single) => jsonSchemaToType({ ...schema, type: single }, root)));

  if (type === "null") return "null";
  if (type === "boolean") return "boolean";
  if (type === "integer" || type === "number") return "number";
  if (type === "string") return "string";
  if (type === "array" || schema.items) return arrayType(schema, root);
  if (type === "object" || schema.properties || schema.additionalProperties) return objectType(schema, root);

  return "unknown";
}

function arrayType(schema: JsonSchema, root: JsonSchema): string {
  const items = schema.items;
  if (Array.isArray(items)) return `[${items.map((item) => jsonSchemaToType(item, root)).join(", ")}]`;
  return `Array<${jsonSchemaToType(items ?? {}, root)}>`;
}

function objectType(schema: JsonSchema, root: JsonSchema): string {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  const lines: string[] = [];

  for (const [key, value] of Object.entries(properties)) {
    const propSchema = isRecord(value) ? value : {};
    const comment = typeof propSchema.description === "string" ? jsDoc(propSchema.description, "  ") : "";
    if (comment) lines.push(comment);
    lines.push(`  ${propertyKey(key)}${required.has(key) ? "" : "?"}: ${jsonSchemaToType(propSchema, root)};`);
  }

  if (schema.additionalProperties && schema.additionalProperties !== false) {
    const valueType = schema.additionalProperties === true ? "unknown" : jsonSchemaToType(schema.additionalProperties, root);
    lines.push(`  [key: string]: ${valueType};`);
  }

  if (lines.length === 0) {
    if (schema.additionalProperties === false) return "Record<string, never>";
    return "Record<string, unknown>";
  }

  return `{
${lines.join("\n")}
}`;
}

function propertyKey(key: string): string {
  return /^[$A-Z_a-z][$\w]*$/.test(key) && !reserved.has(key) ? key : JSON.stringify(key);
}

function literal(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "unknown";
}

function union(values: string[]): string {
  const filtered = [...new Set(values)].filter(Boolean);
  if (filtered.length === 0) return "never";
  if (filtered.length === 1) return filtered[0] ?? "never";
  return filtered.map(parenthesizeIfNeeded).join(" | ");
}

function intersection(values: string[]): string {
  const filtered = [...new Set(values)].filter(Boolean);
  if (filtered.length === 0) return "unknown";
  if (filtered.length === 1) return filtered[0] ?? "unknown";
  return filtered.map(parenthesizeIfNeeded).join(" & ");
}

function parenthesizeIfNeeded(value: string): string {
  return value.includes("\n") ? `(${value})` : value;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveRef(root: JsonSchema, ref: string): JsonSchema | undefined {
  if (!ref.startsWith("#/")) return undefined;
  const parts = ref
    .slice(2)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: any = root;
  for (const part of parts) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return isRecord(current) ? current : undefined;
}

export function jsDoc(text: string, indent = ""): string {
  const clean = text.replace(/\*\//g, "*\\/").trim();
  if (!clean) return "";
  const lines = clean.split(/\r?\n/);
  if (lines.length === 1) return `${indent}/** ${lines[0]} */`;
  return [`${indent}/**`, ...lines.map((line) => `${indent} * ${line}`), `${indent} */`].join("\n");
}
