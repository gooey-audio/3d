# Hosted studio: contracts

The hosted studio is a Next.js app on Vercel (`studio/hosted`, project `bhurlows-projects/3d`).
All Rust (gooey-3d: Replicad builds, validation, path tracing) runs on Modal
(`engine/modal/gooey_api.py`, app `gooey-3d-api`). Storage is the shared private Blob store
`gooey`, **only under the `3d-studio/` prefix**. Never list, write or delete outside it.

## Modal HTTP API

Base URL: `MODAL_API_URL` (no trailing slash). Every request carries
`Authorization: Bearer $STUDIO_MODAL_TOKEN`; anything else gets 401. JSON in and out.
Binary payloads are base64 strings (`*_b64`).

### `POST /build`: build and validate a part script

```json
{ "script": "<source of part.js>", "params": {"length": 140}, "filename": "brace.js", "step": false }
```

The endpoint writes the script to a temp dir and sends a `build` and a `params` request to one
of the container's warm `gooey-3d cad serve` processes (the same results as
`gooey-3d cad build --json` and `cad params --json`; `info` is null only if the script does
not load). Lengths: the mesh, STEP, `report.bounds`, `size_mm`, `volume_mm3` and `faces` are mm;
`report.units` / `info.units` is the script's unit (`export const units`, else the engine's
`GOOEY_UNITS`, else `in`) and `report.size` / `report.volume` are in it. `report.faces[]` carries unit normals and lowercase surface types (`plane`,
`cylinder`, `cone`, `sphere`, `torus`, `bezier`, `bspline`, `revolution`, `extrusion`,
`offset`, `other`).
Response, always HTTP 200 unless auth or the request is malformed:

```json
{ "ok": true,  "report": { ...report.json (gooey-cad/report-v1)... }, "stl_b64": "...",
  "step_b64": "..." | null, "info": {"defaultParams": {}, "paramRanges": {}, "units": "in"} | null, "seconds": 1.2 }
{ "ok": false, "error": {"kind": "kernel", "message": "...", "line": 64, "column": 36},
  "info": {...} | null, "seconds": 0.8 }
```

`error.kind` is a gooey-cad kind (`script syntax params kernel limits invalid expect timeout worker crash trap`).

### `POST /render`: start a path-traced render (GPU)

```json
{ "kind": "sheet" | "still",
  "inputs": [{"name": "brace", "stl_b64": "..."}],
  "views": ["iso", [0, 1, 0]], "orbit": "12@20" | null,
  "materials": ["wood/walnut", "#3d5a80", {"finish": "aluminium/brushed", "roughness": 0.2}],
  "tile": 400, "spp": 256, "background": "#f2f2f0" | "transparent",
  "environment": {"type": "studio", "intensity": 1, "rotation_deg": 0},
  "exposure": 1, "fov": 25, "label_from": "name" | "id",
  "width": 1600, "aspect": 1.5,
  "library": { ...gooey-materials/v1 JSON... } | null }
```

Sheets run `gooey-3d render sheet <inputs> ...`; stills run `gooey-3d render stl <input> --width W --aspect A ...`
with `views[0]` and `materials[0]`. Returns at once: `{"call_id": "fc-..."}`.

### `GET /render/{call_id}`

```json
{ "status": "pending" }
{ "status": "done", "png_b64": "...", "index": { ...sheet.json... } | null, "seconds": 3.1, "adapter": "Tesla T4" }
{ "status": "failed", "error": "..." }
```

## Account storage

In the private Blob store, each workspace starts at `3d-studio/accounts/<sha256-of-Neon-user-id>/`.
API requests derive that prefix from the verified session. Neon Postgres stores AI turn usage in
`studio.chat_turns` and accounts are managed by Neon Auth. Legacy shared files require an explicit
owner before migration.

### Blob paths relative to the workspace

```
parts/<part>/script.js       current script
parts/<part>/scene.json      gooey-studio-scene/v1 (same as the local studio's <part>.studio.json)
parts/<part>/build.json      last build summary (BuildSummary, report without faces)
parts/<part>/mesh.stl        last good mesh
parts/<part>/chat.json       UI messages of the agent conversation
parts/<part>/history/<ts>.json script and scene checkpoints (before agent turns)
uploads/<sha256>.stl, uploads/<sha256>.json
uploads/incoming/<id>.stl   temporary direct upload awaiting registration
renders/<id>.json            render job record; renders/<id>.png when done
seeded                       marker: the workspace was offered the example part (lib/example.ts)
```

## Environment (Vercel project)

| Name | What |
|---|---|
| `BLOB_STORE_ID`, `VERCEL_OIDC_TOKEN` | Blob store auth (OIDC; set by Vercel; `vercel env pull` locally) |
| `MODAL_API_URL`, `STUDIO_MODAL_TOKEN` | the Modal API above. Unset locally means a dev fallback that runs `engine/target/release/gooey-3d` (see `src/lib/modal.ts`) |
| `NEON_AUTH_BASE_URL`, `NEON_AUTH_COOKIE_SECRET`, `DATABASE_URL`, `STUDIO_INVITED_EMAILS` | Neon Auth, database, and beta access settings. See [README.md](README.md). |
| `DEEPSEEK_API_KEY` | the `deepseek-direct` model; other models go through the AI Gateway (OIDC) |
