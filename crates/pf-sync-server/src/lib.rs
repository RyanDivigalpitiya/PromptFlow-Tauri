//! `promptflow-sync` — the hub.
//!
//! Runs on the office Mac Mini as a user LaunchAgent, binds loopback only, and is
//! fronted by a Cloudflare Named Tunnel at `https://pf-sync.ryan-div.com`. It holds the
//! canonical replica of the outline plus an append-only oplog; devices converge on it
//! by per-node LWW merge (see `promptflow-core`).

pub mod api;
pub mod auth;
pub mod config;
pub mod hub;

use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio::sync::Mutex;

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let path = config::Config::default_path();
    // A config problem is never transient, so it must not become a launchd relaunch
    // loop: log one line and exit ZERO, which `KeepAlive = {SuccessfulExit: false}`
    // reads as "done, stop restarting me".
    let cfg = match config::Config::load(&path) {
        Ok(c) => c,
        Err(e) => {
            tracing::error!("config error ({}): {e} — not restarting", path.display());
            std::process::exit(0);
        }
    };
    let db_path = cfg.resolved_db_path();
    let hub = match hub::Hub::open(&db_path) {
        Ok(h) => h,
        Err(e) => {
            tracing::error!(
                "cannot open {} : {e} — not restarting",
                db_path.display()
            );
            std::process::exit(0);
        }
    };
    if !cfg.require_access {
        tracing::warn!(
            "require_access = false — the bearer token is the ONLY credential. \
             Correct for a local run; never for the tunnelled deployment."
        );
    }
    if cfg.require_access && cfg.access_team_domain.is_empty() {
        tracing::warn!(
            "access_team_domain is unset — the `iss` claim is NOT pinned. The first \
             authenticated request will log the value to put here."
        );
    }

    let port = cfg.port;
    let state = api::AppState {
        hub: Arc::new(Mutex::new(hub)),
        config: Arc::new(cfg),
        logged_iss: Arc::new(AtomicBool::new(false)),
    };

    let runtime = match tokio::runtime::Runtime::new() {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("cannot start the async runtime: {e}");
            std::process::exit(1); // genuinely transient — let launchd retry
        }
    };
    runtime.block_on(async move {
        // Loopback ONLY. The tunnel connector is the sole thing that may reach this
        // port, and the mini is shared production hardware running SPARC.
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        let listener = match tokio::net::TcpListener::bind(addr).await {
            Ok(l) => l,
            Err(e) => {
                tracing::error!("cannot bind {addr}: {e}");
                std::process::exit(1); // the port may free up — let launchd retry
            }
        };
        tracing::info!("promptflow-sync listening on {addr} (db {})", db_path.display());
        if let Err(e) = axum::serve(listener, api::router(state))
            .with_graceful_shutdown(shutdown_signal())
            .await
        {
            tracing::error!("server stopped: {e}");
            std::process::exit(1);
        }
    });
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutting down");
}
