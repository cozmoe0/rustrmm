//! Composite device health score (0–100) shown on devices, sites and clients.
//!
//! Deliberately simple and explainable: start at 100 and subtract for each problem, returning
//! the reasons so the UI can show *why* a device scores what it does.

use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
pub struct HealthReport {
    pub score: i64,
    pub reasons: Vec<HealthReason>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HealthReason {
    pub label: String,
    pub penalty: i64,
}

pub struct HealthInputs<'a> {
    pub online: bool,
    pub offline_hours: Option<f64>,
    pub disk_pct: Option<f64>,
    pub mem_pct: Option<f64>,
    pub security: Option<&'a Value>,
    pub system: Option<&'a Value>,
}

pub fn evaluate(inputs: &HealthInputs<'_>) -> HealthReport {
    let mut reasons = Vec::new();
    let mut add = |label: &str, penalty: i64| {
        reasons.push(HealthReason {
            label: label.to_string(),
            penalty,
        })
    };

    if !inputs.online {
        match inputs.offline_hours {
            Some(h) if h > 24.0 * 7.0 => add("Offline for more than a week", 45),
            Some(h) if h > 24.0 => add("Offline for more than a day", 35),
            _ => add("Offline", 25),
        }
    }
    if let Some(disk) = inputs.disk_pct {
        if disk >= 95.0 {
            add("Disk almost full", 25);
        } else if disk >= 90.0 {
            add("Disk above 90%", 15);
        } else if disk >= 80.0 {
            add("Disk above 80%", 5);
        }
    }
    if let Some(mem) = inputs.mem_pct
        && mem >= 95.0
    {
        add("Memory pressure", 5);
    }
    if let Some(sec) = inputs.security {
        let av = sec.get("antivirus").and_then(Value::as_array);
        if let Some(products) = av {
            if products.is_empty() {
                add("No antivirus detected", 15);
            } else if !products
                .iter()
                .any(|p| p.get("enabled").and_then(Value::as_bool).unwrap_or(false))
            {
                add("Antivirus disabled", 20);
            } else if products
                .iter()
                .any(|p| p.get("up_to_date").and_then(Value::as_bool) == Some(false))
            {
                add("Antivirus definitions out of date", 10);
            }
        }
        if sec.pointer("/firewall/enabled").and_then(Value::as_bool) == Some(false) {
            add("Firewall disabled", 10);
        }
        if sec
            .pointer("/encryption/system_volume_encrypted")
            .and_then(Value::as_bool)
            == Some(false)
        {
            add("System drive not encrypted", 10);
        }
    }
    if let Some(sys) = inputs.system
        && sys.get("pending_reboot").and_then(Value::as_bool) == Some(true)
    {
        add("Restart pending", 5);
    }

    let total: i64 = reasons.iter().map(|r| r.penalty).sum();
    HealthReport {
        score: (100 - total).clamp(0, 100),
        reasons,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn healthy_device_scores_100() {
        let sec = json!({ "antivirus": [{ "name": "Defender", "enabled": true, "up_to_date": true }], "firewall": { "enabled": true }, "encryption": { "system_volume_encrypted": true } });
        let r = evaluate(&HealthInputs {
            online: true,
            offline_hours: None,
            disk_pct: Some(40.0),
            mem_pct: Some(50.0),
            security: Some(&sec),
            system: None,
        });
        assert_eq!(r.score, 100);
        assert!(r.reasons.is_empty());
    }

    #[test]
    fn problems_reduce_the_score_with_reasons() {
        let sec = json!({ "antivirus": [{ "name": "Defender", "enabled": false }], "firewall": { "enabled": false } });
        let sys = json!({ "pending_reboot": true });
        let r = evaluate(&HealthInputs {
            online: false,
            offline_hours: Some(30.0),
            disk_pct: Some(92.0),
            mem_pct: None,
            security: Some(&sec),
            system: Some(&sys),
        });
        assert_eq!(r.score, 100 - 35 - 15 - 20 - 10 - 5);
        assert_eq!(r.reasons.len(), 5);
    }
}
