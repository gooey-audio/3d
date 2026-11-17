//! Render jobs (`gooey-3d-job/v1`): a contact sheet planned as independent tiles, so the
//! tiles can be rendered anywhere (in shards, on other machines) and composited later.
//!
//! ```json
//! {
//!   "schema": "gooey-3d-job/v1",
//!   "layout": { "cols": 4, "tile": 400, "gap": 10, "labels": true,
//!               "background": [242, 242, 240], "text": [40, 40, 40] },
//!   "tiles": [{
//!     "id": "bracket-az030", "input": "stl/bracket.stl", "input_sha256": "…",
//!     "view": [0.813798, 0.34202, 0.469846], "material": null, "up": "z",
//!     "sets": [["background", "transparent"], ["spp", "128"]], "label": "bracket · 30°"
//!   }]
//! }
//! ```
//!
//! `input` is relative to the job file's directory (or absolute); `input_sha256` is the
//! SHA-256 of the STL bytes, checked before a tile renders. `sets` are scene `--set`
//! pairs applied in order, then `camera.view` from `view` (a `manifest::VIEWS` name or a
//! direction from the model toward the camera).

use crate::frame::sha256_hex;
use crate::scene::View;
use crate::sheet::Layout;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const SCHEMA: &str = "gooey-3d-job/v1";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Job {
    pub schema: String,
    pub layout: Layout,
    pub tiles: Vec<JobTile>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JobTile {
    /// Unique within the job; names the tile's files (`<id>.png`, `<id>.json`).
    pub id: String,
    /// STL path, relative to the job file's directory or absolute.
    pub input: String,
    /// SHA-256 (hex) of the STL bytes.
    pub input_sha256: String,
    pub view: View,
    /// Material spec (`adhoc` syntax); `None` is the plain default grey.
    pub material: Option<String>,
    /// The STL's up axis: `x`, `y` or `z`.
    pub up: String,
    /// Scene overrides (`KEY`, `VALUE`), applied in order before `camera.view`.
    pub sets: Vec<(String, String)>,
    pub label: String,
}

impl Job {
    pub fn new(layout: Layout, tiles: Vec<JobTile>) -> Job {
        Job {
            schema: SCHEMA.into(),
            layout,
            tiles,
        }
    }

    pub fn from_json(text: &str) -> Result<Job, String> {
        let job: Job = serde_json::from_str(text).map_err(|e| e.to_string())?;
        job.validate()?;
        Ok(job)
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(self).unwrap() + "\n"
    }

    pub fn load(path: &Path) -> Result<Job, String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        Job::from_json(&text).map_err(|e| format!("{}: {e}", path.display()))
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.schema != SCHEMA {
            return Err(format!("schema `{}`: want `{SCHEMA}`", self.schema));
        }
        if self.tiles.is_empty() {
            return Err("job has no tiles".into());
        }
        let mut seen = std::collections::HashSet::new();
        for t in &self.tiles {
            if !valid_id(&t.id) {
                return Err(format!("tile id `{}`: use letters, digits, `.`, `_`, `-`", t.id));
            }
            if !seen.insert(t.id.as_str()) {
                return Err(format!("duplicate tile id `{}`", t.id));
            }
        }
        Ok(())
    }
}

/// Tile ids become file names: ASCII letters, digits, `.`, `_` and `-`, not starting with `.`.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && !id.starts_with('.')
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// `text` as a tile id fragment: runs of other characters become one `-`.
pub fn id_fragment(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '.' | '_') {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let out = out.trim_matches(|c| c == '-' || c == '.');
    if out.is_empty() { "tile".into() } else { out.into() }
}

