import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import nunjucks from "nunjucks";

import {
  type JsonObject,
  type JsonValue,
  setValue,
  stringAt,
  valueAt,
} from "./config.js";
import { formatIsoDuration } from "./duration.js";

export interface SolverBackend {
  name: string;
  package: string;
  optimizer: string;
  attributes: JsonObject;
}

const rootDirectory = resolve(fileURLToPath(new URL("..", import.meta.url)));
const templatesDirectory = join(rootDirectory, "templates");

export function solverBackend(context: JsonValue): SolverBackend {
  const name = stringAt(context, "solver.selected");
  if (!name) {
    throw new Error("config must select a solver in `solver.selected`");
  }

  const backendPath = `solver.backends.${name}`;
  const backend = valueAt(context, backendPath);
  const packageName = stringAt(context, `${backendPath}.package`);
  if (!packageName || packageName.trim().length === 0) {
    throw new Error(`solver '${name}' has no configured package`);
  }
  const optimizer = stringAt(context, `${backendPath}.optimizer`);
  if (!optimizer || optimizer.trim().length === 0) {
    throw new Error(`solver '${name}' has no configured Julia optimizer`);
  }

  const attributesValue =
    backend && typeof backend === "object" && !Array.isArray(backend)
      ? backend.attributes
      : undefined;
  const attributes =
    attributesValue === undefined
      ? {}
      : isJsonObject(attributesValue)
        ? attributesValue
        : (() => {
            throw new Error(`solver '${name}' attributes must be a table`);
          })();

  return { name, package: packageName, optimizer, attributes };
}

export function renderTemplate(
  templateId: string,
  configuration: JsonObject,
): string {
  const templateFile = `${templateId}.jl.j2`;
  const templatePath = join(templatesDirectory, templateFile);
  if (!existsSync(templatePath)) {
    throw new Error(`unknown template '${templateId}'`);
  }

  const context = structuredClone(configuration);
  solverBackend(context);
  normalizeTemplateDurations(templateId, context);

  const environment = new nunjucks.Environment(
    new nunjucks.FileSystemLoader(templatesDirectory, { noCache: true }),
    {
      autoescape: false,
      throwOnUndefined: true,
      noCache: true,
    },
  );
  environment.addFilter(
    "tojson",
    (value: unknown) => JSON.stringify(value) ?? "null",
  );

  try {
    return environment.render(templateFile, context);
  } catch (error) {
    throw new Error(
      `failed to generate Julia script from '${templateId}': ${errorMessage(error)}`,
      {
        cause: error,
      },
    );
  }
}

function normalizeTemplateDurations(
  templateId: string,
  context: JsonObject,
): void {
  let paths: string[];
  if (templateId === "decision_model") {
    paths = ["timing.horizon", "timing.resolution"];
  } else if (templateId === "sequential_simulation") {
    const stages = valueAt(context, "stages");
    if (!Array.isArray(stages)) {
      throw new Error("sequential config must contain a `stages` array");
    }
    paths = stages.flatMap((_, index) => [
      `stages.${index}.forecast_horizon`,
      `stages.${index}.forecast_interval`,
      `stages.${index}.resolution`,
    ]);
  } else {
    paths = [];
  }

  for (const path of paths) {
    const duration = stringAt(context, path);
    if (duration === undefined) {
      throw new Error(`'${path}' must be an ISO 8601 duration string`);
    }
    try {
      setValue(context, path, formatIsoDuration(duration));
    } catch (error) {
      throw new Error(
        `invalid ISO 8601 duration in '${path}': ${errorMessage(error)}`,
        {
          cause: error,
        },
      );
    }
  }
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
