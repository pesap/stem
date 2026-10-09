use std::collections::HashSet;
use std::io::{self, IsTerminal};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::{Context, Result, bail};
use clap::Parser;
use cliclack::{
    Theme, ThemeState, confirm, input, intro, multiselect, note, outro, outro_cancel, select,
    set_theme,
};
use serde_json::{Value, json};
use stem::{
    available_templates, default_config, load_config, render, set_value, solver_backend, string_at,
};

#[derive(Debug, Parser)]
#[command(
    name = "stem",
    version,
    about = "Create Sienna Julia simulation scripts",
    after_help = "Examples:\n  stem -i system.json -o run.jl\n  stem -i system.json -o run.jl --config run.toml\n  stem -i system.json -o run.jl --config https://example.org/run.toml --no-prompt --yes\n  stem -i system.json -o run.jl --solver HiGHS --network-formulation PTDFPowerModel --no-prompt --yes"
)]
struct Cli {
    /// Serialized Sienna system JSON. Used as the single-step script's system path.
    #[arg(short, long)]
    input: Option<PathBuf>,
    /// Output Julia script path.
    #[arg(short, long)]
    output: Option<PathBuf>,
    /// Starting TOML/JSON config path or HTTPS URL.
    #[arg(long, value_name = "PATH_OR_URL")]
    config: Option<String>,
    /// Template ID. A config can set this in [stem].template.
    #[arg(long)]
    template: Option<String>,
    /// Single-step look-ahead horizon as an ISO 8601 duration, for example `P1D`.
    #[arg(long)]
    horizon: Option<String>,
    /// Single-step resolution as an ISO 8601 duration, for example `PT15M`.
    #[arg(long)]
    resolution: Option<String>,
    /// Select a configured solver backend, for example `HiGHS`.
    #[arg(long)]
    solver: Option<String>,
    /// Network formulation. Repeatable settings are available through `--network-option`.
    #[arg(long = "network-formulation")]
    network_formulation: Option<String>,
    /// Set a device formulation. Repeat for multiple classes: `ThermalStandard=ThermalBasicUnitCommitment`.
    #[arg(long = "device-model", value_name = "CLASS=FORMULATION")]
    device_models: Vec<String>,
    /// Set a service formulation. Repeat for multiple services.
    #[arg(long = "service-model", value_name = "SERVICE=FORMULATION")]
    service_models: Vec<String>,
    /// Set a device attribute, for example `EnergyReservoirStorage.reservation=false`.
    #[arg(long = "device-attribute", value_name = "CLASS.ATTRIBUTE=VALUE")]
    device_attributes: Vec<String>,
    /// Set a network option. Repeat to set multiple options.
    #[arg(long = "network-option")]
    network_options: Vec<String>,
    /// Set a solver attribute as a TOML value, for example `mip_rel_gap=0.01`.
    #[arg(long = "solver-attribute", value_name = "NAME=VALUE")]
    solver_attributes: Vec<String>,
    /// Set any config value using a dotted path and TOML value.
    #[arg(long = "set", value_name = "PATH=VALUE")]
    settings: Vec<String>,
    /// Disable all interactive prompts. Missing required values are errors.
    #[arg(long)]
    no_prompt: bool,
    /// Accept the final write or overwrite confirmation.
    #[arg(short = 'y', long)]
    yes: bool,
}

type FixedPaths = HashSet<String>;

struct StemTheme;

impl StemTheme {
    fn description_block(&self, state: &ThemeState, hint: &str) -> String {
        let bar = self.bar_color(state).apply_to("│").to_string();
        let line_prefix = format!("\n{bar}    ");
        let description = hint.lines().collect::<Vec<_>>().join(&line_prefix);
        format!("{bar}  Description\n{bar}    {description}\n")
    }

    fn framed_row(&self, state: &ThemeState, row: &str) -> String {
        let bar = self.bar_color(state).apply_to("│").to_string();
        format!("{bar}  {row}\n")
    }
}

impl Theme for StemTheme {
    fn format_select_item(
        &self,
        state: &ThemeState,
        active: bool,
        label: &str,
        hint: &str,
    ) -> String {
        if matches!(state, ThemeState::Cancel | ThemeState::Submit) && !active {
            return String::new();
        }

        let row = self.radio_item(state, active, label, "");
        let mut rendered = self.framed_row(state, &row);
        if active && !hint.is_empty() && matches!(state, ThemeState::Active | ThemeState::Error(_))
        {
            rendered.push_str(&self.description_block(state, hint));
        }
        rendered
    }

