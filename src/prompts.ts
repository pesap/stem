import { sep } from "node:path";

import * as p from "@clack/prompts";

import {
  type JsonObject,
  type JsonValue,
  parseTomlValue,
  setValue,
  stringAt,
  valueAt,
} from "./config.js";
import { normalizeIsoDateTime } from "./datetime.js";
import { selectWithDescription } from "./description-select.js";
import { selectAllMultiselect } from "./select-all-multiselect.js";
import {
  catalogEntries,
  deviceClassHint,
  deviceComponents,
} from "./cli-options.js";
import { validateIsoDuration } from "./duration.js";
import {
  systemJsonSuggestions,
  validateSiennaSystemJson,
} from "./system-json.js";

export class PromptCancelled extends Error {
  constructor() {
    super("prompt cancelled");
    this.name = "PromptCancelled";
  }
}

const LOOK_AHEAD_OPTIONS = [
  { value: "P1D", label: "P1D", hint: "1 day" },
  { value: "P2D", label: "P2D", hint: "2 days" },
  { value: "P3D", label: "P3D", hint: "3 days" },
  { value: "P7D", label: "P7D", hint: "1 week" },
];

const RESOLUTION_OPTIONS = [
  { value: "PT5M", label: "PT5M", hint: "5 minutes" },
  { value: "PT15M", label: "PT15M", hint: "15 minutes" },
  { value: "PT30M", label: "PT30M", hint: "30 minutes" },
  { value: "PT1H", label: "PT1H", hint: "1 hour" },
];

const CUSTOM = "__stem_custom__";

export async function promptDecisionModel(
  config: JsonObject,
  fixed: ReadonlySet<string>,
  includeSystemPath: boolean,
): Promise<void> {
  if (includeSystemPath) {
    await promptSystemPath(config, "system_path", "System JSON path");
  }
  await promptSimulationSettings(config, fixed);
  await promptDeviceFormulations(config, fixed);
  await promptFixedDeviceOptions(config, fixed);
  await promptModelGroup(
    config,
    "formulations.service_models",
    fixed,
    "Services to customize",
    "Service formulation",
  );
}

export async function promptSequentialSimulation(
  config: JsonObject,
  fixed: ReadonlySet<string>,
): Promise<void> {
  if (!fixed.has("simulation.initial_time")) {
    await promptStartDateTime(
      config,
      "simulation.initial_time",
      "Simulation start time",
      "2020-01-01T00:00:00",
    );
  }
  if (!fixed.has("solver.selected")) {
    await promptSolver(config);
  }

  const stages = valueAt(config, "stages");
  if (!Array.isArray(stages)) {
    throw new Error("sequential config must contain a `stages` array");
  }

  for (const [index, stage] of stages.entries()) {
    const stageName = stringAt(stage, "name") ?? "stage";
    const fields = [
      ["system_path", `System JSON for ${stageName}`],
      ["forecast_horizon", `Look-ahead horizon for ${stageName}`],
      ["forecast_interval", `Forecast interval for ${stageName}`],
      ["resolution", `Time resolution for ${stageName}`],
    ] as const;
    for (const [field, label] of fields) {
      const path = `stages.${index}.${field}`;
      if (fixed.has(path)) {
        continue;
      }
      if (field === "system_path") {
        await promptSystemPath(config, path, label);
      } else {
        const choices =
          field === "forecast_horizon"
            ? LOOK_AHEAD_OPTIONS
            : RESOLUTION_OPTIONS;
        const fallback = field === "forecast_horizon" ? "P1D" : "PT1H";
        await promptDuration(config, path, label, fallback, choices);
      }
    }

    await promptNetworkFormulation(
      config,
      `stages.${index}.network.formulation`,
      `stages.${index}.network.choices`,
      `Network formulation for ${stageName}`,
      fixed,
    );
    await promptStageModels(
      config,
      index,
      "device_models",
      "Device classes to customize",
      fixed,
    );
    await promptStageModels(
      config,
      index,
      "service_models",
      "Services to customize",
      fixed,
    );
  }
}

export async function promptOutputPath(defaultPath: string): Promise<string> {
  return promptText({
    message: "Output Julia script",
    initialValue: defaultPath,
  });
}

export function beginPromptSession(): void {
  p.intro(" stem ");
}

export function finishPromptSession(message: string): void {
  p.outro(message);
}

export function showConfigurationSummary(lines: string[]): void {
  p.note(lines.join("\n"), "Simulation configuration");
}

