# STEM

[![CI](https://github.com/pesap/stem/actions/workflows/ci.yml/badge.svg)](https://github.com/pesap/stem/actions/workflows/ci.yml) [![Latest release](https://img.shields.io/github/v/release/pesap/stem?display_name=tag&label=latest%20release)](https://github.com/pesap/stem/releases/latest)

Generate Julia simulation scripts for Sienna PowerSimulations from TOML or JSON configuration. STEM is a TypeScript CLI that renders Nunjucks templates. It creates `.jl` scripts and does not run simulations.

## Quick Start

### Install

You need Node.js 22.12 or newer and npm.

```bash
npx -y @pesap/stem --help
```

### Generate a script

Pass a serialized Sienna system JSON and an output path. STEM opens the wizard with its built-in decision-model configuration:

```bash
npx -y @pesap/stem -i /path/to/system.json -o /tmp/run.jl
julia --project=/path/to/julia/environment /tmp/run.jl
```

The Julia environment must contain PowerSimulations, the selected formulations, and the solver package.

## Documentation

- [Decision-model configuration](examples/decision_model.toml): single-step simulation settings.
- [Sequential-simulation configuration](examples/sequential_simulation.toml): per-stage systems, horizons, and resolutions. Omit `-i` because each stage has its own system path.
- [Julia templates](templates/): the built-in decision-model and sequential-simulation scripts.
- Run `npx -y @pesap/stem --help` for CLI options and examples.

## Configuration

Use a complete local TOML or JSON config, or an HTTPS URL, to select a template and set its values. CLI flags override config values. For an unattended run:

```bash
npx -y @pesap/stem -i system.json -o run.jl --config run.toml --no-prompt --yes
```

Use `--horizon` and `--resolution` for single-step timing, with ISO 8601 fixed durations such as `P2D` and `PT15M`. For sequential runs, set timing per stage in the config.

Override configuration selections with `--solver`, `--network-formulation`, `--device-model`, and `--service-model`. Set additional values with `--device-attribute`, `--network-option`, `--solver-attribute`, or `--set path=value`. Solver package and optimizer choices are paired under `[solver.backends]`.

Interactive choices are searchable, with descriptions shown in a separate `Description` block. Device, service, and stage-model menus default to `Skip customization`. Choose `Customize` to open a searchable multiselect with a separate `Select All` row.

When `-i` is omitted, the system-file picker shows directories and `.json` files only. It hides dot-prefixed directories and validates the selected file as a Sienna export containing `data.components`.

The scenario label defaults to `test-run`. Start-time prompts use the configured value by default. STEM does not read timestamps from associated HDF5 data. Choose `Custom ISO 8601 date/time` to enter a local date and time in `YYYY-MM-DDTHH:MM[:SS]` format. `--no-prompt` disables wizard prompts, and `--yes` confirms file creation or overwrite.

> [!WARNING]
> Treat configurations as code. Solver and formulation names and configured Julia keyword arguments are emitted into the script. Use remote configurations only from sources you trust.

To add a template, add `templates/<id>.jl.j2` and a complete `examples/<id>.toml` config. Select it with `[stem].template` or `--template`. Interactive workflows are implemented for `decision_model` and `sequential_simulation`.

## Development

Install mise and the pinned Node.js version, then install project dependencies and run the checks:

```bash
mise install
npm ci
mise run fmt-check
mise run typecheck
mise run test
mise run build
```

Use `mise run cli` to launch the interactive wizard while testing prompts. `mise.toml` pins Node.js 24.21.0 and provides `mise run example:single`, `mise run example:sequential`, `mise run example`, and `mise run pack-check`. CI runs on Node.js 22.12 and 24 on Linux and macOS. It checks formatting and types, runs tests, builds and smoke-tests the npm package, and generates both example scripts.

## Release

Bump the version in `package.json` and `package-lock.json`, then commit and push the change to `main`. In GitHub Actions, manually run `Publish npm package` from the latest `main` branch and enter the matching `v<version>` as `release_tag`. This preflight runs CI and checks the version without publishing.

After the preflight passes, draft a GitHub release with the same `v<version>` tag, targeting the version commit, then publish it. The `npm-publish.yml` workflow runs CI again and publishes the package to npm with trusted publishing.

Configure npm trusted publishing for GitHub owner `pesap`, repository `stem`, and workflow file `npm-publish.yml`. Leave the environment name unset. If the npm package does not exist yet, publish its first version once manually before configuring trusted publishing.
