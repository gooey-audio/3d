// Megakernel path tracer for speaker assemblies. One invocation per pixel; each dispatch
// adds `dims.w` samples to the accumulation buffer:
//   accum[3p]     = (sum radiance of model-hit samples, model-hit sample count)
//   accum[3p + 1] = (sum first-hit albedo, sum shadowed ground irradiance)
//   accum[3p + 2] = (sum first-hit normal, sum unshadowed ground irradiance)
// The host divides by the total sample count, tonemaps and builds alpha from coverage and
// the ground shadow ratio (shadow catcher).

const PI: f32 = 3.14159265358979;
const TAU: f32 = 6.28318530717959;
const INF: f32 = 1e30;
const FLAG_GROUND: u32 = 1u;
const FLAG_HDRI: u32 = 2u;

struct Light {
    center: vec4<f32>,
    u: vec4<f32>,
    v: vec4<f32>,
    radiance: vec4<f32>,
}

struct Params {
    cam_pos: vec4<f32>,     // xyz, w = tan(fov_y / 2)
    cam_fwd: vec4<f32>,     // xyz, w = aspect (width / height)
    cam_right: vec4<f32>,   // xyz, w = lens shift x (tan units)
    cam_up: vec4<f32>,      // xyz, w = lens shift y
    dims: vec4<u32>,        // width, height, first sample index, samples this dispatch
    cfg: vec4<u32>,         // max depth, flags, light count, env width
    cfg2: vec4<u32>,        // env height, -, -, -
    env: vec4<f32>,         // intensity, rotation (rad), indirect clamp, ground y
    ground: vec4<f32>,      // albedo rgb, ray epsilon
    lens: vec4<f32>,        // aperture radius mm, focus distance mm, -, -
    dome_top: vec4<f32>,
    dome_horizon: vec4<f32>,
    dome_bottom: vec4<f32>,
    lights: array<Light, 4>,
}

struct Node {
    bmin: vec3<f32>,
    left_first: u32,
    bmax: vec3<f32>,
    count: u32,
}

struct Inst {
    t: vec4<f32>,
    c: vec4<f32>,
    g: vec4<f32>,
    m: vec4<u32>,
}

struct Mat {
    base: vec4<f32>,
    a: vec4<f32>,
    b: vec4<f32>,
    dark: vec4<f32>,
    edge: vec4<f32>,
    tex: vec4<f32>,         // texture kind (0 = none), scale mm, strength, axis code
    fig: vec4<f32>,         // wood figure: cut (0 none, 1 flat, 2 quarter), log mm, ribbon, contrast
    fig2: vec4<f32>,        // ring mm, ribbon mm, taper, -
}

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> tris: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> attrs: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> nodes: array<Node>;
@group(0) @binding(4) var<storage, read> insts: array<Inst>;
@group(0) @binding(5) var<storage, read> mats: array<Mat>;
@group(0) @binding(6) var<storage, read> env_pix: array<vec4<f32>>;
@group(0) @binding(7) var<storage, read> env_cdf: array<f32>;
@group(0) @binding(8) var<storage, read_write> accum: array<vec4<f32>>;

// ---------------------------------------------------------------- random numbers

var<private> seed: u32;

fn pcg(v: u32) -> u32 {
    let state = v * 747796405u + 2891336453u;
    let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}

fn rnd() -> f32 {
    seed = pcg(seed);
    return f32(seed >> 8u) * (1.0 / 16777216.0);
}

fn rnd2() -> vec2<f32> {
    return vec2<f32>(rnd(), rnd());
}

// ---------------------------------------------------------------- geometry

struct Hit {
    t: f32,
    tri: u32,
    u: f32,
    v: f32,
}

fn tri_hit(o: vec3<f32>, d: vec3<f32>, i: u32, tmax: f32) -> vec3<f32> {
    // Returns (t, u, v); t < 0 when missed.
    let v0 = tris[3u * i].xyz;
    let e1 = tris[3u * i + 1u].xyz;
    let e2 = tris[3u * i + 2u].xyz;
    let p = cross(d, e2);
    let det = dot(e1, p);
    if (abs(det) < 1e-12) {
        return vec3<f32>(-1.0, 0.0, 0.0);
    }
    let inv = 1.0 / det;
    let s = o - v0;
    let u = dot(s, p) * inv;
    if (u < 0.0 || u > 1.0) {
        return vec3<f32>(-1.0, 0.0, 0.0);
    }
    let q = cross(s, e1);
    let v = dot(d, q) * inv;
    if (v < 0.0 || u + v > 1.0) {
        return vec3<f32>(-1.0, 0.0, 0.0);
    }
    let t = dot(e2, q) * inv;
    if (t <= 0.0 || t >= tmax) {
        return vec3<f32>(-1.0, 0.0, 0.0);
    }
    return vec3<f32>(t, u, v);
}

fn box_hit(bmin: vec3<f32>, bmax: vec3<f32>, o: vec3<f32>, inv: vec3<f32>, tmax: f32) -> f32 {
    let t0 = (bmin - o) * inv;
    let t1 = (bmax - o) * inv;
    let lo = min(t0, t1);
    let hi = max(t0, t1);
    let tn = max(max(lo.x, lo.y), max(lo.z, 0.0));
    let tf = min(min(hi.x, hi.y), min(hi.z, tmax));
    return select(INF, tn, tn <= tf);
}

fn safe_inv(d: vec3<f32>) -> vec3<f32> {
    let e = 1e-20;
    return 1.0 / select(d, vec3<f32>(e), abs(d) < vec3<f32>(e));
}

