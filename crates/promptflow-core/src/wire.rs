//! The sync wire format — protocol v1.
//!
//! Deliberately a SEPARATE serialization from the `promptflow.outline` export format,
//! which stays byte-compatible with the SwiftUI app and whose seconds-precision ISO
//! dates are far too coarse for merge clocks. Nothing here may leak into `archive.rs`
//! and nothing there may leak into here.
//!
//! Forward compatibility: every type decodes with serde's default of IGNORING unknown
//! keys, so a newer peer may add fields without breaking an older one. Do not add
//! `deny_unknown_fields` anywhere in this module.

use crate::model::{NodeKind, NodeRec};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Bumped only on a BREAKING change. Requests carrying a different major version are
/// rejected 400; responses always state theirs.
pub const PROTOCOL_VERSION: u32 = 1;

/// The device id the hub uses for its own deterministic repairs (reparent-to-root,
/// cascade tombstones). Reserved: no real device may claim it, and `/v1/changes` never
/// filters it out — a repair triggered by device A's push must still reach A.
pub const SERVER_DEVICE_ID: &str = "server";

/// A node as it travels between devices and the hub.
///
/// `NodeRec`'s own serde output is NOT used: it carries `is_collapsed`, which is
/// per-window UI state in both apps and must never sync. Dates are ms-epoch integers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireNode {
    pub id: Uuid,
    /// `None` = a root node.
    pub parent: Option<Uuid>,
    pub position: i64,
    pub text: String,
    pub note: String,
    pub kind: NodeKind,
    pub is_completed: bool,
    pub is_highlighted: bool,
    #[serde(default)]
    pub bold_ranges: Vec<i64>,
    #[serde(default)]
    pub italic_ranges: Vec<i64>,
    #[serde(default)]
    pub underline_ranges: Vec<i64>,
    pub created_at: i64,
    /// Content clock: text, note, and the three style-range arrays.
    pub updated_at: i64,
    /// Structure clock: parent, position, kind, is_completed, completed_at,
    /// is_highlighted.
    pub structure_updated_at: i64,
    #[serde(default)]
    pub completed_at: Option<i64>,
}

impl WireNode {
    /// The larger of the two clocks — the "this node changed at all" instant, used by
    /// the resurrect test and the delete-vs-edit race.
    pub fn newest_clock(&self) -> i64 {
        self.updated_at.max(self.structure_updated_at)
    }

    /// Copy the CONTENT group (and its clock) out of `src`.
    pub fn take_content(&mut self, src: &WireNode) {
        self.text = src.text.clone();
        self.note = src.note.clone();
        self.bold_ranges = src.bold_ranges.clone();
        self.italic_ranges = src.italic_ranges.clone();
        self.underline_ranges = src.underline_ranges.clone();
        self.updated_at = src.updated_at;
    }

    /// Copy the STRUCTURE group (and its clock) out of `src`.
    pub fn take_structure(&mut self, src: &WireNode) {
        self.parent = src.parent;
        self.position = src.position;
        self.kind = src.kind;
        self.is_completed = src.is_completed;
        self.completed_at = src.completed_at;
        self.is_highlighted = src.is_highlighted;
        self.structure_updated_at = src.structure_updated_at;
    }
}

impl From<&NodeRec> for WireNode {
    fn from(r: &NodeRec) -> Self {
        WireNode {
            id: r.id,
            parent: r.parent,
            position: r.position,
            text: r.text.clone(),
            note: r.note.clone(),
            kind: r.kind,
            is_completed: r.is_completed,
            is_highlighted: r.is_highlighted,
            bold_ranges: r.bold_ranges.clone(),
            italic_ranges: r.italic_ranges.clone(),
            underline_ranges: r.underline_ranges.clone(),
            created_at: r.created_at,
            updated_at: r.updated_at,
            // A row written before the two-clock split reads back 0; the content clock
            // is the only history it has, so that is what the structure clock inherits.
            structure_updated_at: if r.structure_updated_at == 0 {
                r.updated_at
            } else {
                r.structure_updated_at
            },
            completed_at: r.completed_at,
        }
    }
}

