//! The desktop sync client: one background thread running `pull → apply → push` against
//! the hub.
//!
//! **The load-bearing rule of this file: no network I/O ever happens while the store
//! mutex is held.** The mutex is what every keystroke's `set_text` waits on, so a single
//! hung request under it would freeze typing in every window until the timeout expired.
//! Each cycle therefore takes the lock three times — read the cursor, apply the pull,
//! process the push results — and does its HTTP between them.
//!
//! It follows the auto-archive precedent (`std::thread` + lock + `emit_delta`) rather
//! than introducing an async runtime into the app process.

use crate::commands::StoreState;
use crate::store::Store;
use promptflow_core::wire::{
    ChangesResponse, Current, ErrorResponse, Outcome, PushRequest, PushResponse, Reason,
    SnapshotResponse, WireOp, CONFIRM_MASS_DELETE_HEADER, PROTOCOL_VERSION,
};
use serde::Serialize;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

// Settings-table keys. The SECRETS are not here — they live in the login Keychain (see
// `keychain`), so a copy of the sqlite file is not a copy of the credentials.
pub const ENABLED_KEY: &str = "sync.enabled";
pub const DEVICE_KEY: &str = "sync.device_id";
pub const CURSOR_KEY: &str = "sync.cursor";
pub const URL_KEY: &str = "sync.url";
pub const CLIENT_ID_KEY: &str = "sync.access_client_id";

/// Quiet time after the last commit before a cycle runs, so a typing burst is one push
/// rather than one per keystroke.
const DEBOUNCE: Duration = Duration::from_secs(2);
/// Idle poll. v1 has no push channel; a WebSocket ping is the Phase 5 nicety.
const IDLE_POLL: Duration = Duration::from_secs(30);
/// Ops per push. Well under Cloudflare's 100 MB body cap with room to spare, and small
/// enough that a first-configuration seed of a big outline makes visible progress.
const PUSH_BATCH: usize = 500;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// Total per request. Cloudflare's free plan gives the origin 100 s before a 524, so
/// there is no point waiting longer than this for anything.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

// MARK: - Status, as the UI sees it

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub configured: bool,
    /// A cycle is in flight right now.
    pub syncing: bool,
    pub last_synced_at: Option<i64>,
    /// Human-readable, and deliberately specific about WHICH thing failed — "check your
    /// credentials" and "the office is offline" want different reactions.
    pub error: Option<String>,
    /// Consecutive failures. The TopBar indicator only appears once this is past 1, so a
    /// single dropped request on a train is not a red badge.
    pub failures: u32,
    pub pending: i64,
    /// Deletes waiting behind the mass-delete tripwire. Non-zero means the UI must offer
    /// the confirm-once action; nothing here is ever automatic.
    pub blocked_deletes: Option<i64>,
}

impl Default for SyncStatus {
    fn default() -> Self {
        SyncStatus {
            configured: false,
            syncing: false,
            last_synced_at: None,
            error: None,
            failures: 0,
            pending: 0,
            blocked_deletes: None,
        }
    }
}

fn status_cell() -> &'static Mutex<SyncStatus> {
    static CELL: OnceLock<Mutex<SyncStatus>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(SyncStatus::default()))
}

pub fn status() -> SyncStatus {
    status_cell().lock().unwrap().clone()
}

fn publish(app: &AppHandle, f: impl FnOnce(&mut SyncStatus)) {
    let next = {
        let mut s = status_cell().lock().unwrap();
        f(&mut s);
        s.clone()
    };
    let _ = app.emit("sync://status", &next);
}

// MARK: - Waking the thread

pub enum Nudge {
    /// A local mutation committed — cycle after the debounce.
    Commit,
    /// The user asked for a sync now, or changed the configuration.
    Now,
    /// Re-send the pending batch ONCE with the mass-delete confirmation header. Only
    /// ever sent from an explicit user action.
    ConfirmMassDelete,
}

fn sender() -> &'static Mutex<Option<Sender<Nudge>>> {
    static CELL: OnceLock<Mutex<Option<Sender<Nudge>>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(None))
}

pub fn nudge(n: Nudge) {
    if let Some(tx) = sender().lock().unwrap().as_ref() {
        let _ = tx.send(n);
    }
}

// MARK: - Configuration

#[derive(Debug, Clone)]
pub struct SyncConfig {
    pub url: String,
    pub device_id: String,
    pub bearer: String,
    pub access_client_id: String,
    pub access_client_secret: String,
}