    fn format_multiselect_item(
        &self,
        state: &ThemeState,
        selected: bool,
        active: bool,
        label: &str,
        hint: &str,
    ) -> String {
        if matches!(state, ThemeState::Cancel | ThemeState::Submit) && !selected {
            return String::new();
        }

        let row = self.checkbox_item(state, selected, active, label, "");
        let mut rendered = self.framed_row(state, &row);
        if active && !hint.is_empty() && matches!(state, ThemeState::Active | ThemeState::Error(_))
        {
            rendered.push_str(&self.description_block(state, hint));
        }
        rendered
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum PromptChoice {
    SelectAll,
    Named(String),
    Custom,
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) if is_cancelled(&error) => {
            let _ = outro_cancel("Cancelled. No script was written.");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("Error: {error:#}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<()> {
    let cli = Cli::parse();
    let templates = available_templates()?;
    let mut config = cli.config.as_deref().map(load_config).transpose()?;
    let configured_template = config
        .as_ref()
        .and_then(|config| string_at(config, "stem.template"))
        .map(normalize_template_id);
    let explicit_template = cli.template.as_deref().map(normalize_template_id);

    if let (Some(configured), Some(explicit)) = (&configured_template, &explicit_template) {
        if configured != explicit {
            bail!(
                "config selects template `{configured}`, but `--template` selects `{explicit}`; use a matching config"
            );
        }
    }

    let template_id = explicit_template
        .or(configured_template)
        .unwrap_or_else(|| "decision_model".to_owned());
    ensure_template_exists(&templates, &template_id)?;

    if config.is_none() {
        config = Some(default_config(&template_id)?);
    }
    let mut config = config.context("failed to load starting config")?;
    let fixed = apply_cli_values(&cli, &mut config, &template_id)?;
    if let Some(input_path) = &cli.input {
        if template_id == "sequential_simulation" {
            bail!("sequential simulations take a system path per stage in the config; omit `-i`");
        }
        set_value(
            &mut config,
            "system_path",
            json!(input_path.to_string_lossy()),
        )?;
    }

    let needs_prompts = !cli.no_prompt && prompts_needed(&cli, &config, &template_id, &fixed);
    if needs_prompts && !io::stdin().is_terminal() {
        bail!("interactive choices need a terminal; provide the options or use `--no-prompt`");
    }
    if needs_prompts {
        set_theme(StemTheme);
        intro(" stem ")?;
    }

    if needs_prompts {
        if template_id == "decision_model" {
            if cli.input.is_none() {
                prompt_system_path(&mut config, "system_path", "System JSON path")?;
            }
            prompt_simulation_settings(&mut config, &fixed)?;
            prompt_model_formulations(&mut config, &fixed)?;
        } else {
            prompt_multi_stage_settings(&mut config, &fixed)?;
        }
    }

    let output = match cli.output {
        Some(path) => path,
        None if needs_prompts => {
            let default_output = format!("generated/{template_id}.jl");
            let output: String = input("Output Julia script")
                .default_input(&default_output)
                .interact()
                .context("output path prompt failed")?;
            PathBuf::from(output)
        }
        None => PathBuf::from(format!("generated/{template_id}.jl")),
    };

    let system_path = if template_id == "decision_model" {
        let system_path = string_at(&config, "system_path").unwrap_or_default();
        if system_path.trim().is_empty() {
            bail!(
                "missing system path; pass `-i <system.json>` or set `system_path` in the config"
            );
        }
        system_path.to_owned()
    } else {
        "Configured per stage".to_owned()
    };

    let generated = render(&template_id, &config)?;
    show_summary(&template_id, &system_path, &config, &output, needs_prompts)?;

    write_after_confirmation(&output, &generated, cli.yes, cli.no_prompt, needs_prompts)
}

fn write_after_confirmation(
    output: &Path,
    generated: &str,
    yes: bool,
    no_prompt: bool,
    interactive: bool,
) -> Result<()> {
    if !yes {
        if no_prompt {
            if output.exists() {
                bail!(
                    "output `{}` already exists; pass `--yes` to overwrite it",
                    output.display()
                );
            }
            bail!("`--no-prompt` requires `--yes` to write the script");
        }
        if !io::stdin().is_terminal() {
            bail!("use `--yes` to confirm script generation in a non-interactive terminal");
        }
        let exists = output.exists();
        let message = if exists {
            format!("Overwrite {}?", output.display())
        } else {
            "Create this Julia script?".to_owned()
        };
        if !confirm(message).initial_value(exists).interact()? {
            outro_cancel("No script was written.")?;
            return Ok(());
        }
    }

    write_output(output, generated)?;
    if interactive {
        outro(format!("Created {}", output.display()))?;
    } else {
        eprintln!("Created {}", output.display());
    }
    Ok(())
}

fn apply_cli_values(cli: &Cli, config: &mut Value, template_id: &str) -> Result<FixedPaths> {
    let mut fixed = HashSet::new();
    for setting in &cli.settings {
        let (path, value) = split_assignment(setting, "--set")?;
        set_value(config, &path, parse_value(&value))?;
        fixed.insert(path);
    }

    for (value, path, flag) in [
        (&cli.horizon, "timing.horizon", "--horizon"),
        (&cli.resolution, "timing.resolution", "--resolution"),
    ] {
        if let Some(value) = value {
            if template_id == "sequential_simulation" {
                let field = if flag == "--horizon" {
                    "forecast_horizon"
                } else {
                    "resolution"
                };
                bail!("use `--set stages.N.{field}=VALUE` for sequential templates");
            }
            set_value(config, path, json!(value))?;
            fixed.insert(path.to_owned());
        }
    }
    if let Some(value) = &cli.solver {
        set_value(config, "solver.selected", json!(value))?;
        fixed.insert("solver.selected".to_owned());
    }
    if let Some(value) = &cli.network_formulation {
        if template_id == "sequential_simulation" {
            bail!("use `--set stages.N.network.formulation=VALUE` for sequential templates");
        }
        let path = "formulations.network.formulation";
        set_value(config, path, json!(value))?;
        fixed.insert(path.to_owned());
    }
    for assignment in &cli.device_models {
        let (component, formulation) = split_assignment(assignment, "--device-model")?;
        if template_id == "sequential_simulation" {
            bail!(
                "use `--set stages.N.device_models.N.formulation=VALUE` for sequential templates"
            );
        }
        let path = format!("formulations.device_models.{component}");
        set_value(config, &path, json!(formulation))?;
        fixed.insert(path);
    }
    for assignment in &cli.service_models {
        let (service, formulation) = split_assignment(assignment, "--service-model")?;
        if template_id == "sequential_simulation" {
            bail!(
                "use `--set stages.N.service_models.N.formulation=VALUE` for sequential templates"
            );
        }
        let path = format!("formulations.service_models.{service}");
        set_value(config, &path, json!(formulation))?;
        fixed.insert(path);
    }
    if template_id == "sequential_simulation"
        && (!cli.device_attributes.is_empty() || !cli.network_options.is_empty())
    {
        bail!("use `--set` with a stage path for sequential device and network options");
    }
    for assignment in &cli.device_attributes {
        let (key, value) = split_assignment(assignment, "--device-attribute")?;
        let (component, attribute) = key.split_once('.').with_context(|| {
            format!("`{key}` must have the form COMPONENT.ATTRIBUTE for --device-attribute")
        })?;
        let formulation_path = format!("formulations.device_models.{component}");
        let formulation = string_at(config, &formulation_path).with_context(|| {
            format!(
                "no formulation configured for `{component}`; set one with `--device-model` first"
            )
        })?;
        let path =
            format!("formulations.device_options.{component}.{formulation}.attributes.{attribute}");
        set_value(config, &path, parse_value(&value))?;
        fixed.insert(path);
    }
    if !cli.network_options.is_empty() {
        set_value(
            config,
            "formulations.network.options",
            json!(cli.network_options),
        )?;
    }
    for assignment in &cli.solver_attributes {
        let (name, value) = split_assignment(assignment, "--solver-attribute")?;
        set_value(
            config,
            &format!("solver.attributes.{name}"),
            parse_value(&value),
        )?;
    }
    if fixed.contains("solver.selected") {
        solver_backend(config)?;
    }
    Ok(fixed)
}

fn prompts_needed(cli: &Cli, config: &Value, template_id: &str, fixed: &FixedPaths) -> bool {
    if (cli.input.is_none() && template_id == "decision_model") || cli.output.is_none() {
        return true;
    }
    if template_id == "decision_model" {
        [
            "scenario.name",
            "scenario.initial_time",
            "timing.horizon",
            "timing.resolution",
            "solver.selected",
            "formulations.network.formulation",
        ]
        .iter()
        .any(|path| !fixed.contains(*path))
            || device_components(config).iter().any(|component| {
                !fixed.contains(&format!("formulations.device_models.{component}"))
            })
            || has_unfixed_models(config, "formulations.service_models", fixed)
            || selected_device_options_need_prompts(config, fixed)
    } else {
        ["solver.selected"]
            .iter()
            .any(|path| !fixed.contains(*path))
            || multi_stage_has_prompts(config, fixed)
    }
}

fn prompt_simulation_settings(config: &mut Value, fixed: &FixedPaths) -> Result<()> {
    for (path, label, fallback) in [
        ("scenario.name", "Scenario label", "scenario"),
        (
            "scenario.initial_time",
            "Scenario start time",
            "2020-01-01T00:00:00",
        ),
        ("timing.horizon", "Look-ahead horizon", "P1D"),
        ("timing.resolution", "Time resolution", "PT1H"),
    ] {
        prompt_if_not_fixed(config, fixed.contains(path), path, label, fallback)?;
    }
    if !fixed.contains("solver.selected") {
        prompt_solver(config)?;
    }
    if !fixed.contains("formulations.network.formulation") {
        prompt_network_formulation(
            config,
            "formulations.network.formulation",
            "formulations.network.choices",
            "Network formulation",
            fixed,
        )?;
    }
    Ok(())
}

fn prompt_solver(config: &mut Value) -> Result<()> {
    prompt_catalog_value(config, "solver.selected", "solver.backends", "Solver", None)?;
    Ok(())
}

fn prompt_network_formulation(
    config: &mut Value,
    value_path: &str,
    choices_path: &str,
    title: &str,
    fixed: &FixedPaths,
) -> Result<()> {
    if fixed.contains(value_path) {
        return Ok(());
    }
    prompt_catalog_value(
        config,
        value_path,
        choices_path,
        title,
        Some((
            "Custom formulation",
            format!("Custom formulation for {title}"),
        )),
    )?;
    Ok(())
}

fn prompt_catalog_value(
    config: &mut Value,
    value_path: &str,
    choices_path: &str,
    title: &str,
    custom: Option<(&str, String)>,
) -> Result<String> {
    let current = string_at(config, value_path).map(str::to_owned);
    let mut choices: Vec<_> = catalog_entries(config, choices_path)
        .into_iter()
        .map(|(value, description)| (PromptChoice::Named(value.clone()), value, description))
        .collect();
    if let Some(current) = &current
        && !choices
            .iter()
            .any(|(choice, _, _)| choice == &PromptChoice::Named(current.clone()))
    {
        choices.push((
            PromptChoice::Named(current.clone()),
            current.clone(),
            "Current configuration".to_owned(),
        ));
    }
    if let Some((custom_label, _)) = &custom {
        choices.push((
            PromptChoice::Custom,
            (*custom_label).to_owned(),
            "Enter a Julia type name".to_owned(),
        ));
    }
    if choices.is_empty() {
        bail!("no selectable values are configured at `{choices_path}`");
    }

    let initial = current.map_or_else(|| choices[0].0.clone(), PromptChoice::Named);
    let prompt_title = format!("{title}\nSearch: type to filter • ↑/↓ move • Enter select");
    let selected = select(&prompt_title)
        .items(&choices)
        .initial_value(initial)
        .filter_mode()
        .max_rows(10)
        .interact()
        .with_context(|| format!("selection failed for `{title}`"))?;
    let value = match selected {
        PromptChoice::Named(value) => value,
        PromptChoice::Custom => {
            let (_, custom_prompt) = custom.context("custom prompt text is missing")?;
            input(&custom_prompt)
                .default_input(string_at(config, value_path).unwrap_or_default())
                .interact()
                .with_context(|| format!("custom value prompt failed for `{title}`"))?
        }
        PromptChoice::SelectAll => bail!("select-all is not valid for `{title}`"),
    };
    set_value(config, value_path, json!(&value))?;
    Ok(value)
}

fn catalog_entries(config: &Value, path: &str) -> Vec<(String, String)> {
    value_at(config, path)
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|choices| choices.iter())
        .map(|(value, metadata)| {
            let description = metadata
                .as_str()
                .or_else(|| metadata.get("description").and_then(Value::as_str))
                .unwrap_or("Configured option")
                .to_owned();
            (value.clone(), description)
        })
        .collect()
}

fn prompt_multi_selection(title: &str, items: &[(String, String, String)]) -> Result<Vec<String>> {
    if items.is_empty() {
        return Ok(Vec::new());
    }
    let item_choices = items
        .iter()
        .map(|(value, label, hint)| {
            (
                PromptChoice::Named(value.clone()),
                label.clone(),
                hint.clone(),
            )
        })
        .collect::<Vec<_>>();
    let mut choices = vec![(
        PromptChoice::SelectAll,
        format!("Select All ({})", items.len()),
        format!("Select all {} listed options.", items.len()),
    )];
    choices.extend(item_choices.iter().cloned());
    let prompt_title =
        format!("{title}\nSearch: type to filter • ↑/↓ move • Space toggle • Enter confirm");
    let selected = multiselect(&prompt_title)
        .items(&choices)
        .required(false)
        .filter_mode()
        .max_rows(10)
        .interact()
        .with_context(|| format!("{title} prompt failed"))?;
    let selected = if selected.contains(&PromptChoice::SelectAll) {
        let title = format!("{title} (all selected; adjust as needed)");
        let prompt_title =
            format!("{title}\nSearch: type to filter • ↑/↓ move • Space toggle • Enter confirm");
        multiselect(&prompt_title)
            .items(&item_choices)
            .initial_values(all_prompt_values(items))
            .required(false)
            .filter_mode()
            .max_rows(10)
            .interact()
            .with_context(|| format!("{title} prompt failed"))?
    } else {
        selected
    };
    Ok(expand_multi_selection(selected))
}

fn all_prompt_values(items: &[(String, String, String)]) -> Vec<PromptChoice> {
    items
        .iter()
        .map(|(value, _, _)| PromptChoice::Named(value.clone()))
        .collect()
}

fn expand_multi_selection(selected: Vec<PromptChoice>) -> Vec<String> {
    selected
        .into_iter()
        .filter_map(|choice| match choice {
            PromptChoice::Named(value) => Some(value),
            PromptChoice::SelectAll | PromptChoice::Custom => None,
        })
        .collect()
}

fn prompt_model_formulations(config: &mut Value, fixed: &FixedPaths) -> Result<()> {
    prompt_device_formulations(config, fixed)?;
    prompt_fixed_device_options(config, fixed)?;
    prompt_model_group(
        config,
        "formulations.service_models",
        fixed,
        "Services to customize",
        "Service formulation",
    )
}

fn device_components(config: &Value) -> Vec<String> {
    let mut components = value_at(config, "formulations.device_models")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|models| models.keys().cloned())
        .chain(
            value_at(config, "formulations.device_options")
                .and_then(Value::as_object)
                .into_iter()
                .flat_map(|options| options.keys().cloned()),
        )
        .collect::<Vec<_>>();
    components.sort();
    components.dedup();
    components
}

fn prompt_device_formulations(config: &mut Value, fixed: &FixedPaths) -> Result<()> {
    let components: Vec<_> = device_components(config)
        .into_iter()
        .filter(|component| !fixed.contains(&format!("formulations.device_models.{component}")))
        .collect();
    if components.is_empty() {
        return Ok(());
    }

    let model_choices: Vec<_> = components
        .iter()
        .map(|component| {
            (
                component.clone(),
                component.clone(),
                device_class_hint(config, component),
            )
        })
        .collect();
    let selected_components =
        prompt_multi_selection("Device classes to customize", &model_choices)?;

    for component in selected_components {
        let model_path = format!("formulations.device_models.{component}");
        let option_path = format!("formulations.device_options.{component}");
        let formulation = prompt_catalog_value(
            config,
            &model_path,
            &option_path,
            &format!("Formulation for {component}"),
            Some((
                "Custom formulation",
                format!("Custom formulation for {component}"),
            )),
        )?;
        prompt_device_options(
            config,
            &format!("formulations.device_options.{component}.{formulation}"),
            &component,
            fixed,
        )?;
    }
    Ok(())
}

fn device_class_hint(config: &Value, component: &str) -> String {
    let current = string_at(config, &format!("formulations.device_models.{component}"));
    let available =
        catalog_entries(config, &format!("formulations.device_options.{component}")).len();
    let formulation_count = format!(
        "{available} configured formulation{}",
        if available == 1 { "" } else { "s" }
    );

    match (current, available) {
        (Some(current), 0) => format!("Current: {current}"),
        (Some(current), _) => format!("Current: {current}; {formulation_count}"),
        (None, 0) => "No formulation configured; select to enter a custom one".to_owned(),
        (None, _) => formulation_count,
    }
}

fn prompt_fixed_device_options(config: &mut Value, fixed: &FixedPaths) -> Result<()> {
    for component in device_components(config) {
        let model_path = format!("formulations.device_models.{component}");
        if !fixed.contains(&model_path) {
            continue;
        }
        let Some(formulation) = string_at(config, &model_path) else {
            continue;
        };
        prompt_device_options(
            config,
            &format!("formulations.device_options.{component}.{formulation}"),
            &component,
            fixed,
        )?;
    }
    Ok(())
}

fn selected_device_options_need_prompts(config: &Value, fixed: &FixedPaths) -> bool {
    device_components(config).iter().any(|component| {
        let model_path = format!("formulations.device_models.{component}");
        if !fixed.contains(&model_path) {
            return false;
        }
        let Some(formulation) = string_at(config, &model_path) else {
            return false;
        };
        let options_path = format!("formulations.device_options.{component}.{formulation}");
        let slacks_path = format!("{options_path}.use_slacks");
        value_at(config, &slacks_path)
            .and_then(Value::as_bool)
            .is_some()
            && !fixed.contains(&slacks_path)
            || value_at(config, &format!("{options_path}.attributes"))
                .and_then(Value::as_object)
                .is_some_and(|attributes| {
                    attributes
                        .keys()
                        .any(|name| !fixed.contains(&format!("{options_path}.attributes.{name}")))
                })
    })
}

fn prompt_device_options(
    config: &mut Value,
    options_path: &str,
    component: &str,
    fixed: &FixedPaths,
) -> Result<()> {
    let slacks_path = format!("{options_path}.use_slacks");
    if !fixed.contains(&slacks_path)
        && let Some(use_slacks) = value_at(config, &slacks_path).and_then(Value::as_bool)
    {
        let value = confirm(format!("Enable slacks for {component}?"))
            .initial_value(use_slacks)
            .interact()?;
        set_value(config, &slacks_path, json!(value))?;
    }

    let attributes_path = format!("{options_path}.attributes");
    let attributes: Vec<_> = value_at(config, &attributes_path)
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|attributes| attributes.iter())
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect();
    for (name, current) in attributes {
        let path = format!("{attributes_path}.{name}");
        if fixed.contains(&path) {
            continue;
        }
        let label = format!("{component} attribute `{name}`");
        let value = if let Some(current) = current.as_bool() {
            json!(confirm(label).initial_value(current).interact()?)
        } else {
            let current = match current {
                Value::String(value) => value,
                value => value.to_string(),
            };
            let value: String = input(label).default_input(&current).interact()?;
            parse_value(&value)
        };
        set_value(config, &path, value)?;
    }
    Ok(())
}

