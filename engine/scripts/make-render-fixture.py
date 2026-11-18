"""python3 scripts/make-render-fixture.py fixtures/render

Writes fixtures/render: synthetic STLs, assembly.json and bounds.json (expected world
bounds computed here, independently of the Rust loader)."""
import json, math, struct, sys
from pathlib import Path

D = Path(sys.argv[1])

def box(lo, hi):
    (x0,y0,z0),(x1,y1,z1) = lo, hi
    v = [(x0,y0,z0),(x1,y0,z0),(x1,y1,z0),(x0,y1,z0),(x0,y0,z1),(x1,y0,z1),(x1,y1,z1),(x0,y1,z1)]
    f = [(0,2,1),(0,3,2),(4,5,6),(4,6,7),(0,1,5),(0,5,4),(2,3,7),(2,7,6),(1,2,6),(1,6,5),(0,4,7),(0,7,3)]
    return [tuple(v[i] for i in t) for t in f]

def cylinder(r, h, n=48):
    tris = []
    for i in range(n):
        a0, a1 = 2*math.pi*i/n, 2*math.pi*(i+1)/n
        p0 = (r*math.cos(a0), r*math.sin(a0)); p1 = (r*math.cos(a1), r*math.sin(a1))
        tris += [((0,0,0),(p1[0],p1[1],0),(p0[0],p0[1],0)), ((0,0,h),(p0[0],p0[1],h),(p1[0],p1[1],h)),
                 ((p0[0],p0[1],0),(p1[0],p1[1],0),(p1[0],p1[1],h)), ((p0[0],p0[1],0),(p1[0],p1[1],h),(p0[0],p0[1],h))]
    return tris

def write_stl(path, tris):
    b = bytearray(b"gooey-3d render fixture".ljust(80, b" ")) + struct.pack("<I", len(tris))
    for t in tris:
        b += struct.pack("<3f", 0, 0, 0)
        for p in t: b += struct.pack("<3f", *p)
        b += b"\0\0"
    path.write_bytes(bytes(b))

# An L bracket: two boxes, asymmetric so rotation and mirroring show in the bounds.
bracket = box((0,0,0),(40,20,4)) + box((0,0,4),(4,20,30))
shapes = {"block": box((0,0,0),(40,20,10)), "puck": cylinder(15, 8), "bracket": bracket}
for name, tris in shapes.items():
    write_stl(D/"stl"/f"{name}.stl", tris)

manifest = {
  "name": "render fixture", "up": "z",
  "materials": [
    {"id": "pla", "finish": "pla/matte", "color": "#e0e0dc"},
    {"id": "walnut", "finish": "wood/walnut", "color": "#5a3a26", "grain": {"color": "#3a2416", "period_mm": 14}},
    {"id": "steel", "color": "#9aa0a6", "roughness": 0.3, "metalness": 1.0},
  ],
  "parts": [
    {"id": "block", "material": "walnut"}, {"id": "puck", "material": "steel"}, {"id": "bracket", "material": "pla"},
  ],
  "assets": [{"id": k, "src": f"stl/{k}.stl"} for k in shapes],
  "variants": [{"id": "foot", "default": "puck", "options": [{"id": "puck"}, {"id": "bracket"}]}],
  "instances": [
    {"id": "base", "part": "block", "asset": "block", "position": [0, 0, 0]},
    {"id": "turned", "part": "block", "asset": "block", "position": [70, 0, 0], "rotation": [0, 0, 90]},
    {"id": "tilted", "part": "bracket", "asset": "bracket", "position": [0, 50, 0], "rotation": [30, -20, 45]},
    {"id": "mirrored", "part": "bracket", "asset": "bracket", "position": [-20, 0, 0], "scale": [-1, 1, 1]},
    {"id": "by-matrix", "part": "puck", "asset": "puck",
     "matrix": [0, 1, 0, 0,  -1, 0, 0, 0,  0, 0, 1, 0,  20, -40, 10, 1]},
    {"id": "lid", "part": "block", "asset": "block", "material": "pla", "position": [0, 0, 10],
     "explode": [0, 0, 25], "groups": ["covers"]},
    {"id": "spare", "part": "puck", "asset": "puck", "position": [100, 100, 0], "hidden": True},
    {"id": "foot-puck", "part": "puck", "asset": "puck", "position": [20, 10, -8], "variants": {"foot": ["puck"]}},
    {"id": "foot-bracket", "part": "bracket", "asset": "bracket", "position": [0, 0, -30], "variants": {"foot": ["bracket"]}},
  ],
}
(D/"assembly.json").write_text(json.dumps(manifest, indent=2) + "\n")