/// Secrets live in the login Keychain, reached through the `security` CLI — the same
/// place `scripts/sync-status.sh` reads them from, so there is one home for them on this
/// Mac rather than two.
pub mod keychain {
    pub const BEARER: &str = "pf-sync-bearer";
    pub const ACCESS_SECRET: &str = "pf-sync-access-client-secret";

    pub fn read(service: &str) -> Option<String> {
        let out = std::process::Command::new("security")
            .args(["find-generic-password", "-s", service, "-w"])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (!v.is_empty()).then_some(v)
    }

    pub fn write(service: &str, value: &str) -> Result<(), String> {
        let user = std::env::var("USER").unwrap_or_else(|_| "promptflow".into());
        let out = std::process::Command::new("security")
            .args([
                "add-generic-password", "-U", "-s", service, "-a", &user, "-w", value,
            ])
            .output()
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
    }
}

fn load_config(store: &mut Store) -> Option<SyncConfig> {
    if !store.sync_enabled() {
        return None;
    }
    let url = store.get_setting(URL_KEY)?;
    if url.is_empty() {
        return None;
    }
    let bearer = keychain::read(keychain::BEARER)?;
    let device_id = store.device_id().ok()?;
    Some(SyncConfig {
        url: url.trim_end_matches('/').to_string(),
        device_id,
        bearer,
        access_client_id: store.get_setting(CLIENT_ID_KEY).unwrap_or_default(),
        access_client_secret: keychain::read(keychain::ACCESS_SECRET).unwrap_or_default(),
    })
}

// MARK: - The thread

pub fn spawn(app: AppHandle) {
    let (tx, rx) = std::sync::mpsc::channel();
    *sender().lock().unwrap() = Some(tx);
    std::thread::spawn(move || run(app, rx));
}

