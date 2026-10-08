# STEM

STEM creates Julia simulation scripts for Sienna PowerSimulations. It packages a fast Rust CLI, MiniJinja templates, and starting configurations. A run configuration is a complete set of values. There is no separate profile-plus-overrides merge.

## Start interactively

Pass the system JSON and the output path. STEM uses the built-in decision-model config and guides you through scenario settings, solver and network selections, and optional device or service formulation changes. Searchable lists show configured descriptions as hints and include a Select All option for multi-select lists:

```bash
stem -i /path/to/system.json -o /tmp/run.jl
```

Select the device or service classes you want to change, then choose a formulation. Optional device classes listed under `formulations.device_options` can also be added. Device-specific options such as `use_slacks` and attributes are prompted only for the selected formulation that defines them. The scenario label is written to the report, and the start time is passed to Sienna for the run.

## Start from a configuration

A local or HTTPS JSON/TOML config prepopulates the prompts. The config selects its template with `[stem].template` and contains the full template context. Without `--config`, STEM starts from the built-in decision-model config:

```bash
stem -i /path/to/system.json -o /tmp/run.jl \
  --config examples/decision_model.toml
```

You can pass `--config https://example.org/run.toml` to start from a remote config. Remote configs must use HTTPS. Only use a config from a source you trust because formulation and solver names are emitted into Julia code.

## Supply choices as flags

Flags set values directly and skip their corresponding prompts. Repeat model flags for multiple components:

```bash
stem -i /path/to/system.json -o /tmp/run.jl \
  --template decision_model \
  --horizon P2D \
  --resolution PT15M \
  --solver HiGHS \
  --network-formulation PTDFPowerModel \
  --device-model ThermalStandard=ThermalBasicUnitCommitment \
  --service-model 'VariableReserve{ReserveUp}=RangeReserve' \
  --device-model EnergyReservoirStorage=StorageDispatchWithReserves \
  --device-attribute EnergyReservoirStorage.reservation=false \
  --yes
```

Use `--set path=value` for other config fields, including `--set scenario.name=winter-day` and `--set scenario.initial_time=2024-01-01T00:00:00`. Look-ahead and resolution values use ISO 8601 durations such as `P2D`, `P1DT12H`, and `PT15M`. STEM converts fixed whole-unit weeks, days, hours, minutes, and seconds to Julia `Dates.Period` values. Calendar months and years are rejected because they are not fixed durations.

Use `--no-prompt` to disable the wizard. Any required values must then come from the config or flags. `--yes` accepts the final write or overwrite confirmation. It does not suppress configuration prompts.

```bash
stem -i /path/to/system.json -o /tmp/run.jl \
  --config examples/decision_model.toml \
  --no-prompt --yes
```

Sequential simulations use one system path per stage in their config, so omit `-i`:

```bash
stem -o /tmp/sequential.jl \
  --config examples/sequential_simulation.toml \
  --no-prompt --yes
```

Run the generated script in a Julia environment containing the selected Sienna formulations and solver packages:

```bash
julia --project=/path/to/julia/environment /tmp/run.jl
```

## Configure solver and network choices

The solver is one selectable backend that keeps the Julia package and optimizer paired. Add backends to `[solver.backends]`, then select one with `solver.selected` or `--solver`:

```toml
[solver]
selected = "Gurobi"

[solver.backends.Gurobi]
package = "Gurobi"
optimizer = "Gurobi.Optimizer"
description = "Commercial optimization solver"
```

The built-in config offers HiGHS. A selected backend must be defined in the config, and its Julia package must be available in the environment used to run the generated script.

Network formulation choices are configured alongside the network settings. Decision-model configs use `[formulations.network.choices]`. Sequential configs use `[stages.network.choices]` for each stage. Each key is a Julia formulation type and its value is the description shown in the searchable selection list. The wizard also offers a custom formulation entry. Existing network options remain separate.

## Configure device formulations

For the decision-model template, keys under `formulations.device_options` define the device formulations offered in the wizard, including optional component classes not already in `formulations.device_models`. Add options only where the selected formulation supports them:

```toml
[formulations.device_options.ThermalStandard.ThermalBasicUnitCommitment]
use_slacks = false
attributes = { reservation = false }
kwargs = ["duals = [ActivePowerLimitConstraint]"]
```

`use_slacks` and configured attributes are prompted after the user selects that device and formulation. `kwargs` contains trusted Julia keyword arguments emitted for that formulation. Keep arbitrary Julia expressions in configs from sources you trust.

## Add a template

Add `templates/<id>.jl.j2` and a complete `examples/<id>.toml` configuration. The config's `[stem]` table provides `template` and `name` metadata. The Rust code discovers and embeds these files at build time, so there is no separate template registry. The interactive CLI currently implements workflows for `decision_model` and `sequential_simulation`; adding a different workflow also requires Rust prompt and configuration handling.

## Install and run

After the first GitHub Release, run STEM directly from this repository with Node.js and npm. Rust and an npm account are not required:

```bash
npx --yes pesap/stem --help
npx --yes pesap/stem -i /path/to/system.json -o /tmp/run.jl
```

For a persistent installation, use `npm install --global github:pesap/stem` and then run `stem`.

The Rust crate is not published to crates.io. To build from source, install Rust and run `cargo build --release`.

## Checks and releases

CI uses stable Rust and runs formatting, all-target/all-feature Clippy with pedantic lints denied, the test suite, non-interactive CLI generation for both built-in templates, and checks the GitHub `npx` package. Run the Rust checks locally with:

```bash
mise run fmt-check
mise run clippy
mise run test
mise run build
```

cargo-dist builds platform binaries and an npm installer asset for GitHub Releases. The checked-in private npm package lets npm run the CLI from this GitHub repository and downloads the matching release binary. Neither crates.io nor the npm registry receives a publish. Release a version by pushing a matching `vX.Y.Z` tag.