fn prompt_multi_stage_settings(config: &mut Value, fixed: &FixedPaths) -> Result<()> {
    prompt_if_not_fixed(
        config,
        fixed.contains("simulation.initial_time"),
        "simulation.initial_time",
        "Simulation start time",
        "",
    )?;
    if !fixed.contains("solver.selected") {
        prompt_solver(config)?;
    }

    let stage_names: Vec<String> = config
        .get("stages")
        .and_then(Value::as_array)
        .context("sequential config must contain a `stages` array")?
        .iter()
        .map(|stage| string_at(stage, "name").unwrap_or("stage").to_owned())
        .collect();
    for (index, stage_name) in stage_names.iter().enumerate() {
        for (field, label) in [
            ("system_path", format!("System JSON for {stage_name}")),
            (
                "forecast_horizon",
                format!("Look-ahead horizon for {stage_name}"),
            ),
            (
                "forecast_interval",
                format!("Forecast interval for {stage_name}"),
            ),
            ("resolution", format!("Time resolution for {stage_name}")),
        ] {
            let path = format!("stages.{index}.{field}");
            if !fixed.contains(&path) {
                if field == "system_path" {
                    prompt_system_path(config, &path, &label)?;
                } else {
                    prompt_string(config, &path, &label, "")?;
                }
            }
        }
        prompt_network_formulation(
            config,
            &format!("stages.{index}.network.formulation"),
            &format!("stages.{index}.network.choices"),
            &format!("Network formulation for {stage_name}"),
            fixed,
        )?;
        prompt_stage_models(
            config,
            index,
            "device_models",
            "Device classes to customize",
            fixed,
        )?;
        prompt_stage_models(
            config,
            index,
            "service_models",
            "Services to customize",
            fixed,
        )?;
    }
    Ok(())
}

