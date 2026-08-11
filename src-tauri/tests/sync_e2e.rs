//! Two REAL desktop stores against a REAL running hub.
//!
//! Everything else in this project's sync coverage is a model of one side: the server
//! crate's matrix drives fake devices, and the store's own tests drive a fake hub. This
//! file is the seam between them — the actual `promptflow-sync` binary over the actual
//! HTTP client, carrying the actual SQLite outbox. It is the code path that moves Ryan's
//! outline between machines, and it should not be the one part only ever exercised by
//! hand.
//!
//! It is the Phase 3 gate ("two app instances with isolated stores against a local
//! server converge through the full matrix"), automated: the parts a person still has to
//! check on real hardware are the UI ones (does the panel say the right thing, does the
//! indicator appear), not the convergence.

use promptflow_core::wire::WireNode;
use promptflow_tauri_lib::store::Store;
use promptflow_tauri_lib::sync::{run_cycle, CycleError, SyncConfig};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use uuid::Uuid;

const BEARER: &str = "e2e-bearer-token-0123456789abcdef0123456789abcdef";

// MARK: - A hub, for real

struct HubProcess {
    child: Child,
    pub url: String,
    _dir: tempdir::TempDir,
}

impl Drop for HubProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// A port nothing is using right now. Bind, read, drop.
fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

impl HubProcess {
    fn start() -> HubProcess {
        let root = workspace_root();
        // Build it here rather than assuming somebody already did. The workspace has its
        // own `target/`, separate from `src-tauri/target/`, so this takes a different
        // package lock than the test run holding us — no deadlock.
        let built = Command::new(env!("CARGO"))
            .args(["build", "-p", "pf-sync-server", "--quiet"])
            .current_dir(&root)
            .status()
            .expect("could not run cargo to build the hub");
        assert!(built.success(), "the hub failed to build");

        let bin = root.join("target/debug/promptflow-sync");
        assert!(bin.exists(), "no hub binary at {}", bin.display());

        let dir = tempdir::TempDir::new("pf-sync-e2e").unwrap();
        let home = dir.path().to_path_buf();
        std::fs::create_dir_all(home.join("PromptFlow-Sync")).unwrap();
        // Tests in this file run in PARALLEL, each with its own hub, so the port cannot
        // be derived from anything they share. Let the OS name a free one, then hand it
        // over: a tiny race, and the only alternative is a fixed port that collides with
        // itself four ways (which is exactly what a pid-derived one did).
        let port = free_port();
        std::fs::write(
            home.join("PromptFlow-Sync/config.toml"),
            format!(
                "port = {port}\n\
                 db_path = \"~/PromptFlow-Sync/sync.sqlite\"\n\
                 bearer_token = \"{BEARER}\"\n\
                 require_access = false\n"
            ),
        )
        .unwrap();

        let mut child = Command::new(&bin)
            .env("HOME", &home)
            .env("RUST_LOG", "info")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("could not start the hub");

        // Wait for the line that says it is listening, rather than sleeping and hoping.
        // `tracing_subscriber::fmt()` writes to STDOUT, not stderr.
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if line.contains("listening on") {
                    let _ = tx.send(());
                }
                eprintln!("[hub] {line}");
            }
        });
        if rx.recv_timeout(Duration::from_secs(20)).is_err() {
            let _ = child.kill();
            let status = child.wait();
            panic!(
                "the hub never reported that it was listening (exit: {status:?}) — \
                 see the [hub] lines above"
            );
        }

        HubProcess {
            child,
            url: format!("http://127.0.0.1:{port}"),
            _dir: dir,
        }
    }
}

// MARK: - A desktop store, for real

struct Device {
    name: &'static str,
    store: Mutex<Store>,
    cfg: SyncConfig,
    _dir: tempdir::TempDir,
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(20)))
        .build()
        .new_agent()
}