fn run(app: AppHandle, rx: Receiver<Nudge>) {
    let agent = ureq::Agent::config_builder()
        .timeout_connect(Some(CONNECT_TIMEOUT))
        .timeout_global(Some(REQUEST_TIMEOUT))
        .build()
        .new_agent();

    // Let the windows load before the first cycle, exactly as the auto-archive sweep
    // does — a cold launch has enough to do.
    std::thread::sleep(Duration::from_secs(3));
    first_configuration(&app);

    loop {
        let mut confirm_mass_delete = false;
        match rx.recv_timeout(IDLE_POLL) {
            Ok(Nudge::Commit) => {
                // Coalesce a burst: keep swallowing nudges until the store has been
                // quiet for the whole debounce.
                loop {
                    match rx.recv_timeout(DEBOUNCE) {
                        Ok(Nudge::Commit) => continue,
                        Ok(Nudge::ConfirmMassDelete) => {
                            confirm_mass_delete = true;
                            break;
                        }
                        Ok(Nudge::Now) => break,
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => return,
                    }
                }
            }
            Ok(Nudge::Now) => {}
            Ok(Nudge::ConfirmMassDelete) => confirm_mass_delete = true,
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        cycle(&app, &agent, confirm_mass_delete);
    }
}

/// The first time sync is configured on a store that already holds an outline, queue
/// ALL of it. Guarded by the CURSOR's absence, not by the outbox being empty: the outbox
/// only ever collects post-configuration edits, so without this the hub would start
/// empty forever while the Mac showed a healthy "last synced" (test T16).
pub fn first_configuration(app: &AppHandle) {
    let Some(state) = app.try_state::<StoreState>() else {
        return;
    };
    let mut store = state.lock().unwrap();
    if !store.sync_enabled() || store.sync_cursor().is_some() {
        return;
    }
    match store.enqueue_all_live() {
        Ok(n) => tracing_line(app, &format!("sync: queued {n} existing nodes for the hub")),
        Err(e) => tracing_line(app, &format!("sync: could not seed the outbox: {e}")),
    }
}

fn tracing_line(app: &AppHandle, msg: &str) {
    eprintln!("[sync] {msg}");
    let _ = app.emit("sync://log", msg);
}

fn cycle(app: &AppHandle, agent: &ureq::Agent, confirm_mass_delete: bool) {
    let Some(state) = app.try_state::<StoreState>() else {
        return;
    };

    // (1) Read what we need under the lock, then RELEASE it before any I/O.
    let (cfg, cursor) = {
        let mut store = state.lock().unwrap();
        match load_config(&mut store) {
            Some(c) => (c, store.sync_cursor().unwrap_or(0)),
            None => {
                publish(app, |s| {
                    s.configured = false;
                    s.error = None;
                    s.blocked_deletes = None;
                });
                return;
            }
        }
    };
    publish(app, |s| {
        s.configured = true;
        s.syncing = true;
    });

    // A cycle that PULLED successfully and then failed to push has already committed the
    // remote changes to SQLite and bumped `rev`. Dropping the deltas on the error path
    // would leave every window rendering an outline that no longer exists — and a
    // keystroke there sends the stale text back with a fresh clock, which wins. The 428
    // path makes this permanent, because it repeats every cycle until the user confirms.
    let (outcome, deltas) = match run_cycle(agent, state.inner(), &cfg, cursor, confirm_mass_delete)
    {
        Ok(deltas) => (Ok(()), deltas),
        Err((e, deltas)) => (Err(e), deltas),
    };
    for d in deltas {
        emit(app, d);
    }
    match outcome {
        Ok(()) => {}
        Err(CycleError::MassDelete) => {
            let pending_deletes = state.lock().unwrap().outbox_delete_count();
            publish(app, |s| {
                s.syncing = false;
                s.failures = s.failures.saturating_add(1);
                s.blocked_deletes = Some(pending_deletes);
                s.error = Some(format!(
                    "sync paused: {pending_deletes} deletion{} pending — the server holds back \
                     an unusually large delete until you confirm it below",
                    if pending_deletes == 1 { "" } else { "s" }
                ));
            });
            return;
        }
        Err(CycleError::Failed(e)) => {
            publish(app, |s| {
                s.syncing = false;
                s.failures = s.failures.saturating_add(1);
                s.error = Some(e);
            });
            return;
        }
    }

    let pending = state.lock().unwrap().outbox_count();
    publish(app, |s| {
        s.syncing = false;
        s.failures = 0;
        s.error = None;
        s.blocked_deletes = None;
        s.last_synced_at = Some(promptflow_core::model::now_ms());
        s.pending = pending;
    });
}

/// What a cycle can fail with. The mass-delete case is separate because it is not an
/// error the user should retry — it needs a decision from them.
pub enum CycleError {
    MassDelete,
    Failed(String),
}

/// ONE sync cycle: pull → apply → push → apply the repairs that came back.
///
/// Deliberately free of `AppHandle`, so the integration test can drive it against a real
/// store and a real running hub — this is the code path that actually carries Ryan's
/// outline between devices, and it should not be the one part that is only ever exercised
/// by hand.
///
/// Returns the deltas the caller must broadcast; it emits nothing itself.
pub fn run_cycle(
    agent: &ureq::Agent,
    state: &StoreState,
    cfg: &SyncConfig,
    cursor: i64,
    confirm_mass_delete: bool,
) -> Result<Vec<crate::store::Delta>, (CycleError, Vec<crate::store::Delta>)> {
    let mut deltas = Vec::new();
    // (2) PULL — no lock held.
    let pulled = match get_changes(agent, cfg, cursor) {
        Ok(r) => r,
        Err(SyncError::Gone) => {
            // The hub cannot serve our cursor (v1: only reachable if it was restored
            // from a backup). Re-bootstrap from the snapshot, merged through the SAME
            // apply path — a snapshot is just a very large pull.
            let snap = match get_snapshot(agent, cfg) {
                Ok(s) => s,
                Err(e) => return Err((CycleError::Failed(e), deltas)),
            };
            let ops: Vec<WireOp> = snap.nodes.into_iter().map(WireOp::upsert).collect();
            {
                let mut store = state.lock().unwrap();
                match store.apply_remote(&ops, Some(snap.latest_seq), &[]) {
                    Ok(delta) => deltas.push(delta),
                    Err(e) => return Err((CycleError::Failed(e), deltas)),
                }
                // A snapshot re-bootstrap can only ADD. `apply_remote` correctly keeps every
                // locally-newer row, but it enqueues nothing, and the outbox is empty by
                // construction (everything was acked before the hub lost its database). So
                // without this, a day of work that exists only on this Mac is never offered
                // to the hub again — and the first time any device touches one of those
                // nodes, its older copy wins and the newer text is gone. Both ends show a
                // healthy "last synced" throughout.
                store.enqueue_all_live().map_err(|e| (CycleError::Failed(e), Vec::new()))?;
            }
            nudge(Nudge::Now);
            return Ok(deltas);
        }
        Err(e) => return Err((CycleError::Failed(e.to_string()), deltas)),
    };

    // (3) APPLY — one lock, one SQLite transaction covering the ops AND the cursor.
    if !pulled.ops.is_empty() || pulled.latest_seq != cursor {
        let ops: Vec<WireOp> = pulled.ops.into_iter().map(|e| e.op).collect();
        let delta = {
            let mut store = state.lock().unwrap();
            match store.apply_remote(&ops, Some(pulled.latest_seq), &[]) {
                Ok(d) => d,
                Err(e) => return Err((CycleError::Failed(e), deltas)),
            }
        };
        deltas.push(delta);
    }

    // (4) Snapshot the outbox under the lock, release, PUSH.
    let batch = {
        let store = state.lock().unwrap();
        match store.outbox_batch(PUSH_BATCH) {
            Ok(b) => b,
            Err(e) => return Err((CycleError::Failed(e), deltas)),
        }
    };
    if batch.is_empty() {
        return Ok(deltas);
    }
    let ops: Vec<WireOp> = batch.iter().map(|r| r.op.clone()).collect();
    let response = match push(agent, cfg, ops, confirm_mass_delete) {
        Ok(r) => r,
        // NEVER retried automatically. The UI surfaces the count and offers a
        // confirm-once action, which is the only thing that sets the header.
        Err(SyncError::MassDelete) => return Err((CycleError::MassDelete, deltas)),
        Err(e) => return Err((CycleError::Failed(e.to_string()), deltas)),
    };

    // (5) Re-take the lock: every named op leaves the outbox (unless re-queued since —
    // that is what the `queued_at` guard is for), and every `current` is applied through
    // the same merge path as a pull. Together these are what stop a losing device
    // re-pushing the same rejected batch forever.
    let by_id: std::collections::HashMap<Uuid, i64> =
        batch.iter().map(|r| (r.node_id, r.queued_at)).collect();
    let mut clear: Vec<(Uuid, i64)> = Vec::new();
    let mut repairs: Vec<WireOp> = Vec::new();
    for r in &response.results {
        // Every named op leaves the outbox — EXCEPT a clock-skew rejection, which is the
        // one outcome in the whole protocol that carries no `current`. Every other
        // rejection hands back the winning state, which is what makes dropping the queued
        // op safe; drop this one and the edit is deleted from the queue having reached
        // nobody, while the push still returns 200 and the panel reports a clean sync.
        let unrepairable =
            r.outcome == Outcome::Rejected && r.reason == Some(Reason::ClockSkew);
        if let (Some(at), false) = (by_id.get(&r.id), unrepairable) {
            clear.push((r.id, *at));
        }
        match &r.current {
            Some(Current::Node(n)) => repairs.push(WireOp::upsert((**n).clone())),
            Some(Current::Tombstone(t)) => repairs.push(WireOp::Delete {
                id: t.id,
                deleted_at: t.deleted_at,
            }),
            None => {}
        }
    }
    let delta = {
        let mut store = state.lock().unwrap();
        match store.apply_remote(&repairs, None, &clear) {
            Ok(d) => d,
            Err(e) => return Err((CycleError::Failed(e), deltas)),
        }
    };
    deltas.push(delta);

    // More queued than one batch could carry — come straight back for the rest.
    if batch.len() == PUSH_BATCH {
        nudge(Nudge::Now);
    }
    Ok(deltas)
}

fn emit(app: &AppHandle, delta: crate::store::Delta) {
    if delta.ops.is_empty() {
        return;
    }
    let _ = app.emit("store://delta", &delta);
}

// MARK: - HTTP

enum SyncError {
    Gone,
    /// The hub's mass-delete tripwire. It carries no counts: the client re-reads its own
    /// pending-delete count, which is the number the user actually cares about (and the
    /// one that stays true while they think about it).
    MassDelete,
    Message(String),
}

impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SyncError::Gone => write!(f, "the hub could not serve our position in its log"),
            SyncError::MassDelete => write!(f, "deletions need confirming"),
            SyncError::Message(m) => write!(f, "{m}"),
        }
    }
}

