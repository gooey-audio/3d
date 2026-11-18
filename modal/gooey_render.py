"""Modal deployment shim: render `gooey-3d-job/v1` tiles on an NVIDIA GPU (wgpu over Vulkan).

    modal deploy modal/gooey_render.py          # app `gooey-render`, function `render_shard`

Callers use `scripts/remote-render` (see modal/README.md). The function writes the shard's
STLs to /tmp, points the job's inputs at them and runs `gooey-3d render tiles`. All the
rendering logic is in the Rust binary; this file only builds the image and moves bytes.

The image has no software Vulkan driver (no mesa-vulkan-drivers), and every result is
checked to have come from an NVIDIA adapter, so a misconfigured host fails loudly instead
of rendering slowly on a CPU.
"""

import json
import os
import pathlib
import subprocess
import tempfile
import time

import modal

T_IMPORT = time.time()  # inside the container: roughly when it started serving

# The module is imported again inside the container (as /root/gooey_render.py), where the
# repo isn't; resolve local paths only on the deploying machine or start-up crash-loops.
REPO = pathlib.Path(__file__).resolve().parents[1] if modal.is_local() else pathlib.Path("/src")

BIN = "/src/target/release/gooey-3d"
APP = "gooey-render"
# Idle time before a container stops. It is billed, so keep it short for batch fan-out;
# a sheet's shards arrive together, so a warm container rarely needs to wait long.
SCALEDOWN_S = 20

APT = [
    # Vulkan loader; Modal mounts the NVIDIA ICD and driver libraries at run time.
    "libvulkan1", "libegl1", "libxext6",
    # The render-only build needs no cmake/C++.
    "curl", "ca-certificates", "build-essential", "pkg-config",
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
        "PATH": "/root/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    })
    .run_commands(
        "curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable",
    )
    # Only what the build reads, so edits to docs, fixtures or this file don't rebuild.
    # TODO: download the release tarball instead once a tag exists.
    .add_local_dir(
        str(REPO),
        "/src",
        copy=True,
        ignore=[
            "target", "**/target", ".git", ".github", ".context", "**/node_modules",
            "fixtures", "modal", "scripts", "skill", "docs", "**/*.md", "**/.DS_Store",
        ],
    )
    .run_commands(
        "cd /src && cargo build --release -p gooey-3d --no-default-features --features render"
        " && target/release/gooey-3d --version"
    )
)

app = modal.App(APP, image=image)


def is_nvidia(adapter: str) -> bool:
    return any(k in adapter.upper() for k in ("NVIDIA", "TESLA"))


def safe_name(i: int, key: str) -> str:
    base = "".join(c if c.isalnum() or c in "._-" else "-" for c in pathlib.PurePath(key).name)
    return f"in{i}-{base or 'input.stl'}"


# T4 first: with L4 first, new containers twice took 110-200 s to appear (probably waiting
# for L4 capacity before falling back), while cold T4-first fan-outs started in ~3 s.
# L4 is only much faster for big tiles. See modal/README.md.
@app.function(
    gpu=["T4", "L4"],
    max_containers=10,
    scaledown_window=SCALEDOWN_S,
    timeout=600,
    retries=1,
)
def render_shard(stls: dict[str, bytes], job: dict, library: bytes | None = None,
                 shard: str = "") -> dict:
    """Render `job`'s tiles (a `gooey-3d-job/v1` dict) and return their PNGs and records.

    `stls` maps each tile `input` string in `job` to the STL bytes. `library` is a finish
    library (`gooey-materials/v1` JSON) for jobs that name finishes. `shard` names the shard
    in errors, so a caller collecting results out of order can tell which one failed.

    Returns `{pngs: {id: bytes}, records: {id: record}, adapter, task_id, timings}`, where a
    record is what `render tiles` writes beside each PNG (`<id>.json`). If `render tiles`
    fails, returns `{shard, error, task_id}` instead. Raises (and Modal retries once) on
    anything else, including a non-NVIDIA adapter.
    """
    t_start = time.time()
    tag = f"[shard {shard}] " if shard else ""
    work = pathlib.Path(tempfile.mkdtemp(prefix="shard-", dir="/tmp"))
    names = {}
    for i, (key, data) in enumerate(stls.items()):
        names[key] = safe_name(i, key)
        (work / names[key]).write_bytes(data)
    job = dict(job)
    job["tiles"] = [dict(t) for t in job["tiles"]]
    for t in job["tiles"]:
        if t["input"] not in names:
            raise ValueError(f"{tag}tile {t['id']}: no STL bytes for input {t['input']!r}")
        t["input"] = names[t["input"]]
    (work / "job.json").write_text(json.dumps(job, indent=2) + "\n")
    cmd = [BIN, "render", "tiles", str(work / "job.json"), "--out-dir", str(work / "out"),
           "--json", "--quiet"]
    if library is not None:
        (work / "library.json").write_bytes(library)
        cmd += ["--library", str(work / "library.json")]
    p = subprocess.run(cmd, cwd=work, capture_output=True, text=True)
    if p.returncode != 0:
        # Almost always the input (a bad STL, an unknown finish): returned, not raised,
        # because a retry would fail the same way after waiting for another container.
        return {"shard": shard, "error": f"gooey-3d render tiles exited {p.returncode}: "
                                         f"{p.stderr.strip()[-2000:]}",
                "task_id": os.environ.get("MODAL_TASK_ID", "")}
    outputs = json.loads(p.stdout)["outputs"]
    adapters = sorted({r["adapter"] for r in outputs})
    bad = [a for a in adapters if not is_nvidia(a)]
    if bad:
        raise RuntimeError(f"{tag}rendered on a non-NVIDIA adapter {bad}; refusing the result")
    pngs, records = {}, {}
    for r in outputs:
        tid = r["shot"]
        pngs[tid] = (work / "out" / f"{tid}.png").read_bytes()
        records[tid] = r
    t_end = time.time()
    return {
        "pngs": pngs,
        "records": records,
        "adapter": ", ".join(adapters),
        "task_id": os.environ.get("MODAL_TASK_ID", ""),
        "timings": {
            "container_start": T_IMPORT,
            "start": t_start,
            "end": t_end,
            "render_s": round(t_end - t_start, 3),
            "scaledown_s": SCALEDOWN_S,
        },
    }
