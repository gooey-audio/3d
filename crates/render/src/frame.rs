//! One resolved scene to RGBA pixels: geometry, camera framing, lights, trace, tonemap.

use crate::env;
use crate::gpu::{self, Gpu};
use crate::post;
use crate::room;
use crate::scene::{self, Environment, Resolved};
use glam::{DVec3, Vec3};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Instant;

pub struct Frame {
    pub rgba: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub spp: u32,
    pub triangles: usize,
    pub geometry_s: f64,
    pub trace_s: f64,
    pub compose_s: f64,
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// The HDRI file of an `hdri` environment: `~/`, absolute, or relative to the scene file
/// (else the project root).
pub fn hdri_path(r: &Resolved) -> Option<PathBuf> {
    match &r.file.environment {
        Environment::Hdri { path, .. } => {
            let p = Path::new(path);
            let p = if let Some(rest) = path.strip_prefix("~/") {
                std::env::var_os("HOME")
                    .map(PathBuf::from)
                    .unwrap_or_default()
                    .join(rest)
            } else if p.is_absolute() {
                p.to_owned()
            } else {
                r.scene_path
                    .as_ref()
                    .and_then(|s| s.parent())
                    .unwrap_or(&r.root)
                    .join(p)
            };
            Some(p)
        }
        _ => None,
    }
}

fn v4(v: DVec3, w: f32) -> [f32; 4] {
    [v.x as f32, v.y as f32, v.z as f32, w]
}

/// Points the camera frames: the whole model, or the instances/parts named in
/// `camera.fit` (`@furniture` = the room's furniture and props).
fn framing_points(r: &Resolved, geo: &scene::Geometry) -> Result<Vec<DVec3>, String> {
    let corners = |(lo, hi): (Vec3, Vec3)| {
        (0..8).map(move |k| {
            DVec3::new(
                if k & 1 == 0 { lo.x } else { hi.x } as f64,
                if k & 2 == 0 { lo.y } else { hi.y } as f64,
                if k & 4 == 0 { lo.z } else { hi.z } as f64,
            )
        })
    };
    let fit = &r.file.camera.fit;
    if fit.is_empty() {
        let (min, max) = (geo.min.as_dvec3(), geo.max.as_dvec3());
        let mut pts: Vec<DVec3> = geo.tris.iter().flatten().step_by(3).map(|v| v.as_dvec3()).collect();
        // Ground margin so contact shadows stay in frame (shadow catcher only): the
        // model's own footprint, grown a little, not its bounding box (which frames
        // empty floor around angled or separate parts).
        if r.file.ground.shadow_catcher && !matches!(r.file.environment, Environment::Room(_)) {
            let m = (max - min).length() * 0.04;
            let foot: Vec<DVec3> = pts.iter().step_by(4).copied().collect();
            for v in foot {
                for (dx, dz) in [(-m, -m), (m, -m), (-m, m), (m, m)] {
                    pts.push(DVec3::new(v.x + dx, min.y, v.z + dz));
                }
            }
        }
        return Ok(pts);
    }
    let mut pts = Vec::new();
    for id in fit {
        if id == "@furniture" {
            let b = geo
                .furniture
                .ok_or("camera.fit @furniture needs a room with furniture")?;
            pts.extend(corners(b));
            continue;
        }
        let before = pts.len();
        for (inst, b) in r.assembly.instances.iter().zip(&geo.inst_bounds) {
            if &inst.id == id || &inst.part == id {
                pts.extend(corners(*b));
            }
        }
        if pts.len() == before {
            return Err(format!("camera.fit: no visible part or instance `{id}`"));
        }
    }
    Ok(pts)
}

/// Render `r` on `gpu`. `log` receives progress lines (geometry stats, resolution).
pub fn render(r: &Resolved, gpu: &Gpu, progress: bool, log: &dyn Fn(String)) -> Result<Frame, String> {
    let t0 = Instant::now();
    let geo = scene::build_geometry(r)?;
    let geometry_s = t0.elapsed().as_secs_f64();
    log(format!(
        "{} instances, {} triangles ({} traced), BVH {} nodes / depth {} ({:.2}s)",
        r.assembly.instances.len(),
        geo.tris.len(),
        geo.traced,
        geo.nodes.len(),
        geo.bvh_depth,
        geometry_s
    ));

    let (min, max) = (geo.min.as_dvec3(), geo.max.as_dvec3());
    let center = (min + max) * 0.5;
    let radius = (max - min).length() * 0.5;
    let pts = framing_points(r, &geo)?;
    let direction = DVec3::from(r.direction);
    let cam = crate::camera::fit(&pts, direction, r.file.camera.fov, r.file.camera.padding, r.file.aspect);
    let width = r.file.width;
    let height = ((width as f64 / cam.aspect).round() as u32).max(1);
    let focus = r.file.camera.focus_mm.unwrap_or_else(|| {
        let (lo, hi) = pts.iter().fold(
            (DVec3::splat(f64::INFINITY), DVec3::splat(f64::NEG_INFINITY)),
            |(a, b), p| (a.min(*p), b.max(*p)),
        );
        ((lo + hi) * 0.5 - cam.pos).dot(cam.fwd)
    });

    let mut room_dome = None;
    let (env_pixels, env_cdf, env_w, env_h, flags_env, lights, intensity, rotation) = match &r.file.environment {
        Environment::Studio {
            intensity,
            rotation_deg,
        } => {
            let lights = env::studio(center, radius, direction, *rotation_deg);
            (vec![[0.0f32; 4]], vec![0.0f32; 4], 1, 1, 0, lights, *intensity, 0.0)
        }
        Environment::Room(room) => {
            let (lights, dome) = room::lights(room, geo.min, geo.max)?;
            room_dome = Some(dome);
            (vec![[0.0f32; 4]], vec![0.0f32; 4], 1, 1, 0, lights, room.intensity, 0.0)
        }
        Environment::Hdri {
            sha256,
            intensity,
            rotation_deg,
            ..
        } => {
            let path = hdri_path(r).unwrap();
            let bytes = std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            if let Some(want) = sha256 {
                let got = sha256_hex(&bytes);
                if !got.eq_ignore_ascii_case(want) {
                    return Err(format!(
                        "{}: sha256 {got} does not match the scene's {want}",
                        path.display()
                    ));
                }
            }
            let hdri = env::load_hdri(&path)?;
            (
                hdri.pixels,
                hdri.cdf,
                hdri.width,
                hdri.height,
                gpu::FLAG_HDRI,
                Vec::new(),
                *intensity,
                *rotation_deg,
            )
        }
    };
    let mut light_arr = [env::Light::default(); env::MAX_LIGHTS];
    light_arr[..lights.len()].copy_from_slice(&lights);
    let dome = room_dome.unwrap_or(env::STUDIO_DOME);
    let in_room = matches!(r.file.environment, Environment::Room(_));
    let ground_flag = if r.file.ground.shadow_catcher && !in_room {
        gpu::FLAG_GROUND
    } else {
        0
    };
    let g = r.file.ground.albedo as f32;
    let params = gpu::Params {
        cam_pos: v4(cam.pos, cam.tan_half as f32),
        cam_fwd: v4(cam.fwd, cam.aspect as f32),
        cam_right: v4(cam.right, cam.shift.0 as f32),
        cam_up: v4(cam.up, cam.shift.1 as f32),
        dims: [width, height, 0, 0],
        cfg: [
            r.file.max_depth.max(1),
            ground_flag | flags_env,
            lights.len() as u32,
            env_w,
        ],
        cfg2: [env_h, 0, 0, 0],
        env: [intensity as f32, (rotation as f32).to_radians(), 8.0, min.y as f32],
        ground: [g, g, g, (radius * 2e-5).max(1e-4) as f32],
        lens: [
            r.file.camera.aperture_mm.max(0.0) as f32,
            focus.max(1.0) as f32,
            0.0,
            0.0,
        ],
        dome_top: [dome.top[0], dome.top[1], dome.top[2], 0.0],
        dome_horizon: [dome.horizon[0], dome.horizon[1], dome.horizon[2], 0.0],
        dome_bottom: [dome.bottom[0], dome.bottom[1], dome.bottom[2], 0.0],
        lights: light_arr,
    };

    log(format!("{width}x{height}, {} spp on {}", r.file.spp, gpu.adapter));
    let t1 = Instant::now();
    let sums = gpu::trace(
        gpu,
        gpu::Inputs {
            params,
            tris: &geo.gpu_tris,
            attrs: &geo.gpu_attrs,
            nodes: bytemuck::cast_slice(&geo.nodes),
            instances: bytemuck::cast_slice(&geo.instances),
            materials: bytemuck::cast_slice(&geo.materials),
            env_pixels: &env_pixels,
            env_cdf: &env_cdf,
            spp: r.file.spp,
        },
        progress,
    )?;
    let trace_s = t1.elapsed().as_secs_f64();
    let t2 = Instant::now();
    let background = match r.file.background.as_str() {
        "transparent" => None,
        hex => Some(scene::parse_hex(hex)?),
    };
    let rgba = post::compose(
        &sums,
        &post::Compose {
            width,
            height,
            spp: r.file.spp,
            exposure: r.file.exposure as f32,
            shadow_strength: r.file.ground.shadow_strength as f32,
            background,
        },
    );
    Ok(Frame {
        rgba,
        width,
        height,
        spp: r.file.spp,
        triangles: geo.tris.len(),
        geometry_s,
        trace_s,
        compose_s: t2.elapsed().as_secs_f64(),
    })
}
