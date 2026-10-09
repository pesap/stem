import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(projectRoot, "src", "cli.ts");

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
  });
}

test("prints help and version without loading a config", () => {
  const help = runCli(["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: stem \[options\]/);
  assert.match(help.stdout, /--no-prompt/);

  const version = runCli(["--version"]);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), "0.1.0");
});

test("generates decision and sequential scripts without prompts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stem-cli-"));
  const systemPath = join(directory, "system.json");
  try {
    await writeFile(systemPath, JSON.stringify({ data: { components: [] } }));
    const decisionOutput = join(directory, "decision.jl");
    const decision = runCli([
      "-i",
      systemPath,
      "-o",
      decisionOutput,
      "--config",
      join(projectRoot, "examples", "decision_model.toml"),
      "--no-prompt",
      "--yes",
    ]);
    assert.equal(decision.status, 0, decision.stderr);
    assert.match(await readFile(decisionOutput, "utf8"), /OptimizationProblem/);

    const sequentialOutput = join(directory, "sequential.jl");
    const sequential = runCli([
      "-o",
      sequentialOutput,
      "--config",
      join(projectRoot, "examples", "sequential_simulation.toml"),
      "--no-prompt",
      "--yes",
    ]);
    assert.equal(sequential.status, 0, sequential.stderr);
    assert.match(
      await readFile(sequentialOutput, "utf8"),
      /SimulationSequence/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects JSON that is not a serialized Sienna system", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stem-invalid-system-"));
  const systemPath = join(directory, "unrelated.json");
  try {
    await writeFile(systemPath, JSON.stringify({ components: [] }));
    const result = runCli([
      "-i",
      systemPath,
      "-o",
      join(directory, "run.jl"),
      "--config",
      join(projectRoot, "examples", "decision_model.toml"),
      "--no-prompt",
      "--yes",
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not a Sienna system JSON/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("requires explicit confirmation for non-interactive writes and preserves existing output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stem-confirm-"));
  const output = join(directory, "run.jl");
  const systemPath = join(directory, "system.json");
  await writeFile(output, "keep this file\n");
  await writeFile(systemPath, JSON.stringify({ data: { components: [] } }));
  try {
    const unconfirmed = runCli([
      "-i",
      systemPath,
      "-o",
      output,
      "--config",
      join(projectRoot, "examples", "decision_model.toml"),
      "--no-prompt",
    ]);
    assert.equal(unconfirmed.status, 1);
    assert.match(unconfirmed.stderr, /already exists; pass --yes to overwrite/);
    assert.equal(await readFile(output, "utf8"), "keep this file\n");

    const confirmed = runCli([
      "-i",
      systemPath,
      "-o",
      output,
      "--config",
      join(projectRoot, "examples", "decision_model.toml"),
      "--no-prompt",
      "--yes",
    ]);
    assert.equal(confirmed.status, 0, confirmed.stderr);
    assert.match(await readFile(output, "utf8"), /OptimizationProblem/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
