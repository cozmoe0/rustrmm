//! `::rustrmm::set-field key=value` lines in script output.

pub const PREFIX: &str = "::rustrmm::set-field ";
/// At most this many directives are honoured per result.
pub const MAX_DIRECTIVES: usize = 50;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Directive {
    pub field: String,
    pub value: String,
}

/// Extracts directives from stdout. A directive is a whole line (leading whitespace allowed);
/// the key runs up to the first `=` and the value is the rest of the line.
pub fn parse(stdout: &str) -> Vec<Directive> {
    stdout
        .lines()
        .filter_map(|line| {
            let rest = line.trim_start().strip_prefix(PREFIX)?;
            let (key, value) = rest.split_once('=')?;
            let key = key.trim();
            if key.is_empty() || key.len() > 48 {
                return None;
            }
            Some(Directive {
                field: key.to_string(),
                value: value.trim_end_matches('\r').trim().to_string(),
            })
        })
        .take(MAX_DIRECTIVES)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_directives_and_ignores_noise() {
        let out = "starting\n::rustrmm::set-field disk_free_gb=42.5\n  ::rustrmm::set-field owner = Jane Doe \r\n\
                   echo ::rustrmm::set-field nope=1\n::rustrmm::set-field =x\n::rustrmm::set-field novalue\n\
                   ::rustrmm::set-field empty=\n::rustrmm::set-field url=https://x/?a=b";
        let parsed = parse(out);
        assert_eq!(
            parsed,
            vec![
                Directive {
                    field: "disk_free_gb".into(),
                    value: "42.5".into()
                },
                Directive {
                    field: "owner".into(),
                    value: "Jane Doe".into()
                },
                Directive {
                    field: "empty".into(),
                    value: String::new()
                },
                Directive {
                    field: "url".into(),
                    value: "https://x/?a=b".into()
                },
            ]
        );
        let many: String = (0..80)
            .map(|i| format!("::rustrmm::set-field f{i}=1\n"))
            .collect();
        assert_eq!(parse(&many).len(), MAX_DIRECTIVES);
    }
}
