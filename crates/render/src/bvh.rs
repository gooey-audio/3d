//! Binned-SAH BVH over world-space triangles, flattened for the GPU: interior nodes keep
//! their two children adjacent at `left_first` and `left_first + 1`; leaves (`count > 0`)
//! own triangles `left_first .. left_first + count` of the reordered triangle list.

use glam::Vec3;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, bytemuck::Pod, bytemuck::Zeroable)]
pub struct Node {
    pub min: [f32; 3],
    pub left_first: u32,
    pub max: [f32; 3],
    pub count: u32,
}

pub struct Bvh {
    pub nodes: Vec<Node>,
    /// Triangle order referenced by the leaves (indices into the input slice).
    pub order: Vec<u32>,
}

#[derive(Clone, Copy)]
struct Aabb {
    min: Vec3,
    max: Vec3,
}

impl Aabb {
    const EMPTY: Aabb = Aabb {
        min: Vec3::splat(f32::INFINITY),
        max: Vec3::splat(f32::NEG_INFINITY),
    };
    fn grow(&mut self, p: Vec3) {
        self.min = self.min.min(p);
        self.max = self.max.max(p);
    }
    fn union(&mut self, o: &Aabb) {
        self.min = self.min.min(o.min);
        self.max = self.max.max(o.max);
    }
    fn area(&self) -> f32 {
        let e = (self.max - self.min).max(Vec3::ZERO);
        e.x * e.y + e.y * e.z + e.z * e.x
    }
}

const BINS: usize = 16;
const MAX_LEAF: usize = 4;

pub fn build(tris: &[[Vec3; 3]]) -> Bvh {
    let boxes: Vec<Aabb> = tris
        .iter()
        .map(|t| {
            let mut b = Aabb::EMPTY;
            t.iter().for_each(|&p| b.grow(p));
            b
        })
        .collect();
    let centroids: Vec<Vec3> = boxes.iter().map(|b| (b.min + b.max) * 0.5).collect();
    let mut order: Vec<u32> = (0..tris.len() as u32).collect();
    let mut nodes = vec![Node::default()];
    // (node index, first, count)
    let mut stack = vec![(0usize, 0usize, tris.len())];
    while let Some((ni, first, count)) = stack.pop() {
        let mut bounds = Aabb::EMPTY;
        let mut cbounds = Aabb::EMPTY;
        for &i in &order[first..first + count] {
            bounds.union(&boxes[i as usize]);
            cbounds.grow(centroids[i as usize]);
        }
        nodes[ni].min = bounds.min.to_array();
        nodes[ni].max = bounds.max.to_array();
        let leaf = |nodes: &mut Vec<Node>| {
            nodes[ni].left_first = first as u32;
            nodes[ni].count = count as u32;
        };
        if count <= MAX_LEAF {
            leaf(&mut nodes);
            continue;
        }
        // Best binned SAH split over all three axes.
        let extent = cbounds.max - cbounds.min;
        let mut best = (f32::INFINITY, 0usize, 0.0f32);
        for axis in 0..3 {
            if extent[axis] <= 1e-9 {
                continue;
            }
            let scale = BINS as f32 / extent[axis];
            let bin_of = |i: u32| (((centroids[i as usize][axis] - cbounds.min[axis]) * scale) as usize).min(BINS - 1);
            let mut bin_box = [Aabb::EMPTY; BINS];
            let mut bin_n = [0usize; BINS];
            for &i in &order[first..first + count] {
                let b = bin_of(i);
                bin_n[b] += 1;
                bin_box[b].union(&boxes[i as usize]);
            }
            let mut left_area = [0.0f32; BINS - 1];
            let mut left_n = [0usize; BINS - 1];
            let (mut acc, mut n) = (Aabb::EMPTY, 0);
            for b in 0..BINS - 1 {
                acc.union(&bin_box[b]);
                n += bin_n[b];
                left_area[b] = acc.area();
                left_n[b] = n;
            }
            let (mut acc, mut n) = (Aabb::EMPTY, 0);
            for b in (1..BINS).rev() {
                acc.union(&bin_box[b]);
                n += bin_n[b];
                let ln = left_n[b - 1];
                if ln == 0 || n == 0 {
                    continue;
                }
                let cost = left_area[b - 1] * ln as f32 + acc.area() * n as f32;
                if cost < best.0 {
                    best = (cost, axis, cbounds.min[axis] + b as f32 / scale);
                }
            }
        }
        let (cost, axis, split) = best;
        // No usable split, or splitting costs more than a small leaf.
        if !cost.is_finite() || (count <= 16 && cost >= bounds.area() * count as f32) {
            leaf(&mut nodes);
            continue;
        }
        let slice = &mut order[first..first + count];
        let mut mid = 0;
        for k in 0..slice.len() {
            if centroids[slice[k] as usize][axis] < split {
                slice.swap(k, mid);
                mid += 1;
            }
        }
        if mid == 0 || mid == count {
            mid = count / 2; // all centroids in one bin edge: fall back to a median split
            slice.select_nth_unstable_by(mid, |a, b| {
                centroids[*a as usize][axis].total_cmp(&centroids[*b as usize][axis])
            });
        }
        let left = nodes.len();
        nodes.push(Node::default());
        nodes.push(Node::default());
        nodes[ni].left_first = left as u32;
        nodes[ni].count = 0;
        stack.push((left, first, mid));
        stack.push((left + 1, first + mid, count - mid));
    }
    Bvh { nodes, order }
}

