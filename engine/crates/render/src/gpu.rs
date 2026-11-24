//! Headless wgpu compute: no window or surface, just a device, storage buffers and a
//! progressive dispatch loop that accumulates samples and reads the sums back.

use crate::env::{Light, MAX_LIGHTS};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use wgpu::util::DeviceExt;

pub const SHADER: &str = include_str!("shaders/trace.wgsl");

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct Params {
    pub cam_pos: [f32; 4],
    pub cam_fwd: [f32; 4],
    pub cam_right: [f32; 4],
    pub cam_up: [f32; 4],
    pub dims: [u32; 4],
    pub cfg: [u32; 4],
    pub cfg2: [u32; 4],
    pub env: [f32; 4],
    pub ground: [f32; 4],
    /// Thin lens: aperture radius mm, focus distance mm.
    pub lens: [f32; 4],
    pub dome_top: [f32; 4],
    pub dome_horizon: [f32; 4],
    pub dome_bottom: [f32; 4],
    pub lights: [Light; MAX_LIGHTS],
}

pub const FLAG_GROUND: u32 = 1;
pub const FLAG_HDRI: u32 = 2;

pub struct Inputs<'a> {
    pub params: Params,
    pub tris: &'a [[f32; 4]],
    pub attrs: &'a [[f32; 4]],
    pub nodes: &'a [u8],
    pub instances: &'a [u8],
    pub materials: &'a [u8],
    pub env_pixels: &'a [[f32; 4]],
    pub env_cdf: &'a [f32],
    pub spp: u32,
}

pub struct Gpu {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub adapter: String,
    /// The trace pipeline, compiled on first use and reused by every later [`trace`].
    pipeline: OnceLock<Pipeline>,
}

/// The compiled shader and its bind group layout (group 0).
struct Pipeline {
    pipeline: wgpu::ComputePipeline,
    layout: wgpu::BindGroupLayout,
}

impl Gpu {
    /// Compile the trace shader once per device: on some drivers (NVIDIA/Vulkan) this
    /// costs ~0.5 s, which per-call compilation paid on every tile of a sheet.
    fn pipeline(&self) -> Result<&Pipeline, String> {
        if let Some(p) = self.pipeline.get() {
            return Ok(p);
        }
        let dev = &self.device;
        let scope = dev.push_error_scope(wgpu::ErrorFilter::Validation);
        let module = dev.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("trace.wgsl"),
            source: wgpu::ShaderSource::Wgsl(SHADER.into()),
        });
        let pipeline = dev.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("trace"),
            layout: None,
            module: &module,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });
        let layout = pipeline.get_bind_group_layout(0);
        if let Some(e) = pollster::block_on(scope.pop()) {
            return Err(format!("GPU setup failed: {e}"));
        }
        // A racing thread may have stored one first; either is equivalent.
        Ok(self.pipeline.get_or_init(|| Pipeline { pipeline, layout }))
    }
}

/// Hardware adapter, else a software one (lavapipe/WARP) so GPU-less CI runners can still
/// render; `RENDER_ADAPTER=software` forces the fallback.
pub fn open() -> Result<Gpu, String> {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let request = |fallback: bool| {
        pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            force_fallback_adapter: fallback,
            compatible_surface: None,
            apply_limit_buckets: false,
        }))
    };
    let software = std::env::var("RENDER_ADAPTER").is_ok_and(|v| v == "software");
    let adapter = if software {
        request(true)
    } else {
        request(false).or_else(|_| request(true))
    }
    .map_err(|e| format!("no GPU adapter: {e}"))?;
    let info = adapter.get_info();
    let name = format!("{} ({:?})", info.name, info.backend);
    // Large scenes and frames need more than the WebGPU defaults; take what the adapter has.
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("render"),
        required_features: wgpu::Features::empty(),
        required_limits: adapter.limits(),
        experimental_features: Default::default(),
        memory_hints: wgpu::MemoryHints::Performance,
        trace: Default::default(),
    }))
    .map_err(|e| format!("request_device: {e}"))?;
    Ok(Gpu {
        device,
        queue,
        adapter: name,
        pipeline: OnceLock::new(),
    })
}