/// The three credentials every request carries. Cloudflare Access proves the request
/// came through the tunnel's front door; the bearer proves it came from PromptFlow. The
/// Access pair is omitted when no client id is configured, which is how a LOCAL server
/// with no tunnel in front is reached (the Phase 3 convergence gate).
///
/// Returned as pairs rather than applied through a generic helper because ureq 3's
/// builder is typestated — a GET builder and a POST builder are different types.
fn auth_headers(cfg: &SyncConfig) -> Vec<(&'static str, String)> {
    let mut h = vec![("Authorization", format!("Bearer {}", cfg.bearer))];
    if !cfg.access_client_id.is_empty() {
        h.push(("CF-Access-Client-Id", cfg.access_client_id.clone()));
        h.push(("CF-Access-Client-Secret", cfg.access_client_secret.clone()));
    }
    h
}

/// Turn a transport or status failure into something the settings panel can show a human
/// without them having to know what a 403 is.
fn explain(status: u16, body: &str) -> String {
    match status {
        401 => "sync credentials rejected — check the bearer token".into(),
        403 => "Cloudflare Access refused the request — check the service token (it expires yearly)".into(),
        413 => "this outline is too large to sync in one request".into(),
        502 | 503 | 504 => "the sync server is not answering — it may be down or the office may be offline".into(),
        _ => {
            let detail = serde_json::from_str::<ErrorResponse>(body)
                .map(|e| e.error)
                .unwrap_or_else(|_| body.chars().take(200).collect());
            format!("sync failed ({status}): {detail}")
        }
    }
}

