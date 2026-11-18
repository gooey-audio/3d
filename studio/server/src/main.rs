//! gooey-studio: a local web app for Replicad part scripts.
//!
//!   gooey-studio [DIR] [--port 7878] [--library lib.json] [--open]
//!
//! Serves DIR's `*.js` part scripts on http://127.0.0.1:PORT. The agent needs
//! DEEPSEEK_API_KEY (optional: DEEPSEEK_MODEL, DEEPSEEK_BASE_URL).

use std::net::SocketAddr;
use std::path::PathBuf;

use clap::Parser;
use gooey_cad::WorkerCommand;
use gooey_studio::{App, Config, agent, api, watch};

#[derive(Parser)]
#[command(
    version,
    about = "A local web app for Replicad part scripts: AI agent, live three.js preview, path-traced renders"
)]
struct Args {
    /// Directory of part scripts (`*.js`).
    #[arg(default_value = ".")]
    dir: PathBuf,
    #[arg(long, default_value_t = 7878)]
    port: u16,
    /// Finish library (gooey-materials/v1); default: the nearest gooey-3d.json's.
    #[arg(long)]
    library: Option<PathBuf>,
    /// CAD worker command (default: GOOEY_CAD_WORKER, next to this binary, or the checkout's build).
    #[arg(long)]
    worker: Option<String>,
    /// Open the browser.
    #[arg(long)]
    open: bool,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    let worker = match &args.worker {
        Some(w) => Some(WorkerCommand::parse(w).map_err(|e| anyhow::anyhow!("{e}"))?),
        None => None,
    };
    let agent = agent::Config::from_env();
    let app = App::new(Config {
        dir: args.dir.clone(),
        library: args.library.clone(),
        worker,
        agent,
    })
    .map_err(|e| anyhow::anyhow!("{}", e.0))?;
    let _watcher = watch::start(app.clone())?;

    let port = args.port;
    let router = api::app(app.clone(), port);
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let url = format!("http://localhost:{port}/");
    eprintln!(
        "gooey-studio {}: {} parts in {}",
        gooey_studio::VERSION,
        app.part_names().len(),
        app.dir.display()
    );
    match &app.library.path {
        Some(p) => eprintln!("  finishes: {} from {}", app.library.entries.len(), p.display()),
        None => eprintln!("  finishes: none (pass --library or add a gooey-3d.json)"),
    }
    match &app.agent {
        Some(a) => eprintln!("  agent: {} at {}", a.model, a.base_url),
        None => eprintln!("  agent: off (set DEEPSEEK_API_KEY)"),
    }
    eprintln!("  {url}");
    if args.open {
        let _ = std::process::Command::new(if cfg!(target_os = "macos") { "open" } else { "xdg-open" })
            .arg(&url)
            .spawn();
    }
    axum::serve(listener, router).await?;
    Ok(())
}