fn storage(device: &wgpu::Device, label: &str, bytes: &[u8]) -> wgpu::Buffer {
    // Zero-length bindings are invalid; pad to one element.
    let pad = [0u8; 16];
    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some(label),
        contents: if bytes.is_empty() { &pad } else { bytes },
        usage: wgpu::BufferUsages::STORAGE,
    })
}

/// Raw per-pixel sums (3 x vec4 per pixel; see the shader header) after `spp` samples.
pub fn trace(gpu: &Gpu, mut inp: Inputs, progress: bool) -> Result<Vec<[f32; 4]>, String> {
    let dev = &gpu.device;
    let (w, h) = (inp.params.dims[0], inp.params.dims[1]);
    let pixels = w as u64 * h as u64;
    let accum_size = pixels * 48;
    let lim = dev.limits();
    if accum_size > lim.max_storage_buffer_binding_size || accum_size > lim.max_buffer_size {
        return Err(format!(
            "{w}x{h} needs {} MB of accumulation, over this GPU's limit",
            accum_size >> 20
        ));
    }
    let Pipeline { pipeline, layout } = gpu.pipeline()?;
    let scope = dev.push_error_scope(wgpu::ErrorFilter::Validation);
    let uniform = dev.create_buffer(&wgpu::BufferDescriptor {
        label: Some("params"),
        size: std::mem::size_of::<Params>() as u64,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let bufs = [
        storage(dev, "tris", bytemuck::cast_slice(inp.tris)),
        storage(dev, "attrs", bytemuck::cast_slice(inp.attrs)),
        storage(dev, "nodes", inp.nodes),
        storage(dev, "instances", inp.instances),
        storage(dev, "materials", inp.materials),
        storage(dev, "env_pixels", bytemuck::cast_slice(inp.env_pixels)),
        storage(dev, "env_cdf", bytemuck::cast_slice(inp.env_cdf)),
    ];
    let accum = dev.create_buffer(&wgpu::BufferDescriptor {
        label: Some("accum"),
        size: accum_size,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let readback = dev.create_buffer(&wgpu::BufferDescriptor {
        label: Some("readback"),
        size: accum_size,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let mut entries = vec![wgpu::BindGroupEntry {
        binding: 0,
        resource: uniform.as_entire_binding(),
    }];
    for (i, b) in bufs.iter().enumerate() {
        entries.push(wgpu::BindGroupEntry {
            binding: i as u32 + 1,
            resource: b.as_entire_binding(),
        });
    }
    entries.push(wgpu::BindGroupEntry {
        binding: 8,
        resource: accum.as_entire_binding(),
    });
    let group = dev.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("trace"),
        layout,
        entries: &entries,
    });
    if let Some(e) = pollster::block_on(scope.pop()) {
        return Err(format!("GPU setup failed: {e}"));
    }

    // Progressive dispatches. Start small and grow the batch until one dispatch takes
    // ~120 ms: long enough to amortize submission, short enough for the GPU watchdog.
    let target = Duration::from_millis(120);
    let started = Instant::now();
    let mut done = 0u32;
    let mut batch = 1u32;
    let mut last_report = Instant::now();
    while done < inp.spp {
        let n = batch.min(inp.spp - done);
        inp.params.dims[2] = done;
        inp.params.dims[3] = n;
        gpu.queue.write_buffer(&uniform, 0, bytemuck::bytes_of(&inp.params));
        let mut enc = dev.create_command_encoder(&Default::default());
        {
            let mut pass = enc.begin_compute_pass(&Default::default());
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.dispatch_workgroups(w.div_ceil(8), h.div_ceil(8), 1);
        }
        let t0 = Instant::now();
        gpu.queue.submit([enc.finish()]);
        dev.poll(wgpu::PollType::wait_indefinitely())
            .map_err(|e| format!("GPU poll: {e}"))?;
        let dt = t0.elapsed();
        done += n;
        if dt < target / 2 && batch < 64 {
            batch *= 2;
        } else if dt > target * 2 && batch > 1 {
            batch /= 2;
        }
        if progress && (last_report.elapsed() > Duration::from_secs(2) || done == inp.spp) {
            last_report = Instant::now();
            eprintln!("  {done}/{} spp  {:.1}s", inp.spp, started.elapsed().as_secs_f64());
        }
    }

    let mut enc = dev.create_command_encoder(&Default::default());
    enc.copy_buffer_to_buffer(&accum, 0, &readback, 0, accum_size);
    gpu.queue.submit([enc.finish()]);
    let (tx, rx) = std::sync::mpsc::channel();
    readback.map_async(wgpu::MapMode::Read, .., move |r| {
        let _ = tx.send(r);
    });
    dev.poll(wgpu::PollType::wait_indefinitely())
        .map_err(|e| format!("GPU poll: {e}"))?;
    rx.recv()
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("readback: {e}"))?;
    let view = readback.get_mapped_range(..).map_err(|e| format!("readback: {e:?}"))?;
    let out = bytemuck::cast_slice::<u8, [f32; 4]>(&view).to_vec();
    drop(view);
    readback.unmap();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene::{GpuInstance, GpuMaterial};
    use glam::Vec3;

    /// Mean radiance over fully covered pixels of a 2 mm cube under a uniform white dome
    /// (no lights, no ground). None when no GPU adapter is available (e.g. CI).
    fn furnace(mat: GpuMaterial) -> Option<f32> {
        let gpu = open().ok()?;
        let mut tris = Vec::new();
        for axis in 0..3 {
            for sign in [-1.0f32, 1.0] {
                let n = Vec3::from_array(std::array::from_fn(|k| if k == axis { sign } else { 0.0 }));
                let u = Vec3::from_array(std::array::from_fn(|k| if k == (axis + 1) % 3 { 1.0 } else { 0.0 }));
                let v = n.cross(u);
                let c = |a: f32, b: f32| n + u * a + v * b;
                tris.push([c(-1.0, -1.0), c(1.0, -1.0), c(1.0, 1.0)]);
                tris.push([c(-1.0, -1.0), c(1.0, 1.0), c(-1.0, 1.0)]);
            }
        }
        let bvh = crate::bvh::build(&tris);
        let (mut gt, mut ga) = (Vec::new(), Vec::new());
        for &i in &bvh.order {
            let p = tris[i as usize];
            let (e1, e2) = (p[1] - p[0], p[2] - p[0]);
            let n = e1.cross(e2).normalize();
            gt.extend([
                [p[0].x, p[0].y, p[0].z, f32::from_bits(0)],
                [e1.x, e1.y, e1.z, 0.0],
                [e2.x, e2.y, e2.z, 0.0],
            ]);
            for v in [n, n, n].iter().chain(p.iter()) {
                ga.push([v.x, v.y, v.z, 0.0]);
            }
        }
        let inst = GpuInstance {
            t: [1.0, 0.0, 0.0, -1.0],
            c: [0.0, 1.0, 0.0, 2.0],
            g: [0.0, 0.0, 1.0, 1.0],
            m: [0; 4],
        };
        let cam = crate::camera::fit(
            &tris.iter().flatten().map(|v| v.as_dvec3()).collect::<Vec<_>>(),
            glam::DVec3::new(1.25, 0.8, 1.5),
            25.0,
            0.0,
            Some(1.0),
        );
        let f = |v: glam::DVec3, w: f64| [v.x as f32, v.y as f32, v.z as f32, w as f32];
        let one = [1.0, 1.0, 1.0, 0.0];
        let (w, h) = (32u32, 32u32);
        let params = Params {
            cam_pos: f(cam.pos, cam.tan_half),
            cam_fwd: f(cam.fwd, cam.aspect),
            cam_right: f(cam.right, cam.shift.0),
            cam_up: f(cam.up, cam.shift.1),
            dims: [w, h, 0, 0],
            cfg: [64, 0, 0, 1],
            cfg2: [1, 0, 0, 0],
            env: [1.0, 0.0, 1e9, -10.0],
            ground: [0.0, 0.0, 0.0, 1e-4],
            lens: [0.0; 4],
            dome_top: one,
            dome_horizon: one,
            dome_bottom: one,
            lights: [Light::default(); MAX_LIGHTS],
        };
        let spp = 256;
        let sums = trace(
            &gpu,
            Inputs {
                params,
                tris: &gt,
                attrs: &ga,
                nodes: bytemuck::cast_slice(&bvh.nodes),
                instances: bytemuck::bytes_of(&inst),
                materials: bytemuck::bytes_of(&mat),
                env_pixels: &[[0.0; 4]],
                env_cdf: &[0.0; 4],
                spp,
            },
            false,
        )
        .unwrap();
        let full: Vec<f32> = (0..(w * h) as usize)
            .filter(|&p| sums[3 * p][3] == spp as f32)
            .map(|p| (sums[3 * p][0] + sums[3 * p][1] + sums[3 * p][2]) / (3.0 * spp as f32))
            .collect();
        assert!(
            full.len() > 200,
            "cube should fill the frame centre ({} px)",
            full.len()
        );
        assert!(full.iter().all(|v| v.is_finite()));
        Some(full.iter().sum::<f32>() / full.len() as f32)
    }

    fn material(base: f32, rough: f32, metal: f32, cc: f32) -> GpuMaterial {
        GpuMaterial {
            base: [base, base, base, rough],
            a: [metal, cc, 0.1, 0.0],
            b: [1.5, 1.0, 0.0, 0.0],
            dark: [0.0, 0.0, 0.0, 12.0],
            edge: [0.0, 0.0, 0.0, 2.0],
            tex: [0.0; 4],
            fig: [0.0; 4],
            fig2: [0.0; 4],
            sp0: [0.0; 4],
            sp1: [0.0; 4],
            sp2: [0.0; 4],
        }
    }

    /// White furnace: a white object under uniform unit light must neither gain energy
    /// nor lose much (single-scatter GGX loses a little at high roughness).
    #[test]
    fn white_furnace() {
        for (name, m, lo) in [
            ("diffuse", material(1.0, 1.0, 0.0, 0.0), 0.90),
            ("metal", material(1.0, 0.2, 1.0, 0.0), 0.93),
            ("clearcoat", material(1.0, 0.6, 0.0, 1.0), 0.88),
            // Bumped shading normals must not create energy either (PLA layer lines).
            (
                "textured",
                GpuMaterial {
                    tex: [1.0, 0.2, 0.25, 3.0],
                    ..material(1.0, 1.0, 0.0, 0.0)
                },
                0.85,
            ),
        ] {
            let Some(v) = furnace(m) else {
                eprintln!("no GPU adapter; skipping white furnace");
                return;
            };
            assert!((lo..=1.02).contains(&v), "{name}: furnace radiance {v}");
        }
        let half = furnace(material(0.5, 1.0, 0.0, 0.0)).unwrap();
        assert!((0.4..0.6).contains(&half), "grey diffuse: {half}");
    }

    #[test]
    fn pipeline_is_compiled_once() {
        let Ok(gpu) = open() else { return };
        let a: *const Pipeline = gpu.pipeline().unwrap();
        let b: *const Pipeline = gpu.pipeline().unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn shader_validates() {
        let module = naga::front::wgsl::parse_str(super::SHADER)
            .unwrap_or_else(|e| panic!("{}", e.emit_to_string(super::SHADER)));
        naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::empty())
            .validate(&module)
            .unwrap_or_else(|e| panic!("{}", e.emit_to_string(super::SHADER)));
    }
}