impl Device {
    fn new(name: &'static str, hub: &HubProcess) -> Device {
        let dir = tempdir::TempDir::new("pf-store").unwrap();
        let mut store = Store::open(&dir.path().join("promptflow.sqlite")).unwrap();
        store.set_sync_enabled(true).unwrap();
        let device_id = store.device_id().unwrap();
        Device {
            name,
            cfg: SyncConfig {
                url: hub.url.clone(),
                device_id,
                bearer: BEARER.into(),
                // Empty Access credentials: this local hub has no tunnel in front, which
                // is exactly the shape the Phase 3 gate calls for.
                access_client_id: String::new(),
                access_client_secret: String::new(),
            },
            store: Mutex::new(store),
            _dir: dir,
        }
    }

    fn with<R>(&self, f: impl FnOnce(&mut Store) -> R) -> R {
        f(&mut self.store.lock().unwrap())
    }

    fn sync(&self) {
        let cursor = self.with(|s| s.sync_cursor().unwrap_or(0));
        if std::env::var("PF_E2E_TRACE").is_ok() {
            let out: Vec<String> = self.with(|s| s.outbox_batch(50).unwrap())
                .iter().map(|r| format!("{:?}", r.op)).collect();
            eprintln!("[{} cycle] cursor={cursor} outbox={out:#?}", self.name);
        }
        match run_cycle(&agent(), &self.store, &self.cfg, cursor, false) {
            Ok(ds) => {
                if std::env::var("PF_E2E_TRACE").is_ok() {
                    for d in &ds { eprintln!("[{} applied] {:?}", self.name, d.ops); }
                }
            }
            Err(CycleError::MassDelete) => panic!("{}: unexpected mass-delete refusal", self.name),
            Err(CycleError::Failed(e)) => panic!("{}: sync failed: {e}", self.name),
        }
    }

    fn sync_confirming_deletes(&self) {
        let cursor = self.with(|s| s.sync_cursor().unwrap_or(0));
        run_cycle(&agent(), &self.store, &self.cfg, cursor, true)
            .unwrap_or_else(|_| panic!("{}: confirmed sync failed", self.name));
    }

    fn try_sync(&self) -> Result<(), CycleError> {
        let cursor = self.with(|s| s.sync_cursor().unwrap_or(0));
        run_cycle(&agent(), &self.store, &self.cfg, cursor, false).map(|_| ())
    }

    fn text(&self, id: Uuid) -> Option<String> {
        self.with(|s| s.get(id).map(|n| n.text.clone()))
    }

    fn node(&self, id: Uuid) -> Option<WireNode> {
        self.with(|s| s.get(id).map(WireNode::from))
    }

    fn count(&self) -> usize {
        self.with(|s| s.node_count())
    }
}

/// Let the millisecond clock move on.
///
/// Both merge clocks are ms-epoch, so two actions inside the same millisecond TIE — and
/// a tie resolves the hub's way, which means a delete pushed in the same millisecond as
/// the edit it follows loses and the node stays alive on every replica. That is correct
/// (convergent, and the user simply deletes again), but it is not what a human ever
/// produces: nobody types and then deletes within one millisecond. A test that runs at
/// full speed does it constantly, so it has to say where it means one action to follow
/// another.
fn tick() {
    std::thread::sleep(Duration::from_millis(2));
}

/// One node with some text, the way a user makes one.
fn typed(dev: &Device, text: &str) -> Uuid {
    dev.with(|s| {
        let (_, out) = s
            .append_root(promptflow_core::NodeKind::BulletPoint)
            .unwrap();
        let id = out.new_node.unwrap();
        s.set_text(id, text.into(), None, None, None).unwrap();
        id
    })
}

// MARK: - The gate