def mat(rows): return rows
def mul(a, b): return [[sum(a[i][k]*b[k][j] for k in range(len(b))) for j in range(len(b[0]))] for i in range(len(a))]
def rx(d):
    c, s = math.cos(math.radians(d)), math.sin(math.radians(d)); return [[1,0,0],[0,c,-s],[0,s,c]]
def ry(d):
    c, s = math.cos(math.radians(d)), math.sin(math.radians(d)); return [[c,0,s],[0,1,0],[-s,0,c]]
def rz(d):
    c, s = math.cos(math.radians(d)), math.sin(math.radians(d)); return [[c,-s,0],[s,c,0],[0,0,1]]
UP_Z = [[1,0,0],[0,0,1],[0,-1,0]]  # +Z -> +Y
def det3(m):
    return (m[0][0]*(m[1][1]*m[2][2]-m[1][2]*m[2][1]) - m[0][1]*(m[1][0]*m[2][2]-m[1][2]*m[2][0])
            + m[0][2]*(m[1][0]*m[2][1]-m[1][1]*m[2][0]))

def placement(inst):
    if "matrix" in inst:
        c = inst["matrix"]
        r = [[c[0], c[4], c[8]], [c[1], c[5], c[9]], [c[2], c[6], c[10]]]
        t = [c[12], c[13], c[14]]
    else:
        rot = inst.get("rotation", [0, 0, 0]); sc = inst.get("scale", [1, 1, 1])
        r = mul(mul(mul(rx(rot[0]), ry(rot[1])), rz(rot[2])), [[sc[0],0,0],[0,sc[1],0],[0,0,sc[2]]])
        t = inst.get("position", [0, 0, 0])
    return r, t

def bounds(inst, explode):
    r, t = placement(inst)
    e = [x * explode for x in inst.get("explode", [0, 0, 0])]
    pts = []
    for tri in shapes[inst["asset"]]:
        for p in tri:
            p = [float(struct.unpack("<f", struct.pack("<f", x))[0]) for x in p]
            q = [sum(r[i][k]*p[k] for k in range(3)) + t[i] + e[i] for i in range(3)]
            pts.append([sum(UP_Z[i][k]*q[k] for k in range(3)) for i in range(3)])
    lo = [round(min(p[i] for p in pts), 4) for i in range(3)]
    hi = [round(max(p[i] for p in pts), 4) for i in range(3)]
    return {"min": lo, "max": hi, "mirrored": det3(r) < 0}

def visible(variants, hide_groups):
    chosen = {"foot": variants.get("foot", "puck")}
    for inst in manifest["instances"]:
        if inst.get("hidden"): continue
        if set(inst.get("groups", [])) & set(hide_groups): continue
        if any(chosen.get(k) not in v for k, v in inst.get("variants", {}).items()): continue
        yield inst

cases = []
for name, explode, variants, hide in [("default", 0.0, {}, []), ("exploded", 1.0, {}, []),
                                      ("bracket-foot-no-covers", 0.5, {"foot": "bracket"}, ["covers"])]:
    cases.append({"name": name, "explode": explode, "variants": variants, "hide_groups": hide,
                  "instances": {i["id"]: bounds(i, explode) for i in visible(variants, hide)}})
(D/"bounds.json").write_text(json.dumps({"about": "Expected world bounds (mm, +Y up) of assembly.json, computed by a separate implementation of the placement rules.", "cases": cases}, indent=1) + "\n")
print("ok", [len(c["instances"]) for c in cases])