/// Möller–Trumbore; returns (t, u, v). Same test the shader uses.
#[cfg(test)]
pub fn intersect_tri(o: Vec3, d: Vec3, t: &[Vec3; 3]) -> Option<(f32, f32, f32)> {
    let e1 = t[1] - t[0];
    let e2 = t[2] - t[0];
    let p = d.cross(e2);
    let det = e1.dot(p);
    if det.abs() < 1e-12 {
        return None;
    }
    let inv = 1.0 / det;
    let s = o - t[0];
    let u = s.dot(p) * inv;
    if !(0.0..=1.0).contains(&u) {
        return None;
    }
    let q = s.cross(e1);
    let v = d.dot(q) * inv;
    if v < 0.0 || u + v > 1.0 {
        return None;
    }
    let t = e2.dot(q) * inv;
    (t > 1e-4).then_some((t, u, v))
}

impl Bvh {
    /// CPU traversal mirroring the shader.
    #[cfg(test)]
    pub fn intersect(&self, tris: &[[Vec3; 3]], o: Vec3, d: Vec3) -> Option<(f32, u32)> {
        let inv = d.recip();
        let mut best: Option<(f32, u32)> = None;
        let mut stack = vec![0u32];
        while let Some(ni) = stack.pop() {
            let n = &self.nodes[ni as usize];
            let t0 = (Vec3::from(n.min) - o) * inv;
            let t1 = (Vec3::from(n.max) - o) * inv;
            let tmin = t0.min(t1).max_element().max(0.0);
            let tmax = t0.max(t1).min_element().min(best.map_or(f32::INFINITY, |b| b.0));
            if tmin > tmax {
                continue;
            }
            if n.count > 0 {
                for k in n.left_first..n.left_first + n.count {
                    let ti = self.order[k as usize];
                    if let Some((t, _, _)) = intersect_tri(o, d, &tris[ti as usize])
                        && best.is_none_or(|b| t < b.0)
                    {
                        best = Some((t, ti));
                    }
                }
            } else {
                stack.push(n.left_first);
                stack.push(n.left_first + 1);
            }
        }
        best
    }

    pub fn depth(&self) -> usize {
        fn go(nodes: &[Node], i: usize) -> usize {
            let n = &nodes[i];
            if n.count > 0 {
                1
            } else {
                1 + go(nodes, n.left_first as usize).max(go(nodes, n.left_first as usize + 1))
            }
        }
        go(&self.nodes, 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Small deterministic generator so the test needs no rand crate.
    fn lcg(s: &mut u64) -> f32 {
        *s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((*s >> 40) as f32) / (1u64 << 24) as f32
    }

    #[test]
    fn matches_brute_force() {
        let mut s = 7u64;
        let r3 = |s: &mut u64| Vec3::new(lcg(s), lcg(s), lcg(s)) * 2.0 - 1.0;
        let tris: Vec<[Vec3; 3]> = (0..2000)
            .map(|_| {
                let c = r3(&mut s) * 10.0;
                [c + r3(&mut s), c + r3(&mut s), c + r3(&mut s)]
            })
            .collect();
        let bvh = build(&tris);
        let mut sorted = bvh.order.clone();
        sorted.sort();
        assert_eq!(sorted, (0..tris.len() as u32).collect::<Vec<_>>());
        let mut hits = 0;
        for _ in 0..3000 {
            let o = r3(&mut s) * 15.0;
            let d = (r3(&mut s) * 10.0 - o).normalize();
            let brute = tris
                .iter()
                .enumerate()
                .filter_map(|(i, t)| intersect_tri(o, d, t).map(|h| (h.0, i as u32)))
                .min_by(|a, b| a.0.total_cmp(&b.0));
            let fast = bvh.intersect(&tris, o, d);
            assert_eq!(brute.map(|b| b.1), fast.map(|b| b.1));
            hits += brute.is_some() as usize;
        }
        assert!(hits > 300, "test rays should hit often ({hits})");
    }
}