export async function confirmWrite(
  output: string,
  exists: boolean,
): Promise<boolean> {
  return promptResult(
    await p.confirm({
      message: exists ? `Overwrite ${output}?` : "Create this Julia script?",
      initialValue: exists,
    }),
  );
}

async function promptSimulationSettings(
  config: JsonObject,
  fixed: ReadonlySet<string>,
): Promise<void> {
  if (!fixed.has("scenario.name")) {
    const name = await promptText({
      message: "Scenario label",
      initialValue: "test-run",
    });
    setValue(config, "scenario.name", name);
  }
  if (!fixed.has("scenario.initial_time")) {
    await promptStartDateTime(
      config,
      "scenario.initial_time",
      "Scenario start time",
      "2020-01-01T00:00:00",
    );
  }
  if (!fixed.has("timing.horizon")) {
    await promptDuration(
      config,
      "timing.horizon",
      "Look-ahead horizon",
      "P1D",
      LOOK_AHEAD_OPTIONS,
    );
  }
  if (!fixed.has("timing.resolution")) {
    await promptDuration(
      config,
      "timing.resolution",
      "Time resolution",
      "PT1H",
      RESOLUTION_OPTIONS,
    );
  }
  if (!fixed.has("solver.selected")) {
    await promptSolver(config);
  }
  if (!fixed.has("formulations.network.formulation")) {
    await promptNetworkFormulation(
      config,
      "formulations.network.formulation",
      "formulations.network.choices",
      "Network formulation",
      fixed,
    );
  }
}

async function promptSolver(config: JsonObject): Promise<void> {
  await promptCatalogValue(
    config,
    "solver.selected",
    "solver.backends",
    "Solver",
  );
}

async function promptNetworkFormulation(
  config: JsonObject,
  valuePath: string,
  choicesPath: string,
  title: string,
  fixed: ReadonlySet<string>,
): Promise<void> {
  if (fixed.has(valuePath)) {
    return;
  }
  await promptCatalogValue(
    config,
    valuePath,
    choicesPath,
    title,
    `Custom formulation for ${title}`,
  );
}

async function promptCatalogValue(
  config: JsonObject,
  valuePath: string,
  choicesPath: string,
  title: string,
  customPrompt?: string,
): Promise<string> {
  const current = stringAt(config, valuePath);
  const choices = catalogEntries(config, choicesPath).map(
    ({ value, description }) => ({
      value,
      label: value,
      hint: description,
    }),
  );
  if (
    current !== undefined &&
    !choices.some((choice) => choice.value === current)
  ) {
    choices.push({
      value: current,
      label: current,
      hint: "Current configuration",
    });
  }
  if (customPrompt !== undefined) {
    choices.push({
      value: CUSTOM,
      label: "Custom formulation",
      hint: "Enter a Julia type name",
    });
  }
  if (choices.length === 0) {
    throw new Error(`no selectable values are configured at '${choicesPath}'`);
  }

  const selected = promptResult(
    await p.autocomplete({
      message: title,
      options: choices,
      ...(current === undefined ? {} : { initialValue: current }),
      placeholder: "Type to search...",
      maxItems: 10,
    }),
  );
  const value =
    selected === CUSTOM
      ? await promptText({
          message: customPrompt ?? `Custom value for ${title}`,
          ...(current === undefined ? {} : { initialValue: current }),
        })
      : selected;
  setValue(config, valuePath, value);
  return value;
}

async function promptDuration(
  config: JsonObject,
  path: string,
  title: string,
  fallback: string,
  common: readonly { value: string; label: string; hint: string }[],
): Promise<void> {
  const current = stringAt(config, path) ?? fallback;
  const choices = common.map((choice) => ({ ...choice }));
  if (!choices.some((choice) => choice.value === current)) {
    choices.push({
      value: current,
      label: `${current} (current)`,
      hint: "Current configured duration",
    });
  }
  choices.push({
    value: CUSTOM,
    label: "Custom",
    hint: "Enter a fixed ISO 8601 duration",
  });
  const selected = promptResult(
    await p.autocomplete({
      message: title,
      options: choices,
      initialValue: current,
      placeholder: "Type to search...",
      maxItems: 10,
    }),
  );
  const duration =
    selected === CUSTOM
      ? await promptText({
          message: `Custom ${title} (ISO 8601 duration)`,
          placeholder: "For example, P4D or PT45M",
          validate: (value) => {
            if (value === undefined) {
              return "enter an ISO 8601 duration";
            }
            try {
              validateIsoDuration(value);
              return undefined;
            } catch (error) {
              return errorMessage(error);
            }
          },
        })
      : selected;
  setValue(config, path, duration);
}