fn get_changes(
    agent: &ureq::Agent,
    cfg: &SyncConfig,
    since: i64,
) -> Result<ChangesResponse, SyncError> {
    let url = format!(
        "{}/v1/changes?since={since}&device={}",
        cfg.url,
        urlencode(&cfg.device_id)
    );
    let mut req = agent.get(&url);
    for (k, v) in auth_headers(cfg) {
        req = req.header(k, &v);
    }
    match req.call() {
        Ok(mut res) => res
            .body_mut()
            .read_json::<ChangesResponse>()
            .map_err(|e| SyncError::Message(format!("could not read the hub's reply: {e}"))),
        Err(ureq::Error::StatusCode(410)) => Err(SyncError::Gone),
        Err(e) => Err(SyncError::Message(transport(e))),
    }
}

fn get_snapshot(agent: &ureq::Agent, cfg: &SyncConfig) -> Result<SnapshotResponse, String> {
    let mut req = agent.get(&format!("{}/v1/snapshot", cfg.url));
    for (k, v) in auth_headers(cfg) {
        req = req.header(k, &v);
    }
    req.call()
        .map_err(transport)?
        .body_mut()
        .read_json::<SnapshotResponse>()
        .map_err(|e| format!("could not read the hub's snapshot: {e}"))
}

fn push(
    agent: &ureq::Agent,
    cfg: &SyncConfig,
    ops: Vec<WireOp>,
    confirm_mass_delete: bool,
) -> Result<PushResponse, SyncError> {
    let body = PushRequest {
        protocol_version: PROTOCOL_VERSION,
        device_id: cfg.device_id.clone(),
        ops,
    };
    let mut req = agent.post(&format!("{}/v1/push", cfg.url));
    for (k, v) in auth_headers(cfg) {
        req = req.header(k, &v);
    }
    if confirm_mass_delete {
        req = req.header(CONFIRM_MASS_DELETE_HEADER, "true");
    }
    match req.send_json(&body) {
        Ok(mut res) => res
            .body_mut()
            .read_json::<PushResponse>()
            .map_err(|e| SyncError::Message(format!("could not read the hub's reply: {e}"))),
        Err(ureq::Error::StatusCode(428)) => Err(SyncError::MassDelete),
        Err(ureq::Error::StatusCode(code)) => Err(SyncError::Message(explain(code, ""))),
        Err(e) => Err(SyncError::Message(transport(e))),
    }
}

fn transport(e: ureq::Error) -> String {
    match e {
        ureq::Error::StatusCode(code) => explain(code, ""),
        ureq::Error::Timeout(_) => {
            "the sync server did not answer in time — it may be down or the office may be offline"
                .into()
        }
        other => format!("could not reach the sync server: {other}"),
    }
}

/// Device ids are UUIDs today, but a query parameter built by string concatenation is
/// exactly the kind of thing that stops being true quietly.
fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}
