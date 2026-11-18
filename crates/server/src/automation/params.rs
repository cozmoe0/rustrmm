//! Script parameters: definitions saved with a script version and the values a job supplies.
//! Values reach the script as environment variables, so names follow environment rules.

use std::collections::{BTreeMap, HashSet};

use rustrmm_proto::scripts::{is_reserved_env_name, valid_env_name};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_PARAMETERS: usize = 50;
pub const MAX_VALUE_LEN: usize = 8192;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScriptParameter {
    pub name: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub description: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub default: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<String>>,
}

impl ScriptParameter {
    pub fn is_secret(&self) -> bool {
        self.kind == "secret"
    }
}

/// Validates parameter definitions; returns them normalised (trimmed, options only on selects).
pub fn validate_definitions(defs: &[ScriptParameter]) -> Result<Vec<ScriptParameter>, String> {
    if defs.len() > MAX_PARAMETERS {
        return Err(format!(
            "A script can have at most {MAX_PARAMETERS} parameters"
        ));
    }
    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(defs.len());
    for def in defs {
        let name = def.name.trim().to_string();
        if !valid_env_name(&name) {
            return Err(format!(
                "Parameter name '{name}' must match [A-Za-z_][A-Za-z0-9_]{{0,63}}"
            ));
        }
        if is_reserved_env_name(&name) {
            return Err(format!("Parameter name '{name}' is reserved"));
        }
        if !seen.insert(name.to_ascii_uppercase()) {
            return Err(format!("Parameter '{name}' is defined twice"));
        }
        if !matches!(
            def.kind.as_str(),
            "string" | "number" | "boolean" | "select" | "secret"
        ) {
            return Err(format!(
                "Parameter '{name}' has an unknown type (string, number, boolean, select, secret)"
            ));
        }
        if def.label.chars().count() > 120 || def.description.chars().count() > 1000 {
            return Err(format!(
                "Parameter '{name}' has a label or description that is too long"
            ));
        }
        let options = if def.kind == "select" {
            let options: Vec<String> = def
                .options
                .clone()
                .unwrap_or_default()
                .into_iter()
                .map(|o| o.trim().to_string())
                .collect();
            if options.is_empty() || options.len() > 100 {
                return Err(format!("Select parameter '{name}' needs 1–100 options"));
            }
            if options
                .iter()
                .any(|o| o.is_empty() || o.chars().count() > 200)
            {
                return Err(format!(
                    "Select parameter '{name}' has an empty or overlong option"
                ));
            }
            if options.iter().collect::<HashSet<_>>().len() != options.len() {
                return Err(format!("Select parameter '{name}' has duplicate options"));
            }
            Some(options)
        } else {
            None
        };
        let mut normalised = ScriptParameter {
            name: name.clone(),
            label: def.label.trim().to_string(),
            description: def.description.trim().to_string(),
            kind: def.kind.clone(),
            required: def.required,
            default: None,
            options,
        };
        match &def.default {
            None | Some(Value::Null) => {}
            Some(_) if def.kind == "secret" => {
                return Err(format!(
                    "Secret parameter '{name}' cannot have a default (store it as a secret variable)"
                ));
            }
            Some(value) => {
                coerce(&normalised, value)
                    .map_err(|e| format!("Default of parameter '{name}': {e}"))?;
                normalised.default = Some(value.clone());
            }
        }
        out.push(normalised);
    }
    Ok(out)
}

/// One parameter value as the script will see it.
#[derive(Debug, Clone, PartialEq)]
pub struct ParamValue {
    pub value: String,
    pub secret: bool,
}

/// Converts a JSON value to the string a script receives, checking it against the definition.
fn coerce(def: &ScriptParameter, value: &Value) -> Result<String, String> {
    let text = match (def.kind.as_str(), value) {
        ("number", Value::Number(n)) => n.to_string(),
        ("number", Value::String(s)) => {
            let t = s.trim();
            if t.parse::<f64>().map(|f| f.is_finite()).unwrap_or(false) {
                t.to_string()
            } else {
                return Err("must be a number".into());
            }
        }
        ("number", _) => return Err("must be a number".into()),
        ("boolean", Value::Bool(b)) => b.to_string(),
        ("boolean", Value::String(s)) => match s.trim().to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" => "true".into(),
            "false" | "0" | "no" => "false".into(),
            _ => return Err("must be true or false".into()),
        },
        ("boolean", _) => return Err("must be true or false".into()),
        ("select", Value::String(s)) => {
            if def.options.as_ref().is_some_and(|o| o.contains(s)) {
                s.clone()
            } else {
                return Err("is not one of the options".into());
            }
        }
        ("select", _) => return Err("must be one of the options".into()),
        (_, Value::String(s)) => s.clone(),
        (_, Value::Number(n)) => n.to_string(),
        (_, Value::Bool(b)) => b.to_string(),
        _ => return Err("must be text".into()),
    };
    if text.len() > MAX_VALUE_LEN {
        return Err(format!("must be at most {MAX_VALUE_LEN} bytes"));
    }
    if text.contains('\0') {
        return Err("must not contain NUL characters".into());
    }
    Ok(text)
}

/// How missing secret parameters are treated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretRule {
    /// Jobs: secrets are supplied like any other value.
    Supplied,
    /// Policy tasks: documents are stored in plain text, so secret values are refused and a
    /// required secret may come from a secret variable of the same name instead.
    FromVariables,
}

