# STEM

[![CI](https://github.com/pesap/stem/actions/workflows/ci.yml/badge.svg)](https://github.com/pesap/stem/actions/workflows/ci.yml) [![Latest release](https://img.shields.io/github/v/release/pesap/stem?display_name=tag&label=latest%20release)](https://github.com/pesap/stem/releases/latest)

Generate Julia simulation scripts for Sienna PowerSimulations from TOML or JSON configuration. STEM is a TypeScript CLI that renders Nunjucks templates. It creates `.jl` scripts and does not run simulations.

## Quick start

Use Node.js 22.12 or newer and npm.

```bash
npx -y @pesap/stem --help
```

Pass a serialized Sienna system JSON and an output path to open the interactive wizard with the built-in decision-model configuration:

```bash
npx -y @pesap/stem -i /path/to/system.json -o /tmp/run.jl
julia --project=/path/to/julia/environment /tmp/run.jl
```

The Julia environment must contain PowerSimulations, the selected formulations, and the solver package.

## Configuration

- [Decision-model configuration](examples/decision_model.toml) defines single-step simulation settings.
- [Sequential-simulation configuration](examples/sequential_simulation.toml) defines per-stage systems, horizons, and resolutions. Omit `-i` because each stage has its own system path.
- [Julia templates](templates/) contains the built-in decision-model and sequential-simulation scripts.

Use a local TOML or JSON config, or an HTTPS URL, to select a template and set its values. CLI flags override config values. For an unattended run:

```bash
npx -y @pesap/stem -i system.json -o run.jl --config run.toml --no-prompt --yes
```

Use `--horizon` and `--resolution` for single-step timing, with ISO 8601 fixed durations such as `P2D` and `PT15M`. For sequential runs, set timing per stage in the config.

Use `--solver`, `--network-formulation`, `--device-model`, and `--service-model` to override selections. `--device-attribute`, `--network-option`, `--solver-attribute`, and `--set path=value` set additional options. Solver package and optimizer choices are paired under `[solver.backends]`. Interactive choices are searchable and show configured descriptions. Device and service menus default to skipping customization. Choose `Customize` to open a searchable multiselect with a separate `Select All` row. The system-file picker suggests directories and `.json` files only, excluding dot-prefixed directories, then validates the Sienna export structure (`data.components`). The start-time prompt defaults to the configured value. Since time-series timestamps are stored in the associated HDF5 file, Stem does not infer them from JSON or read HDF5. Choose `Custom ISO 8601 date/time` to enter a local date and time in `YYYY-MM-DDTHH:MM[:SS]` format. `--no-prompt` disables wizard prompts. `--yes` confirms file creation or overwrite.

> [!WARNING]
> Treat configurations as code. Solver and formulation names and configured Julia keyword arguments are emitted into the script. Use remote configurations only from sources you trust.

To add a template, add `templates/<id>.jl.j2` and a complete `examples/<id>.toml` config. Select it with `[stem].template` or `--template`. Interactive workflows are implemented for `decision_model` and `sequential_simulation`.

## Development

Install the pinned Node.js version and project dependencies, then run the checks. Use `mise run cli` to launch the interactive wizard while testing prompts.

```bash
mise install
npm ci
npm run format:check
npm run typecheck
npm test
npm run build
```

Build the npm package locally with `npm pack`. `mise.toml` pins the development Node.js version to 24.21.0 and provides `mise run example:single`, `mise run example:sequential`, and `mise run example` tasks. CI runs on Node.js 22.12 and 24 on Linux and macOS. It type-checks source and tests, runs the test suite, builds the CLI, installs the packed package, and generates both example scripts.

Before releasing, manually dispatch Publish npm package from the latest `main` branch in GitHub Actions. This runs the same package verification without publishing. Then bump `package.json`, push a matching version tag, and create and publish a GitHub release for that tag. The `npm-publish.yml` workflow runs after the release is published and uses npm trusted publishing.

The npm package must exist before npm lets you configure a trusted publisher. Bootstrap the first version once with `npm publish --access public`, then configure a GitHub Actions trusted publisher for owner `pesap`, repository `stem`, and workflow filename `npm-publish.yml`. Leave the environment name unset and allow direct publishing.