fn prompt_stage_models(
    config: &mut Value,
    stage_index: usize,
    field: &str,
    title: &str,
    fixed_paths: &FixedPaths,
) -> Result<()> {
    let path = format!("stages.{stage_index}.{field}");
    let models = config
        .get("stages")
        .and_then(Value::as_array)
        .and_then(|stages| stages.get(stage_index))
        .and_then(|stage| stage.get(field))
        .and_then(Value::as_array)
        .context("stage model settings must be arrays")?;
    let choices: Vec<_> = models
        .iter()
        .enumerate()
        .filter_map(|(model_index, model)| {
            let component = model.get("component")?.as_str()?;
            let formulation = model.get("formulation")?.as_str()?;
            let setting_path = format!("{path}.{model_index}.formulation");
            if fixed_paths.contains(&setting_path) {
                return None;
            }
            Some((
                model_index.to_string(),
                component.to_owned(),
                format!("Current formulation: {formulation}"),
            ))
        })
        .collect();
    if choices.is_empty() {
        return Ok(());
    }
    let selected = prompt_multi_selection(title, &choices)?;
    for selected_index in selected {
        let model_index = selected_index
            .parse::<usize>()
            .context("selected model index was invalid")?;
        let models = config
            .get("stages")
            .and_then(Value::as_array)
            .and_then(|stages| stages.get(stage_index))
            .and_then(|stage| stage.get(field))
            .and_then(Value::as_array)
            .context("stage model settings must be arrays")?;
        let model = models
            .get(model_index)
            .context("selected model index was out of range")?;
        let component = model
            .get("component")
            .and_then(Value::as_str)
            .context("stage model is missing its component")?
            .to_owned();
        let current = model
            .get("formulation")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let formulation: String = input(format!("Formulation for {component}"))
            .default_input(current)
            .interact()?;
        set_value(
            config,
            &format!("{path}.{model_index}.formulation"),
            json!(formulation),
        )?;
        prompt_device_options(
            config,
            &format!("{path}.{model_index}"),
            &component,
            fixed_paths,
        )?;
    }
    Ok(())
}