/// `--orbit N[@ELEV_DEG]`: `n` directions around +Y, starting at +X and turning toward +Z
/// (`(cos θ, tan elev, sin θ)`, normalised), `elev_deg` above the horizon. Components are
/// rounded to 6 decimals so the job file round-trips them exactly.
pub fn orbit(n: u32, elev_deg: f64) -> Vec<[f64; 3]> {
    let e = elev_deg.to_radians();
    let r6 = |v: f64| {
        let r = (v * 1e6).round() / 1e6;
        if r == 0.0 { 0.0 } else { r }
    };
    (0..n)
        .map(|k| {
            let t = std::f64::consts::TAU * k as f64 / n as f64;
            [r6(e.cos() * t.cos()), r6(e.sin()), r6(e.cos() * t.sin())]
        })
        .collect()
}

/// Parse `N[@ELEV_DEG]` (default elevation 20 degrees).
pub fn parse_orbit(raw: &str) -> Result<(u32, f64), String> {
    let (n, elev) = match raw.split_once('@') {
        Some((n, e)) => (n, e.trim().parse::<f64>().map_err(|e| format!("--orbit {raw}: {e}"))?),
        None => (raw, 20.0),
    };
    let n: u32 = n.trim().parse().map_err(|e| format!("--orbit {raw}: {e}"))?;
    if n == 0 {
        return Err(format!("--orbit {raw}: want at least one view"));
    }
    if !(-89.5..=89.5).contains(&elev) {
        return Err(format!("--orbit {raw}: elevation must be within ±89.5 degrees"));
    }
    Ok((n, elev))
}

/// SHA-256 (hex) of a file's bytes.
pub fn file_sha256(path: &Path) -> Result<String, String> {
    Ok(sha256_hex(
        &std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?,
    ))
}

/// The directory a job file's relative inputs are resolved against.
pub fn base_dir(job_path: &Path) -> Result<PathBuf, String> {
    let abs = std::path::absolute(job_path).map_err(|e| format!("{}: {e}", job_path.display()))?;
    Ok(abs.parent().map(Path::to_owned).unwrap_or_default())
}

/// `input` as stored in a job in `base`: relative when it lies under `base`, else absolute.
pub fn input_ref(input: &Path, base: &Path) -> Result<String, String> {
    let abs = std::path::absolute(input).map_err(|e| format!("{}: {e}", input.display()))?;
    let p = abs.strip_prefix(base).unwrap_or(&abs);
    Ok(p.to_string_lossy().into_owned())
}

impl JobTile {
    /// The STL path (`input` resolved against `base`).
    pub fn input_path(&self, base: &Path) -> PathBuf {
        base.join(&self.input)
    }

