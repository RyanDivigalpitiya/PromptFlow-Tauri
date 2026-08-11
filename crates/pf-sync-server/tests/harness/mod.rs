//! Two fake devices and an in-process hub.
//!
//! `Hub` serves the REAL axum router (auth layer included) over a temp database.
//! `Device` is a minimal but honest client: its own replica, an outbox coalesced per
//! node, a delete journal, a cursor, and the `pull → apply → push → apply current`
//! cycle both shipping clients run. It merges with `promptflow-core`'s `Side::Client`,
//! which is the same code the Tauri client calls and the same rules the Swift client is
//! pinned to by fixtures — so a scenario that passes here is a property of the protocol
//! rather than of one client.
//!
//! What it deliberately does NOT model: per-client concerns like the Tauri undo stack,
//! the iPad's bootstrap UI, or SQLite transaction seams. Those belong to their own
//! suites; this file is about the wire.

#![allow(dead_code)]

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use pf_sync_server::api::{router, AppState};
use pf_sync_server::config::Config;
use promptflow_core::merge::{merge_delete, merge_upsert, NodeState, Side, Stored, TreeLookup};
use promptflow_core::model::{now_ms, NodeKind, GAP};
use promptflow_core::splice::splice_ranges;
use promptflow_core::wire::{
    ChangesResponse, Current, OpResult, PushRequest, PushResponse, SnapshotResponse, WireNode,
    WireOp, CONFIRM_MASS_DELETE_HEADER, PROTOCOL_VERSION,
};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use tower::ServiceExt;
use uuid::Uuid;

pub const BEARER: &str = "test-bearer-token-0123456789abcdef0123456789abcdef";

// MARK: - The hub under test

pub struct Hub {
    router: axum::Router,
    inner: Arc<tokio::sync::Mutex<pf_sync_server::hub::Hub>>,
}

pub struct Raw {
    pub status: u16,
    pub json: serde_json::Value,
}

impl Hub {
    pub async fn new() -> Hub {
        let inner = Arc::new(tokio::sync::Mutex::new(
            pf_sync_server::hub::Hub::open_memory().unwrap(),
        ));
        let config: Config = toml::from_str(&format!(
            r#"
            bearer_token = "{BEARER}"
            require_access = false
        "#
        ))
        .unwrap();
        let state = AppState {
            hub: inner.clone(),
            config: Arc::new(config),
            logged_iss: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        };
        Hub {
            router: router(state),
            inner,
        }
    }

    async fn send(&self, req: Request<Body>) -> Raw {
        let res = self.router.clone().oneshot(req).await.unwrap();
        let status = res.status().as_u16();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let json = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        Raw { status, json }
    }

