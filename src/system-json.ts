import { readdirSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";

export function systemJsonSuggestions(query: string): string[] {
  const typedPath = query || process.cwd();
  const isTypedPathDirectory = isDirectory(typedPath);
  const directory = isTypedPathDirectory ? typedPath : dirname(typedPath);
  const partial = isTypedPathDirectory ? "" : basename(typedPath);

  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }

  const prefix = partial.toLowerCase();
  return entries
    .flatMap((name) => {
      if (!name.toLowerCase().startsWith(prefix)) {
        return [];
      }

      const path = join(directory, name);
      try {
        const entry = statSync(path);
        if (entry.isDirectory()) {
          return name.startsWith(".") ? [] : [`${path}${sep}`];
        }
        if (entry.isFile() && extname(name).toLowerCase() === ".json") {
          return [path];
        }
      } catch {
        return [];
      }
      return [];
    })
    .sort()
    .slice(0, 10);
}

export async function validateSiennaSystemJson(path: string): Promise<void> {
  if (extname(path).toLowerCase() !== ".json") {
    throw new Error(`system input '${path}' must have a .json extension`);
  }

  let fileStat;
  try {
    fileStat = await stat(path);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      throw new Error(`system input '${path}' does not exist`, {
        cause: error,
      });
    }
    throw new Error(`cannot access system input '${path}'`, { cause: error });
  }
  if (!fileStat.isFile()) {
    throw new Error(`system input '${path}' is not a file`);
  }

  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`cannot read system input '${path}'`, { cause: error });
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`system input '${path}' must contain valid JSON`, {
      cause: error,
    });
  }

  if (
    !isRecord(value) ||
    !isRecord(value.data) ||
    !Array.isArray(value.data.components)
  ) {
    throw new Error(
      `system input '${path}' is not a Sienna system JSON (expected a data.components array)`,
    );
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(resolve(path)).isDirectory();
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
