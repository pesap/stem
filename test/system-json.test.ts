import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";

import {
  systemJsonSuggestions,
  validateSiennaSystemJson,
} from "../src/system-json.js";

test("suggests directories and JSON files without listing other file types", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stem-system-paths-"));
  const inputs = join(directory, "inputs");
  const hidden = join(directory, ".hidden");
  try {
    await mkdir(inputs);
    await mkdir(hidden);
    await writeFile(join(directory, "system.json"), "{}");
    await writeFile(join(directory, "notes.txt"), "text");
    await writeFile(join(hidden, "inside.json"), "{}");
    await writeFile(join(inputs, "dispatch.JSON"), "{}");
    await writeFile(join(inputs, "notes.csv"), "text");

    assert.deepEqual(systemJsonSuggestions(`${directory}${sep}`), [
      `${inputs}${sep}`,
      join(directory, "system.json"),
    ]);
    assert.deepEqual(systemJsonSuggestions(join(inputs, "dis")), [
      join(inputs, "dispatch.JSON"),
    ]);
    assert.deepEqual(systemJsonSuggestions(`${inputs}${sep}`), [
      join(inputs, "dispatch.JSON"),
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("accepts a serialized Sienna system JSON file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stem-system-json-"));
  const path = join(directory, "system.json");
  try {
    await writeFile(path, JSON.stringify({ data: { components: [] } }));
    await assert.doesNotReject(validateSiennaSystemJson(path));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects missing files, wrong extensions, invalid JSON, and non-Sienna JSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stem-system-json-"));
  try {
    const wrongExtension = join(directory, "system.txt");
    const malformed = join(directory, "malformed.json");
    const unrelated = join(directory, "unrelated.json");
    await writeFile(
      wrongExtension,
      JSON.stringify({ data: { components: [] } }),
    );
    await writeFile(malformed, "{");
    await writeFile(unrelated, JSON.stringify({ components: [] }));

    await assert.rejects(
      validateSiennaSystemJson(join(directory, "missing.json")),
      /does not exist/,
    );
    await assert.rejects(validateSiennaSystemJson(wrongExtension), /\.json/);
    await assert.rejects(validateSiennaSystemJson(malformed), /valid JSON/);
    await assert.rejects(
      validateSiennaSystemJson(unrelated),
      /Sienna system JSON/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
