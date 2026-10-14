# STEM

[![CI](https://github.com/pesap/stem/actions/workflows/ci.yml/badge.svg)](https://github.com/pesap/stem/actions/workflows/ci.yml) [![Latest release](https://img.shields.io/github/v/release/pesap/stem?display_name=tag&label=latest%20release)](https://github.com/pesap/stem/releases/latest)

STEM is a TypeScript CLI for generating Julia simulation scripts for Sienna PowerSimulations. It creates `.jl` files and does not run simulations.

## Quick Start

### Install

You need Node.js 22.12 or newer and npm.

> [!WARNING]
> I have requested npmjs access to publish under `@pesap`. Until it is
> available, these commands install a pinned GitHub commit instead of a
> published npm package. Pinning the commit avoids npm reusing the earlier
> failed cache entry. `--allow-git=all` permits Git dependency fetching for
> this invocation. Update the SHA to use a newer commit.

```bash
npx --allow-git=all -y --package=github:pesap/stem#dcd36a60b75b96aa6c19b83e2e0c35e2fea2adcb stem --help
```

### Generate a script

Pass a Sienna system JSON and an output path to open the interactive wizard:

```bash
npx --allow-git=all -y --package=github:pesap/stem#dcd36a60b75b96aa6c19b83e2e0c35e2fea2adcb stem -i /path/to/system.json -o /tmp/run.jl
julia --project=/path/to/julia/environment /tmp/run.jl
```

The Julia environment must contain PowerSimulations, the selected formulations, and the solver package. If `-i` is omitted, the wizard browses directories and `.json` files. Start-time prompts use the configured value by default. STEM does not read timestamps from associated HDF5 data.

## Documentation

- [Decision-model configuration](examples/decision_model.toml): single-step simulation settings.
- [Sequential-simulation configuration](examples/sequential_simulation.toml): per-stage systems, horizons, and resolutions. Each stage has its own system path.
- [Julia templates](templates/): built-in decision-model and sequential-simulation scripts.
- Run `npx --allow-git=all -y --package=github:pesap/stem#dcd36a60b75b96aa6c19b83e2e0c35e2fea2adcb stem --help` for CLI options and examples.

Use a local TOML or JSON config, or an HTTPS URL. CLI flags override configuration values.

## Development

Install mise and the project dependencies, then run the checks:

```bash
mise install
npm ci
mise run fmt-check
mise run typecheck
mise run test
mise run build
```

Use `mise run cli` to test the interactive prompts. Mise pins Node.js 24.21.0 and includes tasks for generating the example scripts.