fn intersect(o: vec3<f32>, d: vec3<f32>, tmax_in: f32) -> Hit {
    var hit = Hit(tmax_in, 0xffffffffu, 0.0, 0.0);
    let inv = safe_inv(d);
    var stack: array<u32, 64>;
    var sp = 0u;
    var ni = 0u;
    loop {
        let n = nodes[ni];
        if (n.count > 0u) {
            for (var k = n.left_first; k < n.left_first + n.count; k++) {
                let r = tri_hit(o, d, k, hit.t);
                if (r.x > 0.0) {
                    hit = Hit(r.x, k, r.y, r.z);
                }
            }
        } else {
            let a = n.left_first;
            let b = a + 1u;
            let na = nodes[a];
            let nb = nodes[b];
            var ta = box_hit(na.bmin, na.bmax, o, inv, hit.t);
            var tb = box_hit(nb.bmin, nb.bmax, o, inv, hit.t);
            var first = a;
            var second = b;
            if (tb < ta) {
                first = b;
                second = a;
                let tmp = ta;
                ta = tb;
                tb = tmp;
            }
            if (ta < INF) {
                if (tb < INF && sp < 64u) {
                    stack[sp] = second;
                    sp++;
                }
                ni = first;
                continue;
            }
        }
        if (sp == 0u) {
            break;
        }
        sp--;
        ni = stack[sp];
    }
    return hit;
}

fn inst_of(tri: u32) -> u32 {
    return bitcast<u32>(tris[3u * tri].w);
}

// Shadow test; partially covering or transmissive parts block stochastically.
fn occluded(o: vec3<f32>, d: vec3<f32>, tmax: f32) -> bool {
    var start = o;
    var remaining = tmax;
    for (var hop = 0u; hop < 8u; hop++) {
        let h = intersect(start, d, remaining);
        if (h.tri == 0xffffffffu) {
            return false;
        }
        let m = mats[insts[inst_of(h.tri)].m.x];
        let block = m.b.y * (1.0 - m.a.w * 0.85);
        if (rnd() < block) {
            return true;
        }
        let step = h.t + P.ground.w;
        start = start + d * step;
        remaining = remaining - step;
        if (remaining <= 0.0) {
            return false;
        }
    }
    return true;
}

// ---------------------------------------------------------------- environment

fn rot_y(d: vec3<f32>, a: f32) -> vec3<f32> {
    let c = cos(a);
    let s = sin(a);
    return vec3<f32>(c * d.x + s * d.z, d.y, -s * d.x + c * d.z);
}

fn dome(d: vec3<f32>) -> vec3<f32> {
    let y = d.y;
    if (y >= 0.0) {
        return mix(P.dome_horizon.xyz, P.dome_top.xyz, sqrt(y));
    }
    return mix(P.dome_horizon.xyz, P.dome_bottom.xyz, sqrt(-y));
}

fn env_pixel(d_world: vec3<f32>) -> vec2<u32> {
    let d = rot_y(d_world, -P.env.y);
    let u = (atan2(d.x, -d.z) + PI) / TAU;
    let v = acos(clamp(d.y, -1.0, 1.0)) / PI;
    let w = P.cfg.w;
    let h = P.cfg2.x;
    return vec2<u32>(min(u32(u * f32(w)), w - 1u), min(u32(v * f32(h)), h - 1u));
}

fn env_radiance(d: vec3<f32>) -> vec3<f32> {
    if ((P.cfg.y & FLAG_HDRI) != 0u) {
        let px = env_pixel(d);
        return env_pix[px.y * P.cfg.w + px.x].xyz * P.env.x;
    }
    return dome(d) * P.env.x;
}

fn env_pdf(d: vec3<f32>) -> f32 {
    let w = P.cfg.w;
    let h = P.cfg2.x;
    let px = env_pixel(d);
    let row = (h + 1u) + px.y * (w + 1u);
    let p = (env_cdf[px.y + 1u] - env_cdf[px.y]) * (env_cdf[row + px.x + 1u] - env_cdf[row + px.x]);
    let sin_t = sin((f32(px.y) + 0.5) / f32(h) * PI);
    return p * f32(w) * f32(h) / (2.0 * PI * PI * max(sin_t, 1e-6));
}

// Last index i in [lo, lo + n) with cdf[i] <= x.
fn find_interval(lo: u32, n: u32, x: f32) -> u32 {
    var a = 0u;
    var b = n;
    while (a + 1u < b) {
        let m = (a + b) / 2u;
        if (env_cdf[lo + m] <= x) {
            a = m;
        } else {
            b = m;
        }
    }
    return a;
}

// Importance-sampled HDRI direction; returns (dir, pdf).
fn sample_env() -> vec4<f32> {
    let w = P.cfg.w;
    let h = P.cfg2.x;
    let y = find_interval(0u, h + 1u, rnd());
    let row = (h + 1u) + y * (w + 1u);
    let x = find_interval(row, w + 1u, rnd());
    let theta = (f32(y) + rnd()) / f32(h) * PI;
    let phi = (f32(x) + rnd()) / f32(w) * TAU - PI;
    let local = vec3<f32>(sin(theta) * sin(phi), cos(theta), -sin(theta) * cos(phi));
    let d = rot_y(local, P.env.y);
    return vec4<f32>(d, env_pdf(d));
}

