use std::path::Path;

use anyhow::{Context, Result, bail};
use include_dir::{Dir, include_dir};
use minijinja::{Environment, UndefinedBehavior};
use serde_json::{Value, json};

static TEMPLATE_FILES: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/templates");
static EXAMPLE_CONFIGS: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/examples");

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TemplateInfo {
    pub id: String,
    pub name: String,
}

/// Returns embedded templates ordered by display name.
///
/// # Errors
///
/// Returns an error if an embedded configuration is invalid or if no templates are packaged.
pub fn available_templates() -> Result<Vec<TemplateInfo>> {
    let mut templates = Vec::new();

    for file in TEMPLATE_FILES.files() {
        let Some(file_name) = file.path().file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let Some(id) = file_name.strip_suffix(".jl.j2") else {
            continue;
        };
        let config = default_config(id)?;
        let name = string_at(&config, "stem.name").unwrap_or(id).to_owned();
        templates.push(TemplateInfo {
            id: id.to_owned(),
            name,
        });
    }

    templates.sort_by(|left, right| left.name.cmp(&right.name));
    if templates.is_empty() {
        bail!("no templates found in the packaged template directory");
    }
    Ok(templates)
}

/// Loads the embedded example configuration for a template.
///
/// # Errors
///
/// Returns an error if the configuration is missing or cannot be parsed.
pub fn default_config(template_id: &str) -> Result<Value> {
    let file_name = format!("{template_id}.toml");
    let file = EXAMPLE_CONFIGS
        .get_file(&file_name)
        .with_context(|| format!("no default configuration exists for template `{template_id}`"))?;
    parse_config(
        file.contents_utf8()
            .context("default config is not UTF-8")?,
        &file_name,
    )
}

/// Loads a JSON or TOML configuration from a local path or HTTPS URL.
///
/// # Errors
///
/// Returns an error if the source cannot be read, is not HTTPS when remote, has an unsupported
/// extension, or contains invalid configuration data.
pub fn load_config(source: &str) -> Result<Value> {
    let (contents, label, format_hint) = if source.starts_with("https://") {
        let response = ureq::get(source)
            .call()
            .with_context(|| format!("failed to download config from `{source}`"))?;
        let contents = response
            .into_body()
            .read_to_string()
            .with_context(|| format!("failed to read config from `{source}`"))?;
        let path = source.split(['?', '#']).next().unwrap_or(source);
        let format_hint = Path::new(path)
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or_default()
            .to_owned();
        (contents, source.to_owned(), format_hint)
    } else if source.starts_with("http://") {
        bail!("remote configs must use HTTPS");
    } else {
        let path = Path::new(source);
        let contents = std::fs::read_to_string(path)
            .with_context(|| format!("failed to read config `{}`", path.display()))?;
        let format_hint = path
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or_default()
            .to_owned();
        (contents, path.display().to_string(), format_hint)
    };

    parse_config_with_format(&contents, &label, &format_hint)
}

/// Renders a Julia script from an embedded template and JSON context.
///
/// # Errors
///
/// Returns an error if the template is missing, its context is invalid, or rendering fails.
pub fn render(template_id: &str, context: &Value) -> Result<String> {
    let template_file = format!("{template_id}.jl.j2");
    let template_source = TEMPLATE_FILES
        .get_file(&template_file)
        .with_context(|| format!("unknown template `{template_id}`"))?
        .contents_utf8()
        .context("template is not UTF-8")?;

    let mut environment = Environment::new();
    environment.set_undefined_behavior(UndefinedBehavior::Strict);
    environment.set_loader(|name| {
        Ok(TEMPLATE_FILES
            .get_file(name)
            .and_then(|file| file.contents_utf8())
            .map(str::to_owned))
    });
    environment
        .add_template(&template_file, template_source)
        .with_context(|| format!("failed to load template `{template_id}`"))?;
    let context = julia_context(template_id, context)?;
    environment
        .get_template(&template_file)
        .with_context(|| format!("failed to find template `{template_id}`"))?
        .render(&context)
        .with_context(|| format!("failed to generate Julia script from `{template_id}`"))
}