#[test]
fn two_desktops_converge_through_the_real_hub() {
    let hub = HubProcess::start();
    let mac = Device::new("mac", &hub);
    let studio = Device::new("studio", &hub);

    // --- an edit crosses ---
    let a = typed(&mac, "written on the mac");
    mac.sync();
    studio.sync();
    assert_eq!(studio.text(a).as_deref(), Some("written on the mac"));

    // --- and comes back ---
    tick();
    studio.with(|s| {
        s.set_text(a, "edited on the studio".into(), None, None, None)
            .unwrap()
    });
    studio.sync();
    mac.sync();
    assert_eq!(mac.text(a).as_deref(), Some("edited on the studio"));

    // --- structure and content merge independently (T7 over the real wire) ---
    let b = typed(&mac, "second node");
    mac.sync();
    studio.sync();
    tick();
    // The studio moves it under `a`; the Mac, not knowing, retypes it.
    studio.with(|s| s.move_to(b, Some(a), None).unwrap());
    mac.with(|s| {
        s.set_text(b, "retyped while it was being moved".into(), None, None, None)
            .unwrap()
    });
    studio.sync();
    mac.sync();
    studio.sync();
    for dev in [&mac, &studio] {
        let n = dev.node(b).expect("the node must exist on both");
        assert_eq!(
            n.text, "retyped while it was being moved",
            "{}: the text edit survived the move",
            dev.name
        );
        assert_eq!(n.parent, Some(a), "{}: the move survived the text edit", dev.name);
    }

    // --- a delete crosses, subtree and all ---
    tick(); // the delete must be strictly newer than the edits above
    mac.with(|s| s.delete(a).unwrap());
    mac.sync();
    studio.sync();
    assert_eq!(studio.count(), 0, "the whole subtree died on both");
    assert_eq!(mac.count(), 0);

    // --- offline edits on both sides converge by clock ---
    let c = typed(&mac, "shared again");
    mac.sync();
    studio.sync();
    // Both edit while "offline"; the studio's edit is strictly newer.
    mac.with(|s| s.set_text(c, "mac's version".into(), None, None, None).unwrap());
    tick();
    studio.with(|s| {
        s.set_text(c, "studio's version".into(), None, None, None)
            .unwrap()
    });
    mac.sync();
    studio.sync();
    mac.sync();
    assert_eq!(mac.text(c).as_deref(), Some("studio's version"));
    assert_eq!(studio.text(c).as_deref(), Some("studio's version"));

    // --- a second cycle with nothing to say is silent ---
    mac.sync();
    assert_eq!(
        mac.with(|s| s.outbox_count()),
        0,
        "a converged device owes the hub nothing"
    );
}

/// The first-configuration seed, end to end: a store that predates sync hands its WHOLE
/// outline over, and a fresh device picks all of it up.
#[test]
fn a_pre_existing_outline_seeds_the_hub_on_first_configuration() {
    let hub = HubProcess::start();

    // A store written before sync existed: nothing is queued.
    let dir = tempdir::TempDir::new("pf-store-legacy").unwrap();
    let mut legacy = Store::open(&dir.path().join("promptflow.sqlite")).unwrap();
    let mut ids = Vec::new();
    for i in 0..12 {
        let (_, out) = legacy
            .append_root(promptflow_core::NodeKind::BulletPoint)
            .unwrap();
        let id = out.new_node.unwrap();
        legacy
            .set_text(id, format!("older than sync {i}"), None, None, None)
            .unwrap();
        ids.push(id);
    }
    assert_eq!(legacy.outbox_count(), 0, "nothing queued before configuration");

    // Configure. This is what `sync_set_config` does on the user's behalf.
    legacy.set_sync_enabled(true).unwrap();
    assert!(legacy.sync_cursor().is_none(), "never synced");
    assert_eq!(legacy.enqueue_all_live().unwrap(), 12);
    let device_id = legacy.device_id().unwrap();

    let mac = Device {
        name: "mac",
        cfg: SyncConfig {
            url: hub.url.clone(),
            device_id,
            bearer: BEARER.into(),
            access_client_id: String::new(),
            access_client_secret: String::new(),
        },
        store: Mutex::new(legacy),
        _dir: dir,
    };
    mac.sync();

    let fresh = Device::new("fresh", &hub);
    fresh.sync();
    assert_eq!(fresh.count(), 12, "a new device receives the whole outline");
    for id in &ids {
        assert!(fresh.text(*id).is_some(), "ids are PRESERVED, never re-minted");
    }
}