impl From<&WireNode> for NodeRec {
    /// `is_collapsed` is not on the wire, so a node arriving from another device lands
    /// EXPANDED. That is the right default and not a loss: collapse is per-window state
    /// in this app, and the flag on `NodeRec` exists only to seed the export format.
    fn from(w: &WireNode) -> Self {
        NodeRec {
            id: w.id,
            parent: w.parent,
            position: w.position,
            text: w.text.clone(),
            note: w.note.clone(),
            kind: w.kind,
            is_completed: w.is_completed,
            is_highlighted: w.is_highlighted,
            is_collapsed: false,
            bold_ranges: w.bold_ranges.clone(),
            italic_ranges: w.italic_ranges.clone(),
            underline_ranges: w.underline_ranges.clone(),
            created_at: w.created_at,
            updated_at: w.updated_at,
            structure_updated_at: w.structure_updated_at,
            completed_at: w.completed_at,
        }
    }
}

/// Merge a wire node into an EXISTING local record, preserving the fields the wire
/// deliberately does not carry. Only `is_collapsed` qualifies today — a remote edit
/// must not silently expand a subtree the local window had folded in its export seed.
pub fn apply_wire_to_rec(w: &WireNode, existing: Option<&NodeRec>) -> NodeRec {
    let mut rec = NodeRec::from(w);
    if let Some(old) = existing {
        rec.is_collapsed = old.is_collapsed;
    }
    rec
}

// MARK: - Ops

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum WireOp {
    Upsert {
        node: Box<WireNode>,
    },
    #[serde(rename_all = "camelCase")]
    Delete {
        id: Uuid,
        deleted_at: i64,
    },
}

impl WireOp {
    pub fn upsert(node: WireNode) -> Self {
        WireOp::Upsert {
            node: Box::new(node),
        }
    }

    pub fn node_id(&self) -> Uuid {
        match self {
            WireOp::Upsert { node } => node.id,
            WireOp::Delete { id, .. } => *id,
        }
    }

    pub fn is_delete(&self) -> bool {
        matches!(self, WireOp::Delete { .. })
    }
}

/// Reorder a batch so a node is never applied before its parent, when both are in the
/// batch.
///
/// **This is not a nicety — without it a first sync shreds the outline.** Tree validation
/// repairs a node whose parent it cannot find by moving it to the ROOT, which is right
/// when the parent is genuinely gone and catastrophic when the parent is merely three
/// entries further down the same batch. Every producer of a batch has an order that is
/// arbitrary with respect to the tree: the desktop outbox sorts by `(queued_at, node_id)`
/// and a first-configuration seed stamps every row with ONE `queued_at`, so it degenerates
/// to uuid order; the iPad pushes an unordered SwiftData fetch; and `/v1/snapshot` returns
/// rows in whatever order SQLite hands back. Half a nested outline arriving child-first
/// ends up flat, on the hub and — because the repair does not move the structure clock —
/// on the device that sent it.
///
/// A stable partial sort, not a full topological one: an op moves only when something
/// else in the batch must precede it, so ordinary batches come out untouched and the
/// relative order of everything else (including deletes, and an upsert and delete of the
/// same node) is preserved. A parent chain that loops — only reachable from corrupted data
/// — falls out on the safety valve rather than spinning, and tree validation catches it.
pub fn order_parents_first(ops: &mut Vec<WireOp>) {
    use std::collections::{HashMap, HashSet};

    // Only UPSERTS can depend on anything: a delete names a node whose parent is
    // irrelevant to it.
    let parents: HashMap<Uuid, Uuid> = ops
        .iter()
        .filter_map(|op| match op {
            WireOp::Upsert { node } => node.parent.map(|p| (node.id, p)),
            _ => None,
        })
        .collect();
    let upserted: HashSet<Uuid> = ops
        .iter()
        .filter_map(|op| match op {
            WireOp::Upsert { node } => Some(node.id),
            _ => None,
        })
        .collect();
    // Nothing in this batch waits on anything else in it — the common case, and worth
    // detecting so an ordinary push does no work at all.
    if !parents
        .iter()
        .any(|(child, parent)| child != parent && upserted.contains(parent))
    {
        return;
    }

    let mut emitted: HashSet<Uuid> = HashSet::new();
    let mut out: Vec<WireOp> = Vec::with_capacity(ops.len());
    let mut pending: Vec<WireOp> = std::mem::take(ops);
    while !pending.is_empty() {
        let mut deferred = Vec::new();
        let mut progressed = false;
        for op in pending {
            let ready = match &op {
                WireOp::Upsert { node } => match node.parent {
                    Some(p) if p != node.id && upserted.contains(&p) => emitted.contains(&p),
                    _ => true,
                },
                WireOp::Delete { .. } => true,
            };
            if ready {
                emitted.insert(op.node_id());
                out.push(op);
                progressed = true;
            } else {
                deferred.push(op);
            }
        }
        if !progressed {
            // A cycle among the batch's own parents. Emit the rest in their original order
            // and let tree validation deal with it — that is exactly what it is for.
            out.extend(deferred);
            break;
        }
        pending = deferred;
    }
    *ops = out;
}

