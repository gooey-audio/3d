//! Mould parameters: one typed struct passed everywhere (the reference reads a
//! global dict in some helpers, so overrides there were silently ignored).

use serde::{Deserialize, Serialize};

/// Mould dimensions in mm. Defaults are the reference's `MOULD` dict plus the
/// M5 nut.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct K {
    /// Material round the body.
    pub wall: f64,
    /// Core slab under the high-z face.
    pub base: f64,
    /// How far the clamp ears stand off the block.
    pub ear: f64,
    /// Seam flange (per half) and bottom lip thickness.
    pub flange: f64,
    /// Bolt clearance hole.
    pub bolt: f64,
    /// Nut / washer pocket diameter.
    pub pocket: f64,
    pub bolt_spacing: f64,
    /// Air vent diameter.
    pub vent: f64,
    pub vent_spacing: f64,
    /// Registration bump radius.
    pub key: f64,
    pub key_fit: f64,
    /// Circle segments for rods and keys.
    pub segments: i32,
    /// Nut across flats.
    pub nut_af: f64,
    pub nut_fit: f64,
}

impl Default for K {
    fn default() -> Self {
        Self {
            wall: 12.0,
            base: 10.0,
            ear: 20.0,
            flange: 8.0,
            bolt: 5.5,
            pocket: 14.0,
            bolt_spacing: 50.0,
            vent: 3.0,
            vent_spacing: 40.0,
            key: 3.0,
            key_fit: 0.3,
            segments: 32,
            nut_af: 8.0,
            nut_fit: 0.3,
        }
    }
}

/// Partial overrides as written in a spec's `k` object.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct KPatch {
    pub wall: Option<f64>,
    pub base: Option<f64>,
    pub ear: Option<f64>,
    pub flange: Option<f64>,
    pub bolt: Option<f64>,
    pub pocket: Option<f64>,
    pub bolt_spacing: Option<f64>,
    pub vent: Option<f64>,
    pub vent_spacing: Option<f64>,
    pub key: Option<f64>,
    pub key_fit: Option<f64>,
    pub segments: Option<i32>,
    pub nut_af: Option<f64>,
    pub nut_fit: Option<f64>,
    /// Cup moulds only: floor under the part's open face.
    pub floor: Option<f64>,
}

impl KPatch {
    pub fn apply(&self, k: &mut K) {
        macro_rules! set {
            ($($f:ident),*) => { $(if let Some(v) = self.$f { k.$f = v; })* };
        }
        set!(
            wall,
            base,
            ear,
            flange,
            bolt,
            pocket,
            bolt_spacing,
            vent,
            vent_spacing,
            key,
            key_fit,
            segments,
            nut_af,
            nut_fit
        );
    }
}

/// ISO metric clamp bolts: clearance hole, washer/head pocket, nut across flats.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Bolt {
    M4,
    M5,
}

impl Bolt {
    /// (clearance, pocket, nut across flats).
    pub fn dims(self) -> (f64, f64, f64) {
        match self {
            Bolt::M4 => (4.5, 12.0, 7.0),
            Bolt::M5 => (5.5, 14.0, 8.0),
        }
    }

    /// Bolt, pocket and nut follow the size together.
    pub fn apply(self, k: &mut K) {
        let (bolt, pocket, nut_af) = self.dims();
        k.bolt = bolt;
        k.pocket = pocket;
        k.nut_af = nut_af;
    }

    pub fn k(self) -> K {
        let mut k = K::default();
        self.apply(&mut k);
        k
    }
}