/// The mass-delete tripwire, over the real wire: the hub refuses, the client keeps the
/// deletes queued and reports it, and only an explicit confirmation sends them.
#[test]
fn a_large_delete_is_held_until_it_is_confirmed() {
    let hub = HubProcess::start();
    let mac = Device::new("mac", &hub);

    let mut ids = Vec::new();
    for i in 0..60 {
        ids.push(typed(&mac, &format!("node {i}")));
    }
    mac.sync();

    mac.with(|s| {
        for id in &ids {
            s.delete(*id).unwrap();
        }
    });
    match mac.try_sync() {
        Err(CycleError::MassDelete) => {}
        other => panic!("expected the tripwire to hold; got {:?}", other.is_ok()),
    }
    assert_eq!(
        mac.with(|s| s.outbox_delete_count()),
        60,
        "a refused batch stays queued — nothing is lost while the user decides"
    );

    let peer = Device::new("peer", &hub);
    peer.sync();
    assert_eq!(peer.count(), 60, "and the hub still holds every node");

    mac.sync_confirming_deletes();
    peer.sync();
    assert_eq!(peer.count(), 0);
    assert_eq!(mac.with(|s| s.outbox_count()), 0);
}

/// A remote change must never become an undo step, and must invalidate the local steps it
/// contradicts — checked here against a real round trip rather than a hand-built delta.
#[test]
fn a_remote_edit_does_not_end_up_on_the_undo_stack() {
    let hub = HubProcess::start();
    let mac = Device::new("mac", &hub);
    let studio = Device::new("studio", &hub);

    let a = typed(&mac, "original");
    mac.sync();
    studio.sync();

    // The Mac has local history for `a`. The studio changes it out from under them.
    studio.with(|s| {
        s.set_text(a, "changed elsewhere".into(), None, None, None)
            .unwrap()
    });
    studio.sync();
    mac.sync();
    assert_eq!(mac.text(a).as_deref(), Some("changed elsewhere"));

    // ⌘Z must not walk backwards through the other device's edit.
    mac.with(|s| {
        let _ = s.undo();
    });
    assert_eq!(
        mac.text(a).as_deref(),
        Some("changed elsewhere"),
        "undo must not revert a remote change (its history for this node was dropped)"
    );
}

/// The pull-before-push ordering hazard, which the convergence test above found the hard
/// way: every cycle pulls FIRST, so the hub — which has not heard about a just-deleted
/// subtree — sends it straight back. Without the outbox being read as this device's own
/// tombstone record, the deleted rows reappear in the outline and stay there until a
/// later cycle brings the hub's tombstones round, which at a 30 s idle poll is half a
/// minute of a deletion visibly undoing itself.
#[test]
fn a_pull_does_not_resurrect_what_this_device_just_deleted() {
    let hub = HubProcess::start();
    let mac = Device::new("mac", &hub);
    let studio = Device::new("studio", &hub);

    let parent = typed(&mac, "a subtree");
    mac.sync();
    studio.sync();
    // The studio touches it, so the hub has an op the Mac has NOT yet pulled — which is
    // what makes the Mac's next pull non-empty and dangerous.
    tick();
    studio.with(|s| s.set_text(parent, "a subtree, edited".into(), None, None, None).unwrap());
    studio.sync();

    tick();
    mac.with(|s| s.delete(parent).unwrap());
    assert_eq!(mac.count(), 0);

    mac.sync();
    assert_eq!(
        mac.count(),
        0,
        "the pull must not undo a deletion that is still queued to be pushed"
    );
    studio.sync();
    assert_eq!(studio.count(), 0);
}

/// And the other half of the same rule: a queued delete is a tombstone, not a veto. An
/// incoming edit made AFTER the delete legitimately brings the node back — that is
/// `resurrect`, and it must still work on this side.
#[test]
fn an_edit_newer_than_our_queued_delete_still_resurrects_it() {
    let hub = HubProcess::start();
    let mac = Device::new("mac", &hub);
    let studio = Device::new("studio", &hub);

    let x = typed(&mac, "contested");
    mac.sync();
    studio.sync();

    // The Mac deletes; the studio, not knowing, keeps working on it afterwards.
    tick();
    mac.with(|s| s.delete(x).unwrap());
    tick();
    studio.with(|s| s.set_text(x, "no, I still want this".into(), None, None, None).unwrap());
    studio.sync();

    mac.sync();
    assert_eq!(
        mac.text(x).as_deref(),
        Some("no, I still want this"),
        "an edit made after the delete outranks it, on the client exactly as on the hub"
    );
    studio.sync();
    assert_eq!(studio.text(x).as_deref(), Some("no, I still want this"));
}
