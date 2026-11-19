"""Modal deployment: the hosted studio's HTTP API (app `gooey-3d-api`).

    modal deploy modal/gooey_api.py

Serves the "Modal HTTP API" of studio/hosted/CONTRACT.md:

    POST /build             build + validate a Replicad part script (inline, CPU)
    POST /render            start a path-traced sheet or still on an NVIDIA GPU -> {call_id}
    GET  /render/{call_id}  poll it: pending | done | failed

Every route needs `Authorization: Bearer $STUDIO_MODAL_TOKEN` (Modal secret `gooey-3d-api`).
All the CAD and rendering logic is in the `gooey-3d` binary (full build: cad + render +
mould) and its `gooey-cad-worker`; this file builds the image and moves bytes. See
modal/README.md ("Studio API").
"""

import base64
import binascii
import hmac
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import time

import modal

# The module is imported again inside the container (as /root/gooey_api.py), where the repo
# isn't; resolve local paths only on the deploying machine.
REPO = pathlib.Path(__file__).resolve().parents[1] if modal.is_local() else pathlib.Path("/src")

BIN = "/src/target/release/gooey-3d"
APP = "gooey-3d-api"
SECRET = "gooey-3d-api"
BUN_VERSION = "1.3.13"

BUILD_TIMEOUT_S = 45     # gooey-3d's own wall-clock limit (kills the worker -> kind "timeout")
PARAMS_TIMEOUT_S = 20
WEB_SCALEDOWN_S = 300    # keep the editor's container warm between edits
GPU_SCALEDOWN_S = 60     # a follow-up render within a minute skips the GPU cold start

APT = [
    # Vulkan loader; Modal mounts the NVIDIA ICD and driver libraries at run time.
    "libvulkan1", "libegl1", "libxext6",
    "curl", "ca-certificates", "build-essential", "pkg-config",
    # Manifold (castkit-core, linked statically): manifold-csg-sys clones it and builds
    # with cmake + a C++ compiler (g++ from build-essential).
    "cmake", "git",
    # The bun installer.
    "unzip",
]

image = (
    # Pin bookworm: with the legacy image builder, debian_slim() is bullseye, whose security
    # mirror 404s.
    modal.Image.from_registry("debian:bookworm-slim", add_python="3.12")
    # --no-install-recommends keeps mesa-vulkan-drivers (lavapipe) out; the dpkg check makes
    # sure nothing else brought it in, so wgpu cannot fall back to a software adapter.
    .run_commands(
        "apt-get update && apt-get install -y --no-install-recommends " + " ".join(APT)
        + " && rm -rf /var/lib/apt/lists/*",
        "! dpkg -l | grep -i mesa-vulkan",
    )
    .env({
        "NVIDIA_DRIVER_CAPABILITIES": "all",
        "NVIDIA_VISIBLE_DEVICES": "all",
        "PATH": "/root/.bun/bin:/root/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin"
                ":/usr/bin:/sbin:/bin",
    })
    .run_commands(
        "curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable",
        f"curl -fsSL https://bun.sh/install | bash -s bun-v{BUN_VERSION} && bun --version",
    )
    .pip_install("fastapi[standard]")
    # The CAD worker first, in its own layer: Rust edits don't rebuild it, and worker edits
    # don't rebuild Rust. build.sh runs `bun install --frozen-lockfile` (node_modules is not
    # uploaded) and compiles a host (linux-x64) executable.
    .add_local_dir(
        str(REPO / "cad-worker"),
        "/cad-worker",
        copy=True,
        ignore=["node_modules", "dist", "**/*.md", "**/.DS_Store"],
    )
    .run_commands("cd /cad-worker && ./build.sh")
    # Only what cargo reads, so edits to docs, fixtures or this file don't rebuild.
    .add_local_dir(
        str(REPO),
        "/src",
        copy=True,
        ignore=[
            "target", "**/target", ".git", ".github", ".context", "**/node_modules",
            "cad-worker", "fixtures", "modal", "scripts", "skill", "docs", "**/*.md",
            "**/.DS_Store",
        ],
    )
    .run_commands(
        "cd /src && cargo build --release -p gooey-3d && target/release/gooey-3d --version"
        " && cp /cad-worker/dist/gooey-cad-worker target/release/gooey-cad-worker"
        " && rm -rf target/release/build target/release/deps target/release/incremental",
    )
)

