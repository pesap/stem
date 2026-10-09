import assert from "node:assert/strict";
import test from "node:test";

import { defaultConfig, stringAt, valueAt } from "../src/config.js";
import {
  applyCliValues,
  parseCliArguments,
  deviceClassHint,
  deviceComponents,
  parseCliOptions,
  promptsNeeded,
} from "../src/cli-options.js";

test("handles help and version without adding a third-party parser", () => {
  assert.equal(parseCliArguments(["--help"]).help, true);
  assert.equal(parseCliArguments(["-v"]).version, true);
});

test("rejects unknown options and missing values", () => {
  assert.throws(() => parseCliOptions(["--unknown"]), /Unknown option/);
  assert.throws(() => parseCliOptions(["--input"]), /argument/);
});

test("parses short paths, repeated settings, and prompt controls", () => {
  const options = parseCliOptions([
    "-i",
    "system.json",
    "-o",
    "run.jl",
    "--config",
    "https://example.org/run.toml",
    "--device-model",
    "ThermalStandard=ThermalBasicUnitCommitment",
    "--network-option",
    "use_slacks = true",
    "--network-option",
    "use_reserves = false",
    "--no-prompt",
    "--yes",
  ]);

  assert.equal(options.input, "system.json");
  assert.equal(options.output, "run.jl");
  assert.equal(options.config, "https://example.org/run.toml");
  assert.deepEqual(options.deviceModel, [
    "ThermalStandard=ThermalBasicUnitCommitment",
  ]);
  assert.deepEqual(options.networkOption, [
    "use_slacks = true",
    "use_reserves = false",
  ]);
  assert.equal(options.noPrompt, true);
  assert.equal(options.yes, true);
});

test("applies explicit CLI values and records which prompts they replace", () => {
  const options = parseCliOptions([
    "--horizon",
    "P2D",
    "--resolution",
    "PT15M",
    "--solver",
    "Xpress",
    "--network-formulation",
    "PTDFPowerModel",
    "--device-model",
    "ThermalStandard=ThermalBasicUnitCommitment",
    "--solver-attribute",
    "MIPRELSTOP=0.05",
    "--device-attribute",
    "ThermalStandard.reservation=false",
    "--set",
    "scenario.initial_time=2024-01-01T00:00:00",
  ]);
  const config = defaultConfig("decision_model");

  const fixed = applyCliValues(options, config, "decision_model");

  assert.equal(stringAt(config, "timing.horizon"), "P2D");
  assert.equal(stringAt(config, "solver.selected"), "Xpress");
  assert.equal(
    stringAt(config, "formulations.network.formulation"),
    "PTDFPowerModel",
  );
  assert.equal(
    stringAt(config, "formulations.device_models.ThermalStandard"),
    "ThermalBasicUnitCommitment",
  );
  assert.equal(
    valueAt(config, "solver.backends.Xpress.attributes.MIPRELSTOP"),
    0.05,
  );
  assert.equal(
    valueAt(
      config,
      "formulations.device_options.ThermalStandard.ThermalBasicUnitCommitment.attributes.reservation",
    ),
    false,
  );
  assert.equal(
    stringAt(config, "scenario.initial_time"),
    "2024-01-01T00:00:00",
  );
  assert.equal(promptsNeeded(options, config, "decision_model", fixed), true);
});

test("rejects missing solver backends, wrong template flags, and malformed assignments", () => {
  const missingBackend = parseCliOptions(["--solver", "Gurobi"]);
  assert.throws(
    () =>
      applyCliValues(
        missingBackend,
        defaultConfig("decision_model"),
        "decision_model",
      ),
    /no configured package/,
  );

  const sequentialHorizon = parseCliOptions(["--horizon", "P2D"]);
  assert.throws(
    () =>
      applyCliValues(
        sequentialHorizon,
        defaultConfig("sequential_simulation"),
        "sequential_simulation",
      ),
    /use `--set stages\.N\.forecast_horizon/,
  );

  const sequentialNetwork = parseCliOptions([
    "--network-option",
    "use_slacks=true",
  ]);
  assert.throws(
    () =>
      applyCliValues(
        sequentialNetwork,
        defaultConfig("sequential_simulation"),
        "sequential_simulation",
      ),
    /use `--set` with a stage path/,
  );

  const malformed = parseCliOptions(["--device-model", "ThermalStandard"]);
  assert.throws(
    () =>
      applyCliValues(
        malformed,
        defaultConfig("decision_model"),
        "decision_model",
      ),
    /must have the form KEY=VALUE/,
  );
});

test("computes customizable device classes and prompt hints from config", () => {
  const config = defaultConfig("decision_model");
  assert.ok(deviceComponents(config).includes("EnergyReservoirStorage"));
  assert.match(
    deviceClassHint(config, "ThermalStandard"),
    /Current: ThermalStandardUnitCommitment/,
  );
  assert.match(
    deviceClassHint(config, "ThermalStandard"),
    /2 configured formulations/,
  );
});
