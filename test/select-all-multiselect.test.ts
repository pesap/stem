import assert from "node:assert/strict";
import test from "node:test";

import {
  renderSelectAllMenu,
  toggleAllValues,
} from "../src/select-all-multiselect.js";

const entries = [
  {
    value: "ThermalStandard",
    label: "ThermalStandard",
    hint: "1 configured formulation",
  },
  {
    value: "HydroDispatch",
    label: "HydroDispatch",
    hint: "Current formulation: HydroDispatchBasic",
  },
];

test("select-all toggles empty and partial selections on, then clears a full selection", () => {
  assert.deepEqual(
    [...toggleAllValues(new Set(), ["ThermalStandard", "HydroDispatch"])],
    ["ThermalStandard", "HydroDispatch"],
  );
  assert.deepEqual(
    [
      ...toggleAllValues(new Set(["ThermalStandard"]), [
        "ThermalStandard",
        "HydroDispatch",
      ]),
    ],
    ["ThermalStandard", "HydroDispatch"],
  );
  assert.deepEqual(
    [
      ...toggleAllValues(new Set(["ThermalStandard", "HydroDispatch"]), [
        "ThermalStandard",
        "HydroDispatch",
      ]),
    ],
    [],
  );
});

test("renders a separate select-all row, divider, options, and focused description", () => {
  const output = renderSelectAllMenu("Device classes to customize", {
    state: "active",
    search: "",
    focused: { type: "select-all" },
    visibleEntries: entries,
    selectedValues: new Set(["ThermalStandard"]),
    totalItems: 2,
  });

  const selectAll = output.indexOf("Select All (1/2)");
  const divider = output.indexOf("─");
  const firstEntry = output.indexOf("ThermalStandard");
  const description = output.indexOf("Select or clear all 2 options.");
  assert.ok(selectAll >= 0);
  assert.ok(selectAll < divider);
  assert.ok(divider < firstEntry);
  assert.ok(description > firstEntry);
});

test("shows the focused item's hint in the description panel", () => {
  const output = renderSelectAllMenu("Device classes to customize", {
    state: "active",
    search: "Hydro",
    focused: { type: "item", value: "HydroDispatch" },
    visibleEntries: [entries[1]!],
    selectedValues: new Set(),
    totalItems: 2,
  });

  assert.match(output, /Current formulation: HydroDispatchBasic/);
  assert.ok(
    output.indexOf("Description") <
      output.lastIndexOf("Current formulation: HydroDispatchBasic"),
  );
});