fn prompt_model_group(
    config: &mut Value,
    path: &str,
    fixed: &FixedPaths,
    prompt_title: &str,
    value_title: &str,
) -> Result<()> {
    let Some(models) = value_at(config, path).and_then(Value::as_object) else {
        return Ok(());
    };
    let choices: Vec<_> = models
        .iter()
        .filter(|(component, _)| !fixed.contains(&format!("{path}.{component}")))
        .filter_map(|(component, formulation)| {
            formulation.as_str().map(|formulation| {
                (
                    component.clone(),
                    component.clone(),
                    format!("Current formulation: {formulation}"),
                )
            })
        })
        .collect();
    if choices.is_empty() {
        return Ok(());
    }

    let selected = prompt_multi_selection(prompt_title, &choices)?;
    for component in selected {
        let current = string_at(config, &format!("{path}.{component}")).unwrap_or_default();
        let formulation: String = input(format!("{value_title} for {component}"))
            .default_input(current)
            .interact()
            .with_context(|| format!("formulation prompt failed for `{component}`"))?;
        set_value(config, &format!("{path}.{component}"), json!(formulation))?;
    }
    Ok(())
}

fn prompt_if_not_fixed(
    config: &mut Value,
    fixed: bool,
    path: &str,
    label: &str,
    fallback: &str,
) -> Result<()> {
    if !fixed {
        prompt_string(config, path, label, fallback)?;
    }
    Ok(())
}

fn prompt_system_path(config: &mut Value, path: &str, label: &str) -> Result<()> {
    let current = string_at(config, path).unwrap_or_default();
    let prompt_label =
        format!("{label}\nType to filter up to 10 local matches; ↑/↓ choose, Tab complete");
    let mut prompt = input(&prompt_label).autocomplete(system_json_suggestions);
    if current.is_empty() {
        prompt = prompt.placeholder("Path to system JSON");
    } else {
        prompt = prompt.default_input(current);
    }
    let value: String = prompt
        .interact()
        .with_context(|| format!("prompt failed for `{label}`"))?;
    set_value(config, path, json!(value))
}