// Ray against light i; returns distance or INF.
fn light_hit(i: u32, o: vec3<f32>, d: vec3<f32>) -> f32 {
    let L = P.lights[i];
    let n = cross(L.u.xyz, L.v.xyz);
    let denom = dot(d, n);
    if (denom >= 0.0) {
        return INF; // back side or parallel
    }
    let t = dot(L.center.xyz - o, n) / denom;
    if (t <= 0.0) {
        return INF;
    }
    let q = o + d * t - L.center.xyz;
    let a = dot(q, L.u.xyz) / dot(L.u.xyz, L.u.xyz);
    let b = dot(q, L.v.xyz) / dot(L.v.xyz, L.v.xyz);
    return select(INF, t, abs(a) <= 1.0 && abs(b) <= 1.0);
}

fn light_area(i: u32) -> f32 {
    return 4.0 * length(cross(P.lights[i].u.xyz, P.lights[i].v.xyz));
}

fn power_heuristic(a: f32, b: f32) -> f32 {
    let a2 = a * a;
    return a2 / max(a2 + b * b, 1e-30);
}

// ---------------------------------------------------------------- materials

struct Surface {
    base: vec3<f32>,
    rough: f32,
    metal: f32,
    cc: f32,
    cc_rough: f32,
    trans: f32,
    ior: f32,
    opacity: f32,
    sheen: f32,
}

fn grain_color(m: Mat, inst: Inst, lp: vec3<f32>, ln: vec3<f32>) -> vec4<f32> {
    // Mirrors grain_colors() in framework/guide/render3d.py and the viewer shader.
    // Returns (colour, ring weight).
    if (abs(dot(ln, inst.t.xyz)) > 0.5) {
        let a = dot(lp, inst.c.xyz);
        let g = dot(lp, inst.g.xyz);
        let period = m.dark.w;
        let warp = 2.5 * sin(g / 83.0 + a / 47.0) + 1.2 * sin(g / 19.0 + a / 13.0);
        let ribbon = 0.5 + 0.5 * sin(TAU * (a + warp) / period);
        let fine = 0.5 + 0.5 * sin(TAU * (a + 0.5 * warp + 0.3 * sin(g / 7.0)) / (0.23 * period));
        let k = 0.55 * ribbon * ribbon + 0.25 * pow(fine, 4.0);
        return vec4<f32>(mix(m.base.xyz, m.dark.xyz, k), k);
    }
    let plies = inst.g.w;
    let layer = clamp(floor((dot(lp, inst.t.xyz) - inst.t.w) / inst.c.w * plies), 0.0, plies - 1.0);
    return vec4<f32>(m.edge.xyz * (1.0 - 0.22 * (layer % 2.0)), 0.0);
}

// ---------------------------------------------------------------- surface texture
// Procedural detail from framework/materials.json `texture`, in part-local millimetres.
// Bumps tilt the shading normal along the world-space gradient of a local coordinate, so
// they fade out on faces the coordinate does not cross (no layer lines on a print's top).

fn hash_u(x: u32) -> f32 {
    return f32(pcg(x) >> 8u) * (1.0 / 16777216.0);
}

fn cell(x: i32, y: i32, salt: u32) -> f32 {
    return hash_u((bitcast<u32>(x) * 73856093u) ^ (bitcast<u32>(y) * 19349663u) ^ salt);
}

// 1D value noise and its derivative.
fn noise1(x: f32, salt: u32) -> vec2<f32> {
    let i = floor(x);
    let f = x - i;
    let a = cell(i32(i), 0, salt);
    let b = cell(i32(i) + 1, 0, salt);
    let u = f * f * (3.0 - 2.0 * f);
    return vec2<f32>(mix(a, b, u), (b - a) * 6.0 * f * (1.0 - f));
}

fn noise2(p: vec2<f32>, salt: u32) -> f32 {
    let i = floor(p);
    let f = p - i;
    let u = f * f * (3.0 - 2.0 * f);
    let x = i32(i.x);
    let y = i32(i.y);
    return mix(mix(cell(x, y, salt), cell(x + 1, y, salt), u.x),
               mix(cell(x, y + 1, salt), cell(x + 1, y + 1, salt), u.x), u.y);
}

// World-space gradient over triangle i of the local coordinate dot(local, v).
fn tgrad(i: u32, v: vec3<f32>) -> vec3<f32> {
    let e1 = tris[3u * i + 1u].xyz;
    let e2 = tris[3u * i + 2u].xyz;
    let l0 = attrs[6u * i + 3u].xyz;
    let s1 = dot(attrs[6u * i + 4u].xyz - l0, v);
    let s2 = dot(attrs[6u * i + 5u].xyz - l0, v);
    let a11 = dot(e1, e1);
    let a12 = dot(e1, e2);
    let a22 = dot(e2, e2);
    let det = a11 * a22 - a12 * a12;
    if (abs(det) < 1e-20) {
        return vec3<f32>(0.0);
    }
    return ((s1 * a22 - s2 * a12) * e1 + (s2 * a11 - s1 * a12) * e2) / det;
}

// Texture axis: 0-2 local x/y/z, 3 thickness, 4 grain, 5 cross (bounding-box axes).
fn tex_axis(code: f32, inst: Inst) -> vec3<f32> {
    let c = i32(code + 0.5);
    if (c == 0) { return vec3<f32>(1.0, 0.0, 0.0); }
    if (c == 1) { return vec3<f32>(0.0, 1.0, 0.0); }
    if (c == 2) { return vec3<f32>(0.0, 0.0, 1.0); }
    if (c == 3) { return inst.t.xyz; }
    if (c == 4) { return inst.g.xyz; }
    return inst.c.xyz;
}

struct TexOut {
    n: vec3<f32>,
    tint: f32,
}

