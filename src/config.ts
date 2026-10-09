import { readdirSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml, TomlDate } from "smol-toml";

export type JsonValue =
  string | number | boolean | null | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export interface TemplateInfo {
  id: string;
  name: string;
}

const rootDirectory = resolve(fileURLToPath(new URL("..", import.meta.url)));
const templatesDirectory = join(rootDirectory, "templates");
const examplesDirectory = join(rootDirectory, "examples");

export function availableTemplates(): TemplateInfo[] {
  const templates = readdirSync(templatesDirectory)
    .filter((fileName) => fileName.endsWith(".jl.j2"))
    .map((fileName) => {
      const id = fileName.slice(0, -".jl.j2".length);
      const config = defaultConfig(id);
      return {
        id,
        name: stringAt(config, "stem.name") ?? id,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  if (templates.length === 0) {
    throw new Error("no templates found in the packaged template directory");
  }
  return templates;
}

export function defaultConfig(templateId: string): JsonObject {
  const fileName = `${templateId}.toml`;
  const configPath = join(examplesDirectory, fileName);
  let contents: string;
  try {
    contents = readFileSync(configPath, "utf8");
  } catch (error) {
    throw new Error(
      `no default configuration exists for template '${templateId}'`,
      { cause: error },
    );
  }
  return parseConfig(contents, fileName);
}

export async function loadConfig(source: string): Promise<JsonObject> {
  if (source.startsWith("http://")) {
    throw new Error("remote configs must use HTTPS");
  }

  if (source.startsWith("https://")) {
    let response: Response;
    try {
      response = await fetch(source);
    } catch (error) {
      throw new Error(
        `failed to download config from '${source}': ${errorMessage(error)}`,
        {
          cause: error,
        },
      );
    }
    if (!response.ok) {
      throw new Error(
        `failed to download config from '${source}': HTTP ${response.status}`,
      );
    }
    if (new URL(response.url).protocol !== "https:") {
      throw new Error("remote configs must remain on HTTPS after redirects");
    }

    let contents: string;
    try {
      contents = await response.text();
    } catch (error) {
      throw new Error(
        `failed to read config from '${source}': ${errorMessage(error)}`,
        {
          cause: error,
        },
      );
    }
    const sourcePath = new URL(source).pathname;
    return parseConfig(contents, source, extname(sourcePath));
  }

  const configPath = resolve(source);
  let contents: string;
  try {
    contents = readFileSync(configPath, "utf8");
  } catch (error) {
    throw new Error(
      `failed to read config '${configPath}': ${errorMessage(error)}`,
      { cause: error },
    );
  }
  return parseConfig(contents, configPath);
}

export function parseConfig(
  contents: string,
  source: string,
  format = inferFormat(source),
): JsonObject {
  let value: unknown;
  try {
    value =
      format.toLowerCase() === "json"
        ? JSON.parse(contents)
        : format.toLowerCase() === "toml"
          ? normalizeTomlValue(
              parseToml(contents, { integersAsBigInt: "asNeeded" }),
            )
          : undefined;
  } catch (error) {
    const formatName = format.toLowerCase();
    if (formatName !== "json" && formatName !== "toml") {
      throw new Error(`config '${source}' must be a .toml or .json file`);
    }
    throw new Error(
      `failed to parse ${formatName.toUpperCase()} config '${source}': ${errorMessage(error)}`,
      {
        cause: error,
      },
    );
  }

  if (format.toLowerCase() !== "json" && format.toLowerCase() !== "toml") {
    throw new Error(`config '${source}' must be a .toml or .json file`);
  }
  if (!isJsonObject(value)) {
    throw new Error(
      `config '${source}' must have an object or table at its root`,
    );
  }
  return value;
}

export function parseTomlValue(source: string): JsonValue {
  try {
    const parsed = parseToml(`value = ${source}`, {
      integersAsBigInt: "asNeeded",
    });
    return normalizeTomlValue(parsed.value);
  } catch {
    return source;
  }
}

export function setValue(
  context: JsonObject,
  path: string,
  value: JsonValue,
): void {
  const parts = path.split(".");
  if (parts.length === 0 || parts.some((part) => part.length === 0)) {
    throw new Error("config path must not be empty");
  }
  if (
    parts.some(
      (part) =>
        part === "__proto__" || part === "prototype" || part === "constructor",
    )
  ) {
    throw new Error(`config path '${path}' contains a forbidden key`);
  }
  setNested(context, parts, value, path);
}

export function valueAt(
  context: JsonValue,
  path: string,
): JsonValue | undefined {
  let value: JsonValue | undefined = context;
  for (const part of path.split(".")) {
    if (Array.isArray(value)) {
      const index = parseArrayIndex(part);
      value = index === undefined ? undefined : value[index];
    } else if (isJsonObject(value)) {
      value = Object.hasOwn(value, part) ? value[part] : undefined;
    } else {
      return undefined;
    }
  }
  return value;
}

export function stringAt(context: JsonValue, path: string): string | undefined {
  const value = valueAt(context, path);
  return typeof value === "string" ? value : undefined;
}

function setNested(
  context: JsonValue,
  parts: string[],
  value: JsonValue,
  path: string,
): void {
  const [part, ...rest] = parts;
  if (part === undefined) {
    throw new Error("config path must not be empty");
  }

  if (Array.isArray(context)) {
    const index = parseArrayIndex(part);
    if (index === undefined) {
      throw new Error(
        `array path segment '${part}' in '${path}' must be an index`,
      );
    }
    if (index >= context.length) {
      throw new Error(`array index ${index} is out of range in '${path}'`);
    }
    if (rest.length === 0) {
      context[index] = value;
      return;
    }
    const child = context[index];
    if (child === undefined) {
      throw new Error(`array index ${index} is out of range in '${path}'`);
    }
    setNested(child, rest, value, path);
    return;
  }

  if (!isJsonObject(context)) {
    throw new Error(
      `config path '${path}' does not point through a table or array`,
    );
  }
  if (rest.length === 0) {
    context[part] = value;
    return;
  }

  if (!Object.hasOwn(context, part)) {
    context[part] = /^\d+$/.test(rest[0] ?? "") ? [] : {};
  }
  const child = context[part];
  if (child === undefined) {
    throw new Error(
      `config path '${path}' does not point through a table or array`,
    );
  }
  setNested(child, rest, value, path);
}

function parseArrayIndex(part: string): number | undefined {
  if (!/^\d+$/.test(part)) {
    return undefined;
  }
  const index = Number(part);
  return Number.isSafeInteger(index) ? index : undefined;
}

function inferFormat(source: string): string {
  const sourcePath = source.startsWith("https://")
    ? new URL(source).pathname
    : source;
  return extname(sourcePath).slice(1);
}

function normalizeTomlValue(value: unknown): JsonValue {
  if (value instanceof TomlDate) {
    return value.toISOString().replace(/\.000(?=Z|$)/, "");
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "bigint") {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) {
      throw new Error(
        "TOML integer is too large to represent as a JSON number",
      );
    }
    return number;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("TOML numbers must be finite JSON numbers");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeTomlValue);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        normalizeTomlValue(child),
      ]),
    );
  }
  throw new Error(`unsupported TOML value '${String(value)}'`);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
