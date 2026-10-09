import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import {
  type JsonObject,
  type JsonValue,
  parseTomlValue,
  setValue,
  stringAt,
  valueAt,
} from "./config.js";
import { solverBackend } from "./render.js";

export interface CliOptions {
  input?: string;
  output?: string;
  config?: string;
  template?: string;
  horizon?: string;
  resolution?: string;
  solver?: string;
  networkFormulation?: string;
  deviceModel: string[];
  serviceModel: string[];
  deviceAttribute: string[];
  networkOption: string[];
  solverAttribute: string[];
  set: string[];
  noPrompt: boolean;
  yes: boolean;
}

export interface CatalogEntry {
  value: string;
  description: string;
}

export interface CliArguments {
  options: CliOptions;
  help: boolean;
  version: boolean;
}

export function parseCliArguments(args: string[]): CliArguments {
  const parsed = parseArgs({
    args,
    allowPositionals: false,
    options: {
      input: { type: "string", short: "i" },
      output: { type: "string", short: "o" },
      config: { type: "string" },
      template: { type: "string" },
      horizon: { type: "string" },
      resolution: { type: "string" },
      solver: { type: "string" },
      "network-formulation": { type: "string" },
      "device-model": { type: "string", multiple: true },
      "service-model": { type: "string", multiple: true },
      "device-attribute": { type: "string", multiple: true },
      "network-option": { type: "string", multiple: true },
      "solver-attribute": { type: "string", multiple: true },
      set: { type: "string", multiple: true },
      "no-prompt": { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  const values = parsed.values;
  const options: CliOptions = {
    deviceModel: stringList(values["device-model"]),
    serviceModel: stringList(values["service-model"]),
    deviceAttribute: stringList(values["device-attribute"]),
    networkOption: stringList(values["network-option"]),
    solverAttribute: stringList(values["solver-attribute"]),
    set: stringList(values.set),
    noPrompt: values["no-prompt"] === true,
    yes: values.yes === true,
  };
  assignStringOption(options, "input", values.input);
  assignStringOption(options, "output", values.output);
  assignStringOption(options, "config", values.config);
  assignStringOption(options, "template", values.template);
  assignStringOption(options, "horizon", values.horizon);
  assignStringOption(options, "resolution", values.resolution);
  assignStringOption(options, "solver", values.solver);
  assignStringOption(
    options,
    "networkFormulation",
    values["network-formulation"],
  );

  return {
    options,
    help: values.help === true,
    version: values.version === true,
  };
}

export function parseCliOptions(args: string[]): CliOptions {
  return parseCliArguments(args).options;
}

export function formatCliHelp(): string {
  return `Usage: stem [options]

Create Sienna Julia simulation scripts.

Options:
  -i, --input <path>                       Serialized Sienna system JSON
  -o, --output <path>                      Output Julia script path
      --config <path-or-url>               Starting TOML/JSON config path or HTTPS URL
      --template <id>                      Template ID
      --horizon <duration>                 Single-step look-ahead horizon, for example P1D
      --resolution <duration>              Single-step resolution, for example PT15M
      --solver <name>                      Select a configured solver backend
      --network-formulation <name>         Select the single-step network formulation
      --device-model <class=formulation>    Set a device formulation. Repeat for multiple classes.
      --service-model <service=formulation> Set a service formulation. Repeat for multiple services.
      --device-attribute <class.attr=value> Set a device attribute
      --network-option <option>             Set a network option. Repeat for multiple options.
      --solver-attribute <name=value>       Set a backend-specific solver attribute.
      --set <path=value>                    Set any config value using a dotted path and TOML value.
      --no-prompt                           Disable prompts. Missing required values are errors.
  -y, --yes                                Accept the final write or overwrite confirmation.
  -h, --help                               Show this help message.
  -v, --version                            Show version number.

Examples:
  stem -i system.json -o run.jl
  stem -i system.json -o run.jl --config run.toml
  stem -i system.json -o run.jl --config https://example.org/run.toml --no-prompt --yes
  stem -i system.json -o run.jl --solver HiGHS --network-formulation PTDFPowerModel --no-prompt --yes
`;
}

export function cliVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as {
    version?: unknown;
  };
  if (typeof packageJson.version !== "string") {
    throw new Error("package.json is missing a string version");
  }
  return packageJson.version;
}

function stringList(value: string | string[] | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function assignStringOption<
  K extends
    | "input"
    | "output"
    | "config"
    | "template"
    | "horizon"
    | "resolution"
    | "solver"
    | "networkFormulation",
>(options: CliOptions, key: K, value: string | undefined): void {
  if (value !== undefined) {
    options[key] = value;
  }
}

export function applyCliValues(
  options: CliOptions,
  config: JsonObject,
  templateId: string,
): Set<string> {
  const fixed = new Set<string>();
  for (const setting of options.set) {
    const [path, source] = splitAssignment(setting, "--set");
    setValue(config, path, parseTomlValue(source));
    fixed.add(path);
  }

  for (const [value, path, flag] of [
    [options.horizon, "timing.horizon", "--horizon"],
    [options.resolution, "timing.resolution", "--resolution"],
  ] as const) {
    if (value === undefined) {
      continue;
    }
    if (templateId === "sequential_simulation") {
      const field = flag === "--horizon" ? "forecast_horizon" : "resolution";
      throw new Error(
        `use \`--set stages.N.${field}=VALUE\` for sequential templates`,
      );
    }
    setValue(config, path, value);
    fixed.add(path);
  }

  if (options.solver !== undefined) {
    setValue(config, "solver.selected", options.solver);
    fixed.add("solver.selected");
  }
  if (options.networkFormulation !== undefined) {
    if (templateId === "sequential_simulation") {
      throw new Error(
        "use `--set stages.N.network.formulation=VALUE` for sequential templates",
      );
    }
    const path = "formulations.network.formulation";
    setValue(config, path, options.networkFormulation);
    fixed.add(path);
  }

  for (const assignment of options.deviceModel) {
    const [component, formulation] = splitAssignment(
      assignment,
      "--device-model",
    );
    if (templateId === "sequential_simulation") {
      throw new Error(
        "use `--set stages.N.device_models.N.formulation=VALUE` for sequential templates",
      );
    }
    const path = `formulations.device_models.${component}`;
    setValue(config, path, formulation);
    fixed.add(path);
  }
  for (const assignment of options.serviceModel) {
    const [service, formulation] = splitAssignment(
      assignment,
      "--service-model",
    );
    if (templateId === "sequential_simulation") {
      throw new Error(
        "use `--set stages.N.service_models.N.formulation=VALUE` for sequential templates",
      );
    }
    const path = `formulations.service_models.${service}`;
    setValue(config, path, formulation);
    fixed.add(path);
  }

  if (
    templateId === "sequential_simulation" &&
    (options.deviceAttribute.length > 0 || options.networkOption.length > 0)
  ) {
    throw new Error(
      "use `--set` with a stage path for sequential device and network options",
    );
  }
  for (const assignment of options.deviceAttribute) {
    const [key, source] = splitAssignment(assignment, "--device-attribute");
    const separator = key.indexOf(".");
    if (separator < 0) {
      throw new Error(
        `'${key}' must have the form COMPONENT.ATTRIBUTE for --device-attribute`,
      );
    }
    const component = key.slice(0, separator);
    const attribute = key.slice(separator + 1);
    const modelPath = `formulations.device_models.${component}`;
    const formulation = stringAt(config, modelPath);
    if (formulation === undefined) {
      throw new Error(
        `no formulation configured for '${component}'; set one with --device-model first`,
      );
    }
    const path = `formulations.device_options.${component}.${formulation}.attributes.${attribute}`;
    setValue(config, path, parseTomlValue(source));
    fixed.add(path);
  }
  if (options.networkOption.length > 0) {
    setValue(config, "formulations.network.options", options.networkOption);
  }
  for (const assignment of options.solverAttribute) {
    const [name, source] = splitAssignment(assignment, "--solver-attribute");
    const solver = stringAt(config, "solver.selected");
    if (solver === undefined) {
      throw new Error("select a solver before setting `--solver-attribute`");
    }
    setValue(
      config,
      `solver.backends.${solver}.attributes.${name}`,
      parseTomlValue(source),
    );
  }

  if (fixed.has("solver.selected")) {
    solverBackend(config);
  }
  return fixed;
}

export function promptsNeeded(
  options: CliOptions,
  config: JsonObject,
  templateId: string,
  fixed: ReadonlySet<string>,
): boolean {
  if (
    (options.input === undefined && templateId === "decision_model") ||
    options.output === undefined
  ) {
    return true;
  }
  if (templateId === "decision_model") {
    const scalarPaths = [
      "scenario.name",
      "scenario.initial_time",
      "timing.horizon",
      "timing.resolution",
      "solver.selected",
      "formulations.network.formulation",
    ];
    return (
      scalarPaths.some((path) => !fixed.has(path)) ||
      deviceComponents(config).some(
        (component) => !fixed.has(`formulations.device_models.${component}`),
      ) ||
      hasUnfixedModels(config, "formulations.service_models", fixed) ||
      selectedDeviceOptionsNeedPrompts(config, fixed)
    );
  }

  return !fixed.has("solver.selected") || multiStageHasPrompts(config, fixed);
}

export function deviceComponents(config: JsonValue): string[] {
  const modelKeys = objectKeys(valueAt(config, "formulations.device_models"));
  const optionKeys = objectKeys(valueAt(config, "formulations.device_options"));
  return [...new Set([...modelKeys, ...optionKeys])].sort();
}

export function catalogEntries(
  config: JsonValue,
  path: string,
): CatalogEntry[] {
  const value = valueAt(config, path);
  if (!isJsonObject(value)) {
    return [];
  }
  return Object.entries(value).map(([name, metadata]) => ({
    value: name,
    description:
      typeof metadata === "string"
        ? metadata
        : isJsonObject(metadata) && typeof metadata.description === "string"
          ? metadata.description
          : "Configured option",
  }));
}

export function deviceClassHint(config: JsonValue, component: string): string {
  const current = stringAt(config, `formulations.device_models.${component}`);
  const count = catalogEntries(
    config,
    `formulations.device_options.${component}`,
  ).length;
  const formulationCount = `${count} configured formulation${count === 1 ? "" : "s"}`;
  if (current !== undefined && count === 0) {
    return `Current: ${current}`;
  }
  if (current !== undefined) {
    return `Current: ${current}; ${formulationCount}`;
  }
  if (count === 0) {
    return "No formulation configured; select to enter a custom one";
  }
  return formulationCount;
}

function selectedDeviceOptionsNeedPrompts(
  config: JsonObject,
  fixed: ReadonlySet<string>,
): boolean {
  return deviceComponents(config).some((component) => {
    const modelPath = `formulations.device_models.${component}`;
    if (!fixed.has(modelPath)) {
      return false;
    }
    const formulation = stringAt(config, modelPath);
    if (formulation === undefined) {
      return false;
    }
    const optionsPath = `formulations.device_options.${component}.${formulation}`;
    const slacksPath = `${optionsPath}.use_slacks`;
    if (
      typeof valueAt(config, slacksPath) === "boolean" &&
      !fixed.has(slacksPath)
    ) {
      return true;
    }
    const attributes = valueAt(config, `${optionsPath}.attributes`);
    return (
      isJsonObject(attributes) &&
      Object.keys(attributes).some(
        (name) => !fixed.has(`${optionsPath}.attributes.${name}`),
      )
    );
  });
}

function multiStageHasPrompts(
  config: JsonObject,
  fixed: ReadonlySet<string>,
): boolean {
  const stages = valueAt(config, "stages");
  if (!Array.isArray(stages)) {
    return true;
  }
  if (!fixed.has("simulation.initial_time")) {
    return true;
  }

  return stages.some((stage, stageIndex) => {
    const fields = [
      "system_path",
      "forecast_horizon",
      "forecast_interval",
      "resolution",
      "network.formulation",
    ];
    if (fields.some((field) => !fixed.has(`stages.${stageIndex}.${field}`))) {
      return true;
    }
    return ["device_models", "service_models"].some((field) => {
      const models = valueAt(stage, field);
      return (
        Array.isArray(models) &&
        models.some(
          (_, modelIndex) =>
            !fixed.has(
              `stages.${stageIndex}.${field}.${modelIndex}.formulation`,
            ),
        )
      );
    });
  });
}

function hasUnfixedModels(
  config: JsonObject,
  path: string,
  fixed: ReadonlySet<string>,
): boolean {
  const models = valueAt(config, path);
  return (
    isJsonObject(models) &&
    Object.keys(models).some((name) => !fixed.has(`${path}.${name}`))
  );
}

function objectKeys(value: JsonValue | undefined): string[] {
  return isJsonObject(value) ? Object.keys(value) : [];
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function splitAssignment(value: string, flag: string): [string, string] {
  const separator = value.indexOf("=");
  if (separator < 0) {
    throw new Error(`'${value}' must have the form KEY=VALUE for ${flag}`);
  }
  const key = value.slice(0, separator).trim();
  const assignmentValue = value.slice(separator + 1).trim();
  if (!key || !assignmentValue) {
    throw new Error(`'${value}' must have non-empty KEY and VALUE for ${flag}`);
  }
  return [key, assignmentValue];
}