fn apply_texture(m: Mat, inst: Inst, i: u32, lp: vec3<f32>, ns: vec3<f32>) -> TexOut {
    let kind = i32(m.tex.x + 0.5);
    let sc = max(m.tex.y, 1e-3);
    let k = m.tex.z;
    let a = tex_axis(m.tex.w, inst);
    // The two local axes across `a` (one-hot axes are permutations of each other).
    let b = a.yzx;
    let c = a.zxy;
    var out = TexOut(ns, 1.0);
    if (kind == 1) {
        // Layer lines stacked along a.
        let s = dot(lp, a) / sc;
        out.n = ns - k * cos(TAU * s) * tgrad(i, a);
        // Plus layer-to-layer extrusion drift every few layers, which survives at pixel scale.
        out.tint = (1.0 - 0.05 * k * (0.5 + 0.5 * sin(TAU * s)))
            * (1.0 + 0.12 * k * (noise1(s * 0.15, 41u).x - 0.5));
    } else if (kind == 2) {
        // Streaks running along a: noise across it.
        let s = (dot(lp, b) + dot(lp, c)) / sc;
        let n1 = noise1(s, 7u);
        let n2 = noise1(s * 0.31 + 17.0, 13u);
        out.n = ns - k * 0.35 * (0.6 * n1.y + 0.4 * n2.y) * (tgrad(i, b) + tgrad(i, c));
        out.tint = 1.0 + 0.1 * k * (n1.x - 0.5);
    } else if (kind == 3) {
        // Weave across the face: over/under bumps along both in-plane axes.
        let s1 = dot(lp, b) / sc;
        let s2 = dot(lp, c) / sc;
        out.n = ns - k * 0.5 * (cos(TAU * s1) * tgrad(i, b) + cos(TAU * s2) * tgrad(i, c));
        let over = select(-1.0, 1.0, fract(0.5 * (floor(s1) + floor(s2))) < 0.25);
        out.tint = 1.0 + 0.08 * k * over + 0.15 * k * (noise2(vec2<f32>(s1, s2) * 0.11, 3u) - 0.5);
    } else if (kind == 4) {
        // Fibre: blotchy albedo across the face.
        let p = vec2<f32>(dot(lp, b), dot(lp, c)) / sc;
        let n = 0.6 * noise2(p, 3u) + 0.4 * noise2(p * 2.7 + 5.0, 5u);
        out.tint = 1.0 + 1.2 * k * (n - 0.5);
    } else if (kind == 5) {
        // Concentric grooves about a through the local origin.
        let rv = lp - a * dot(lp, a);
        let r = length(rv);
        let s = r / sc;
        out.n = ns - k * cos(TAU * s) * tgrad(i, rv / max(r, 1e-4));
        out.tint = 1.0 - 0.12 * k * (0.5 + 0.5 * sin(TAU * s * 0.021));
    } else if (kind == 6) {
        // Wood figure over the procedural grain: fine pores and flecks along the grain,
        // broken along their length, plus board-scale colour drift. Face grain only (the
        // thickness coordinate is constant there); edges keep their plies.
        if (length(tgrad(i, inst.t.xyz)) < 0.5) {
            let u = dot(lp, inst.c.xyz);
            let v = dot(lp, inst.g.xyz);
            let warp = 4.0 * (noise2(vec2<f32>(u / 30.0, v / 220.0), 21u) - 0.5);
            let streak = noise1((u + warp) / sc, 23u);
            let broken = noise2(vec2<f32>((u + warp) / sc, v / (sc * 40.0)), 29u);
            let pore = smoothstep(0.62, 0.9, streak.x) * smoothstep(0.3, 0.7, broken);
            let drift = noise2(vec2<f32>(u / 90.0, v / 600.0), 31u) - 0.5;
            out.tint = (1.0 - 0.45 * k * pore) * (1.0 + 0.35 * k * drift);
            out.n = ns - k * 0.12 * streak.y * tgrad(i, inst.c.xyz);
        }
    }
    out.n = normalize(out.n);
    return out;
}

// ---------------------------------------------------------------- growth-ring wood
// The part is a plank cut from a log whose axis runs along the grain (inst.g); rings are
// cylinders about it with uneven spacing and a wandering course. Flat cuts put the pith
// under the face and let it drift along the board, so ring lines form arches/cathedrals;
// quarter cuts put it off to the side, so they run as near-straight stripes. Evaluated in
// 3D, so solid edges show the same rings end-on.

struct WoodOut {
    col: vec3<f32>,
    k: f32,
    tilt: f32,
}

