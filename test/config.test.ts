import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  availableTemplates,
  defaultConfig,
  loadConfig,
  parseConfig,
  parseTomlValue,
  setValue,
  stringAt,
  valueAt,
  type JsonObject,
} from "../src/config.js";

test("loads TOML and JSON object configurations and rejects other roots or formats", () => {
  assert.deepEqual(parseConfig('[stem]\nname = "Example"', "settings.toml"), {
    stem: { name: "Example" },
  });
  assert.deepEqual(
    parseConfig('{"stem":{"name":"Example"}}', "settings.json"),
    {
      stem: { name: "Example" },
    },
  );
  assert.throws(
    () => parseConfig("[]", "settings.json"),
    /object or table at its root/,
  );
  assert.throws(
    () => parseConfig("not valid", "settings.yaml"),
    /must be a \.toml or \.json file/,
  );
});

test("loads local configuration files and only permits HTTPS remote sources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stem-config-"));
  const configPath = join(directory, "settings.json");
  try {
    await writeFile(configPath, '{"solver":{"selected":"HiGHS"}}');
    assert.deepEqual(await loadConfig(configPath), {
      solver: { selected: "HiGHS" },
    });
    await assert.rejects(
      loadConfig("http://example.org/settings.toml"),
      /remote configs must use HTTPS/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("parses CLI assignments as TOML scalars and falls back to strings", () => {
  assert.equal(parseTomlValue("false"), false);
  assert.equal(parseTomlValue("0.01"), 0.01);
  assert.deepEqual(parseTomlValue('["a", "b"]'), ["a", "b"]);
  assert.equal(parseTomlValue("2024-01-01T00:00:00"), "2024-01-01T00:00:00");
  assert.equal(
    parseTomlValue("custom Julia expression"),
    "custom Julia expression",
  );
});

test("sets dotted object and existing array paths with precise path errors", () => {
  const config: JsonObject = { stages: [{ horizon: "P1D" }] };
  setValue(config, "solver.backends.HiGHS.attributes.mip_rel_gap", 0.05);
  setValue(config, "stages.0.horizon", "P2D");

  assert.equal(
    valueAt(config, "solver.backends.HiGHS.attributes.mip_rel_gap"),
    0.05,
  );
  assert.equal(stringAt(config, "stages.0.horizon"), "P2D");
  assert.throws(() => setValue(config, "", true), /path must not be empty/);
  assert.throws(
    () => setValue(config, "stages.one.horizon", "P3D"),
    /must be an index/,
  );
  assert.throws(
    () => setValue(config, "stages.3.horizon", "P3D"),
    /out of range/,
  );
  assert.throws(
    () => setValue(config, "__proto__.polluted", true),
    /forbidden key/,
  );
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

test("discovers packaged templates and loads their complete defaults", () => {
  const templates = availableTemplates();
  assert.deepEqual(
    templates.map(({ id }) => id),
    ["decision_model", "sequential_simulation"],
  );
  assert.equal(templates[0]?.name, "DecisionModel");
  assert.equal(
    valueAt(defaultConfig("decision_model"), "solver.backends.Xpress.package"),
    "Xpress",
  );
  assert.throws(() => defaultConfig("missing"), /no default configuration/);
});
