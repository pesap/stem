import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("routes @gpac packages to the internal npm registry", async () => {
  const [rawManifest, rawLockfile, npmrc] = await Promise.all([
    readFile(join(projectRoot, "package.json"), "utf8"),
    readFile(join(projectRoot, "package-lock.json"), "utf8"),
    readFile(join(projectRoot, ".npmrc"), "utf8"),
  ]);
  const manifest = JSON.parse(rawManifest) as {
    name: string;
    publishConfig: { registry: string };
  };

  const lockfile = JSON.parse(rawLockfile) as {
    name: string;
    packages: Record<string, { name?: string }>;
  };

  assert.equal(manifest.name, "@gpac/stem");
  assert.equal(lockfile.name, manifest.name);
  assert.equal(lockfile.packages[""]?.name, manifest.name);
  assert.equal(manifest.publishConfig.registry, "https://npm.github.nrel.gov/");
  assert.match(npmrc, /^@gpac:registry=https:\/\/npm\.github\.nrel\.gov\/$/m);
});

test("publishes tagged releases to internal npm with the enterprise token", async () => {
  const workflow = await readFile(
    join(projectRoot, ".github", "workflows", "npm-publish.yml"),
    "utf8",
  );

  assert.match(workflow, /registry-url: "https:\/\/npm\.github\.nrel\.gov\/"/);
  assert.match(workflow, /scope: "@gpac"/);
  assert.match(workflow, /tag_version="\$\{RELEASE_TAG#v\}"/);
  assert.match(workflow, /npm publish --ignore-scripts --tag latest/);
  assert.match(
    workflow,
    /NODE_AUTH_TOKEN: \$\{\{ secrets\.NREL_NPM_TOKEN \}\}/,
  );
  assert.doesNotMatch(workflow, /registry\.npmjs\.org/);

  const buildIndex = workflow.indexOf(
    "Build package before registry authentication",
  );
  const authenticationIndex = workflow.indexOf(
    "Verify internal registry credentials",
  );
  assert.ok(buildIndex >= 0 && authenticationIndex > buildIndex);
});
