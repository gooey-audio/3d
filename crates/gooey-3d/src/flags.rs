//! Minimal flag parsing shared by the subcommands: `--name VALUE`, `--name=VALUE`,
//! switches, and positionals.

pub struct Flags {
    pub positional: Vec<String>,
    pub switches: Vec<String>,
    pub values: Vec<(String, String)>,
}

/// `with_value` lists the flags that take a value as the next argument.
pub fn parse(args: &[String], with_value: &[&str]) -> Result<Flags, String> {
    let mut f = Flags {
        positional: vec![],
        switches: vec![],
        values: vec![],
    };
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if let Some((k, v)) = a.split_once('=').filter(|_| a.starts_with("--")) {
            f.values.push((k.to_string(), v.to_string()));
        } else if with_value.contains(&a.as_str()) {
            let v = it.next().ok_or(format!("{a} needs a value"))?;
            f.values.push((a.clone(), v.clone()));
        } else if a.starts_with("--") {
            f.switches.push(a.clone());
        } else {
            f.positional.push(a.clone());
        }
    }
    Ok(f)
}

impl Flags {
    /// The last value given for `k`.
    pub fn value(&self, k: &str) -> Option<&str> {
        self.values.iter().rev().find(|(n, _)| n == k).map(|(_, v)| v.as_str())
    }
    /// Every value given for `k`, in order.
    #[cfg_attr(not(feature = "render"), allow(dead_code))]
    pub fn all(&self, k: &str) -> Vec<&str> {
        self.values
            .iter()
            .filter(|(n, _)| n == k)
            .map(|(_, v)| v.as_str())
            .collect()
    }
    pub fn has(&self, k: &str) -> bool {
        self.switches.iter().any(|s| s == k)
    }
    pub fn reject_unknown(&self, switches: &[&str], values: &[&str]) -> Result<(), String> {
        for s in &self.switches {
            if !switches.contains(&s.as_str()) {
                return Err(format!("unknown option {s}"));
            }
        }
        for (k, _) in &self.values {
            if !values.contains(&k.as_str()) {
                return Err(format!("unknown option {k}"));
            }
        }
        Ok(())
    }
}
