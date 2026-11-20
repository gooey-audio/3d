# gooey-studio (hosted)

The web version of gooey-studio: edit Replicad part scripts (JavaScript CAD on OpenCascade),
see every build in a three.js preview that matches the path tracer, tune parameters and the
look, ask the agent for changes, and make path-traced contact sheets and stills.

A Next.js 16 app (App Router, bun) deployed on Vercel (project `bhurlows-projects/3d`). All the
Rust (gooey-3d: builds, validation, rendering) runs on Modal behind an HTTP API; parts, uploads
and renders live in the private Vercel Blob store `gooey` under `3d-studio/`. Contracts (Modal
API, Blob layout): [CONTRACT.md](CONTRACT.md).

## Layout

- `src/proxy.ts`: the password gate (every page and API route but `/login` and `POST /api/login`).
- `src/app/api/`: parts (script, build, mesh, scene, STEP, revert, render), uploads, renders, and
  the agent chat (`api/chat`).
- `src/components/studio/`: the UI (editor, params and look panels, viewer, render mode).
- `src/lib/`: server libraries shared by the routes and the agent: `scene.ts` (scene documents,
  materials; also used in the browser for an instant preview), `store.ts` (Blob), `modal.ts`
  (Modal client with a local fallback), `parts.ts`, `renders.ts`.

## Environment

| Name | What |
|---|---|
| `STUDIO_PASSWORD` | password for the gate. Unset: everything answers 503 (fails closed). Changing it signs everyone out. |
| `BLOB_STORE_ID`, `VERCEL_OIDC_TOKEN` | Blob store auth (OIDC, set by Vercel) |
| `BLOB_WEBHOOK_PUBLIC_KEY` | set by Vercel with the store; the presigned-upload helper wants it |
| `MODAL_API_URL`, `STUDIO_MODAL_TOKEN` | the Modal API (`engine/modal/gooey_api.py`). Unset locally: the local fallback below |
| `DEEPSEEK_API_KEY` | the agent's `deepseek-direct` model; other models go through the AI Gateway (OIDC) |

## Local development

```sh
cd studio/hosted
bun install
vercel env pull                    # writes .env.local (Blob OIDC token; it expires after ~12 h)
export STUDIO_PASSWORD=goo
# Without MODAL_API_URL, builds and renders run the checkout's gooey-3d:
export GOOEY_CAD_WORKER=$PWD/../../engine/cad-worker/dist/gooey-cad-worker
bun run dev                        # http://localhost:3000
```

The local fallback runs `../../engine/target/release/gooey-3d` (override with `GOOEY_3D`), so
build it first (`cargo build --release -p gooey-3d` in `engine/`, and the cad worker). Local
renders run synchronously inside the request; on Modal they are queued and render mode
polls every 2 s. Storage is always the real Blob store, so use throwaway part names when testing
(for example `t-…`) and delete them afterwards.

Checks: `bunx tsc --noEmit`, `bun run lint`, `bun run build`.

## Notes

- Vercel limits function request bodies to 4.5 MB: STL uploads up to 4 MB go through
  `POST /api/uploads`; larger ones go straight from the browser to Blob with a presigned URL
  (`/api/uploads/presign`, limited to `3d-studio/uploads/incoming/`) and are then filed under
  `uploads/<sha256>.stl` by `/api/uploads/register`.
- Builds take 1–3 s round trip. The editor autosaves 800 ms after typing stops (or on Cmd-S);
  only the newest build's result is applied, and a build whose script or parameters changed
  while it ran does not replace the stored mesh. Scene patches show in the preview at once and
  are sent one at a time.