fn system_json_suggestions(query: &str) -> Vec<String> {
    const MAX_SUGGESTIONS: usize = 10;

    let typed_path = Path::new(query);
    let has_trailing_separator = query.ends_with(std::path::MAIN_SEPARATOR) || query.ends_with('/');
    let (directory, partial) = if has_trailing_separator && typed_path.is_dir() {
        (typed_path, "")
    } else {
        (
            typed_path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .unwrap_or_else(|| Path::new(".")),
            typed_path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default(),
        )
    };
    let Ok(entries) = std::fs::read_dir(directory) else {
        return Vec::new();
    };
    let partial = partial.to_lowercase();
    let mut suggestions = entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name().into_string().ok()?;
            if !name.to_lowercase().starts_with(&partial) {
                return None;
            }

            let path = entry.path();
            if path.is_dir() {
                let mut suggestion = path.into_os_string();
                suggestion.push(std::path::MAIN_SEPARATOR.to_string());
                suggestion.into_string().ok()
            } else if path.is_file()
                && path
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
            {
                Some(path.to_string_lossy().into_owned())
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    suggestions.sort_unstable();
    suggestions.truncate(MAX_SUGGESTIONS);
    suggestions
}

fn prompt_string(config: &mut Value, path: &str, label: &str, fallback: &str) -> Result<()> {
    let current = string_at(config, path).unwrap_or(fallback);
    let value: String = input(label)
        .default_input(current)
        .interact()
        .with_context(|| format!("prompt failed for `{label}`"))?;
    set_value(config, path, json!(value))
}

fn show_summary(
    template_id: &str,
    system_path: &str,
    config: &Value,
    output: &Path,
    interactive: bool,
) -> Result<()> {
    let template_name = available_templates()?
        .into_iter()
        .find(|template| template.id == template_id)
        .map_or_else(|| template_id.to_owned(), |template| template.name);
    let mut lines = vec![
        format!("Template: {template_name}"),
        format!("System: {system_path}"),
        format!("Output: {}", output.display()),
    ];
    for (label, path) in [
        ("Scenario", "scenario.name"),
        ("Scenario start", "scenario.initial_time"),
        ("Simulation start", "simulation.initial_time"),
        ("Horizon", "timing.horizon"),
        ("Resolution", "timing.resolution"),
        ("Network", "formulations.network.formulation"),
    ] {
        if let Some(value) = string_at(config, path) {
            lines.push(format!("{label}: {value}"));
        }
    }
    if let Some(solver_name) = string_at(config, "solver.selected") {
        let backend_path = format!("solver.backends.{solver_name}");
        let package = string_at(config, &format!("{backend_path}.package")).unwrap_or("?");
        let optimizer = string_at(config, &format!("{backend_path}.optimizer")).unwrap_or("?");
        lines.push(format!("Solver: {solver_name} ({package}, {optimizer})"));
    }
    if interactive {
        note(lines.join("\n"), "Simulation configuration")?;
    } else {
        eprintln!("{}", lines.join("\n"));
    }
    Ok(())
}

fn write_output(path: &Path, rendered: &str) -> Result<()> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create output directory `{}`", parent.display()))?;
    }
    std::fs::write(path, rendered)
        .with_context(|| format!("failed to write Julia script `{}`", path.display()))
}

fn split_assignment(value: &str, flag: &str) -> Result<(String, String)> {
    let (key, value) = value
        .split_once('=')
        .with_context(|| format!("`{value}` must have the form KEY=VALUE for {flag}"))?;
    if key.trim().is_empty() || value.trim().is_empty() {
        bail!("`{value}` must have non-empty KEY and VALUE for {flag}");
    }
    Ok((key.trim().to_owned(), value.trim().to_owned()))
}

fn parse_value(source: &str) -> Value {
    let wrapped = format!("value = {source}");
    let Ok(parsed) = toml::from_str::<toml::Value>(&wrapped) else {
        return json!(source);
    };
    let Some(value) = parsed.get("value") else {
        return json!(source);
    };
    match value {
        toml::Value::Datetime(datetime) => json!(datetime.to_string()),
        value => serde_json::to_value(value).unwrap_or_else(|_| json!(source)),
    }
}

fn value_at<'a>(context: &'a Value, path: &str) -> Option<&'a Value> {
    path.split('.').try_fold(context, |value, key| {
        if let Some(array) = value.as_array() {
            key.parse::<usize>().ok().and_then(|index| array.get(index))
        } else {
            value.get(key)
        }
    })
}

fn has_unfixed_models(context: &Value, path: &str, fixed: &FixedPaths) -> bool {
    value_at(context, path)
        .and_then(Value::as_object)
        .is_some_and(|models| {
            models
                .keys()
                .any(|component| !fixed.contains(&format!("{path}.{component}")))
        })
}

fn multi_stage_has_prompts(context: &Value, fixed: &FixedPaths) -> bool {
    let Some(stages) = context.get("stages").and_then(Value::as_array) else {
        return true;
    };
    !fixed.contains("simulation.initial_time")
        || stages.iter().enumerate().any(|(stage_index, stage)| {
            [
                "system_path",
                "forecast_horizon",
                "forecast_interval",
                "resolution",
                "network.formulation",
            ]
            .iter()
            .any(|field| !fixed.contains(&format!("stages.{stage_index}.{field}")))
                || ["device_models", "service_models"].iter().any(|field| {
                    stage
                        .get(*field)
                        .and_then(Value::as_array)
                        .is_some_and(|models| {
                            models.iter().enumerate().any(|(model_index, _)| {
                                !fixed.contains(&format!(
                                    "stages.{stage_index}.{field}.{model_index}.formulation"
                                ))
                            })
                        })
                })
        })
}

fn normalize_template_id(template_id: &str) -> String {
    template_id.replace('-', "_")
}

