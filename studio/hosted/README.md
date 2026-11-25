# gooey-studio (hosted)

The web version of gooey-studio: edit Replicad part scripts (JavaScript CAD on OpenCascade),
see every build in a three.js preview that matches the path tracer, tune parameters and the
look, ask the agent for changes, and make path-traced contact sheets and stills.

A Next.js 16 app (App Router, bun) deployed on Vercel (project `bhurlows-projects/3d`). All the
Rust (gooey-3d: builds, validation, rendering) runs on Modal behind an HTTP API; parts, uploads
and renders live in a private Vercel Blob workspace per account. Neon Auth manages accounts, and
Neon Postgres tracks the daily AI allowance and the monthly AI spend. See [CONTRACT.md](CONTRACT.md) for the Modal API and Blob layout.

## Layout

- `src/app/login/` and `src/app/api/auth/`: Neon Auth Google sign-in and email codes for invited accounts. All Studio API routes verify the session before accessing account data.
- `src/app/api/`: parts (script, build, mesh, scene, STEP, revert, render), uploads, renders, and
  the agent chat (`api/chat`).
- `src/components/studio/`: the UI (editor, params and look panels, viewer, render mode).
- `src/lib/`: server libraries shared by the routes and the agent: `scene.ts` (scene documents,
  materials; also used in the browser for an instant preview), `store.ts` (Blob), `modal.ts`
  (Modal client with a local fallback), `parts.ts`, `renders.ts`.

## Environment

| Name | What |
|---|---|
| `NEON_AUTH_BASE_URL` | Auth URL for the Neon branch |
| `NEON_AUTH_COOKIE_SECRET` | At least 32 characters. Generate with `openssl rand -base64 32`. |
| `DATABASE_URL` | Server-only Neon Postgres connection string for AI usage |
| `STUDIO_INVITED_EMAILS` | Comma-separated email addresses of trusted beta users. Omit to deny all beta access. |
| `STUDIO_ADMIN_EMAILS` | Comma-separated admin email addresses (e.g. the owner, `brian@brianhurlow.com`). Admins are invited implicitly and have no personal AI allowance. |
| `STUDIO_AI_DAILY_TURNS` | Free AI turns per account per UTC day (default 5) |
| `STUDIO_AI_GLOBAL_DAILY_TURNS` | Total AI turns across all accounts per UTC day (default 40) |
| `STUDIO_AI_MONTHLY_BUDGET_USD` | Global AI spend per UTC calendar month, in USD, across all accounts and models (default 100; `0` pauses AI chat) |
| `STUDIO_AI_TURN_RESERVE_USD` | Spend each admitted turn reserves against the monthly budget until its cost is known (default 0.50) |
| `STUDIO_AI_INTEREST_EMAIL` | Destination for the email link shown when the daily allowance runs out |
| `BLOB_STORE_ID`, `VERCEL_OIDC_TOKEN` | Blob store auth (OIDC, set by Vercel) |
| `BLOB_WEBHOOK_PUBLIC_KEY` | set by Vercel with the store; the presigned-upload helper wants it |
| `MODAL_API_URL`, `STUDIO_MODAL_TOKEN` | the Modal API (`engine/modal/gooey_api.py`). Unset locally: the local fallback below |
| `DEEPSEEK_API_KEY` | the agent's `deepseek-direct` model; other models go through the AI Gateway (OIDC) |
| `NEXT_PUBLIC_STUDIO_UNITS` | optional: the default of the units setting (`in`, `cm` or `mm`; default `in`) |

## Prepare a beta deployment

1. Enable Better Auth and email sign-in on the Neon branch. Set up production SMTP for one-time sign-in codes and add the deployment origin to Neon’s trusted domains. Add the local origin when testing locally.
2. Apply [db/001_chat_usage.sql](db/001_chat_usage.sql) and [db/002_ai_spend.sql](db/002_ai_spend.sql) to the database used by `DATABASE_URL`. Keep the connection string and cookie secret server-side.
3. Set the environment variables for the deployment. Invite only people you trust to run code in the CAD environment. The current CAD worker executes Replicad scripts as JavaScript in a shared process. Isolate untrusted script execution from other jobs, credentials, the filesystem, and network access before enabling public signup.
4. Cap AI Gateway spend for the project: `vercel ai-gateway budgets set project 3d --amount 100 --refresh-period monthly`. The gateway budget does not cover `deepseek-direct`, which calls DeepSeek with `DEEPSEEK_API_KEY`; the studio's own monthly budget (`STUDIO_AI_MONTHLY_BUDGET_USD`) covers every model. Set a spending limit in the DeepSeek console as well.
5. Sign in from two invited email addresses. Create a part with the same name in both accounts and check that scripts, uploads, chat, and renders are private to each account. Try an uninvited address and verify that it cannot enter the Studio. Set a low allowance in staging and verify that concurrent AI requests cannot exceed it.