/// Returns the package and optimizer configured for the selected solver.
///
/// # Errors
///
/// Returns an error if the selected solver or either of its configured values is missing or empty.
pub fn solver_backend(context: &Value) -> Result<(&str, &str)> {
    let selected_solver = string_at(context, "solver.selected")
        .context("config must select a solver in `solver.selected`")?;
    let backend_path = format!("solver.backends.{selected_solver}");
    let package = string_at(context, &format!("{backend_path}.package"))
        .with_context(|| format!("solver `{selected_solver}` has no configured package"))?;
    if package.trim().is_empty() {
        bail!("solver `{selected_solver}` has an empty package name");
    }
    let optimizer = string_at(context, &format!("{backend_path}.optimizer"))
        .with_context(|| format!("solver `{selected_solver}` has no configured Julia optimizer"))?;
    if optimizer.trim().is_empty() {
        bail!("solver `{selected_solver}` has an empty Julia optimizer");
    }
    Ok((package, optimizer))
}

fn julia_context(template_id: &str, context: &Value) -> Result<Value> {
    let mut context = context.clone();
    solver_backend(&context)?;

    let duration_paths = if template_id == "decision_model" {
        vec!["timing.horizon".to_owned(), "timing.resolution".to_owned()]
    } else if template_id == "sequential_simulation" {
        let stage_count = context
            .get("stages")
            .and_then(Value::as_array)
            .context("sequential config must contain a `stages` array")?
            .len();
        (0..stage_count)
            .flat_map(|index| {
                [
                    format!("stages.{index}.forecast_horizon"),
                    format!("stages.{index}.forecast_interval"),
                    format!("stages.{index}.resolution"),
                ]
            })
            .collect()
    } else {
        Vec::new()
    };

    for path in duration_paths {
        let duration = string_at(&context, &path)
            .with_context(|| format!("`{path}` must be an ISO 8601 duration string"))?
            .to_owned();
        let period = parse_iso_duration(&duration)
            .with_context(|| format!("invalid ISO 8601 duration in `{path}`"))?;
        set_value(&mut context, &path, json!(period))?;
    }
    Ok(context)
}

fn parse_iso_duration(source: &str) -> Result<String> {
    let units = source
        .strip_prefix('P')
        .context("duration must begin with `P`")?;
    let mut in_time = false;
    let mut saw_time_marker = false;
    let mut saw_time_unit = false;
    let mut saw_week = false;
    let mut saw_other_unit = false;
    let mut number = String::new();
    let mut date_rank = 0;
    let mut time_rank = 0;
    let mut total_seconds = 0_i64;

    for character in units.chars() {
        if character == 'T' {
            if saw_time_marker || !number.is_empty() {
                bail!("`T` must appear once between date and time units");
            }
            saw_time_marker = true;
            in_time = true;
            continue;
        }
        if character.is_ascii_digit() {
            number.push(character);
            continue;
        }

        let amount = number
            .parse::<i64>()
            .with_context(|| format!("missing whole-number amount before `{character}`"))?;
        number.clear();

        let (rank, seconds_per_unit) = match (in_time, character) {
            (false, 'W') => (1, 7 * 24 * 60 * 60),
            (false, 'D') => (2, 24 * 60 * 60),
            (true, 'H') => (1, 60 * 60),
            (true, 'M') => (2, 60),
            (true, 'S') => (3, 1),
            (false, 'Y' | 'M') => {
                bail!("calendar years and months are not supported for fixed simulation periods")
            }
            _ => bail!("unsupported ISO 8601 duration unit `{character}`"),
        };
        let last_rank = if in_time {
            saw_time_unit = true;
            &mut time_rank
        } else {
            &mut date_rank
        };
        if rank <= *last_rank {
            bail!("ISO 8601 duration units must be unique and ordered");
        }
        *last_rank = rank;

        if character == 'W' {
            if saw_other_unit {
                bail!("ISO 8601 week durations cannot be combined with other units");
            }
            saw_week = true;
        } else {
            if saw_week {
                bail!("ISO 8601 week durations cannot be combined with other units");
            }
            saw_other_unit = true;
        }
        let unit_seconds = amount
            .checked_mul(seconds_per_unit)
            .context("duration is too large to represent as a Julia period")?;
        total_seconds = total_seconds
            .checked_add(unit_seconds)
            .context("duration is too large to represent as a Julia period")?;
    }

    if !number.is_empty() {
        bail!("duration amount is missing a unit");
    }
    if saw_time_marker && !saw_time_unit {
        bail!("`T` must be followed by a time unit");
    }
    if total_seconds == 0 {
        bail!("duration must be greater than zero");
    }
    if saw_week {
        return Ok(format!("Week({})", total_seconds / (7 * 24 * 60 * 60)));
    }
    for (unit_seconds, julia_type) in [
        (24 * 60 * 60, "Day"),
        (60 * 60, "Hour"),
        (60, "Minute"),
        (1, "Second"),
    ] {
        if total_seconds % unit_seconds == 0 {
            return Ok(format!("{julia_type}({})", total_seconds / unit_seconds));
        }
    }
    Ok(format!("Second({total_seconds})"))
}