/// Validates job parameter values against a version's definitions: unknown names, required
/// values, types and select options. Missing optional values fall back to their default.
pub fn validate_values(
    defs: &[ScriptParameter],
    values: &serde_json::Map<String, Value>,
    secrets: SecretRule,
) -> Result<BTreeMap<String, ParamValue>, String> {
    for key in values.keys() {
        if !defs.iter().any(|d| &d.name == key) {
            return Err(format!("Unknown parameter '{key}'"));
        }
    }
    let mut out = BTreeMap::new();
    for def in defs {
        let supplied = values.get(&def.name).filter(|v| !v.is_null());
        let supplied = supplied
            .filter(|v| !matches!(v, Value::String(s) if s.is_empty() && def.kind != "string"));
        if def.is_secret() && secrets == SecretRule::FromVariables {
            if supplied.is_some() {
                return Err(format!(
                    "Secret parameter '{}' cannot be stored in a policy; use a secret variable named {} instead",
                    def.name, def.name
                ));
            }
            continue;
        }
        let value = match (supplied, &def.default) {
            (Some(v), _) => v,
            (None, Some(default)) => default,
            (None, None) if def.required => {
                return Err(format!("Parameter '{}' is required", def.name));
            }
            (None, None) => continue,
        };
        let text = coerce(def, value).map_err(|e| format!("Parameter '{}' {e}", def.name))?;
        if def.required && text.is_empty() {
            return Err(format!("Parameter '{}' is required", def.name));
        }
        out.insert(
            def.name.clone(),
            ParamValue {
                value: text,
                secret: def.is_secret(),
            },
        );
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn def(name: &str, kind: &str, required: bool) -> ScriptParameter {
        ScriptParameter {
            name: name.into(),
            label: String::new(),
            description: String::new(),
            kind: kind.into(),
            required,
            default: None,
            options: (kind == "select").then(|| vec!["a".into(), "b".into()]),
        }
    }

    #[test]
    fn definitions_reject_bad_and_reserved_names() {
        assert!(validate_definitions(&[def("ServiceName", "string", true)]).is_ok());
        for bad in [
            "1abc",
            "a-b",
            "",
            "PATH",
            "path",
            "RUSTRMM_X",
            "Temp",
            "LD_PRELOAD",
        ] {
            assert!(
                validate_definitions(&[def(bad, "string", false)]).is_err(),
                "{bad} should be refused"
            );
        }
        assert!(
            validate_definitions(&[def("a", "string", false), def("A", "number", false)]).is_err()
        );
        assert!(validate_definitions(&[def("a", "color", false)]).is_err());
        let mut select = def("pick", "select", false);
        select.options = Some(vec![]);
        assert!(validate_definitions(&[select]).is_err());
        let mut secret = def("token", "secret", false);
        secret.default = Some(json!("x"));
        assert!(validate_definitions(&[secret]).is_err());
        let mut number = def("count", "number", false);
        number.default = Some(json!("ten"));
        assert!(validate_definitions(&[number]).is_err());
    }

    #[test]
    fn values_are_typed_and_required() {
        let mut with_default = def("Days", "number", false);
        with_default.default = Some(json!(30));
        let defs = vec![
            def("Name", "string", true),
            def("Force", "boolean", false),
            def("Pick", "select", false),
            def("Token", "secret", false),
            with_default,
        ];
        let ok = validate_values(
            &defs,
            json!({ "Name": "Spooler", "Force": "yes", "Pick": "b", "Token": "s3cret!" })
                .as_object()
                .expect("object"),
            SecretRule::Supplied,
        )
        .expect("valid");
        assert_eq!(ok["Name"].value, "Spooler");
        assert_eq!(ok["Force"].value, "true");
        assert_eq!(ok["Days"].value, "30", "default applied");
        assert!(ok["Token"].secret);

        let obj = |v: Value| v.as_object().expect("object").clone();
        assert!(
            validate_values(&defs, &obj(json!({})), SecretRule::Supplied).is_err(),
            "required"
        );
        assert!(validate_values(&defs, &obj(json!({ "Name": "" })), SecretRule::Supplied).is_err());
        assert!(
            validate_values(
                &defs,
                &obj(json!({ "Name": "x", "Pick": "z" })),
                SecretRule::Supplied
            )
            .is_err()
        );
        assert!(
            validate_values(
                &defs,
                &obj(json!({ "Name": "x", "Days": "many" })),
                SecretRule::Supplied
            )
            .is_err()
        );
        assert!(
            validate_values(
                &defs,
                &obj(json!({ "Name": "x", "Bogus": 1 })),
                SecretRule::Supplied
            )
            .is_err()
        );
        assert!(
            validate_values(
                &defs,
                &obj(json!({ "Name": "x", "Force": [1] })),
                SecretRule::Supplied
            )
            .is_err()
        );
        // Policies refuse secret values but tolerate a missing required secret.
        let mut required_secret = def("Token", "secret", true);
        required_secret.required = true;
        let policy_defs = vec![required_secret];
        assert!(validate_values(&policy_defs, &obj(json!({})), SecretRule::FromVariables).is_ok());
        assert!(
            validate_values(
                &policy_defs,
                &obj(json!({ "Token": "x" })),
                SecretRule::FromVariables
            )
            .is_err()
        );
        assert!(validate_values(&policy_defs, &obj(json!({})), SecretRule::Supplied).is_err());
    }
}