An AI turn starts when the server admits a message or retry. It counts even if stopped or if a provider call fails. Allowances reset at midnight UTC. Set either limit to zero to pause AI chat. Admins (`STUDIO_ADMIN_EMAILS`) skip the per-account limit, but their turns are recorded and count toward the global one, so a zero global limit pauses them too. A limit on turns bounds model requests and each turn has a step and output cap. Provider spend also depends on the model and input size. Set a provider spending cap where available.

The monthly AI budget is a failsafe on top of the turn limits. It applies to every account, admins included. A turn is admitted only while this UTC month's spend plus `STUDIO_AI_TURN_RESERVE_USD` fits in `STUDIO_AI_MONTHLY_BUDGET_USD`. The turn holds that reservation (in `studio.ai_spend`, under the same lock as the turn limits) until it ends, then records its cost: the AI Gateway's billed cost for each model call, looked up by generation ID, or otherwise an estimate from token usage and the per-model prices in `src/lib/models.ts`. These prices err high. A call stopped mid-stream is estimated at its output cap. A turn that never records its cost keeps its reservation counted. When the budget is used up, chat answers 429 until the next month. `aiSpend()` in `src/lib/ai-spend.ts` reports the month's spend.

Existing files under the old shared `3d-studio/parts/`, `uploads/`, and `renders/` prefixes need an explicit owner before migration. To assign them, copy the owned files to the corresponding paths under `3d-studio/accounts/<sha256-of-Neon-user-id>/`. Omit old turn locks and staging uploads. Leave the shared prefix inaccessible to the hosted app.

### Google sign-in

Neon's shared Google credentials can be used for local testing. To use your own Google app for the beta deployment:

1. Create a **Web application** OAuth client in Google Cloud and add `<NEON_AUTH_BASE_URL>/callback/google` as its authorized redirect URI.
2. In the Neon branch's Auth settings, set the Google provider to use that OAuth client ID and secret. Add the Studio deployment origin to Neon's trusted domains.
3. Add each tester's Google account email to `STUDIO_INVITED_EMAILS`. If Google's OAuth consent screen is in testing mode, add those accounts to its test users too.

Neon verifies Google's callback and returns the browser to the Studio at `/api/auth/google/callback`. The Studio checks the resulting session's verified email against the beta invite list before granting access. See [Neon's OAuth setup guide](https://neon.com/docs/auth/guides/setup-oauth).

## Units

Inches by default. The header's units menu (kept per browser) sets the units of every dimension
the UI shows (size, volume, grid, dims, picked points, chat chips), the units of new parts, and
the units the agent answers in. Each script declares its own (`export const units = "in"`), so
switching the setting never rescales an existing part; the engine builds a script without one
in its default (`GOOEY_UNITS` on Modal, else inches). Meshes, STEP files, reports and face tables
are always mm (`lib/units.ts` converts); the agent reads sizes, faces and selections in the
script's units.

## Local development

```sh
cd studio/hosted
bun install
vercel env pull                    # writes .env.local (Blob OIDC token; it expires after ~12 h)
# Set the Neon and beta environment variables above in .env.local
# Without MODAL_API_URL, builds and renders run the checkout's gooey-3d:
export GOOEY_CAD_WORKER=$PWD/../../engine/cad-worker/dist/gooey-cad-worker
bun run dev                        # http://localhost:3000
```

The local fallback runs `../../engine/target/release/gooey-3d` (override with `GOOEY_3D`), so
build it first (`cargo build --release -p gooey-3d` in `engine/`, and the cad worker). Local
renders run synchronously inside the request; on Modal they are queued and render mode
polls every 2 s. Storage is always the real Blob store, so use a dedicated test account or disposable part names.

Checks: `bunx tsc --noEmit`, `bun run lint`, `bun run build`.

## Notes

- Vercel limits function request bodies to 4.5 MB: STL uploads up to 4 MB go through
  `POST /api/uploads`; larger ones go straight from the browser to Blob with a presigned URL
  (`/api/uploads/presign`, limited to the signed-in account’s `uploads/incoming/` folder) and are then filed under
  `uploads/<sha256>.stl` by `/api/uploads/register`.
- Builds take 1–3 s round trip. The editor autosaves 800 ms after typing stops (or on Cmd-S);
  only the newest build's result is applied, and a build whose script or parameters changed
  while it ran does not replace the stored mesh. Scene patches show in the preview at once and
  are sent one at a time.