/// Sets a value at a dotted JSON object or array path, creating missing containers as needed.
///
/// # Errors
///
/// Returns an error if the path is empty, an array index is invalid or out of range, or the path
/// crosses a value that cannot contain the requested segment.
pub fn set_value(context: &mut Value, path: &str, value: Value) -> Result<()> {
    let parts: Vec<_> = path.split('.').collect();
    if parts.is_empty() || parts.iter().any(|part| part.is_empty()) {
        bail!("config path must not be empty");
    }
    set_nested(context, &parts, value, path)
}

fn set_nested(context: &mut Value, parts: &[&str], value: Value, path: &str) -> Result<()> {
    let (part, rest) = parts
        .split_first()
        .context("config path must not be empty")?;
    if let Some(object) = context.as_object_mut() {
        if rest.is_empty() {
            object.insert((*part).to_owned(), value);
            return Ok(());
        }
        let next = object.entry((*part).to_owned()).or_insert_with(|| {
            if rest[0].parse::<usize>().is_ok() {
                Value::Array(Vec::new())
            } else {
                Value::Object(serde_json::Map::new())
            }
        });
        return set_nested(next, rest, value, path);
    }
    if let Some(array) = context.as_array_mut() {
        let index = part
            .parse::<usize>()
            .with_context(|| format!("array path segment `{part}` in `{path}` must be an index"))?;
        let item = array
            .get_mut(index)
            .with_context(|| format!("array index {index} is out of range in `{path}`"))?;
        if rest.is_empty() {
            *item = value;
            return Ok(());
        }
        return set_nested(item, rest, value, path);
    }
    bail!("config path `{path}` does not point through a table or array")
}

/// Returns the string at a dotted JSON object or array path, if present.
#[must_use]
pub fn string_at<'a>(context: &'a Value, path: &str) -> Option<&'a str> {
    path.split('.')
        .try_fold(context, |value, key| {
            if let Some(array) = value.as_array() {
                key.parse::<usize>().ok().and_then(|index| array.get(index))
            } else {
                value.get(key)
            }
        })?
        .as_str()
}

fn parse_config(contents: &str, source: &str) -> Result<Value> {
    let extension = Path::new(source)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default();
    parse_config_with_format(contents, source, extension)
}

