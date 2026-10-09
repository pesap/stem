#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import * as p from "@clack/prompts";

import {
  availableTemplates,
  defaultConfig,
  loadConfig,
  setValue,
  stringAt,
} from "./config.js";
import {
  applyCliValues,
  cliVersion,
  formatCliHelp,
  parseCliArguments,
  promptsNeeded,
} from "./cli-options.js";
import { renderTemplate, solverBackend } from "./render.js";
import { validateSiennaSystemJson } from "./system-json.js";
import {
  PromptCancelled,
  beginPromptSession,
  confirmWrite,
  finishPromptSession,
  promptDecisionModel,
  promptOutputPath,
  promptSequentialSimulation,
  showConfigurationSummary,
} from "./prompts.js";

async function main(): Promise<void> {
  try {
    const request = parseCliArguments(process.argv.slice(2));
    if (request.help) {
      console.log(formatCliHelp());
      return;
    }
    if (request.version) {
      console.log(cliVersion());
      return;
    }

    await run(request.options);
  } catch (error) {
    if (error instanceof PromptCancelled) {
      p.cancel("Cancelled. No script was written.");
      return;
    }
    console.error(`Error: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}

async function run(
  cli: ReturnType<typeof parseCliArguments>["options"],
): Promise<void> {
  const templates = availableTemplates();
  let config =
    cli.config === undefined ? undefined : await loadConfig(cli.config);
  const configuredTemplate =
    config === undefined
      ? undefined
      : stringAt(config, "stem.template")?.replaceAll("-", "_");
  const explicitTemplate = cli.template?.replaceAll("-", "_");

  if (
    configuredTemplate !== undefined &&
    explicitTemplate !== undefined &&
    configuredTemplate !== explicitTemplate
  ) {
    throw new Error(
      `config selects template '${configuredTemplate}', but --template selects '${explicitTemplate}'; use a matching config`,
    );
  }

  const templateId = explicitTemplate ?? configuredTemplate ?? "decision_model";
  if (!templates.some((template) => template.id === templateId)) {
    const available = templates.map((template) => template.id).join(", ");
    throw new Error(
      `unknown template '${templateId}'. Available templates: ${available}`,
    );
  }
  const activeConfig = config ?? defaultConfig(templateId);

  const fixed = applyCliValues(cli, activeConfig, templateId);
  if (cli.input !== undefined) {
    if (templateId === "sequential_simulation") {
      throw new Error(
        "sequential simulations take a system path per stage in the config; omit -i",
      );
    }
    await validateSiennaSystemJson(cli.input);
    setValue(activeConfig, "system_path", cli.input);
    fixed.add("system_path");
  }

  const interactive =
    !cli.noPrompt && promptsNeeded(cli, activeConfig, templateId, fixed);
  if (interactive && !process.stdin.isTTY) {
    throw new Error(
      "interactive choices need a terminal; provide the options or use --no-prompt",
    );
  }
  if (interactive) {
    beginPromptSession();
    if (templateId === "decision_model") {
      await promptDecisionModel(activeConfig, fixed, cli.input === undefined);
    } else {
      await promptSequentialSimulation(activeConfig, fixed);
    }
  }

  const output =
    cli.output ??
    (interactive
      ? await promptOutputPath(`generated/${templateId}.jl`)
      : `generated/${templateId}.jl`);
  const systemPath =
    templateId === "decision_model"
      ? stringAt(activeConfig, "system_path")?.trim()
      : "Configured per stage";
  if (templateId === "decision_model" && !systemPath) {
    throw new Error(
      "missing system path; pass -i <system.json> or set system_path in the config",
    );
  }
  if (
    templateId === "decision_model" &&
    !interactive &&
    cli.input === undefined &&
    systemPath !== undefined
  ) {
    await validateSiennaSystemJson(systemPath);
  }

  const generated = renderTemplate(templateId, activeConfig);
  const templateName =
    templates.find((template) => template.id === templateId)?.name ??
    templateId;
  const summary = [
    `Template: ${templateName}`,
    `System: ${systemPath}`,
    `Output: ${output}`,
  ];
  for (const [label, path] of [
    ["Scenario", "scenario.name"],
    ["Scenario start", "scenario.initial_time"],
    ["Simulation start", "simulation.initial_time"],
    ["Horizon", "timing.horizon"],
    ["Resolution", "timing.resolution"],
    ["Network", "formulations.network.formulation"],
  ] as const) {
    const value = stringAt(activeConfig, path);
    if (value !== undefined) {
      summary.push(`${label}: ${value}`);
    }
  }
  const selectedSolver = stringAt(activeConfig, "solver.selected");
  if (selectedSolver !== undefined) {
    const backend = solverBackend(activeConfig);
    summary.push(
      `Solver: ${selectedSolver} (${backend.package}, ${backend.optimizer})`,
    );
  }
  if (interactive) {
    showConfigurationSummary(summary);
  } else {
    console.error(summary.join("\n"));
  }

  await writeAfterConfirmation(
    output,
    generated,
    cli.yes,
    cli.noPrompt,
    interactive,
  );
}

async function writeAfterConfirmation(
  output: string,
  generated: string,
  yes: boolean,
  noPrompt: boolean,
  interactive: boolean,
): Promise<void> {
  const exists = existsSync(output);
  if (!yes) {
    if (noPrompt) {
      if (exists) {
        throw new Error(
          `output '${output}' already exists; pass --yes to overwrite it`,
        );
      }
      throw new Error("--no-prompt requires --yes to write the script");
    }
    if (!process.stdin.isTTY) {
      throw new Error(
        "use --yes to confirm script generation in a non-interactive terminal",
      );
    }
    if (!(await confirmWrite(output, exists))) {
      p.cancel("No script was written.");
      return;
    }
  }

  const parent = dirname(resolve(output));
  await mkdir(parent, { recursive: true });
  await writeFile(output, generated, "utf8");
  if (interactive) {
    finishPromptSession(`Created ${output}`);
  } else {
    console.error(`Created ${output}`);
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause;
    if (cause instanceof Error && cause.message !== error.message) {
      return `${error.message}: ${cause.message}`;
    }
    return error.message;
  }
  return String(error);
}

await main();
