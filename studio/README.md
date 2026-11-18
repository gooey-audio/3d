# gooey-studio

A local web app on the gooey-3d engine for parametric parts written as
[Replicad](https://replicad.xyz) scripts:

- **Edit** the script in the browser, in your own editor, or by asking the embedded
  agent ([DeepSeek](https://api-docs.deepseek.com), tool calling). Every change rebuilds
  the part on one warm cad-worker (about 0.3 s for a small part) and reloads it in the
  preview.
- **Preview** in three.js, lit like `gooey-3d render`: the same studio rig (key, fill
  and rim softboxes that follow the camera), Khronos PBR Neutral tonemapping, finishes
  from a `gooey-materials/v1` library, and a shadow-catcher ground. Wood figure and
  procedural textures show only in path-traced renders.
- **Change the look**: material, environment, background, exposure and camera live in
  `<part>.studio.json`. You or the agent change them, and they map one-to-one onto
  `gooey-3d render` flags.
- **Render**: the Renders page turns uploaded STLs, or parts, into path-traced contact
  sheets, from any views, orbits and finishes. Click a tile for a 1600 px still. The
  editor's "Render" button makes a sheet of the current part in its look.

```sh
# once: the CAD worker and the web UI
(cd ../engine && cad-worker/build.sh)
(cd web && bun install && bun run build)

export DEEPSEEK_API_KEY=...            # optional; without it the agent is off
cargo run --release -p gooey-studio -- ../engine/fixtures/cad \
    --library ../engine/fixtures/render/materials.json --open
```

`gooey-studio [DIR] [--port 7878] [--library FILE] [--worker CMD] [--open]` serves the
`*.js` part scripts in DIR (default: the current directory) on http://localhost:7878.
The finish library defaults to the nearest `gooey-3d.json`'s, as in `gooey-3d render`.
The CAD worker is `--worker`, else `$GOOEY_CAD_WORKER`, else `gooey-cad-worker` next to
the binary, else this checkout's `engine/cad-worker/dist/gooey-cad-worker`.

The agent reads `DEEPSEEK_API_KEY`, plus `DEEPSEEK_MODEL` (default `deepseek-chat`),
`DEEPSEEK_BASE_URL` (default `https://api.deepseek.com`; any OpenAI-compatible
endpoint with tool calls works) and `DEEPSEEK_MAX_STEPS` (model calls per turn, default 32).

## Files

| Path | What |
|---|---|
| `<part>.js` | The part script: the source of truth. The engine's conventions apply (`main`, `defaultParams`, `paramRanges`, `expect`; see `engine/skill/cad/SKILL.md`). |
| `<part>.studio.json` | `gooey-studio-scene/v1`: parameter overrides and the look. Worth committing. |
| `.studio/` | Scratch space (it ignores itself in git): `build/` holds the latest good mesh per part, `chat/` the conversations, `history/` the script and scene from before each agent turn (for "revert"), and `export/` STEP exports. |

```json
{ "schema": "gooey-studio-scene/v1",
  "params": { "length": 140 },
  "material": { "finish": "aluminium/brushed", "roughness": 0.3 },
  "environment": { "type": "studio", "intensity": 1.0, "rotation_deg": 0 },
  "background": "#f2f2f0", "exposure": 1.0,
  "camera": { "view": "iso", "fov": 25 } }
```

- `material` is a `--material` spec: a finish name, `#rrggbb`, or an object (`finish`,
  `color`, `grain` and look overrides).
- `environment` is `studio`, `hdri` (with `path` relative to DIR) or `room`. `room`
  shows only in renders; the preview falls back to the studio.
- `camera.view` is a view name or an `[x, y, z]` direction (Y up).

## The agent

Each message starts a turn. Before it changes anything, the script and scene are
checkpointed. The model gets the cad skill and the current script, scene and last build
as context, plus these tools:

| Tool | What it does |
|---|---|
| `read_script` | Returns the script. |
| `edit_script` | Exact search and replace, then a build. |
| `write_script` | Replaces the whole script, then a build. |
| `set_params` | Changes parameter overrides, then a build. |
| `get_report` | Returns the last build's validation report. |
| `get_scene` / `update_scene` | Reads the scene, or applies a JSON merge patch to it. |
| `list_finishes` | Lists the finishes in the library. |
| `render_sheet` | Queues a final render of the part (views, orbit, spp). |

Script tools wait for their build and return the result: the size, genus and
printability, or the error kind, message and line with the surrounding source. The model
can then fix its own mistakes. The editor is read-only during a turn. "Revert" restores
the checkpoint.

## Renders

Renders run through the engine's CLI, so they match `gooey-3d render` byte for byte.
`gooey-3d` is found as `$GOOEY_3D`, else next to `gooey-studio`, else in this checkout's
`engine/target/{release,debug}`, else on PATH. One job runs at a time.

- **Uploads.** `POST /api/uploads` takes multipart `file` fields of up to 512 MB. Each
  STL is parsed, then stored by SHA-256 in `.studio/uploads/`.
- **Jobs.** `POST /api/renders` takes either of these:

  ```json
  { "kind": "sheet", "inputs": [{"upload": "<sha256>"}, {"part": "brace"}],
    "views": ["iso", "top", [1, 0.5, 0]], "orbit": "12@20",
    "materials": ["wood/walnut", "#3d5a80", {"finish": "aluminium/brushed", "roughness": 0.2}],
    "tile": 400, "spp": 256, "background": "#f2f2f0",
    "environment": {"type": "studio", "intensity": 1}, "exposure": 1, "fov": 25,
    "label_from": "name", "remote": false }
  { "kind": "still", "input": {"upload": "<sha256>"}, "view": "iso", "material": "wood/oak",
    "width": 1600, "aspect": 1.5, "spp": 1024 }
  ```

  A sheet has at most 400 tiles (inputs × views × materials).
- **Job directory.** Each job lives in `.studio/renders/<id>/`. Inputs are copied there
  when the job is queued, so later edits don't change it. Progress streams as SSE
  `render` events, and the job's `sheet.json` index maps tiles to their rectangles.
- **Modal.** `"remote": true` renders the tiles on Modal through
  `engine/scripts/remote-render`, which needs `uv` and a Modal token (see
  `engine/modal/README.md`).

```sh
curl -F file=@a.stl -F file=@b.stl localhost:7878/api/uploads
curl -H 'content-type: application/json' localhost:7878/api/renders \
     -d '{"kind":"sheet","inputs":[{"upload":"<sha256>"}],"orbit":"8","materials":["wood/oak"]}'
```

## Security

Part scripts are programs, and the CAD worker runs them with your user's rights. The
server only listens on 127.0.0.1. It answers only requests whose `Host` is a loopback
name, which blocks DNS rebinding. It rejects any `Origin` other than itself or the Vite
dev server, which blocks cross-site requests from other pages.

## Develop

```sh
cargo test                                   # unit + API + mock-agent tests; the build test needs the worker
(cd web && bun run dev)                      # Vite on :5173, proxying /api to a gooey-studio on :7878
(cd web && bun run typecheck && bun run build)
```

The server is `server/` (axum). `builder.rs` owns the warm worker and coalesces
rebuilds, `watch.rs` follows file changes, `scene.rs` holds the scene document,
`agent.rs` runs the DeepSeek loop and `api.rs` serves the HTTP API and the SSE stream.
The UI is `web/` (React, three.js, CodeMirror). It is embedded in release builds
and read from `web/dist` in debug builds. `studio/` is its own Cargo workspace and
depends on the engine's crates by path.
