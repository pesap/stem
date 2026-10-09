# STEM

[![CI](https://github.com/pesap/stem/actions/workflows/ci.yml/badge.svg)](https://github.com/pesap/stem/actions/workflows/ci.yml) [![Latest release](https://img.shields.io/github/v/release/pesap/stem?display_name=tag&label=latest%20release)](https://github.com/pesap/stem/releases/latest)

Generate Julia simulation scripts for Sienna PowerSimulations from TOML or JSON configuration. STEM is a Rust CLI that renders MiniJinja templates. It creates `.jl` scripts and does not run simulations.

## Quick Start

### Install

You need Node.js and npm, but not Rust or an npm account.

```bash
npx -y pesap/stem --help
```

> [!NOTE]
> npm 12 blocks Git-based installs by default. If npm reports `EALLOWGIT`, use `npx --allow-git=all -y pesap/stem --help` and add `--allow-git=all` to other `npx` commands. This permits Git dependencies for that invocation. Use it only for package sources you trust. See npm's [`allow-git` setting](https://docs.npmjs.com/cli/v12/using-npm/config#allow-git).

### Generate a script

Pass a serialized Sienna system JSON and an output path. STEM opens the wizard with its built-in decision-model configuration:

```bash
npx -y pesap/stem -i /path/to/system.json -o /tmp/run.jl
julia --project=/path/to/julia/environment /tmp/run.jl
```

The Julia environment must contain PowerSimulations, the selected formulations, and the solver package.

## Documentation

- [Decision-model configuration](examples/decision_model.toml): single-step simulation settings.
- [Sequential-simulation configuration](examples/sequential_simulation.toml): per-stage systems, horizons, and resolutions. Omit `-i` because each stage has its own system path.
- [Julia templates](templates/): the built-in decision-model and sequential-simulation scripts.
- Run `npx -y pesap/stem --help` for CLI options and examples.

## Configuration

Use a complete local TOML or JSON config, or an HTTPS URL, to select a template and set its values. CLI flags override config values. For an unattended run:

```bash
npx -y pesap/stem -i system.json -o run.jl --config run.toml --no-prompt --yes
```

Use `--horizon` and `--resolution` for single-step timing, with ISO 8601 fixed durations such as `P2D` and `PT15M`. For sequential runs, set timing per stage in the config.

Use `--solver`, `--network-formulation`, `--device-model`, and `--service-model` to override selections. `--device-attribute`, `--network-option`, `--solver-attribute`, and `--set path=value` set additional options. Solver package and optimizer choices are paired under `[solver.backends]`. Interactive choices are searchable and show a hint for the active item. System JSON prompts suggest up to 10 matching `.json` files and directories in the typed path; type to filter, then use ↑/↓ and Tab to complete. `--no-prompt` disables wizard prompts. `--yes` confirms file creation or overwrite.

> [!WARNING]
> Treat configurations as code. Solver and formulation names and configured Julia keyword arguments are emitted into the script. Use remote configurations only from sources you trust.

To add a template, add `templates/<id>.jl.j2` and a complete `examples/<id>.toml` config. Select it with `[stem].template` or `--template`. Interactive workflows are currently implemented for `decision_model` and `sequential_simulation`.

## Development

Install Rust 1.85 or newer and mise. Run the checks with:

```bash
mise run fmt-check
mise run clippy
mise run test
mise run build
```

Build from source with `cargo build --release`. cargo-dist attaches platform binaries and an npm installer archive to GitHub Releases. STEM is not published to crates.io or the npm registry.