    pub async fn raw_snapshot(&self) -> Raw {
        self.send(
            Request::get("/v1/snapshot")
                .header("authorization", format!("Bearer {BEARER}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
    }

    pub async fn raw_changes(&self, since: i64, device: &str) -> Raw {
        self.send(
            Request::get(format!("/v1/changes?since={since}&device={device}"))
                .header("authorization", format!("Bearer {BEARER}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
    }

    pub async fn raw_push(&self, body: &serde_json::Value, confirm: bool) -> Raw {
        let mut req = Request::post("/v1/push")
            .header("authorization", format!("Bearer {BEARER}"))
            .header("content-type", "application/json");
        if confirm {
            req = req.header(CONFIRM_MASS_DELETE_HEADER, "true");
        }
        self.send(req.body(Body::from(body.to_string())).unwrap())
            .await
    }

    /// `None` = send no Authorization header at all.
    pub async fn raw_health(&self, bearer: Option<&str>) -> Raw {
        let mut req = Request::get("/v1/health");
        if let Some(b) = bearer {
            req = req.header("authorization", format!("Bearer {b}"));
        }
        self.send(req.body(Body::empty()).unwrap()).await
    }

    // Direct inspection — assertions about stored state, not about the wire.

    pub async fn node(&self, id: Uuid) -> Option<WireNode> {
        let mut hub = self.inner.lock().await;
        hub.snapshot()
            .unwrap()
            .nodes
            .into_iter()
            .find(|n| n.id == id)
    }

    pub async fn live_count(&self) -> usize {
        let mut hub = self.inner.lock().await;
        hub.snapshot().unwrap().nodes.len()
    }

    pub async fn latest_seq(&self) -> i64 {
        let hub = self.inner.lock().await;
        hub.health().unwrap().latest_seq
    }
}

// MARK: - A device replica

pub struct Device {
    pub id: String,
    pub cursor: i64,
    /// Until this is set the engine refuses to push — the iPad's destructive-bootstrap
    /// gate. Devices default to bootstrapped; T4 is the test that exercises the gate.
    pub bootstrapped: bool,
    nodes: HashMap<Uuid, WireNode>,
    /// Coalesced per node, latest image wins, a delete replaces a queued upsert — the
    /// same shape the Tauri outbox table has.
    outbox: BTreeMap<u64, (Uuid, WireOp)>,
    outbox_index: HashMap<Uuid, u64>,
    seq: u64,
    clock: i64,
}

impl Device {
    pub fn new(id: &str) -> Device {
        Device {
            id: id.into(),
            cursor: 0,
            bootstrapped: true,
            nodes: HashMap::new(),
            outbox: BTreeMap::new(),
            outbox_index: HashMap::new(),
            seq: 0,
            clock: 1_000,
        }
    }

    fn tick(&mut self) -> i64 {
        self.clock += 1;
        self.clock
    }

    fn enqueue(&mut self, id: Uuid, op: WireOp) {
        if let Some(old) = self.outbox_index.remove(&id) {
            self.outbox.remove(&old);
        }
        self.seq += 1;
        self.outbox.insert(self.seq, (id, op));
        self.outbox_index.insert(id, self.seq);
    }

    // MARK: Local mutations

    pub fn create(&mut self, text: &str) -> Uuid {
        let id = self.create_quietly(text);
        self.enqueue(id, WireOp::upsert(self.nodes[&id].clone()));
        id
    }

    /// A node that exists locally but was never queued — what an outline written before
    /// sync was configured looks like (T16).
    pub fn create_quietly(&mut self, text: &str) -> Uuid {
        let at = self.tick();
        let position = (self.nodes.len() as i64) * GAP;
        let n = WireNode {
            id: Uuid::new_v4(),
            parent: None,
            position,
            text: text.into(),
            note: String::new(),
            kind: NodeKind::BulletPoint,
            is_completed: false,
            is_highlighted: false,
            bold_ranges: vec![],
            italic_ranges: vec![],
            underline_ranges: vec![],
            created_at: at,
            updated_at: at,
            structure_updated_at: at,
            completed_at: None,
        };
        let id = n.id;
        self.nodes.insert(id, n);
        id
    }

    pub fn create_child(&mut self, text: &str, parent: Uuid, at: i64) -> Uuid {
        let id = self.create_quietly(text);
        let n = self.nodes.get_mut(&id).unwrap();
        n.parent = Some(parent);
        n.created_at = at;
        n.updated_at = at;
        n.structure_updated_at = at;
        self.enqueue(id, WireOp::upsert(self.nodes[&id].clone()));
        id
    }

    pub fn edit_text(&mut self, id: Uuid, text: &str, at: i64) {
        let n = self.nodes.get_mut(&id).expect("editing a node we do not have");
        n.text = text.into();
        n.updated_at = at; // CONTENT clock only
        self.enqueue(id, WireOp::upsert(self.nodes[&id].clone()));
    }

    pub fn set_styles(&mut self, id: Uuid, bold: Vec<i64>, italic: Vec<i64>, under: Vec<i64>, at: i64) {
        let n = self.nodes.get_mut(&id).unwrap();
        n.bold_ranges = bold;
        n.italic_ranges = italic;
        n.underline_ranges = under;
        n.updated_at = at;
        self.enqueue(id, WireOp::upsert(self.nodes[&id].clone()));
    }

    /// One text splice, carrying ALL THREE style arrays across it — including the two a
    /// bold-only client cannot paint (T9).
    pub fn splice_text(&mut self, id: Uuid, location: i64, length: i64, insert: &str, at: i64) {
        let n = self.nodes.get_mut(&id).unwrap();
        let old: Vec<u16> = n.text.encode_utf16().collect();
        let old_len = old.len() as i64;
        let repl: Vec<u16> = insert.encode_utf16().collect();
        let mut next: Vec<u16> = Vec::new();
        next.extend_from_slice(&old[..location as usize]);
        next.extend_from_slice(&repl);
        next.extend_from_slice(&old[(location + length) as usize..]);
        n.text = String::from_utf16(&next).unwrap();
        let rl = repl.len() as i64;
        n.bold_ranges = splice_ranges(&n.bold_ranges, old_len, location, length, rl);
        n.italic_ranges = splice_ranges(&n.italic_ranges, old_len, location, length, rl);
        n.underline_ranges = splice_ranges(&n.underline_ranges, old_len, location, length, rl);
        n.updated_at = at;
        self.enqueue(id, WireOp::upsert(self.nodes[&id].clone()));
    }

    pub fn set_position(&mut self, id: Uuid, position: i64, at: i64) {
        let n = self.nodes.get_mut(&id).unwrap();
        n.position = position;
        n.structure_updated_at = at; // STRUCTURE clock only
        self.enqueue(id, WireOp::upsert(self.nodes[&id].clone()));
    }

    pub fn move_under(&mut self, id: Uuid, parent: Option<Uuid>, at: i64) {
        let n = self.nodes.get_mut(&id).unwrap();
        n.parent = parent;
        n.structure_updated_at = at;
        self.enqueue(id, WireOp::upsert(self.nodes[&id].clone()));
    }

    /// Drive a clock directly — for the broken-device-clock case only.
    pub fn set_clock(&mut self, id: Uuid, at: i64) {
        let n = self.nodes.get_mut(&id).unwrap();
        n.updated_at = at;
        n.structure_updated_at = at;
        self.enqueue(id, WireOp::upsert(self.nodes[&id].clone()));
    }

    /// The local half of a delete: enumerate the subtree FIRST (a cascade cannot tell
    /// you afterwards what it took), drop it, and journal one delete per node.
    pub fn delete_subtree(&mut self, root: Uuid, at: i64) {
        for id in self.local_descendants(root) {
            self.nodes.remove(&id);
            self.enqueue(
                id,
                WireOp::Delete {
                    id,
                    deleted_at: at,
                },
            );
        }
    }

    /// `replace_all` (import) while sync is configured: deletes for everything replaced,
    /// upserts for everything imported.
    pub fn replace_all(&mut self, texts: &[&str]) -> Vec<Uuid> {
        let at = self.tick();
        let roots: Vec<Uuid> = self
            .nodes
            .values()
            .filter(|n| n.parent.is_none())
            .map(|n| n.id)
            .collect();
        for r in roots {
            self.delete_subtree(r, at);
        }
        texts.iter().map(|t| self.create(t)).collect()
    }

    /// First-configuration seeding: everything live goes into the outbox at once. This
    /// is how the hub gets an outline that predates sync (T16).
    pub fn enqueue_everything(&mut self) {
        let ids: Vec<Uuid> = self.nodes.keys().copied().collect();
        for id in ids {
            self.enqueue(id, WireOp::upsert(self.nodes[&id].clone()));
        }
    }

    // MARK: The sync cycle

    pub async fn sync(&mut self, hub: &Hub) {
        self.pull(hub).await;
        self.push(hub).await;
    }

    /// pull → apply → advance the cursor. A `410` sends us back to the snapshot.
    pub async fn pull(&mut self, hub: &Hub) {
        let raw = hub.raw_changes(self.cursor, &self.id).await;
        if raw.status == StatusCode::GONE.as_u16() {
            self.bootstrap(hub).await;
            return;
        }
        assert_eq!(raw.status, 200, "unexpected pull failure: {:?}", raw.json);
        let res: ChangesResponse = serde_json::from_value(raw.json).unwrap();
        for entry in &res.ops {
            self.apply_incoming(&entry.op);
        }
        self.cursor = res.latest_seq;
    }

    pub async fn push(&mut self, hub: &Hub) -> Vec<OpResult> {
        // The bootstrap HARD GATE: a device that has not adopted hub state must never
        // push, however much it has queued. Its outline is by definition the stale one,
        // and its pre-configuration delete journal would arrive as thousands of
        // tombstones. Nothing is consumed — the queue is still there after the adopt.
        if !self.bootstrapped {
            return Vec::new();
        }
        let ops: Vec<WireOp> = self.outbox.values().map(|(_, op)| op.clone()).collect();
        if ops.is_empty() {
            return Vec::new();
        }
        self.send_push(hub, ops, false).await
    }

    /// The iPad's shape: every live node as an upsert, every journalled delete beside
    /// it. Idempotent by construction (T6).
    pub async fn push_full_state(&mut self, hub: &Hub) -> Vec<OpResult> {
        let mut ops: Vec<WireOp> = self
            .nodes
            .values()
            .cloned()
            .map(WireOp::upsert)
            .collect();
        ops.sort_by_key(|o| o.node_id());
        ops.extend(
            self.outbox
                .values()
                .filter(|(_, op)| op.is_delete())
                .map(|(_, op)| op.clone()),
        );
        self.send_push(hub, ops, false).await
    }

    pub async fn try_push(&mut self, hub: &Hub, confirm: bool) -> Raw {
        let ops: Vec<WireOp> = self.outbox.values().map(|(_, op)| op.clone()).collect();
        let body = serde_json::to_value(PushRequest {
            protocol_version: PROTOCOL_VERSION,
            device_id: self.id.clone(),
            ops,
        })
        .unwrap();
        let raw = hub.raw_push(&body, confirm).await;
        if raw.status == 200 {
            let res: PushResponse = serde_json::from_value(raw.json.clone()).unwrap();
            self.process_results(&res.results);
        }
        raw
    }

    async fn send_push(&mut self, hub: &Hub, ops: Vec<WireOp>, confirm: bool) -> Vec<OpResult> {
        let body = serde_json::to_value(PushRequest {
            protocol_version: PROTOCOL_VERSION,
            device_id: self.id.clone(),
            ops,
        })
        .unwrap();
        let raw = hub.raw_push(&body, confirm).await;
        assert_eq!(raw.status, 200, "unexpected push failure: {:?}", raw.json);
        let res: PushResponse = serde_json::from_value(raw.json).unwrap();
        self.process_results(&res.results);
        res.results
    }

    /// The rule both clients follow: EVERY op named in `results` leaves the outbox,
    /// whatever its outcome, and EVERY `current` is applied through the normal merge
    /// path. The first half is what stops a losing device re-pushing forever (T17); the
    /// second is what repairs it without a pull (T5, T12).
    fn process_results(&mut self, results: &[OpResult]) {
        for r in results {
            if let Some(seq) = self.outbox_index.remove(&r.id) {
                self.outbox.remove(&seq);
            }
            match &r.current {
                Some(Current::Node(n)) => self.apply_incoming(&WireOp::upsert((**n).clone())),
                Some(Current::Tombstone(t)) => self.apply_incoming(&WireOp::Delete {
                    id: t.id,
                    deleted_at: t.deleted_at,
                }),
                None => {}
            }
        }
    }

    /// Destructive bootstrap: adopt hub state wholesale, preserving incoming ids, and
    /// set the cursor in the same step. Nothing pending survives it — carrying a stale
    /// journal through would push thousands of junk tombstones on the first cycle.
    pub async fn bootstrap(&mut self, hub: &Hub) {
        let raw = hub.raw_snapshot().await;
        assert_eq!(raw.status, 200);
        let snap: SnapshotResponse = serde_json::from_value(raw.json).unwrap();
        self.nodes.clear();
        self.outbox.clear();
        self.outbox_index.clear();
        for n in snap.nodes {
            self.nodes.insert(n.id, n);
        }
        self.cursor = snap.latest_seq;
        self.bootstrapped = true;
    }

    fn apply_incoming(&mut self, op: &WireOp) {
        match op {
            WireOp::Upsert { node } => {
                let stored = match self.nodes.get(&node.id) {
                    Some(n) => Stored::live(n.clone()),
                    None => Stored::Missing,
                };
                let tree = LocalTree { nodes: &self.nodes };
                let m = merge_upsert(node, &stored, &tree, Side::Client);
                if let Some(w) = m.write {
                    self.nodes.insert(w.id, w);
                }
            }
            WireOp::Delete { id, deleted_at } => {
                let stored = match self.nodes.get(id) {
                    Some(n) => Stored::live(n.clone()),
                    None => Stored::Missing,
                };
                let m = merge_delete(*deleted_at, &stored);
                if m.write_tombstone.is_some() {
                    // A client keeps no tombstones of its own: the hub holds the
                    // authoritative one, and a local row that is simply absent loses
                    // nothing (an incoming upsert the hub itself resurrected SHOULD
                    // come back).
                    self.nodes.remove(id);
                }
            }
        }
    }

    // MARK: Inspection

    pub fn get(&self, id: Uuid) -> Option<&WireNode> {
        self.nodes.get(&id)
    }
    pub fn text(&self, id: Uuid) -> String {
        self.nodes
            .get(&id)
            .map(|n| n.text.clone())
            .unwrap_or_default()
    }
    pub fn parent_of(&self, id: Uuid) -> Option<Uuid> {
        self.nodes.get(&id).and_then(|n| n.parent)
    }
    pub fn position_of(&self, id: Uuid) -> i64 {
        self.nodes.get(&id).map(|n| n.position).unwrap_or(-1)
    }
    pub fn live_count(&self) -> usize {
        self.nodes.len()
    }
    pub fn outbox_is_empty(&self) -> bool {
        self.outbox.is_empty()
    }
    /// The delete journal is the delete half of the outbox.
    pub fn journal_is_empty(&self) -> bool {
        !self.outbox.values().any(|(_, op)| op.is_delete())
    }
    pub fn snapshot_texts(&self) -> BTreeMap<Uuid, String> {
        self.nodes
            .iter()
            .map(|(id, n)| (*id, n.text.clone()))
            .collect()
    }
    pub fn first_id(&self) -> Uuid {
        let mut ids: Vec<Uuid> = self.nodes.keys().copied().collect();
        ids.sort();
        ids[0]
    }

    pub fn has_cycle(&self) -> bool {
        for start in self.nodes.keys() {
            let mut seen = HashSet::from([*start]);
            let mut cur = self.nodes[start].parent;
            while let Some(p) = cur {
                if !seen.insert(p) {
                    return true;
                }
                cur = self.nodes.get(&p).and_then(|n| n.parent);
            }
        }
        false
    }

    fn local_descendants(&self, root: Uuid) -> Vec<Uuid> {
        let mut out = vec![root];
        let mut frontier = vec![root];
        let mut seen = HashSet::from([root]);
        while let Some(cur) = frontier.pop() {
            for (id, n) in &self.nodes {
                if n.parent == Some(cur) && seen.insert(*id) {
                    out.push(*id);
                    frontier.push(*id);
                }
            }
        }
        out
    }
}

struct LocalTree<'a> {
    nodes: &'a HashMap<Uuid, WireNode>,
}

impl TreeLookup for LocalTree<'_> {
    fn state(&self, id: Uuid) -> NodeState {
        match self.nodes.get(&id) {
            // A client keeps no tombstones, so "not here" is the only absence it knows.
            None => NodeState::Missing,
            Some(n) => NodeState::Live { parent: n.parent },
        }
    }
    fn max_root_position(&self) -> Option<i64> {
        self.nodes
            .values()
            .filter(|n| n.parent.is_none())
            .map(|n| n.position)
            .max()
    }
}

/// A bare wire node, for tests that want to hand-build one.
pub fn node(id: Uuid, text: &str, content: i64, structure: i64) -> WireNode {
    WireNode {
        id,
        parent: None,
        position: 0,
        text: text.into(),
        note: String::new(),
        kind: NodeKind::BulletPoint,
        is_completed: false,
        is_highlighted: false,
        bold_ranges: vec![],
        italic_ranges: vec![],
        underline_ranges: vec![],
        created_at: now_ms(),
        updated_at: content,
        structure_updated_at: structure,
        completed_at: None,
    }
}
