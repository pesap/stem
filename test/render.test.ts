import assert from "node:assert/strict";
import test from "node:test";

import { defaultConfig, setValue } from "../src/config.js";
import { formatIsoDuration } from "../src/duration.js";
import { renderTemplate, solverBackend } from "../src/render.js";

test("renders decision-model configuration, backend attributes, and Julia periods", () => {
  const config = defaultConfig("decision_model");
  setValue(config, "system_path", "/data/system.json");
  setValue(config, "timing.horizon", "P1D");
  setValue(config, "timing.resolution", "PT15M");

  const rendered = renderTemplate("decision_model", config);

  assert.match(rendered, /const SYSTEM_PATH = "\/data\/system\.json"/);
  assert.match(rendered, /HiGHS\.Optimizer/);
  assert.match(rendered, /ThermalStandardUnitCommitment/);
  assert.match(rendered, /CopperPlatePowerModel/);
  assert.match(rendered, /horizon = Day\(1\)/);
  assert.match(rendered, /resolution = Minute\(15\)/);
  assert.match(rendered, /"mip_rel_gap" => 0\.5/);
});

test("uses the selected solver backend instead of attributes from another solver", () => {
  const config = defaultConfig("decision_model");
  setValue(config, "solver.selected", "Xpress");

  const rendered = renderTemplate("decision_model", config);

  assert.match(rendered, /using Xpress/);
  assert.match(rendered, /Xpress\.Optimizer/);
  assert.match(rendered, /"MIPRELSTOP" => 0\.5/);
  assert.doesNotMatch(rendered, /mip_rel_gap/);
  assert.deepEqual(solverBackend(config), {
    name: "Xpress",
    package: "Xpress",
    optimizer: "Xpress.Optimizer",
    attributes: { MIPRELSTOP: 0.5 },
  });
});

test("keeps sequential build, execution, and report generation", () => {
  const rendered = renderTemplate(
    "sequential_simulation",
    defaultConfig("sequential_simulation"),
  );

  assert.match(
    rendered,
    /transform_single_time_series!\(system_1, Day\(2\), Day\(1\)\)/,
  );
  assert.match(
    rendered,
    /transform_single_time_series!\(system_2, Hour\(1\), Minute\(15\)\)/,
  );
  assert.match(rendered, /NetworkModel\(PTDFPowerModel; use_slacks = true\)/);
  assert.match(rendered, /build!\(simulation\)/);
  assert.match(rendered, /execute!\(simulation/);
  assert.match(
    rendered,
    /write_report\(REPORT_PATH, SimulationResults\(simulation\)\)/,
  );
});

test("rejects incomplete solver configuration and malformed periods", () => {
  assert.throws(
    () => solverBackend({ solver: { selected: "Missing", backends: {} } }),
    /no configured package/,
  );
  assert.throws(
    () =>
      solverBackend({
        solver: {
          selected: "BlankPackage",
          backends: {
            BlankPackage: {
              package: "  ",
              optimizer: "BlankPackage.Optimizer",
            },
          },
        },
      }),
    /no configured package/,
  );
  assert.throws(
    () =>
      solverBackend({
        solver: {
          selected: "BlankOptimizer",
          backends: {
            BlankOptimizer: { package: "BlankOptimizer", optimizer: "  " },
          },
        },
      }),
    /no configured Julia optimizer/,
  );
  assert.throws(
    () => renderTemplate("decision_model", { solver: {} }),
    /select a solver/,
  );
  assert.throws(() => formatIsoDuration("Hour(1)"), /begin with `P`/);
});
