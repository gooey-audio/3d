// Replicad idioms the agent models got wrong, each checked against gooey-3d cad (Replicad
// 1.2.1) on 2026-11-19. Part of the system prompt (lib/agent.ts).
export const REPLICAD_IDIOMS = `## Replicad idioms (checked against this kernel)

Lengths below are in the script's \`units\`; the examples give inch, cm and mm values.

Fillets and chamfers:
- Fillet edges that meet at a corner in ONE call. A second fillet next to an earlier one \
(e.g. rounding the top edges after the vertical corners were rounded) fails with \
\`BRep_API: command not done\`. Widen the existing call instead: \
\`shape.fillet(r, (e) => e.either([(f) => f.inDirection("Z"), (f) => f.inPlane("XY", h)]))\`.
- Fillet before you drill holes or cut slots; otherwise \`inDirection("Z")\` also picks the hole \
seams. If the order cannot change, narrow the finder: \`.inBox(...)\` or \`.not((f) => ...)\`.
- A radius must be smaller than half the narrowest adjacent face. On \`command not done\` or \
\`invalid\`, reduce it or drop the offending edges; do not retry the same call.
- Fillets run along tangent-continuous edge chains. Filleting one edge of a smooth (spline) top \
rounds the whole chain along that side.
- \`inBox\` also matches edges that only touch the box: a box around the top face also catches \
the vertical edges below it. Add \`.not((f) => f.inDirection("Z"))\` or use \`inPlane\`.
- The edges of one face: \`const face = new FaceFinder().near([x, y, z], tol).find(shape, \
{ unique: true }); shape = shape.fillet(r, (e) => e.inList(face.edges));\` (destructure \
\`FaceFinder\` from the replicad argument). Use the face's centre or a point on it, in the \
coordinates of the shape at that point in the script, and a small \`tol\` (about 0.01 in, \
0.03 cm or 0.3 mm). On curved faces, \`containsPoint\` often \
misses because a centre or a clicked point is not exactly on the surface. Use \`near\` there.

Planes, sketches and directions:
- A number origin moves along the plane's normal, and "XZ"'s normal is -Y. \
\`sketchOnPlane("XZ", 5)\` and \`FaceFinder().inPlane("XZ", 5)\` therefore mean y = -5. Use a \
point origin to avoid the sign: \`sketchOnPlane("XZ", [0, y, 0])\`, \`inPlane("XZ", [0, y, 0])\`. \
Alternatively use "ZX" (normal +Y; local x → Z, y → X).
- \`extrude(d)\` goes along the sketch normal: +Z for "XY", -Y for "XZ", +X for "YZ". A negative \
distance extrudes the other way. To extrude a side profile across a width w centred on y = 0, \
use \`sketchOnPlane("XZ", [0, w / 2, 0]).extrude(w)\`.
- \`makeCylinder(r, h, base, dir)\` starts at \`base\` and grows along \`dir\` (default +Z). For a \
side hole, use \`dir\` [1,0,0] or [0,1,0] and start a little outside the wall (0.05 in, 0.1 cm or 1 mm).

cut versus fuse:
- \`cut\` removes material: holes, pockets, slots, chamfer tools. \`fuse\` adds it: bosses, ribs, \
tabs. Both return a new shape, so reassign (\`part = part.cut(tool)\`).
- A cut tool must pass through each surface it opens by at least 0.05 in (0.1 cm, 1 mm). A flush tool leaves a \
zero-thickness skin or coplanar faces.
- A fused body must overlap the part by at least 0.02 in (0.05 cm, 0.5 mm). Touching or separate solids give \
pieces: 2, which \`expect\` should catch. Check \`pieces\` after every fuse.
- Cut 2D holes in the drawing before you sketch (\`drawing.cut(drawCircle(r).translate([x, \
y]))\`). That is cheaper and more robust than many 3D cuts.`;
