# Remote rendering on Modal

Render a contact sheet's tiles on Modal GPUs (NVIDIA T4/L4, wgpu over Vulkan) and
compose the sheet locally. Use it when the local machine has no usable GPU
(`gooey-3d render info` shows a software adapter or none) or the sheet has many tiles.

- `modal/gooey_render.py` is the deployment: an image with the render-only
  `gooey-3d` build and one function, `render_shard`, which runs `gooey-3d render tiles`
  on one shard (the tiles of one STL) and returns the PNGs and their records.
- `scripts/remote-render` is the client: a single-file `uv run` script. It needs the
  local `gooey-3d` binary only for `render plan` and `render compose` (no GPU), and
  Python only through `uv`.

## Set up (once)

```sh
uv tool install modal          # or: pip install modal
modal token new                # browser login; writes ~/.modal.toml
modal deploy modal/gooey_render.py
```

On a machine without a browser, set `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` (from
Modal → Settings → API tokens) instead of `modal token new`. The client reads either.

The deploy builds the image: about 2 minutes the first time, about 70 s after a
Rust source change (cargo rebuilds; the layer only sees the workspace's Rust files,
so docs, fixtures and the scripts don't invalidate it). Re-deploy after changing the
renderer, or remote tiles will come from the old binary. The app scales to zero when
idle and costs nothing then.

## Render

```sh
# Plan + render + compose in one go; any `render plan` flag passes through.
scripts/remote-render sheet parts/*.stl --view iso --view top --label-from id \
    --out .context/remote/sheet.png

# An existing job file (`gooey-3d render plan ... --out job.json`, or written by a tool).
scripts/remote-render job job.json --out .context/remote/sheet.png
```

Outputs: `sheet.png` + `sheet.json` (the `gooey-3d-sheet/v1` index), the tiles
in `tiles/` beside it (`--tiles DIR` to change) as `<id>.png` + `<id>.json`, and in
`sheet` mode the `job.json` it planned. `--json` prints a summary (tiles rendered,
cached, missing; failed shards; containers; GPUs; wall time; estimated cost).

- **Binary:** `--gooey-3d PATH`, else `$GOOEY_3D`, else `gooey-3d` on `PATH`.
- **Shards:** one per STL, so each GPU process initialises once per part.
  `--shard-size N` splits big ones (e.g. a 100-view orbit of one STL at high spp).
  At most 10 containers run at once; further shards queue.
- **Finishes:** the finish library (`--library FILE`, else the project's) is shipped
  with every shard. Inputs other than STLs and the library (an `--env file.hdr`)
  are not shipped and fail remotely.
- **Cache:** a tile whose PNG and record are already in the tile directory, rendered
  from the same STL bytes, view, material, up axis, scene sets and library, is
  skipped. `--force` re-renders everything.
- **Failures:** a shard that fails (bad STL, timeout, a non-NVIDIA adapter) is listed
  on stderr and in `--json`; its tiles are labelled blanks on the sheet (compose
  `--allow-missing`) and the exit status is 1 unless `--allow-failed`. Rerun the
  same command to retry only the missing tiles. An STL that changed since the plan
  fails before anything is sent: re-plan. Exit 2 is any other error (not deployed,
  no token, bad arguments).

## Cost and speed

Modal bills per second: T4 $0.59/h, L4 $0.80/h (plus small CPU and memory charges;
`modal billing rates`). Measured (A0 spike, render-only build with the cached
pipeline):

| | T4 | L4 |
|---|---|---|
| per tile, 400 px / 128 spp | ~0.21 s | ≤ 0.55 s (before the pipeline cache) |
| per tile, 1200 px / 256 spp | ~2.2 s | ~1.0 s |
| GPU init per shard | 0.3–0.6 s | 0.3 s |
| container cold start | ~10 s | ~10 s, but capacity waits happen |

So 100 tiles at 400/128 are about $0.0035 of T4 time. The fixed costs dominate:
each container bills its cold start, about 0.6 s of process start and GPU init per
shard, and its idle `scaledown_window` (20 s here).

Measured end to end (2026-11-17, from a Mac with nothing warm): 100 STLs × 6 views
at 400 px / 128 spp, 600 tiles in 100 shards, took **37 s** wall on **10 T4
containers** (about 2.1 s per 6-tile shard), for an estimated **$0.07** of GPU time.
A rerun with every tile cached took 2 s and called nothing.

The client prints an estimate from the containers' own timings (summed over the test
runs it matched the bill within about 2%). `modal billing report --for today -r h
--show-resources` has the real numbers, including CPU and memory (about 5% more).

## Gotchas

- **Legacy image builder:** on a workspace still on the legacy builder,
  `modal.Image.debian_slim()` is bullseye, whose security mirror 404s. The image pins
  `debian:bookworm-slim` via `from_registry` instead.
- **No software fallback:** the image installs with `--no-install-recommends` and fails
  to build if `mesa-vulkan-drivers` (lavapipe) is present; `render_shard` raises if a
  record's adapter isn't NVIDIA. Modal mounts the NVIDIA Vulkan ICD itself.
- **Not goldens:** remote PNGs match Metal visually (PSNR 72–93 dB, max 1–10/255) but
  are not byte-identical, and T4 and L4 can differ by 1/255. Never use them as
  `render sync` / committed renders; those stay local.
- **Slow container starts:** new containers sometimes took 100–200 s to appear: twice
  with L4 first (probably waiting for L4 capacity before falling back to T4) and once
  for a retry with T4 first. Two cold fan-outs with T4 first started in about 3 s, so
  the function asks for T4, then L4. L4 is about twice as fast only for big tiles.
- **Autoscaling** follows the queue: one warm container can soak up most of a batch
  before more start, so wall times vary (two cold runs of the batch above: 37 s on 10
  containers, 70 s on 4).
- **Retries:** a shard whose `render tiles` fails (a corrupt STL, an unknown finish)
  returns its error and is not retried, since a retry would fail the same way after
  waiting for a container. Crashes, timeouts and non-NVIDIA adapters raise, and
  Modal retries them once (`retries=1`).
- Stop a stuck run with Ctrl-C; `modal app logs gooey-render` shows the container side.

## Studio API (gooey_api.py)

`modal/gooey_api.py` is the hosted studio's backend (app `gooey-3d-api`): a FastAPI app
on one web endpoint implementing the "Modal HTTP API" in `studio/hosted/CONTRACT.md`.

- `POST /build` runs `gooey-3d cad build --json` (then `cad params`) inline in the web
  container (CPU, 4 cores, 6 GiB, up to 4 requests at once, kept warm 300 s after the
  last request) and returns the report, the STL (and STEP with `step: true`) as base64.
- `POST /render` spawns `render_job` on a GPU (T4, then L4; at most 4 containers, 900 s
  timeout, warm 60 s) running `gooey-3d render sheet` or `render stl`, and returns a
  `call_id` at once; `GET /render/{call_id}` polls it (results are kept by Modal for a
  limited time, so callers store the PNG as soon as it is done).
- The image is the full `gooey-3d` build (cad + render + mould: cmake, g++, git for
  Manifold) with a linux-x64 `gooey-cad-worker` (bun 1.3.13) next to the binary. The
  worker is built in its own layer, so Rust edits and worker edits rebuild only their part.

```sh
modal secret create gooey-3d-api STUDIO_MODAL_TOKEN="$(cat /tmp/studio-modal-token)" --force
modal deploy modal/gooey_api.py      # prints the web URL (MODAL_API_URL)
```

Every route needs `Authorization: Bearer $STUDIO_MODAL_TOKEN`, else 401. The same token
goes in the Vercel project's `STUDIO_MODAL_TOKEN`.

Measured (2026-11-19, from a Mac, brace.js): a build is 10 s cold (container start) and
2.1 to 3.2 s warm (about 2 s of it the build itself; CPU hosts vary), a syntax or params
error about 0.4 s. A 2-STL x 2-view x 2-material sheet at 256 px / 64 spp took 9.5 to 14 s
wall cold on a T4 (1.6 to 4.7 s inside the function), a 1200 px / 128 spp still 7 s.

Cost: the web container bills CPU and memory while warm (4 cores + 6 GiB, roughly
$0.25/h), so each editing session pays up to 5 min of idle after its last build; nothing
when idle. Renders bill GPU seconds like `gooey-render` plus up to 60 s of warm idle per
burst. `modal app logs gooey-3d-api` shows both sides.