async function promptStartDateTime(
  config: JsonObject,
  path: string,
  label: string,
  fallback: string,
): Promise<void> {
  const configured = normalizeIsoDateTime(stringAt(config, path) ?? fallback);
  const choice = promptResult(
    await selectWithDescription({
      message: label,
      choices: [
        {
          value: "configured",
          label: `Use configured value (${configured})`,
          description:
            "The configured value is the default. STEM does not read timestamps from associated HDF5 data.",
        },
        {
          value: "custom",
          label: "Custom ISO 8601 date/time",
          description:
            "Enter a local date and time in YYYY-MM-DDTHH:MM[:SS] format.",
        },
      ],
      initialValue: "configured",
    }),
  );
  const value =
    choice === "configured"
      ? configured
      : normalizeIsoDateTime(
          await promptText({
            message: `${label} (YYYY-MM-DDTHH:MM[:SS], local time)`,
            initialValue: configured,
            placeholder: "2024-01-31T13:30:00",
            validate: (input) => {
              if (input === undefined) {
                return "enter a date and time in YYYY-MM-DDTHH:MM[:SS] format";
              }
              try {
                normalizeIsoDateTime(input);
                return undefined;
              } catch (error) {
                return errorMessage(error);
              }
            },
          }),
        );
  setValue(config, path, value);
}

async function promptDeviceFormulations(
  config: JsonObject,
  fixed: ReadonlySet<string>,
): Promise<void> {
  const components = deviceComponents(config).filter(
    (component) => !fixed.has(`formulations.device_models.${component}`),
  );
  const selected = await promptMultiSelection(
    "Device classes to customize",
    components.map((component) => ({
      value: component,
      label: component,
      hint: deviceClassHint(config, component),
    })),
  );

  for (const component of selected) {
    const modelPath = `formulations.device_models.${component}`;
    const optionsPath = `formulations.device_options.${component}`;
    const formulation = await promptCatalogValue(
      config,
      modelPath,
      optionsPath,
      `Formulation for ${component}`,
      `Custom formulation for ${component}`,
    );
    await promptDeviceOptions(
      config,
      `${optionsPath}.${formulation}`,
      component,
      fixed,
    );
  }
}

async function promptFixedDeviceOptions(
  config: JsonObject,
  fixed: ReadonlySet<string>,
): Promise<void> {
  for (const component of deviceComponents(config)) {
    const modelPath = `formulations.device_models.${component}`;
    if (!fixed.has(modelPath)) {
      continue;
    }
    const formulation = stringAt(config, modelPath);
    if (formulation !== undefined) {
      await promptDeviceOptions(
        config,
        `formulations.device_options.${component}.${formulation}`,
        component,
        fixed,
      );
    }
  }
}

async function promptDeviceOptions(
  config: JsonObject,
  optionsPath: string,
  component: string,
  fixed: ReadonlySet<string>,
): Promise<void> {
  const slacksPath = `${optionsPath}.use_slacks`;
  const useSlacks = valueAt(config, slacksPath);
  if (!fixed.has(slacksPath) && typeof useSlacks === "boolean") {
    const enabled = promptResult(
      await p.confirm({
        message: `Enable slacks for ${component}?`,
        initialValue: useSlacks,
      }),
    );
    setValue(config, slacksPath, enabled);
  }

  const attributesPath = `${optionsPath}.attributes`;
  const attributes = valueAt(config, attributesPath);
  if (!isJsonObject(attributes)) {
    return;
  }
  for (const [name, current] of Object.entries(attributes)) {
    const path = `${attributesPath}.${name}`;
    if (fixed.has(path)) {
      continue;
    }
    const label = `${component} attribute '${name}'`;
    const value =
      typeof current === "boolean"
        ? promptResult(
            await p.confirm({ message: label, initialValue: current }),
          )
        : parseTomlValue(
            await promptText({
              message: label,
              initialValue:
                typeof current === "string" ? current : JSON.stringify(current),
            }),
          );
    setValue(config, path, value);
  }
}