fn parse_config_with_format(contents: &str, source: &str, format: &str) -> Result<Value> {
    let context = match format.to_ascii_lowercase().as_str() {
        "json" => serde_json::from_str(contents)
            .with_context(|| format!("failed to parse JSON config `{source}`"))?,
        "toml" => {
            let parsed = toml::from_str::<toml::Value>(contents)
                .with_context(|| format!("failed to parse TOML config `{source}`"))?;
            serde_json::to_value(parsed)
                .with_context(|| format!("failed to convert TOML config `{source}`"))?
        }
        _ => bail!("config `{source}` must be a `.toml` or `.json` file"),
    };

    if !context.is_object() {
        bail!("config `{source}` must have an object or table at its root");
    }
    Ok(context)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{available_templates, default_config, render, set_value, string_at};

    #[test]
    fn template_catalog_uses_template_files_and_config_names() {
        let templates = available_templates().expect("template catalog");

        assert_eq!(templates.len(), 2);
        assert!(
            templates
                .iter()
                .any(|template| template.id == "decision_model")
        );
        assert!(
            templates
                .iter()
                .any(|template| template.id == "sequential_simulation")
        );
    }

    #[test]
    fn iso_duration_parser_emits_julia_periods_and_rejects_calendar_units() {
        assert_eq!(
            super::parse_iso_duration("P1DT12H").expect("parse compound duration"),
            "Hour(36)"
        );
        assert_eq!(
            super::parse_iso_duration("P1W").expect("parse week duration"),
            "Week(1)"
        );
        assert!(super::parse_iso_duration("P1M").is_err());
    }

    #[test]
    fn decision_model_template_preserves_solver_formulation_and_timing() {
        let mut config = default_config("decision_model").expect("default config");
        set_value(&mut config, "system_path", json!("/data/system.json")).expect("set system path");
        set_value(&mut config, "timing.horizon", json!("P1D")).expect("set horizon");
        set_value(&mut config, "timing.resolution", json!("PT15M")).expect("set resolution");

        let rendered = render("decision_model", &config).expect("render decision model");

        assert!(rendered.contains("const SYSTEM_PATH = \"/data/system.json\""));
        assert!(rendered.contains("HiGHS.Optimizer"));
        assert!(rendered.contains("ThermalStandardUnitCommitment"));
        assert!(rendered.contains("CopperPlatePowerModel"));
        assert!(rendered.contains("horizon = Day(1)"));
        assert!(rendered.contains("resolution = Minute(15)"));
    }

    #[test]
    fn selected_network_formulation_is_rendered() {
        let mut config = default_config("decision_model").expect("default config");
        set_value(
            &mut config,
            "formulations.network.formulation",
            json!("PTDFPowerModel"),
        )
        .expect("select PTDF network formulation");

        let rendered = render("decision_model", &config).expect("render selected network");

        assert!(rendered.contains("NetworkModel(PTDFPowerModel"));
    }

    #[test]
    fn invalid_simulation_duration_is_rejected_before_rendering() {
        let mut config = default_config("decision_model").expect("default config");
        set_value(&mut config, "timing.resolution", json!("Hour(1)"))
            .expect("set invalid resolution");

        let error = render("decision_model", &config).expect_err("reject Julia expressions");

        assert!(format!("{error:#}").contains("ISO 8601 duration"));
    }

    #[test]
    fn device_model_options_are_emitted_only_for_the_selected_formulation() {
        let mut config = default_config("decision_model").expect("default config");
        set_value(
            &mut config,
            "formulations.device_models.ThermalStandard",
            json!("ThermalBasicUnitCommitment"),
        )
        .expect("select thermal formulation");
        set_value(
            &mut config,
            "formulations.device_options.ThermalStandard.ThermalBasicUnitCommitment.use_slacks",
            json!(true),
        )
        .expect("set thermal slacks");
        set_value(
            &mut config,
            "formulations.device_options.ThermalStandard.ThermalBasicUnitCommitment.attributes",
            json!({"reservation": false}),
        )
        .expect("set thermal attributes");
        set_value(
            &mut config,
            "formulations.device_options.ThermalStandard.ThermalBasicUnitCommitment.kwargs",
            json!(["duals = [ActivePowerLimitConstraint]"]),
        )
        .expect("set extra Julia keywords");
        set_value(
            &mut config,
            "formulations.device_options.ThermalStandard.ThermalStandardUnitCommitment.kwargs",
            json!(["must_not_appear = true"]),
        )
        .expect("set unselected formulation keyword");

        let rendered = render("decision_model", &config).expect("render device options");

        assert!(rendered.contains("use_slacks = true"), "{rendered}");
        assert!(rendered.contains("\"reservation\" => false"));
        assert!(rendered.contains("duals = [ActivePowerLimitConstraint]"));
        assert!(!rendered.contains("must_not_appear"));
    }

    #[test]
    fn selected_solver_resolves_package_and_optimizer_as_one_choice() {
        let mut config = default_config("decision_model").expect("default config");
        set_value(&mut config, "solver.selected", json!("Gurobi")).expect("select solver");
        set_value(
            &mut config,
            "solver.backends.Gurobi.package",
            json!("Gurobi"),
        )
        .expect("set solver package");
        set_value(
            &mut config,
            "solver.backends.Gurobi.optimizer",
            json!("Gurobi.Optimizer"),
        )
        .expect("set Julia optimizer");

        let rendered = render("decision_model", &config).expect("render selected solver");

        assert!(rendered.contains("using Gurobi"));
        assert!(rendered.contains("Gurobi.Optimizer"));
        assert!(!rendered.contains("using HiGHS"));
        assert!(!rendered.contains("HiGHS.Optimizer"));
    }

    #[test]
    fn selected_solver_requires_a_complete_backend_entry() {
        let mut config = default_config("decision_model").expect("default config");
        set_value(&mut config, "solver.selected", json!("Unavailable"))
            .expect("select unavailable solver");

        let error = render("decision_model", &config).expect_err("reject missing backend");

        assert!(format!("{error:#}").contains("solver `Unavailable` has no configured package"));
    }

    #[test]
    fn custom_device_formulation_without_options_uses_the_simple_constructor() {
        let mut config = default_config("decision_model").expect("default config");
        set_value(
            &mut config,
            "formulations.device_models.ThermalStandard",
            json!("CustomUnitCommitment"),
        )
        .expect("set custom formulation");

        let rendered = render("decision_model", &config).expect("render custom formulation");

        assert!(
            rendered.contains("set_device_model!(template, ThermalStandard, CustomUnitCommitment)")
        );
    }

    #[test]
    fn sequential_template_keeps_build_execution_and_reporting() {
        let config = default_config("sequential_simulation").expect("default config");
        let rendered = render("sequential_simulation", &config).expect("render sequential plan");

        assert!(rendered.contains("transform_single_time_series!(system_1, Day(2), Day(1))"));
        assert!(rendered.contains("transform_single_time_series!(system_2, Hour(1), Minute(15))"));
        assert!(rendered.contains("NetworkModel(PTDFPowerModel; use_slacks = true)"));
        assert!(rendered.contains("resolution = Hour(1)"));
        assert!(rendered.contains("resolution = Minute(5)"));
        assert!(rendered.contains("build!(simulation)"));
        assert!(rendered.contains("execute!(simulation"));
        assert!(rendered.contains("write_report(REPORT_PATH, SimulationResults(simulation))"));
    }

    #[test]
    fn config_values_can_be_changed_without_profile_merging() {
        let mut config = default_config("decision_model").expect("default config");
        set_value(
            &mut config,
            "formulations.device_models.ThermalStandard",
            json!("ThermalBasicUnitCommitment"),
        )
        .expect("set device formulation");

        assert_eq!(
            string_at(&config, "formulations.device_models.ThermalStandard"),
            Some("ThermalBasicUnitCommitment")
        );
    }

    #[test]
    fn config_values_can_target_a_stage_by_array_index() {
        let mut config = json!({"stages": [{"forecast_horizon": "PT1H"}]});
        set_value(&mut config, "stages.0.forecast_horizon", json!("P2D"))
            .expect("set stage horizon");

        assert_eq!(string_at(&config, "stages.0.forecast_horizon"), Some("P2D"));
    }
}