    /// Fail loudly when the STL is not the one the job was planned with.
    pub fn verify_input(&self, base: &Path) -> Result<PathBuf, String> {
        let path = self.input_path(base);
        let got = file_sha256(&path).map_err(|e| format!("tile {}: {e}", self.id))?;
        if !got.eq_ignore_ascii_case(&self.input_sha256) {
            return Err(format!(
                "tile {}: {} changed since the job was planned (sha256 {got}, job says {})",
                self.id,
                path.display(),
                self.input_sha256
            ));
        }
        Ok(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Job {
        Job::new(
            Layout {
                cols: 3,
                tile: 200,
                gap: 5,
                labels: true,
                background: [242, 242, 240],
                text: [40, 40, 40],
            },
            vec![
                JobTile {
                    id: "bracket-iso".into(),
                    input: "stl/bracket.stl".into(),
                    input_sha256: "ab".repeat(32),
                    view: View::Named("iso".into()),
                    material: Some(r##"{"color":"#334455"}"##.into()),
                    up: "z".into(),
                    sets: vec![
                        ("spp".into(), "128".into()),
                        ("environment".into(), r#"{"type":"room"}"#.into()),
                    ],
                    label: "bracket · iso".into(),
                },
                JobTile {
                    id: "bracket-az030".into(),
                    input: "/abs/bracket.stl".into(),
                    input_sha256: "cd".repeat(32),
                    view: View::Direction(orbit(12, 20.0)[1]),
                    material: None,
                    up: "y".into(),
                    sets: vec![],
                    label: "v032".into(),
                },
            ],
        )
    }

    #[test]
    fn job_round_trips() {
        let job = sample();
        let text = job.to_json();
        assert_eq!(Job::from_json(&text).unwrap(), job);
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["schema"], SCHEMA);
        assert_eq!(v["tiles"][0]["view"], "iso");
        assert_eq!(v["tiles"][0]["sets"][0], serde_json::json!(["spp", "128"]));
        assert!(v["tiles"][1]["view"].is_array());
        assert!(v["tiles"][1]["material"].is_null());
    }

    #[test]
    fn job_rejects_bad_ids_and_schema() {
        let mut job = sample();
        job.tiles[1].id = "bracket-iso".into();
        assert!(Job::from_json(&job.to_json()).unwrap_err().contains("duplicate"));
        job.tiles[1].id = "../x".into();
        assert!(job.validate().is_err());
        let mut job = sample();
        job.schema = "gooey-3d-job/v2".into();
        assert!(job.validate().is_err());
        let text = sample()
            .to_json()
            .replace("\"label\": \"v032\"", "\"label\": \"v032\", \"extra\": 1");
        assert!(Job::from_json(&text).is_err(), "unknown fields are rejected");
    }

    #[test]
    fn orbit_turns_around_y_at_the_elevation() {
        let d = orbit(12, 20.0);
        assert_eq!(d.len(), 12);
        let e = 20f64.to_radians();
        assert!((d[0][0] - e.cos()).abs() < 1e-6 && d[0][2] == 0.0);
        assert!(
            (d[3][2] - e.cos()).abs() < 1e-6 && d[3][0] == 0.0,
            "quarter turn faces +Z"
        );
        for (k, v) in d.iter().enumerate() {
            let len = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
            assert!((len - 1.0).abs() < 2e-6, "{k}: unit length");
            assert!((v[1] - e.sin()).abs() < 1e-6, "{k}: elevation");
            let az = v[2].atan2(v[0]).to_degrees().rem_euclid(360.0);
            assert!((az - 30.0 * k as f64).abs() < 1e-3, "{k}: azimuth {az}");
            // Exact through JSON text.
            let back: [f64; 3] = serde_json::from_str(&serde_json::to_string(v).unwrap()).unwrap();
            assert_eq!(&back, v);
        }
        assert_eq!(orbit(1, 0.0), vec![[1.0, 0.0, 0.0]]);
    }

    #[test]
    fn orbit_flag() {
        assert_eq!(parse_orbit("12").unwrap(), (12, 20.0));
        assert_eq!(parse_orbit("100@35").unwrap(), (100, 35.0));
        assert_eq!(parse_orbit("8@-10").unwrap(), (8, -10.0));
        assert!(parse_orbit("0").is_err());
        assert!(parse_orbit("12@90").is_err());
        assert!(parse_orbit("x@1").is_err());
    }

    #[test]
    fn ids_are_file_names() {
        assert_eq!(id_fragment("slab-m4/part"), "slab-m4-part");
        assert_eq!(id_fragment("wood/walnut"), "wood-walnut");
        assert_eq!(id_fragment(r##"{"color":"#334455"}"##), "color-334455");
        assert_eq!(id_fragment("1,0.5,1"), "1-0.5-1");
        assert_eq!(id_fragment("///"), "tile");
        assert!(valid_id("v032-iso") && !valid_id(".hidden") && !valid_id("a/b") && !valid_id(""));
    }

    #[test]
    fn inputs_relative_to_the_job() {
        let base = Path::new("/work/gen-003");
        assert_eq!(
            input_ref(Path::new("/work/gen-003/v032/part.stl"), base).unwrap(),
            "v032/part.stl"
        );
        assert_eq!(
            input_ref(Path::new("/elsewhere/a.stl"), base).unwrap(),
            "/elsewhere/a.stl"
        );
        let t = &sample().tiles[1];
        assert_eq!(t.input_path(base), Path::new("/abs/bracket.stl"));
    }
}