// MARK: - Per-op results

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    /// The stored row now IS what the client pushed. (Includes a redundant re-push of
    /// state the hub already held — nothing was written, but nothing disagrees either.)
    Applied,
    /// Some of what the client pushed survived and some did not: one clock group lost,
    /// or tree validation repaired the result. `current` always accompanies this.
    Partial,
    /// Nothing the client pushed was taken.
    Rejected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Reason {
    /// A stored edit is newer than the pushed op.
    Stale,
    /// A standing tombstone outlives the pushed node.
    Tombstone,
    /// Equal clocks: the hub is canonical, so the stored value stands.
    Tie,
    /// Clocks beyond `server_now + 24h` — a broken device clock.
    ClockSkew,
    /// Structurally impossible (a cycle, a self-parent).
    Invalid,
}

/// What the hub currently holds for a node, handed back so the pusher can re-converge
/// from the push response alone — no extra pull round-trip.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Current {
    Node(Box<WireNode>),
    Tombstone(TombstoneRef),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TombstoneRef {
    pub id: Uuid,
    pub deleted_at: i64,
}

impl Current {
    pub fn node(n: WireNode) -> Self {
        Current::Node(Box::new(n))
    }

    pub fn id(&self) -> Uuid {
        match self {
            Current::Node(n) => n.id,
            Current::Tombstone(t) => t.id,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpResult {
    pub id: Uuid,
    pub outcome: Outcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<Reason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<Current>,
}

// MARK: - Requests / responses

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushRequest {
    pub protocol_version: u32,
    pub device_id: String,
    pub ops: Vec<WireOp>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushResponse {
    pub protocol_version: u32,
    pub latest_seq: i64,
    pub results: Vec<OpResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeqOp {
    pub seq: i64,
    pub device_id: String,
    pub op: WireOp,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangesResponse {
    pub protocol_version: u32,
    pub ops: Vec<SeqOp>,
    pub latest_seq: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotResponse {
    pub protocol_version: u32,
    pub nodes: Vec<WireNode>,
    pub latest_seq: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceHealth {
    pub device_id: String,
    pub last_push_at: Option<i64>,
    pub last_pull_seq: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthResponse {
    pub protocol_version: u32,
    pub latest_seq: i64,
    pub live_nodes: i64,
    pub tombstones: i64,
    /// Seconds since the process started.
    pub uptime: i64,
    pub per_device: Vec<DeviceHealth>,
}

/// Every error the hub returns has this shape, so a client can show one message
/// whatever went wrong.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorResponse {
    pub protocol_version: u32,
    pub error: String,
    /// Present on 428: how many deletes the rejected batch carried, and the threshold
    /// it crossed, so the client's confirm affordance can state both.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deletes: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub threshold: Option<usize>,
}

/// Header a client sets exactly once, on an explicit user confirmation, to push a
/// batch the mass-delete tripwire refused. Clients NEVER set it automatically.
pub const CONFIRM_MASS_DELETE_HEADER: &str = "x-pf-confirm-mass-delete";

/// The tripwire: a push may not delete more than this without the confirm header.
pub fn mass_delete_threshold(live_nodes: usize) -> usize {
    50.max(live_nodes / 5)
}
