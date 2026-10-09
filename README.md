# STEM

[![CI](https://github.com/pesap/stem/actions/workflows/ci.yml/badge.svg)](https://github.com/pesap/stem/actions/workflows/ci.yml) [![Latest release](https://img.shields.io/github/v/release/pesap/stem?display_name=tag&label=latest%20release)](https://github.com/pesap/stem/releases/latest)

STEM is a TypeScript CLI for generating Julia simulation scripts for Sienna PowerSimulations. It creates `.jl` files and does not run simulations.

## Quick Start

### Install

You need Node.js 22.12 or newer and npm.

```bash
npx -y @pesap/stem --help
```

### Generate a script

Pass a Sienna system JSON and an output path to open the interactive wizard:

```bash
npx -y @pesap/stem -i /path/to/system.json -o /tmp/run.jl
julia --project=/path/to/julia/environment /tmp/run.jl
```

The Julia environment must contain PowerSimulations, the selected formulations, and the solver package. If `-i` is omitted, the wizard browses directories and `.json` files. Start-time prompts use the configured value by default. STEM does not read timestamps from associated HDF5 data.

## Documentation

- [Decision-model configuration](examples/decision_model.toml): single-step simulation settings.
- [Sequential-simulation configuration](examples/sequential_simulation.toml): per-stage systems, horizons, and resolutions. Each stage has its own system path.
- [Julia templates](templates/): built-in decision-model and sequential-simulation scripts.
- Run `npx -y @pesap/stem --help` for CLI options and examples.

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