fn ensure_template_exists(templates: &[stem::TemplateInfo], template_id: &str) -> Result<()> {
    if templates.iter().any(|template| template.id == template_id) {
        Ok(())
    } else {
        let available = templates
            .iter()
            .map(|template| template.id.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        bail!("unknown template `{template_id}`. Available templates: {available}")
    }
}

fn is_cancelled(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<io::Error>()
            .is_some_and(|error| error.kind() == io::ErrorKind::Interrupted)
    })
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    use clap::Parser;
    use serde_json::json;
    use stem::{default_config, set_value, string_at};

    use super::{
        Cli, PromptChoice, StemTheme, Theme, ThemeState, all_prompt_values, apply_cli_values,
        catalog_entries, device_class_hint, device_components, expand_multi_selection,
        prompts_needed, system_json_suggestions,
    };

    #[test]
    fn multiselect_can_exclude_choices_after_selecting_all() {
        let choices = vec![
            (
                "thermal".to_owned(),
                "Thermal".to_owned(),
                "Current: UC".to_owned(),
            ),
            (
                "storage".to_owned(),
                "Storage".to_owned(),
                "Optional".to_owned(),
            ),
        ];

        assert_eq!(
            all_prompt_values(&choices),
            vec![
                PromptChoice::Named("thermal".to_owned()),
                PromptChoice::Named("storage".to_owned())
            ]
        );
        assert_eq!(
            expand_multi_selection(vec![PromptChoice::Named("thermal".to_owned())]),
            vec!["thermal"]
        );
    }

    #[test]
    fn short_system_and_output_flags_parse_with_config_and_prompt_controls() {
        let cli = Cli::try_parse_from([
            "stem",
            "-i",
            "system.json",
            "-o",
            "run.jl",
            "--config",
            "https://example.org/run.toml",
            "--no-prompt",
            "--yes",
        ])
        .expect("parse CLI arguments");

        assert_eq!(
            cli.input.as_deref(),
            Some(std::path::Path::new("system.json"))
        );
        assert_eq!(cli.output.as_deref(), Some(std::path::Path::new("run.jl")));
        assert_eq!(cli.config.as_deref(), Some("https://example.org/run.toml"));
        assert!(cli.no_prompt);
        assert!(cli.yes);
    }

    #[test]
    fn explicit_model_flags_override_the_starting_config() {
        let cli = Cli::try_parse_from([
            "stem",
            "-i",
            "system.json",
            "-o",
            "run.jl",
            "--horizon",
            "P2D",
            "--solver",
            "Gurobi",
            "--device-model",
            "ThermalStandard=ThermalBasicUnitCommitment",
            "--no-prompt",
            "--yes",
        ])
        .expect("parse CLI arguments");
        let mut config = default_config("decision_model").expect("default config");
        set_value(
            &mut config,
            "solver.backends.Gurobi.package",
            json!("Gurobi"),
        )
        .expect("configure solver package");
        set_value(
            &mut config,
            "solver.backends.Gurobi.optimizer",
            json!("Gurobi.Optimizer"),
        )
        .expect("configure Julia optimizer");

        let fixed =
            apply_cli_values(&cli, &mut config, "decision_model").expect("apply explicit flags");

        assert_eq!(string_at(&config, "timing.horizon"), Some("P2D"));
        assert_eq!(string_at(&config, "solver.selected"), Some("Gurobi"));
        assert_eq!(
            string_at(&config, "formulations.device_models.ThermalStandard"),
            Some("ThermalBasicUnitCommitment")
        );
        assert!(fixed.contains("timing.horizon"));
        assert!(fixed.contains("solver.selected"));
        assert!(fixed.contains("formulations.device_models.ThermalStandard"));
    }

    #[test]
    fn unconfigured_solver_flag_fails_before_prompting() {
        let cli =
            Cli::try_parse_from(["stem", "--solver", "Gurobi"]).expect("parse solver selection");
        let mut config = default_config("decision_model").expect("default config");

        let error = apply_cli_values(&cli, &mut config, "decision_model")
            .expect_err("reject an unconfigured backend");

        assert!(
            error
                .to_string()
                .contains("solver `Gurobi` has no configured package")
        );
    }

    #[test]
    fn set_flag_accepts_iso_durations_and_toml_scalars() {
        let cli = Cli::try_parse_from([
            "stem",
            "--set",
            "timing.horizon=P2D",
            "--set",
            "solver.attributes.mip_rel_gap=0.01",
            "--set",
            "scenario.initial_time=2024-01-01T00:00:00",
        ])
        .expect("parse CLI arguments");
        let mut config = default_config("decision_model").expect("default config");

        apply_cli_values(&cli, &mut config, "decision_model").expect("apply settings");

        assert_eq!(string_at(&config, "timing.horizon"), Some("P2D"));
        assert_eq!(
            string_at(&config, "scenario.initial_time"),
            Some("2024-01-01T00:00:00")
        );
        assert_eq!(
            config
                .get("solver")
                .and_then(|solver| solver.get("attributes"))
                .and_then(|attributes| attributes.get("mip_rel_gap")),
            Some(&json!(0.01))
        );
    }

    #[test]
    fn device_attributes_require_and_update_a_configured_model() {
        let missing_model_cli = Cli::try_parse_from([
            "stem",
            "--device-attribute",
            "EnergyReservoirStorage.reservation=false",
        ])
        .expect("parse device attribute");
        let mut config = default_config("decision_model").expect("default config");
        let error = apply_cli_values(&missing_model_cli, &mut config, "decision_model")
            .expect_err("attribute without a formulation should fail");
        assert!(error.to_string().contains("no formulation configured"));

        let cli = Cli::try_parse_from([
            "stem",
            "--device-model",
            "EnergyReservoirStorage=StorageDispatchWithReserves",
            "--device-attribute",
            "EnergyReservoirStorage.reservation=false",
        ])
        .expect("parse storage options");
        apply_cli_values(&cli, &mut config, "decision_model").expect("apply storage options");

        assert_eq!(
            string_at(&config, "formulations.device_models.EnergyReservoirStorage"),
            Some("StorageDispatchWithReserves")
        );
        assert_eq!(
            config
                .get("formulations")
                .and_then(|formulations| formulations.get("device_options"))
                .and_then(|options| options.get("EnergyReservoirStorage"))
                .and_then(|formulations| formulations.get("StorageDispatchWithReserves"))
                .and_then(|options| options.get("attributes"))
                .and_then(|attributes| attributes.get("reservation")),
            Some(&json!(false))
        );
    }

    #[test]
    fn configured_optional_device_formulations_are_selectable() {
        let config = default_config("decision_model").expect("default config");

        assert!(device_components(&config).contains(&"EnergyReservoirStorage".to_owned()));
    }

    #[test]
    fn explicitly_selected_device_prompts_only_for_unset_configured_options() {
        let config = json!({
            "scenario": {"name": "winter", "initial_time": "2020-01-01T00:00:00"},
            "timing": {"horizon": "P1D", "resolution": "PT1H"},
            "solver": {
                "selected": "HiGHS",
                "backends": {
                    "HiGHS": {"package": "HiGHS", "optimizer": "HiGHS.Optimizer"}
                }
            },
            "formulations": {
                "network": {"formulation": "CopperPlatePowerModel"},
                "device_models": {"ThermalStandard": "ThermalStandardUnitCommitment"},
                "service_models": {},
                "device_options": {
                    "ThermalStandard": {
                        "ThermalBasicUnitCommitment": {"use_slacks": false}
                    }
                }
            }
        });
        let base_args = [
            "stem",
            "-i",
            "system.json",
            "-o",
            "run.jl",
            "--horizon",
            "P2D",
            "--resolution",
            "PT15M",
            "--solver",
            "HiGHS",
            "--network-formulation",
            "CopperPlatePowerModel",
            "--device-model",
            "ThermalStandard=ThermalBasicUnitCommitment",
            "--set",
            "scenario.name=manual",
            "--set",
            "scenario.initial_time=2024-01-01T00:00:00",
        ];
        let cli = Cli::try_parse_from(base_args).expect("parse selected model options");
        let mut configured = config.clone();
        let fixed = apply_cli_values(&cli, &mut configured, "decision_model")
            .expect("apply selected model");
        assert!(prompts_needed(&cli, &configured, "decision_model", &fixed));

        let mut explicit_slacks_args = base_args.to_vec();
        explicit_slacks_args.extend([
            "--set",
            "formulations.device_options.ThermalStandard.ThermalBasicUnitCommitment.use_slacks=false",
        ]);
        let cli = Cli::try_parse_from(explicit_slacks_args).expect("parse explicitly set slacks");
        let mut configured = config;
        let fixed = apply_cli_values(&cli, &mut configured, "decision_model")
            .expect("apply explicit slacks");
        assert!(!prompts_needed(&cli, &configured, "decision_model", &fixed));
    }

    #[test]
    fn solver_and_network_choices_include_descriptions() {
        let decision = default_config("decision_model").expect("decision config");
        let sequential = default_config("sequential_simulation").expect("sequential config");

        assert!(catalog_entries(&decision, "solver.backends").iter().any(
            |(name, description)| name == "HiGHS" && description.contains("mixed-integer")
        ));
        assert!(
            catalog_entries(&decision, "formulations.network.choices")
                .iter()
                .any(
                    |(name, description)| name == "PTDFPowerModel" && description.contains("PTDFs")
                )
        );
        assert!(
            catalog_entries(&sequential, "stages.1.network.choices")
                .iter()
                .any(|(name, _)| name == "DCPPowerModel")
        );
    }

    #[test]
    fn active_choices_render_descriptions_in_a_separate_block() {
        let select = <StemTheme as Theme>::format_select_item(
            &StemTheme,
            &ThemeState::Active,
            true,
            "HiGHS",
            "Open-source linear optimization solver",
        );
        let multiselect = <StemTheme as Theme>::format_multiselect_item(
            &StemTheme,
            &ThemeState::Active,
            false,
            true,
            "ThermalStandard",
            "Current formulation: ThermalStandardUnitCommitment",
        );

        let select_label = select.find("HiGHS").expect("select label");
        let select_description = select
            .find("Description\n")
            .expect("select description block");
        let select_text = select
            .find("Open-source linear optimization solver")
            .expect("select description text");
        assert!(select[select_label..select_description].contains('\n'));
        assert!(select_description < select_text);

        let multiselect_label = multiselect
            .find("ThermalStandard")
            .expect("multiselect label");
        let multiselect_description = multiselect
            .find("Description\n")
            .expect("multiselect description block");
        let multiselect_text = multiselect
            .find("Current formulation: ThermalStandardUnitCommitment")
            .expect("multiselect description text");
        assert!(multiselect[multiselect_label..multiselect_description].contains('\n'));
        assert!(multiselect_description < multiselect_text);
    }

    #[test]
    fn system_path_suggestions_include_json_files_and_directories() {
        let directory = TestDirectory::new();
        let inputs = directory.path().join("inputs");
        std::fs::create_dir(&inputs).expect("create nested input directory");
        std::fs::write(directory.path().join("dispatch.json"), "{}").expect("write JSON file");
        std::fs::write(directory.path().join("notes.txt"), "text").expect("write text file");
        std::fs::write(inputs.join("system.json"), "{}").expect("write nested JSON file");

        let query = format!(
            "{}{separator}",
            directory.path().display(),
            separator = std::path::MAIN_SEPARATOR
        );
        let suggestions = system_json_suggestions(&query);

        assert_eq!(
            suggestions,
            vec![
                directory
                    .path()
                    .join("dispatch.json")
                    .to_string_lossy()
                    .into_owned(),
                format!(
                    "{}{separator}",
                    inputs.display(),
                    separator = std::path::MAIN_SEPARATOR
                ),
            ]
        );

        let nested_query = format!(
            "{}{separator}sys",
            inputs.display(),
            separator = std::path::MAIN_SEPARATOR
        );
        assert_eq!(
            system_json_suggestions(&nested_query),
            vec![inputs.join("system.json").to_string_lossy().into_owned()]
        );
    }

    #[test]
    fn system_path_suggestions_are_limited_to_ten_matches() {
        let directory = TestDirectory::new();
        for index in 0..12 {
            std::fs::write(
                directory.path().join(format!("system-{index:02}.json")),
                "{}",
            )
            .expect("write JSON file");
        }
        let query = format!(
            "{}{separator}",
            directory.path().display(),
            separator = std::path::MAIN_SEPARATOR
        );

        assert_eq!(system_json_suggestions(&query).len(), 10);
    }

    #[test]
    fn device_class_hints_describe_current_and_available_formulations() {
        let config = default_config("decision_model").expect("default config");

        let hint = device_class_hint(&config, "ThermalStandard");

        assert!(hint.contains("Current: ThermalStandardUnitCommitment"));
        assert!(hint.contains("2 configured formulations"));
    }

    #[test]
    fn supplying_all_selectable_values_skips_the_wizard() {
        let cli = Cli::try_parse_from([
            "stem",
            "-i",
            "system.json",
            "-o",
            "run.jl",
            "--horizon",
            "P2D",
            "--resolution",
            "PT15M",
            "--solver",
            "HiGHS",
            "--network-formulation",
            "PTDFPowerModel",
            "--device-model",
            "ThermalStandard=ThermalBasicUnitCommitment",
            "--set",
            "scenario.name=manual",
            "--set",
            "scenario.initial_time=2024-01-01T00:00:00",
        ])
        .expect("parse CLI arguments");
        let mut config = json!({
            "timing": {"horizon": "P1D", "resolution": "PT1H"},
            "solver": {
                "selected": "HiGHS",
                "backends": {
                    "HiGHS": {"package": "HiGHS", "optimizer": "HiGHS.Optimizer"}
                }
            },
            "formulations": {
                "network": {"formulation": "CopperPlatePowerModel"},
                "device_models": {"ThermalStandard": "ThermalStandardUnitCommitment"},
                "service_models": {}
            }
        });
        let fixed =
            apply_cli_values(&cli, &mut config, "decision_model").expect("apply explicit choices");

        assert!(!prompts_needed(&cli, &config, "decision_model", &fixed));
    }

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock is after Unix epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "stem-system-path-test-{}-{timestamp}",
                std::process::id()
            ));
            std::fs::create_dir(&path).expect("create test directory");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}
