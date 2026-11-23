---
name: gooey-3d-moulds
description: Choose, design, check and print moulds for casting concrete, resin or plaster parts (plinths, slabs, feet, waveguides). Picks wood forms, PLA split moulds, TPU cups or PLA master + silicone by shape; builds printed moulds with the gooey-3d CLI (gooey-audio/3d, `gooey-3d mould`); enforces printability with `gooey-3d mould check`; covers Bambu A1 PLA and TPU printing. Use for any cast part, mould STL or mould print failure.
---

# Casting moulds

The goal is the cast part: concrete or resin is the material that shows, and the
mould is a tool, so it should be quick and reliable to make, not a showpiece. The
worked example is the synthetic slab in `fixtures/slab-m5-square-ears/` of
gooey-audio/3d: a 100 x 100 x 30 mm slab with a through slot and a counterbore.

## 1. Pick the method by shape

| Shape | Method | Notes |
|---|---|---|
| Flat-faced block or slab | **Wood form box**: melamine or MDF, caulked joints | Cheapest and crispest; no printing. Formers: waxed ply strips, steel dowel pins. |
| Straight-sided part with slots, bosses or holes | **PLA split mould** (`"method": "split"`) | Default for printed moulds. Rigid, prints with normal PLA settings, unbolts instead of flexing. |
| Curves or shallow undercuts that must peel off | **TPU cup** (`"method": "cup"`) | Works, but slow and fussy to print (see TPU below). |
| Organic, textured or undercut shapes | **PLA master + silicone** | Print the part itself, seal it, pour silicone round it. |
| Waveguides | waveopt Studio's own moulds | TPU halves, quadrants or box mould; `docs/tpu-mould.md` in waveopt. |

## 2. Build it with castkit, not a copy

The mould geometry lives in **one place**: castkit, run as `gooey-3d mould` from gooey-audio/3d
(install a release binary, or `cargo install --git https://github.com/gooey-audio/3d gooey-3d`).
Write the cast part as an STL, next to a spec, and build:

```json
{ "castkit": 1, "part": "slab.stl", "method": "split", "material": "pla",
  "bolts": "M5", "square_ears": true, "nut_trap": true,
  "z_part": 28.0, "rotate_deg": [0, 0, 0],
  "k": { "wall": 8.0, "base": 12.7 }, "out": "mould/" }
```

```sh
gooey-3d mould build mould.json          # one STL per part (print pose) + report.json in out/
gooey-3d mould build mould.json --check  # CI: rebuild and compare with the committed report.json
gooey-3d mould check part.stl --material pla
gooey-3d render sheet mould/*.stl --out mould/sheet.png   # look at what was built (see the render skill)
```

- **Frame:** the part is given in the casting frame (after `rotate_deg`): the open
  top is its lowest z, the core pulls along +z, the halves split on x = 0 and slide
  along ±x. Orient through-slots along x, so the halves carry them and slide out
  along them. castkit centres the part in x and y.
- **`material` is required** (`pla` or `tpu`): it sets the checker's limits and
  the weight estimate.
- **Part above edge chamfers:** set `z_part` to the foot of any chamfer on the core
  face, so the core moulds the chamfer and the halves don't end in a knife edge.
- **`cast`:** an optional second STL, the part less cast-in pins; defaults to the part.
- **`k`:** overrides of wall 12, base 10, ear 20, flange 8, bolt 5.5, pocket 14,
  bolt_spacing 50, vent 3, vent_spacing 40, key 3, key_fit 0.3, segments 32,
  nut_af, nut_fit (cups: wall 6, floor 5). `bolts` sets bolt, pocket and nut_af together.
- **Small holes:**
  - **PLA:** model the hole in the cast part, tapered about 0.5° (wider at the
    core). The split frame turns it into a printed pin on the core that pulls
    straight out. A 6 mm pin 30 mm tall prints fine.
  - **TPU:** tall pins topple, so use greased steel dowel pins through the mould
    floor.
- **Screw seats:** flat counterbores and pan heads, never countersinks (a cone wedges
  concrete apart). A counterbore moulds as a short, stable boss.
- **Tangencies:** never let booleaned surfaces meet tangentially; offset by ≥ 0.3 mm
  or make them coaxial at different radii.
- **Improve castkit itself** if something's missing (gooey-audio/3d, with a golden
  fixture); don't fork the geometry into a project.

## 3. Check every part (enforced)

`gooey-3d mould build` checks every part it writes and exits non-zero on any failure;
`report.json` carries the full checker report per part. For STLs from elsewhere,
run `gooey-3d mould check part.stl --material pla|tpu`:

- closed, one piece, no vertices within 0.001 mm (a slicer welds them into pinches);
- fits the A1's 256 mm bed, flat-bottom down (30 % of the footprint on the bed);
- free-standing posts no taller than 3:1 (TPU) or 8:1 (PLA);
- walls at least 2 mm (TPU) or 1.6 mm (PLA);
- overhangs over 45° under 0.5 cm² (TPU) or 3 cm² (PLA), with flat bridges up to
  20 mm allowed for PLA.