fn wood_figure(m: Mat, inst: Inst, lp: vec3<f32>) -> WoodOut {
    let a = dot(lp, inst.c.xyz);
    let g = dot(lp, inst.g.xyz);
    let d = dot(lp, inst.t.xyz) - inst.t.w;
    let log_r = m.fig.y;
    let wob = 6.0 * (noise2(vec2<f32>(a / 70.0, g / 450.0), 51u) - 0.5)
        + 1.6 * (noise2(vec2<f32>(a / 17.0, g / 110.0), 53u) - 0.5);
    var r: f32;
    if (m.fig.x < 1.5) {
        let drift = m.fig2.z * (g + 500.0 * (noise1(g / 900.0, 59u).x - 0.5));
        r = length(vec2<f32>(a - 0.23 * log_r, log_r + d + drift));
    } else {
        // Quarter cuts still wander a little across the stripes along the board.
        r = length(vec2<f32>(a + log_r, d - 0.1 * log_r))
            + 3.0 * (noise2(vec2<f32>(a / 25.0, g / 300.0), 61u) - 0.5);
    }
    r += wob;
    let yr = r / m.fig2.x;
    let f = fract(yr + 0.5 * (noise1(yr * 0.17, 57u).x - 0.5));
    // Earlywood lightens across the ring, latewood darkens towards a crisp boundary.
    let late = smoothstep(0.45, 0.9, f) * (1.0 - smoothstep(0.95, 1.0, f));
    let k = m.fig.w * late;
    var out: WoodOut;
    out.col = mix(m.base.xyz, m.dark.xyz, k);
    out.k = k;
    out.tilt = 0.0;
    if (m.fig.z > 0.0) {
        // Interlocked grain: fibres lean alternately in bands across the face. Band spacing
        // is irregular and the ribbon fades in and out along the board.
        let phase = (a + 0.6 * wob) / m.fig2.y + 0.9 * noise1(a / (2.5 * m.fig2.y), 63u).x;
        let fade = smoothstep(0.25, 0.8, noise2(vec2<f32>(a / 45.0, g / 380.0), 67u));
        let band = sin(TAU * phase) * fade;
        out.tilt = m.fig.z * 0.2 * band;
        out.col *= 1.0 + 0.1 * m.fig.z * band;
    }
    return out;
}

fn surface_of(m: Mat) -> Surface {
    return Surface(m.base.xyz, m.base.w, m.a.x, m.a.y, m.a.z, m.a.w, m.b.x, m.b.y, m.b.z);
}