app = modal.App(APP, image=image)


# --- helpers -----------------------------------------------------------------------------

def is_nvidia(adapter: str) -> bool:
    return any(k in adapter.upper() for k in ("NVIDIA", "TESLA"))


def safe_stem(name: str, fallback: str) -> str:
    base = "".join(c if c.isalnum() or c in "_.-" else "-" for c in pathlib.PurePath(name).name)
    base = base.lstrip(".")
    return base or fallback


def arg(v) -> str:
    """A CLI value: strings as-is, everything else JSON-encoded."""
    return v if isinstance(v, str) else json.dumps(v)


def tail(s: str, n: int = 2000) -> str:
    s = (s or "").strip()
    return s[-n:]


def parse_json(s: str):
    try:
        return json.loads(s)
    except (json.JSONDecodeError, TypeError):
        return None


# --- build (inline, CPU) -----------------------------------------------------------------

def run_build(script: str, params: dict, filename: str, step: bool) -> dict:
    t0 = time.time()
    work = pathlib.Path(tempfile.mkdtemp(prefix="build-", dir="/tmp"))
    try:
        name = safe_stem(filename, "part.js")
        if not name.endswith(".js"):
            name += ".js"
        src = work / name
        src.write_text(script)
        out = work / "out"
        sets = [x for k, v in params.items() for x in ("--set", f"{k}={arg(v)}")]
        # Relative paths (cwd = work) keep the temp dir out of error messages. `cad params`
        # runs alongside the build (its own worker process): it only reads the script.
        q = subprocess.Popen([BIN, "cad", "params", name, "--json"], cwd=work, text=True,
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        cmd = [BIN, "cad", "build", name, "--out", "out", "--json",
               "--timeout", str(BUILD_TIMEOUT_S), *sets]
        try:
            p = subprocess.run(cmd, cwd=work, capture_output=True, text=True,
                               timeout=BUILD_TIMEOUT_S + 15)
            res = parse_json(p.stdout)
            if not isinstance(res, dict) or "ok" not in res:
                res = {"ok": False, "error": {
                    "kind": "crash", "line": None, "column": None,
                    "message": f"gooey-3d cad build exited {p.returncode}: {tail(p.stderr)}"}}
        except subprocess.TimeoutExpired:
            res = {"ok": False, "error": {
                "kind": "timeout", "line": None, "column": None,
                "message": f"build exceeded {BUILD_TIMEOUT_S + 15} s"}}

        info = None
        try:
            qout, _ = q.communicate(timeout=PARAMS_TIMEOUT_S)
            j = parse_json(qout) if q.returncode == 0 else None
            if isinstance(j, dict) and "defaultParams" in j:
                info = {"defaultParams": j.get("defaultParams") or {},
                        "paramRanges": j.get("paramRanges") or {}}
        except subprocess.TimeoutExpired:
            q.kill()
            q.communicate()

        if not res.get("ok"):
            return {"ok": False, "error": res.get("error"), "info": info,
                    "seconds": round(time.time() - t0, 3)}

        outputs = res.get("outputs") or {}
        stl = work / (outputs.get("stl") or out / (src.stem + ".stl"))
        step_path = work / (outputs.get("step") or out / (src.stem + ".step"))
        report_path = work / (outputs.get("report") or out / "report.json")
        report = parse_json(report_path.read_text()) if report_path.exists() else None
        return {
            "ok": True,
            "report": report if isinstance(report, dict) else res.get("report"),
            "stl_b64": base64.b64encode(stl.read_bytes()).decode(),
            "step_b64": (base64.b64encode(step_path.read_bytes()).decode()
                         if step and step_path.exists() else None),
            "info": info,
            "seconds": round(time.time() - t0, 3),
        }
    finally:
        shutil.rmtree(work, ignore_errors=True)


# --- render (GPU) ------------------------------------------------------------------------

def render_args(req: dict) -> tuple[list[str], list[str]]:
    """(scene options, kind-specific options) for a render request."""
    a: list[str] = []

    def flag(k, v):
        if v is not None:
            a.extend([k, arg(v)])

    def view(v):
        return ",".join(str(x) for x in v) if isinstance(v, (list, tuple)) else str(v)

    flag("--spp", req.get("spp"))
    flag("--background", req.get("background"))
    flag("--env", req.get("environment"))
    flag("--exposure", req.get("exposure"))
    flag("--fov", req.get("fov"))
    k: list[str] = []
    views = req.get("views") or []
    materials = req.get("materials") or []
    if req["kind"] == "sheet":
        for v in views:
            k += ["--view", view(v)]
        if req.get("orbit") is not None:
            k += ["--orbit", str(req["orbit"])]
        for m in materials:
            k += ["--material", arg(m)]
        if req.get("tile") is not None:
            k += ["--tile", str(req["tile"])]
        if req.get("label_from") is not None:
            k += ["--label-from", str(req["label_from"])]
    else:
        if views:
            k += ["--view", view(views[0])]
        if materials:
            k += ["--material", arg(materials[0])]
        k += ["--width", str(req.get("width") or 1600), "--aspect", str(req.get("aspect") or 1.5)]
    return a, k


# T4 first: with L4 first, new containers took 110-200 s to appear in the gooey-render
# spike (capacity waits), while T4-first cold starts took ~3 s. See modal/README.md.
@app.function(gpu=["T4", "L4"], timeout=900, scaledown_window=GPU_SCALEDOWN_S, retries=1,
              max_containers=4)
def render_job(req: dict) -> dict:
    """Render a contract `POST /render` request. Returns `{png_b64, index, seconds, adapter}`,
    or `{error}` when gooey-3d fails (bad STL, unknown finish: a retry would fail the same way).
    Raises (Modal retries once) on a non-NVIDIA adapter."""
    t0 = time.time()
    work = pathlib.Path(tempfile.mkdtemp(prefix="render-", dir="/tmp"))
    try:
        files, used = [], set()
        for i, inp in enumerate(req["inputs"]):
            stem = safe_stem(str(inp.get("name") or ""), f"in{i}")
            if stem.lower().endswith(".stl"):
                stem = stem[:-4] or f"in{i}"
            f, n = f"{stem}.stl", 2
            while f in used:  # labels come from the file stem, so keep names unique
                f, n = f"{stem}-{n}.stl", n + 1
            used.add(f)
            (work / f).write_bytes(base64.b64decode(inp["stl_b64"]))
            files.append(f)
        scene, kind_args = render_args(req)
        if req.get("library") is not None:
            (work / "library.json").write_text(json.dumps(req["library"]))
            scene += ["--library", "library.json"]
        if req["kind"] == "sheet":
            out = "sheet.png"
            cmd = [BIN, "render", "sheet", *files, *scene, *kind_args]
        else:
            out = "still.png"
            cmd = [BIN, "render", "stl", files[0], *scene, *kind_args]
        cmd += ["--out", out, "--json", "--quiet"]
        p = subprocess.run(cmd, cwd=work, capture_output=True, text=True)
        if p.returncode != 0:
            return {"error": f"gooey-3d {' '.join(cmd[1:3])} exited {p.returncode}: {tail(p.stderr)}"}
        res = parse_json(p.stdout) or {}
        adapters = sorted({o.get("adapter", "") for o in res.get("outputs", [])})
        bad = [x for x in adapters if not is_nvidia(x)]
        if bad or not adapters:
            raise RuntimeError(f"rendered on a non-NVIDIA adapter {bad}; refusing the result")
        index = None
        if req["kind"] == "sheet" and (work / "sheet.json").exists():
            index = json.loads((work / "sheet.json").read_text())
        return {
            "png_b64": base64.b64encode((work / out).read_bytes()).decode(),
            "index": index,
            "seconds": round(time.time() - t0, 3),
            "adapter": ", ".join(adapters),
        }
    finally:
        shutil.rmtree(work, ignore_errors=True)


def validate_render(req) -> str | None:
    """A reason the request is malformed, or None."""
    if not isinstance(req, dict):
        return "body must be a JSON object"
    if req.get("kind") not in ("sheet", "still"):
        return "kind must be 'sheet' or 'still'"
    inputs = req.get("inputs")
    if not isinstance(inputs, list) or not inputs:
        return "inputs must be a non-empty list"
    for i, inp in enumerate(inputs):
        if not isinstance(inp, dict) or not isinstance(inp.get("stl_b64"), str):
            return f"inputs[{i}] needs a stl_b64 string"
        try:
            base64.b64decode(inp["stl_b64"], validate=True)
        except (binascii.Error, ValueError):
            return f"inputs[{i}].stl_b64 is not base64"
    for key in ("views", "materials"):
        if req.get(key) is not None and not isinstance(req[key], list):
            return f"{key} must be a list"
    for v in req.get("views") or []:
        if not (isinstance(v, str) or (isinstance(v, list) and len(v) == 3
                                       and all(isinstance(x, (int, float)) for x in v))):
            return "each view is a name or [x, y, z]"
    for key in ("tile", "spp", "width"):
        v = req.get(key)
        if v is not None and (not isinstance(v, int) or isinstance(v, bool) or v <= 0):
            return f"{key} must be a positive integer"
    for key in ("exposure", "fov", "aspect"):
        v = req.get(key)
        if v is not None and (not isinstance(v, (int, float)) or isinstance(v, bool)):
            return f"{key} must be a number"
    if req.get("label_from") not in (None, "name", "id"):
        return "label_from must be 'name' or 'id'"
    if req.get("library") is not None and not isinstance(req["library"], dict):
        return "library must be an object"
    return None


# --- web ---------------------------------------------------------------------------------

@app.function(cpu=4, memory=6144, scaledown_window=WEB_SCALEDOWN_S, timeout=300,
              secrets=[modal.Secret.from_name(SECRET)])
@modal.concurrent(max_inputs=4)
@modal.asgi_app()
def web():
    from fastapi import FastAPI, Request
    from fastapi.concurrency import run_in_threadpool
    from fastapi.responses import JSONResponse

    token = os.environ.get("STUDIO_MODAL_TOKEN", "").strip().encode()
    api = FastAPI(title=APP, docs_url=None, redoc_url=None, openapi_url=None)

    @api.middleware("http")
    async def auth(request: Request, call_next):
        h = request.headers.get("authorization", "")
        given = h[7:].strip().encode() if h[:7].lower() == "bearer " else b""
        if not token or not hmac.compare_digest(given, token):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        return await call_next(request)

    async def body(request: Request):
        try:
            return await request.json()
        except Exception:
            return None

    @api.post("/build")
    async def build(request: Request):
        req = await body(request)
        if not isinstance(req, dict) or not isinstance(req.get("script"), str):
            return JSONResponse({"error": "body needs a script string"}, status_code=400)
        params = req.get("params") or {}
        if not isinstance(params, dict):
            return JSONResponse({"error": "params must be an object"}, status_code=400)
        filename = req.get("filename") or "part.js"
        if not isinstance(filename, str):
            return JSONResponse({"error": "filename must be a string"}, status_code=400)
        return await run_in_threadpool(run_build, req["script"], params, filename,
                                       bool(req.get("step")))

    @api.post("/render")
    async def render(request: Request):
        req = await body(request)
        why = validate_render(req)
        if why:
            return JSONResponse({"error": why}, status_code=400)
        call = await render_job.spawn.aio(req)
        return {"call_id": call.object_id}

    @api.get("/render/{call_id}")
    async def render_status(call_id: str):
        if not call_id.startswith("fc-"):
            return JSONResponse({"error": "not a call id"}, status_code=400)
        try:
            fc = modal.FunctionCall.from_id(call_id)
            res = await fc.get.aio(timeout=0)
        except (TimeoutError, modal.exception.TimeoutError):
            return {"status": "pending"}
        except Exception as e:  # the job raised, was cancelled, expired or is unknown
            return {"status": "failed", "error": f"{type(e).__name__}: {e}"[:2000]}
        if not isinstance(res, dict) or "error" in res:
            return {"status": "failed",
                    "error": str(res.get("error") if isinstance(res, dict) else res)}
        return {"status": "done", **res}

    return api