Then draw a section and render an exploded view, and look at both.

## 4. Findings so far (keep adding)

- **TPU is fussy.** Spools must be dried (70 °C, 8 h), fed from a dry box, and printed
  at 3–4 mm³/s. Failures came about 1 in 3 prints, and an early cup lost its pins
  overnight. Use PLA unless the shape needs to flex off.
- **Tall thin TPU pins topple.** PLA pins at about 5:1 with a slight draft are fine.
- **Bolt access:**
  - M4 or M5 bolts through ears hold a split mould together well.
  - Holding a nut deep in a round pocket bored into the 45° ear gusset (the tapered
    gap) was awkward.
  - Rigid moulds use `"square_ears": true`: full-depth square ribs with flat-walled
    notches open at the side. The nut drops in, the notch's flats stop it spinning,
    and the bolt turns from the other side with a hex key. Square channels reach the
    hold-down bolts.
  - Don't print halves parting face down: the end wall becomes a flat ceiling
    across the whole cavity.
  - Short moulds get one seam bolt per side; two would overlap.
- **Float precision:**
  - castkit snaps its outer frame to 1/8 mm.
  - Outlines such as 57.15 + 8 mm otherwise land nanometres apart in the ears
    (CrossSections) and the block (a box), and break once stored as float32 STL.
  - castkit guarantees every part it writes survives a float32 round-trip and a
    slicer-style weld (closed, one piece, no vertices within 0.001 mm); the
    checker does the same weld before testing any STL.
- **Release agents:** cooking spray, form oil or Vaseline on PLA. Layer lines copy
  into the concrete, so use 0.16 mm layers on faces that show.

## 5. Printing on the Bambu A1

### PLA (split moulds)
Standard "0.20mm Standard @BBL A1" with the A1's 0.4 mm nozzle, 3 walls, 15 % gyroid,
no supports. Print halves parting face up and the core slab down.

### TPU (Elegoo TPU on the A1)

Most intermittent TPU failures (gaps, missing layers, stringing) come from wet
filament, the feed path, or printing faster than TPU can melt.

- **Dry it:** about 70 °C for 8 h in a filament dryer, then print from a dry
  box. TPU absorbs water within hours,
  and wet TPU pops, strings and under-extrudes.
- **Feed from the external spool holder, never the AMS lite.** Make sure the
  spool turns freely and the PTFE path has no tight bends. A spool that snags
  stretches the filament, which causes missing layers.
- **Use the right profile and cap the flow:**
  - Bambu TPU 95A HF: use Bambu's profile.
  - Other TPU: start from "Generic TPU" and keep max volumetric speed around
    3–4 mm³/s (outer walls 20–30 mm/s).
  - Under-extruded bands partway up are the classic sign of exceeding this.
- **Owner's filament: Elegoo TPU, 1.75 mm** ([spec sheet](https://us.elegoo.com/products/tpu-filament-1-75mm-colored-1kg)).
  Elegoo's figures: dry 70 ± 5 °C for 8 h (required), store at ≤ 20 % RH with
  desiccant, nozzle 220–240 °C, bed 30–45 °C with glue recommended, nozzle at
  least 0.4 mm, print speed under 60 mm/s. Use a copy of Generic TPU saved as
  "Elegoo TPU":
  - nozzle 230 °C, bed 35 °C (textured PEI plus glue stick);
  - max volumetric speed 3.5 mm³/s, which keeps 0.2 mm × 0.42 mm lines under
    about 42 mm/s. Elegoo's 60 mm/s ceiling works out to about 5 mm³/s.
- **Retraction:** short (0.4–1 mm) or off. Long retractions buckle TPU in the
  extruder.
- **Temperatures:** nozzle 220–240 °C per the filament's label. Textured PEI at
  about 35 °C (glue stick on smooth PEI). Part fan moderate.
- **Settings:** 3 walls, 4–5 top and bottom layers, 10–15 % gyroid, 0.2 mm
  layers, aligned seam. No ironing or fuzzy skin.
- **Nozzle:** the A1 ships with a 0.4 mm nozzle; swap kits are 0.2, 0.6 and
  0.8.
  - Check the size marked on the hotend, and that the printer preset in Bambu
    Studio says the same (e.g. "Bambu Lab A1 0.4 nozzle").
  - After a swap, update the nozzle size stored on the printer too. A mismatch
    over- or under-extrudes every layer.
- **Before a long print:** watch the first layers and the first tall features,
  and leave the printer's clog and tangle detection on.

## Casting checklist

- Release agent on every face and former that touches concrete.
- Fine mix (sand mix or GFRC/countertop) at pancake-batter consistency. Tap or
  vibrate to raise the air, then screed the open face flat.
- Cure 24–48 h, kept damp. Pull steel formers (TPU moulds) at 12–24 h. Unbolt and
  slide the parts off along their pulls.