fn lum(c: vec3<f32>) -> f32 {
    return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

fn schlick(f0: vec3<f32>, c: f32) -> vec3<f32> {
    let k = pow(clamp(1.0 - c, 0.0, 1.0), 5.0);
    return f0 + (vec3<f32>(1.0) - f0) * k;
}

fn schlick1(f0: f32, c: f32) -> f32 {
    return f0 + (1.0 - f0) * pow(clamp(1.0 - c, 0.0, 1.0), 5.0);
}

fn alpha_of(rough: f32) -> f32 {
    return max(rough * rough, 0.0016);
}

fn ggx_d(nh: f32, a: f32) -> f32 {
    let a2 = a * a;
    let k = nh * nh * (a2 - 1.0) + 1.0;
    return a2 / (PI * k * k);
}

fn ggx_g1(nx: f32, a: f32) -> f32 {
    let a2 = a * a;
    return 2.0 * nx / (nx + sqrt(a2 + (1.0 - a2) * nx * nx));
}

// Visible-normal sampling (Dupuy & Benyoub 2023 spherical caps), local frame z = n.
fn sample_vndf(wo: vec3<f32>, a: f32, u: vec2<f32>) -> vec3<f32> {
    let vh = normalize(vec3<f32>(a * wo.x, a * wo.y, wo.z));
    let phi = TAU * u.x;
    let z = (1.0 - u.y) * (1.0 + vh.z) - vh.z;
    let st = sqrt(clamp(1.0 - z * z, 0.0, 1.0));
    let c = vec3<f32>(st * cos(phi), st * sin(phi), z);
    let nh = c + vh;
    return normalize(vec3<f32>(a * nh.x, a * nh.y, max(nh.z, 1e-6)));
}

fn onb(n: vec3<f32>) -> mat3x3<f32> {
    // Duff et al. 2017
    let s = select(-1.0, 1.0, n.z >= 0.0);
    let a = -1.0 / (s + n.z);
    let b = n.x * n.y * a;
    let t = vec3<f32>(1.0 + s * n.x * n.x * a, s * b, -s * n.x);
    let bt = vec3<f32>(b, s + n.y * n.y * a, -n.y);
    return mat3x3<f32>(t, bt, n);
}

struct Lobes {
    diff: f32,
    spec: f32,
    cc: f32,
    trans: f32,
}

fn f0_dielectric(ior: f32) -> f32 {
    let r = (ior - 1.0) / (ior + 1.0);
    return r * r;
}

fn lobe_weights(s: Surface, nv: f32) -> Lobes {
    let f0d = f0_dielectric(s.ior);
    let fd = schlick1(f0d, nv);
    let f0 = mix(vec3<f32>(f0d), s.base, s.metal);
    let coat = s.cc * schlick1(0.04, nv);
    let under = 1.0 - coat;
    let dielectric = 1.0 - s.metal;
    var l: Lobes;
    l.cc = coat;
    l.spec = under * max(lum(schlick(f0, nv)), 0.02);
    l.diff = under * dielectric * (1.0 - s.trans) * (1.0 - fd) * max(lum(s.base), 0.02);
    l.trans = under * dielectric * s.trans * (1.0 - fd);
    let total = l.cc + l.spec + l.diff + l.trans;
    l.cc /= total;
    l.spec /= total;
    l.diff /= total;
    l.trans /= total;
    return l;
}

// Non-delta BSDF value * cos(theta_l), and its sampling pdf, local frame.
struct Eval {
    f: vec3<f32>,
    pdf: f32,
}

fn bsdf_eval(s: Surface, wo: vec3<f32>, wi: vec3<f32>) -> Eval {
    var e: Eval;
    e.f = vec3<f32>(0.0);
    e.pdf = 0.0;
    let nv = wo.z;
    let nl = wi.z;
    if (nl <= 0.0 || nv <= 0.0) {
        return e;
    }
    let lw = lobe_weights(s, nv);
    let h = normalize(wo + wi);
    let nh = h.z;
    let vh = max(dot(wo, h), 0.0);
    let lh = max(dot(wi, h), 0.0);
    let f0d = f0_dielectric(s.ior);
    let coat_v = s.cc * schlick1(0.04, nv);
    let under = 1.0 - coat_v;
    let dielectric = 1.0 - s.metal;

    // Diffuse + sheen
    // Energy not reflected by the specular layer at this view angle reaches the diffuse base.
    let fd = 1.0 - schlick1(f0d, nv);
    let sheen = s.sheen * mix(vec3<f32>(1.0), s.base, 0.5) * pow(1.0 - lh, 5.0);
    let diffuse = (s.base / PI * fd + sheen) * dielectric * (1.0 - s.trans);
    // Base specular
    let a = alpha_of(s.rough);
    let f0 = mix(vec3<f32>(f0d), s.base, s.metal);
    let d = ggx_d(nh, a);
    let g1v = ggx_g1(nv, a);
    let spec = schlick(f0, vh) * d * g1v * ggx_g1(nl, a) / (4.0 * nv * nl);
    var f = under * (diffuse + spec);
    var pdf = lw.diff * nl / PI + lw.spec * d * g1v / (4.0 * nv);
    // Clearcoat
    if (s.cc > 0.0) {
        let ac = alpha_of(s.cc_rough);
        let dc = ggx_d(nh, ac);
        let g1c = ggx_g1(nv, ac);
        f += vec3<f32>(s.cc * schlick1(0.04, vh) * dc * g1c * ggx_g1(nl, ac) / (4.0 * nv * nl));
        pdf += lw.cc * dc * g1c / (4.0 * nv);
    }
    e.f = f * nl;
    e.pdf = pdf;
    return e;
}

struct Sample {
    wi: vec3<f32>,
    weight: vec3<f32>, // f * cos / pdf
    pdf: f32,
    delta: bool,
}

fn bsdf_sample(s: Surface, wo: vec3<f32>) -> Sample {
    var out: Sample;
    out.delta = false;
    out.weight = vec3<f32>(0.0);
    out.pdf = 0.0;
    let lw = lobe_weights(s, wo.z);
    let r = rnd();
    let u = rnd2();
    if (r < lw.trans) {
        // Thin-walled straight-through transmission, tinted per interface.
        out.wi = -wo;
        out.delta = true;
        let f0d = f0_dielectric(s.ior);
        let under = 1.0 - s.cc * schlick1(0.04, wo.z);
        out.weight = sqrt(s.base) * under * (1.0 - s.metal) * s.trans * (1.0 - schlick1(f0d, wo.z)) / lw.trans;
        return out;
    }
    var wi: vec3<f32>;
    if (r < lw.trans + lw.diff) {
        let rr = sqrt(u.x);
        let phi = TAU * u.y;
        wi = vec3<f32>(rr * cos(phi), rr * sin(phi), sqrt(max(1.0 - u.x, 0.0)));
    } else if (r < lw.trans + lw.diff + lw.spec) {
        let h = sample_vndf(wo, alpha_of(s.rough), u);
        wi = reflect(-wo, h);
    } else {
        let h = sample_vndf(wo, alpha_of(s.cc_rough), u);
        wi = reflect(-wo, h);
    }
    let e = bsdf_eval(s, wo, wi);
    if (e.pdf <= 0.0) {
        return out;
    }
    out.wi = wi;
    out.pdf = e.pdf;
    out.weight = e.f / e.pdf;
    return out;
}

// ---------------------------------------------------------------- integrator

struct PathOut {
    radiance: vec3<f32>,
    model: f32,
    albedo: vec3<f32>,
    normal: vec3<f32>,
    shadowed: f32,
    unshadowed: f32,
}

fn offset_point(p: vec3<f32>, ng: vec3<f32>, dir: vec3<f32>) -> vec3<f32> {
    let eps = P.ground.w * (1.0 + 0.001 * length(p));
    return p + ng * select(-eps, eps, dot(dir, ng) > 0.0);
}

// Direct light (area lights + HDRI) at a surface, with MIS against the BSDF.
fn direct(s: Surface, p: vec3<f32>, ng: vec3<f32>, frame: mat3x3<f32>, wo: vec3<f32>) -> vec3<f32> {
    var L = vec3<f32>(0.0);
    let to_local = transpose(frame);
    for (var i = 0u; i < P.cfg.z; i++) {
        let lt = P.lights[i];
        let q = lt.center.xyz + lt.u.xyz * (2.0 * rnd() - 1.0) + lt.v.xyz * (2.0 * rnd() - 1.0);
        let dv = q - p;
        let dist2 = dot(dv, dv);
        let dist = sqrt(dist2);
        let wi = dv / dist;
        let nl = normalize(cross(lt.u.xyz, lt.v.xyz));
        let cos_l = -dot(wi, nl);
        if (cos_l <= 0.0 || dot(wi, ng) <= 0.0) {
            continue;
        }
        let e = bsdf_eval(s, wo, to_local * wi);
        if (e.pdf <= 0.0 && lum(e.f) <= 0.0) {
            continue;
        }
        let pdf_l = dist2 / (light_area(i) * cos_l);
        let o = offset_point(p, ng, wi);
        if (occluded(o, wi, dist * 0.999)) {
            continue;
        }
        L += e.f * lt.radiance.xyz * P.env.x * power_heuristic(pdf_l, e.pdf) / pdf_l;
    }
    if ((P.cfg.y & FLAG_HDRI) != 0u) {
        let es = sample_env();
        let wi = es.xyz;
        if (es.w > 0.0 && dot(wi, ng) > 0.0) {
            let e = bsdf_eval(s, wo, to_local * wi);
            if (lum(e.f) > 0.0) {
                let o = offset_point(p, ng, wi);
                if (!occluded(o, wi, INF) && !ground_blocks(o, wi)) {
                    L += e.f * env_radiance(wi) * power_heuristic(es.w, e.pdf) / es.w;
                }
            }
        }
    }
    return L;
}

fn ground_on() -> bool {
    return (P.cfg.y & FLAG_GROUND) != 0u;
}

fn ground_t(o: vec3<f32>, d: vec3<f32>) -> f32 {
    if (!ground_on() || d.y >= 0.0 || o.y < P.env.w - 1e-3) {
        return INF;
    }
    return (P.env.w - o.y) / d.y;
}

fn ground_blocks(o: vec3<f32>, d: vec3<f32>) -> bool {
    return ground_t(o, d) < INF;
}

// Radiance arriving along a ray that escaped the scene (lights and environment).
fn escaped(o: vec3<f32>, d: vec3<f32>, prev_pdf: f32, prev_delta: bool) -> vec3<f32> {
    for (var i = 0u; i < P.cfg.z; i++) {
        let t = light_hit(i, o, d);
        if (t < INF) {
            let lt = P.lights[i];
            let cos_l = -dot(d, normalize(cross(lt.u.xyz, lt.v.xyz)));
            let pdf_l = t * t / (light_area(i) * cos_l);
            let w = select(power_heuristic(prev_pdf, pdf_l), 1.0, prev_delta);
            return lt.radiance.xyz * P.env.x * w;
        }
    }
    if ((P.cfg.y & FLAG_HDRI) != 0u) {
        let w = select(power_heuristic(prev_pdf, env_pdf(d)), 1.0, prev_delta);
        return env_radiance(d) * w;
    }
    return env_radiance(d);
}

// Shadow-catcher estimate at a ground point seen directly: irradiance with and without
// the model in the way (luminance).
fn catcher(p: vec3<f32>) -> vec2<f32> {
    var shadowed = 0.0;
    var open = 0.0;
    let n = vec3<f32>(0.0, 1.0, 0.0);
    let o = p + n * P.ground.w;
    for (var i = 0u; i < P.cfg.z; i++) {
        let lt = P.lights[i];
        let q = lt.center.xyz + lt.u.xyz * (2.0 * rnd() - 1.0) + lt.v.xyz * (2.0 * rnd() - 1.0);
        let dv = q - p;
        let dist2 = dot(dv, dv);
        let dist = sqrt(dist2);
        let wi = dv / dist;
        let cos_l = -dot(wi, normalize(cross(lt.u.xyz, lt.v.xyz)));
        if (cos_l <= 0.0 || wi.y <= 0.0) {
            continue;
        }
        let e = lum(lt.radiance.xyz) * wi.y * cos_l * light_area(i) / dist2;
        open += e;
        if (!occluded(o, wi, dist)) {
            shadowed += e;
        }
    }
    var wi: vec3<f32>;
    var e: f32;
    if ((P.cfg.y & FLAG_HDRI) != 0u) {
        let es = sample_env();
        wi = es.xyz;
        e = select(0.0, lum(env_radiance(wi)) * wi.y / max(es.w, 1e-12), wi.y > 0.0);
    } else {
        let u = rnd2();
        let rr = sqrt(u.x);
        let phi = TAU * u.y;
        wi = vec3<f32>(rr * cos(phi), sqrt(max(1.0 - u.x, 0.0)), rr * sin(phi));
        e = PI * lum(dome(wi));
    }
    open += e;
    if (!occluded(o, wi, INF)) {
        shadowed += e;
    }
    return vec2<f32>(shadowed, open);
}

fn trace(o_in: vec3<f32>, d_in: vec3<f32>) -> PathOut {
    var out: PathOut;
    out.radiance = vec3<f32>(0.0);
    out.model = 0.0;
    out.albedo = vec3<f32>(0.0);
    out.normal = vec3<f32>(0.0);
    out.shadowed = 0.0;
    out.unshadowed = 0.0;
    var o = o_in;
    var d = d_in;
    var thr = vec3<f32>(1.0);
    var straight = true; // still on the camera ray (only see-through passes so far)
    var prev_pdf = 0.0;
    var prev_delta = true;
    var bounce = 0u;
    var passes = 0u;
    loop {
        let h = intersect(o, d, INF);
        let tg = ground_t(o, d);
        var s: Surface;
        var p: vec3<f32>;
        var ng: vec3<f32>;
        var ns: vec3<f32>;
        if (h.tri != 0xffffffffu && h.t < tg) {
            let i = h.tri;
            let inst = insts[inst_of(i)];
            let m = mats[inst.m.x];
            s = surface_of(m);
            p = o + d * h.t;
            let w = 1.0 - h.u - h.v;
            ng = normalize(cross(tris[3u * i + 1u].xyz, tris[3u * i + 2u].xyz));
            ns = normalize(attrs[6u * i].xyz * w + attrs[6u * i + 1u].xyz * h.u + attrs[6u * i + 2u].xyz * h.v);
            if (m.b.w > 0.5 || m.tex.x > 0.5) {
                let l0 = attrs[6u * i + 3u].xyz;
                let l1 = attrs[6u * i + 4u].xyz;
                let l2 = attrs[6u * i + 5u].xyz;
                let lp = l0 * w + l1 * h.u + l2 * h.v;
                if (m.b.w > 0.5) {
                    let ln = normalize(cross(l1 - l0, l2 - l0));
                    let face = abs(dot(ln, inst.t.xyz)) > 0.5;
                    // Ring figure on faces, and on every side of solid (single-ply) parts;
                    // plywood edges keep their laminations.
                    if (m.fig.x > 0.5 && (face || inst.g.w < 1.5)) {
                        let wf = wood_figure(m, inst, lp);
                        s.base = wf.col;
                        s.rough = clamp(s.rough * (1.0 + 0.12 * wf.k), 0.0, 1.0);
                        if (face && wf.tilt != 0.0) {
                            ns = normalize(ns + wf.tilt * tgrad(i, inst.c.xyz));
                        }
                    } else {
                        let gc = grain_color(m, inst, lp, ln);
                        s.base = gc.xyz;
                        s.rough = clamp(s.rough * (1.0 + 0.12 * gc.w), 0.0, 1.0);
                    }
                }
                if (m.tex.x > 0.5) {
                    let tx = apply_texture(m, inst, i, lp, ns);
                    ns = tx.n;
                    s.base = clamp(s.base * tx.tint, vec3<f32>(0.0), vec3<f32>(1.0));
                }
            }
            // See-through coverage (grille cloth): continue untouched.
            if (s.opacity < 1.0 && rnd() >= s.opacity) {
                passes++;
                if (passes > 24u) {
                    break;
                }
                o = p + d * P.ground.w;
                continue;
            }
        } else if (tg < INF) {
            p = o + d * tg;
            if (straight) {
                let c = catcher(p);
                out.shadowed = c.x;
                out.unshadowed = c.y;
                return out;
            }
            s = Surface(P.ground.xyz, 1.0, 0.0, 0.0, 0.1, 0.0, 1.5, 1.0, 0.0);
            ng = vec3<f32>(0.0, 1.0, 0.0);
            ns = ng;
        } else {
            if (!straight) {
                var e = thr * escaped(o, d, prev_pdf, prev_delta);
                if (bounce > 1u) {
                    let l = lum(e);
                    if (l > P.env.z) {
                        e *= P.env.z / l;
                    }
                }
                out.radiance += e;
            }
            return out;
        }

        // Shade from the side the ray arrives on.
        if (dot(ng, d) > 0.0) {
            ng = -ng;
            ns = -ns;
        }
        if (dot(ns, -d) <= 0.01) {
            ns = ng;
        }
        if (straight) {
            straight = false;
            out.model = 1.0;
            out.albedo = s.base;
            out.normal = ns;
        }
        let frame = onb(ns);
        let to_local = transpose(frame);
        let wo = to_local * (-d);

        var dl = thr * direct(s, p, ng, frame, wo);
        if (bounce > 0u) {
            let l = lum(dl);
            if (l > P.env.z) {
                dl *= P.env.z / l;
            }
        }
        out.radiance += dl;

        bounce++;
        if (bounce >= P.cfg.x) {
            break;
        }
        let bs = bsdf_sample(s, wo);
        if (lum(bs.weight) <= 0.0) {
            break;
        }
        let wi = frame * bs.wi;
        if (!bs.delta && dot(wi, ng) <= 0.0) {
            break; // shading normal sent the ray under the surface
        }
        thr *= bs.weight;
        prev_pdf = bs.pdf;
        prev_delta = bs.delta;
        if (bounce > 3u) {
            let q = clamp(max(thr.x, max(thr.y, thr.z)), 0.05, 0.95);
            if (rnd() > q) {
                break;
            }
            thr /= q;
        }
        o = offset_point(p, ng, wi);
        d = wi;
    }
    return out;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let w = P.dims.x;
    let h = P.dims.y;
    if (gid.x >= w || gid.y >= h) {
        return;
    }
    let pix = gid.y * w + gid.x;
    var c = vec4<f32>(0.0);
    var a = vec4<f32>(0.0);
    var n = vec4<f32>(0.0);
    for (var k = 0u; k < P.dims.w; k++) {
        seed = pcg(pix ^ pcg(P.dims.z + k + 0x9e3779b9u));
        let j = rnd2();
        let ndc = vec2<f32>(
            ((f32(gid.x) + j.x) / f32(w)) * 2.0 - 1.0,
            1.0 - ((f32(gid.y) + j.y) / f32(h)) * 2.0,
        );
        let t = P.cam_pos.w;
        let dir = normalize(
            P.cam_fwd.xyz
            + P.cam_right.xyz * (ndc.x * t * P.cam_fwd.w + P.cam_right.w)
            + P.cam_up.xyz * (ndc.y * t + P.cam_up.w),
        );
        var origin = P.cam_pos.xyz;
        var ray = dir;
        if (P.lens.x > 0.0) {
            // Thin lens: jitter the origin over the aperture, keep the focal plane sharp.
            let focal = origin + dir * (P.lens.y / dot(dir, P.cam_fwd.xyz));
            let u = rnd2();
            let rr = sqrt(u.x) * P.lens.x;
            origin += P.cam_right.xyz * (rr * cos(TAU * u.y)) + P.cam_up.xyz * (rr * sin(TAU * u.y));
            ray = normalize(focal - origin);
        }
        let r = trace(origin, ray);
        let rad = select(r.radiance, vec3<f32>(0.0), r.radiance != r.radiance); // drop NaNs
        c += vec4<f32>(rad, r.model);
        a += vec4<f32>(r.albedo, r.shadowed);
        n += vec4<f32>(r.normal, r.unshadowed);
    }
    accum[3u * pix] += c;
    accum[3u * pix + 1u] += a;
    accum[3u * pix + 2u] += n;
}
