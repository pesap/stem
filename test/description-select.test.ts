import assert from "node:assert/strict";
import test from "node:test";

import { renderDescriptionSelect } from "../src/description-select.js";

const choices = [
  {
    value: "configured",
    label: "Use configured value (2020-01-01T00:00:00)",
    description:
      "The configured value is the default. STEM does not read timestamps from associated HDF5 data.",
  },
  {
    value: "custom",
    label: "Custom ISO 8601 date/time",
    description: "Enter a local date and time in YYYY-MM-DDTHH:MM[:SS] format.",
  },
] as const;

test("renders the focused choice description below the options", () => {
  const output = renderDescriptionSelect(
    {
      cursor: 0,
      state: "active",
      value: "configured",
      options: choices,
    },
    "Scenario start time",
  );

  assert.ok(
    output.indexOf("Custom ISO 8601 date/time") < output.indexOf("Description"),
  );
  assert.ok(
    output.indexOf("Description") <
      output.indexOf("The configured value is the default."),
  );
});

test("updates the description as the focused choice changes", () => {
  const output = renderDescriptionSelect(
    {
      cursor: 1,
      state: "active",
      value: "configured",
      options: choices,
    },
    "Scenario start time",
  );

  assert.match(output, /Enter a local date and time/);
  assert.doesNotMatch(output, /does not read timestamps/);
});