async function promptStageModels(
  config: JsonObject,
  stageIndex: number,
  field: "device_models" | "service_models",
  title: string,
  fixed: ReadonlySet<string>,
): Promise<void> {
  const path = `stages.${stageIndex}.${field}`;
  const models = valueAt(config, path);
  if (!Array.isArray(models)) {
    throw new Error("stage model settings must be arrays");
  }
  const entries = models.flatMap((model, index) => {
    if (!isJsonObject(model)) {
      return [];
    }
    const component = stringAt(model, "component");
    const formulation = stringAt(model, "formulation");
    if (
      component === undefined ||
      formulation === undefined ||
      fixed.has(`${path}.${index}.formulation`)
    ) {
      return [];
    }
    return [
      {
        value: String(index),
        label: component,
        hint: `Current formulation: ${formulation}`,
      },
    ];
  });
  const selected = await promptMultiSelection(title, entries);

  for (const selectedIndex of selected) {
    const index = Number(selectedIndex);
    const model = models[index];
    if (!isJsonObject(model)) {
      throw new Error(`selected model index ${selectedIndex} is out of range`);
    }
    const component = stringAt(model, "component");
    const current = stringAt(model, "formulation") ?? "";
    if (component === undefined) {
      throw new Error("stage model is missing its component");
    }
    const formulation = await promptText({
      message: `Formulation for ${component}`,
      initialValue: current,
    });
    const modelPath = `${path}.${index}`;
    setValue(config, `${modelPath}.formulation`, formulation);
    await promptDeviceOptions(config, modelPath, component, fixed);
  }
}

async function promptModelGroup(
  config: JsonObject,
  path: string,
  fixed: ReadonlySet<string>,
  selectionTitle: string,
  valueTitle: string,
): Promise<void> {
  const models = valueAt(config, path);
  if (!isJsonObject(models)) {
    return;
  }
  const entries = Object.entries(models).flatMap(([component, formulation]) => {
    if (typeof formulation !== "string" || fixed.has(`${path}.${component}`)) {
      return [];
    }
    return [
      {
        value: component,
        label: component,
        hint: `Current formulation: ${formulation}`,
      },
    ];
  });
  const selected = await promptMultiSelection(selectionTitle, entries);
  for (const component of selected) {
    const current = stringAt(config, `${path}.${component}`) ?? "";
    const formulation = await promptText({
      message: `${valueTitle} for ${component}`,
      initialValue: current,
    });
    setValue(config, `${path}.${component}`, formulation);
  }
}

async function promptMultiSelection(
  title: string,
  entries: Array<{ value: string; label: string; hint: string }>,
): Promise<string[]> {
  if (entries.length === 0) {
    return [];
  }

  const selection = promptResult(
    await p.select({
      message: title,
      options: [
        {
          value: "skip",
          label: "Skip customization",
          hint: "Leave all current formulations unchanged.",
        },
        {
          value: "customize",
          label: "Customize",
          hint: "Choose which entries to customize.",
        },
      ],
      initialValue: "skip",
    }),
  );
  if (selection === "skip") {
    return [];
  }

  return promptResult(await selectAllMultiselect(title, entries));
}

async function promptSystemPath(
  config: JsonObject,
  path: string,
  label: string,
): Promise<void> {
  let initialValue = stringAt(config, path) || process.cwd();
  let selectedPath: string;
  while (true) {
    selectedPath = promptResult(
      await p.autocomplete<string>({
        message: `${label} (directories and .json files only)`,
        options(this) {
          return systemJsonSuggestions(this.userInput).map((suggestion) => ({
            value: suggestion,
            label: suggestion,
            hint: suggestion.endsWith(sep) ? "Directory" : "Sienna system JSON",
          }));
        },
        initialUserInput: initialValue,
        completeOnTab: true,
        filter: () => true,
        maxItems: 10,
        validate: async (value) => {
          if (typeof value !== "string") {
            return "select a Sienna system .json file";
          }
          if (value.endsWith(sep)) {
            return undefined;
          }
          try {
            await validateSiennaSystemJson(value);
            return undefined;
          } catch (error) {
            return errorMessage(error);
          }
        },
      }),
    );
    if (!selectedPath.endsWith(sep)) {
      break;
    }
    initialValue = selectedPath;
  }
  setValue(config, path, selectedPath);
}

async function promptText(options: {
  message: string;
  initialValue?: string;
  placeholder?: string;
  validate?: (value: string | undefined) => string | undefined;
}): Promise<string> {
  return promptResult(await p.text(options));
}

function promptResult<T>(result: T | typeof p.CANCEL_SYMBOL): T {
  if (result === p.CANCEL_SYMBOL) {
    throw new PromptCancelled();
  }
  return result;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
