//! The canonical replica: nodes + tombstones + an append-only oplog, in one SQLite
//! file.
//!
//! Every endpoint below runs as ONE SQLite transaction. That is not an optimization —
//! it is the correctness property the protocol rests on:
//!   * a torn `/v1/snapshot` (state read at one instant, `latestSeq` at another) makes a
//!     bootstrapping client permanently skip whatever landed in between;
//!   * a torn `/v1/push` could tombstone a parent and lose its cascade, leaving orphans
//!     no later op ever mentions.
//!
//! Write model: one connection, WAL, serialized behind a mutex by the caller. Two
//! clients — correctness over throughput.

use promptflow_core::merge::{
    is_clock_absurd, merge_delete, merge_upsert, NodeState, Side, Stored, TreeLookup,
    MAX_FUTURE_SKEW_MS, WARN_SKEW_MS,
};
use promptflow_core::model::now_ms;
use promptflow_core::model::GAP;
use promptflow_core::wire::{
    mass_delete_threshold, order_parents_first, ChangesResponse, DeviceHealth, HealthResponse,
    OpResult,
    Outcome, PushRequest, PushResponse, Reason, SeqOp, SnapshotResponse, TombstoneRef, WireNode,
    WireOp, PROTOCOL_VERSION, SERVER_DEVICE_ID,
};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use std::collections::HashSet;
use uuid::Uuid;

/// The most oplog rows one `/v1/changes` will scan. A device that is further behind
/// than this pulls again immediately — see `changes()` for why the cursor still lands
/// correctly when the window truncates.
const MAX_CHANGES: usize = 2000;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS nodes (
  id           TEXT PRIMARY KEY,
  parent       TEXT,                    -- materialized so tree validation is one query
  position     INTEGER NOT NULL DEFAULT 0, -- materialized too: a repair needs max(root positions)
  deleted      INTEGER NOT NULL DEFAULT 0,
  deleted_at   INTEGER,
  content_at   INTEGER NOT NULL,        -- = the wire's updatedAt
  structure_at INTEGER NOT NULL,
  server_seq   INTEGER NOT NULL,        -- last oplog seq that touched this row
  payload      TEXT NOT NULL            -- full WireNode JSON, opaque (forward-compatible)
);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent);
CREATE TABLE IF NOT EXISTS oplog (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  node_id   TEXT NOT NULL,
  op        TEXT NOT NULL,              -- 'upsert' | 'delete'
  payload   TEXT NOT NULL,              -- WireNode JSON, or {id, deletedAt}
  server_ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
  device_id     TEXT PRIMARY KEY,
  last_push_at  INTEGER,
  last_pull_seq INTEGER
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
";

pub type HubResult<T> = Result<T, HubError>;

#[derive(Debug)]
pub enum HubError {
    Sqlite(rusqlite::Error),
    Json(serde_json::Error),
    /// The caller's cursor predates what the log still holds (or is ahead of it, which a
    /// hub restored from backup produces). Re-bootstrap from `/v1/snapshot`.
    Gone,
    /// The mass-delete tripwire: this many deletes, over this threshold.
    MassDelete { deletes: usize, threshold: usize },
    /// A protocol-level refusal the caller must fix, not retry.
    BadRequest(String),
}

impl From<rusqlite::Error> for HubError {
    fn from(e: rusqlite::Error) -> Self {
        HubError::Sqlite(e)
    }
}
impl From<serde_json::Error> for HubError {
    fn from(e: serde_json::Error) -> Self {
        HubError::Json(e)
    }
}

impl std::fmt::Display for HubError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HubError::Sqlite(e) => write!(f, "sqlite: {e}"),
            HubError::Json(e) => write!(f, "json: {e}"),
            HubError::Gone => write!(f, "cursor predates the retained oplog"),
            HubError::MassDelete { deletes, threshold } => {
                write!(f, "{deletes} deletes exceeds the {threshold} tripwire")
            }
            HubError::BadRequest(m) => write!(f, "{m}"),
        }
    }
}

pub struct Hub {
    conn: Connection,
    started_at: std::time::Instant,
}

impl Hub {
    pub fn open(path: &std::path::Path) -> HubResult<Hub> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| {
                HubError::BadRequest(format!("cannot create {}: {e}", dir.display()))
            })?;
        }
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    pub fn open_memory() -> HubResult<Hub> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> HubResult<Hub> {
        let _ = conn.pragma_update(None, "journal_mode", "WAL");
        let _ = conn.pragma_update(None, "synchronous", "NORMAL");
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        conn.execute_batch(SCHEMA)?;
        Ok(Hub {
            conn,
            started_at: std::time::Instant::now(),
        })
    }

    // MARK: - Reads

    /// Live nodes plus the sequence they are current as of, read in ONE transaction. A
    /// client bootstraps from this and then pulls `seq > latestSeq`; if the two halves
    /// came from different instants it would skip every op that landed between them,
    /// permanently.
    pub fn snapshot(&mut self) -> HubResult<SnapshotResponse> {
        let tx = self.conn.transaction()?;
        let nodes = {
            let mut stmt = tx.prepare("SELECT payload FROM nodes WHERE deleted = 0")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            let mut out = Vec::new();
            for r in rows {
                out.push(serde_json::from_str::<WireNode>(&r?)?);
            }
            // Parents first. A bootstrapping client applies these in one pass, and a child
            // ahead of its parent would be "repaired" to the root permanently — nothing
            // re-queues a node the client adopted from a snapshot.
            let mut ops: Vec<WireOp> = out.into_iter().map(WireOp::upsert).collect();
            order_parents_first(&mut ops);
            ops.into_iter()
                .filter_map(|op| match op {
                    WireOp::Upsert { node } => Some(*node),
                    _ => None,
                })
                .collect()
        };
        let latest_seq = latest_seq(&tx)?;
        tx.commit()?;
        Ok(SnapshotResponse {
            protocol_version: PROTOCOL_VERSION,
            nodes,
            latest_seq,
        })
    }

    /// Oplog entries after `since`, excluding the caller's own — but never excluding
    /// `"server"`, whose repairs and cascade tombstones exist precisely to reach the
    /// device whose push triggered them (T2, T3).
    pub fn changes(&mut self, since: i64, device: &str) -> HubResult<ChangesResponse> {
        if device == SERVER_DEVICE_ID {
            return Err(HubError::BadRequest(format!(
                "`{SERVER_DEVICE_ID}` is a reserved device id"
            )));
        }
        let tx = self.conn.transaction()?;
        let latest = latest_seq(&tx)?;
        let earliest: Option<i64> =
            tx.query_row("SELECT MIN(seq) FROM oplog", [], |r| r.get(0))?;
        // A cursor below the retained window, or above the log entirely (a hub restored
        // from backup), cannot be served incrementally.
        if let Some(min) = earliest {
            if since + 1 < min {
                return Err(HubError::Gone);
            }
        }
        if since > latest {
            return Err(HubError::Gone);
        }

        // The LIMIT is applied to the RAW range, before the caller's own ops are
        // filtered out, so `latest_seq` below can always name a sequence the caller has
        // now definitely considered. Filtering first and then limiting would let a long
        // run of the caller's own ops produce an empty page whose cursor could not
        // safely advance past them.
        let mut stmt = tx.prepare(
            "SELECT seq, device_id, op, payload FROM oplog WHERE seq > ?1 ORDER BY seq LIMIT ?2",
        )?;
        let rows: Vec<(i64, String, String, String)> = stmt
            .query_map(params![since, MAX_CHANGES as i64], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })?
            .collect::<Result<_, _>>()?;
        let truncated = rows.len() == MAX_CHANGES;
        let scanned_max = rows.last().map(|r| r.0).unwrap_or(since);

        let mut ops = Vec::new();
        for (seq, device_id, kind, payload) in rows {
            if device_id == device {
                continue;
            }
            let op = decode_op(&kind, &payload)?;
            ops.push(SeqOp {
                seq,
                device_id,
                op,
            });
        }
        drop(stmt);
        tx.execute(
            "INSERT INTO devices (device_id, last_pull_seq) VALUES (?1, ?2)
             ON CONFLICT(device_id) DO UPDATE SET last_pull_seq = excluded.last_pull_seq",
            params![device, scanned_max],
        )?;
        tx.commit()?;
        Ok(ChangesResponse {
            protocol_version: PROTOCOL_VERSION,
            ops,
            // When the window truncated, this names the last sequence actually scanned —
            // the client advances there and comes straight back for the rest.
            latest_seq: if truncated { scanned_max } else { latest },
        })
    }

    pub fn health(&self) -> HubResult<HealthResponse> {
        let latest_seq = latest_seq(&self.conn)?;
        let live_nodes: i64 =
            self.conn
                .query_row("SELECT COUNT(*) FROM nodes WHERE deleted = 0", [], |r| {
                    r.get(0)
                })?;
        let tombstones: i64 =
            self.conn
                .query_row("SELECT COUNT(*) FROM nodes WHERE deleted = 1", [], |r| {
                    r.get(0)
                })?;
        let mut stmt = self
            .conn
            .prepare("SELECT device_id, last_push_at, last_pull_seq FROM devices ORDER BY device_id")?;
        let per_device = stmt
            .query_map([], |r| {
                Ok(DeviceHealth {
                    device_id: r.get(0)?,
                    last_push_at: r.get(1)?,
                    last_pull_seq: r.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(HealthResponse {
            protocol_version: PROTOCOL_VERSION,
            latest_seq,
            live_nodes,
            tombstones,
            uptime: self.started_at.elapsed().as_secs() as i64,
            per_device,
        })
    }

    // MARK: - Push

    /// Merge a device's ops. ONE transaction: either every op in the batch lands with
    /// its repairs and cascades, or none does.
    pub fn push(&mut self, req: &PushRequest, confirm_mass_delete: bool) -> HubResult<PushResponse> {
        if req.device_id.is_empty() {
            return Err(HubError::BadRequest("deviceId is required".into()));
        }
        if req.device_id == SERVER_DEVICE_ID {
            return Err(HubError::BadRequest(format!(
                "`{SERVER_DEVICE_ID}` is a reserved device id"
            )));
        }

        let live_nodes: usize =
            self.conn
                .query_row("SELECT COUNT(*) FROM nodes WHERE deleted = 0", [], |r| {
                    r.get::<_, i64>(0)
                })? as usize;
        let deletes = req.ops.iter().filter(|o| o.is_delete()).count();
        let threshold = mass_delete_threshold(live_nodes);
        // The tripwire is checked BEFORE the transaction opens, so a refused batch
        // leaves no trace at all. Clients never set the confirm header on their own —
        // it is an explicit user action in each app's sync-error UI.
        if deletes > threshold && !confirm_mass_delete {
            return Err(HubError::MassDelete { deletes, threshold });
        }

        let now = now_ms();
        // Parents before children, ALWAYS. Every client's batch order is arbitrary with
        // respect to the tree (a uuid-ordered outbox, an unordered SwiftData fetch), and a
        // child applied first finds no parent, gets "repaired" to the root, and — because
        // the repair does not move its structure clock — is adopted as flat by the very
        // device that sent it. Ordering here fixes every client at once.
        let mut ops = req.ops.clone();
        order_parents_first(&mut ops);

        let tx = self.conn.transaction()?;
        // Results are reported in the order the CLIENT sent them, not the order they were
        // applied: a client matches them against its own outbox by id, and handing back a
        // reshuffled list would be a gratuitous way to get that wrong.
        let mut by_id: std::collections::HashMap<Uuid, OpResult> = std::collections::HashMap::new();
        for op in &ops {
            let r = apply_op(&tx, &req.device_id, op, now)?;
            by_id.insert(r.id, r);
        }
        let mut results = Vec::with_capacity(req.ops.len());
        for op in &req.ops {
            if let Some(r) = by_id.remove(&op.node_id()) {
                results.push(r);
            }
        }
        tx.execute(
            "INSERT INTO devices (device_id, last_push_at) VALUES (?1, ?2)
             ON CONFLICT(device_id) DO UPDATE SET last_push_at = excluded.last_push_at",
            params![req.device_id, now],
        )?;
        let latest_seq = latest_seq(&tx)?;
        tx.commit()?;
        Ok(PushResponse {
            protocol_version: PROTOCOL_VERSION,
            latest_seq,
            results,
        })
    }
}

// MARK: - One op

fn apply_op(tx: &Transaction, device: &str, op: &WireOp, now: i64) -> HubResult<OpResult> {
    match op {
        WireOp::Upsert { node } => apply_upsert(tx, device, node, now),
        WireOp::Delete { id, deleted_at } => apply_delete(tx, device, *id, *deleted_at, now),
    }
}

fn apply_upsert(tx: &Transaction, device: &str, node: &WireNode, now: i64) -> HubResult<OpResult> {
    if let Some(res) = clock_guard(node.id, node.newest_clock(), now) {
        return Ok(res);
    }
    let stored = read_stored(tx, node.id)?;
    let tree = TxTree { tx };
    let m = merge_upsert(node, &stored, &tree, Side::Hub);

    if let Some(write) = &m.write {
        // A row the hub had to change is filed under the RESERVED device id, so
        // `/v1/changes` never filters it out of the pusher's own pull. The pusher
        // already learns from `current` in this very response; the oplog entry is what
        // makes the repair survive a client that crashed before reading it.
        let author = if write == node { device } else { SERVER_DEVICE_ID };
        let seq = append_oplog(tx, author, write.id, "upsert", &serde_json::to_string(write)?, now)?;
        put_node(tx, write, seq)?;
    }
    Ok(OpResult {
        id: node.id,
        outcome: m.outcome,
        reason: m.reason,
        current: m.current,
    })
}

fn apply_delete(
    tx: &Transaction,
    device: &str,
    id: Uuid,
    deleted_at: i64,
    now: i64,
) -> HubResult<OpResult> {
    if let Some(res) = clock_guard(id, deleted_at, now) {
        return Ok(res);
    }
    let stored = read_stored(tx, id)?;
    let m = merge_delete(deleted_at, &stored, Side::Hub);

    if let Some(at) = m.write_tombstone {
        let seq = append_oplog(tx, device, id, "delete", &tombstone_json(id, at)?, now)?;
        put_tombstone(tx, id, at, seq)?;

        if m.cascade {
            // The pusher computed its delete set from its own replica, so it cannot know
            // about children another device created under this node. Each cascade
            // tombstone is its own oplog entry under `"server"` — which is exactly what
            // makes it reach the pusher, whose own ops its pull filters out (T3).
            //
            // Each child is WEIGHED, not simply asserted dead. A cascade stamps the
            // PARENT's `deletedAt` onto clocks it never compared against, so a child
            // edited after the delete was made would be tombstoned here and then REFUSED
            // by every client's own merge — leaving it dead on the hub and alive on the
            // devices, parented to a node that no longer exists, invisible in the outline
            // and irrecoverable. A child that outlives the delete is re-rooted instead, so
            // no live node is ever left under a tombstone.
            for child in live_descendants(tx, id)? {
                let stored = read_stored(tx, child)?;
                let decision = merge_delete(at, &stored, Side::Hub);
                if decision.write_tombstone.is_some() {
                    let seq = append_oplog(
                        tx,
                        SERVER_DEVICE_ID,
                        child,
                        "delete",
                        &tombstone_json(child, at)?,
                        now,
                    )?;
                    put_tombstone(tx, child, at, seq)?;
                } else if let Stored::Live(live) = stored {
                    let mut rescued = (*live).clone();
                    rescued.parent = None;
                    rescued.position = TxTree { tx }.max_root_position().map_or(0, |m| m + GAP);
                    // The clock has to MOVE, or the rescue loses to the very replica it is
                    // correcting: every device still holds this child under the dead
                    // parent at exactly the clock the payload would carry.
                    rescued.structure_updated_at = at.max(rescued.structure_updated_at) + 1;
                    let seq = append_oplog(
                        tx,
                        SERVER_DEVICE_ID,
                        child,
                        "upsert",
                        &serde_json::to_string(&rescued)?,
                        now,
                    )?;
                    put_node(tx, &rescued, seq)?;
                }
            }
        }
    }
    Ok(OpResult {
        id,
        outcome: m.outcome,
        reason: m.reason,
        current: m.current,
    })
}

/// A clock far enough in the future to be a broken device clock rather than drift is
/// refused PER OP — the rest of the batch still applies (T10). No clamping: silently
/// rewriting the value would leave the client and the hub disagreeing about what was
/// stored, with nothing in the response to say so.
fn clock_guard(id: Uuid, clock: i64, now: i64) -> Option<OpResult> {
    if is_clock_absurd(clock, now) {
        tracing::warn!(
            node = %id,
            skew_ms = clock - now,
            "rejecting op: clock more than {}h in the future",
            MAX_FUTURE_SKEW_MS / 3_600_000
        );
        return Some(OpResult {
            id,
            outcome: Outcome::Rejected,
            reason: Some(Reason::ClockSkew),
            current: None,
        });
    }
    if clock > now + WARN_SKEW_MS {
        tracing::warn!(node = %id, skew_ms = clock - now, "op clock is ahead of the hub");
    }
    None
}

// MARK: - Row access

fn read_stored(tx: &Transaction, id: Uuid) -> HubResult<Stored> {
    let row: Option<(i64, Option<i64>, String)> = tx
        .query_row(
            "SELECT deleted, deleted_at, payload FROM nodes WHERE id = ?1",
            params![id.to_string()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    Ok(match row {
        None => Stored::Missing,
        Some((1, deleted_at, _)) => Stored::Tombstone {
            deleted_at: deleted_at.unwrap_or(0),
        },
        Some((_, _, payload)) => Stored::live(serde_json::from_str(&payload)?),
    })
}

fn put_node(tx: &Transaction, n: &WireNode, seq: i64) -> HubResult<()> {
    tx.execute(
        "INSERT INTO nodes (id, parent, position, deleted, deleted_at, content_at, structure_at, server_seq, payload)
         VALUES (?1, ?2, ?3, 0, NULL, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET
           parent=excluded.parent, position=excluded.position, deleted=0, deleted_at=NULL,
           content_at=excluded.content_at, structure_at=excluded.structure_at,
           server_seq=excluded.server_seq, payload=excluded.payload",
        params![
            n.id.to_string(),
            n.parent.map(|p| p.to_string()),
            n.position,
            n.updated_at,
            n.structure_updated_at,
            seq,
            serde_json::to_string(n)?
        ],
    )?;
    Ok(())
}

fn put_tombstone(tx: &Transaction, id: Uuid, deleted_at: i64, seq: i64) -> HubResult<()> {
    // A tombstone keeps whatever the row last carried — its payload and its parent. The
    // merge never reads either, but they are the only record of what died and where it
    // lived, and a delete that arrived before its node ever did gets an empty one.
    // Crucially the CHILDREN's parent column is untouched, which is what lets the
    // cascade below walk a subtree whose root is already dead.
    tx.execute(
        "INSERT INTO nodes (id, parent, position, deleted, deleted_at, content_at, structure_at, server_seq, payload)
         VALUES (?1, NULL, 0, 1, ?2, 0, 0, ?3, '{}')
         ON CONFLICT(id) DO UPDATE SET
           deleted=1, deleted_at=excluded.deleted_at, server_seq=excluded.server_seq",
        params![id.to_string(), deleted_at, seq],
    )?;
    Ok(())
}

/// Every currently-live node under `root`, root excluded. Breadth-first over the
/// materialized `parent` column, cycle-guarded because imported data can be malformed.
fn live_descendants(tx: &Transaction, root: Uuid) -> HubResult<Vec<Uuid>> {
    let mut out = Vec::new();
    let mut seen: HashSet<Uuid> = HashSet::from([root]);
    let mut frontier = vec![root];
    let mut stmt = tx.prepare("SELECT id FROM nodes WHERE parent = ?1 AND deleted = 0")?;
    while let Some(cur) = frontier.pop() {
        let kids: Vec<Uuid> = stmt
            .query_map(params![cur.to_string()], |r| r.get::<_, String>(0))?
            .filter_map(|s| s.ok().and_then(|s| Uuid::parse_str(&s).ok()))
            .collect();
        for k in kids {
            if seen.insert(k) {
                out.push(k);
                frontier.push(k);
            }
        }
    }
    Ok(out)
}

fn append_oplog(
    tx: &Transaction,
    device: &str,
    node: Uuid,
    op: &str,
    payload: &str,
    now: i64,
) -> HubResult<i64> {
    tx.execute(
        "INSERT INTO oplog (device_id, node_id, op, payload, server_ts)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![device, node.to_string(), op, payload, now],
    )?;
    Ok(tx.last_insert_rowid())
}

fn tombstone_json(id: Uuid, deleted_at: i64) -> HubResult<String> {
    Ok(serde_json::to_string(&TombstoneRef { id, deleted_at })?)
}

fn decode_op(kind: &str, payload: &str) -> HubResult<WireOp> {
    Ok(match kind {
        "delete" => {
            let t: TombstoneRef = serde_json::from_str(payload)?;
            WireOp::Delete {
                id: t.id,
                deleted_at: t.deleted_at,
            }
        }
        _ => WireOp::upsert(serde_json::from_str(payload)?),
    })
}

fn latest_seq(conn: &rusqlite::Connection) -> HubResult<i64> {
    Ok(conn.query_row("SELECT COALESCE(MAX(seq), 0) FROM oplog", [], |r| r.get(0))?)
}

/// Tree validation reads through the SAME transaction the push is writing in, so a node
/// repaired earlier in a batch is visible to the next one — two orphans in one push get
/// two different root positions rather than colliding.
struct TxTree<'a, 'b> {
    tx: &'a Transaction<'b>,
}

impl TreeLookup for TxTree<'_, '_> {
    fn state(&self, id: Uuid) -> NodeState {
        let row: Option<(i64, Option<String>)> = self
            .tx
            .query_row(
                "SELECT deleted, parent FROM nodes WHERE id = ?1",
                params![id.to_string()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .unwrap_or(None);
        match row {
            None => NodeState::Missing,
            Some((1, _)) => NodeState::Deleted,
            Some((_, parent)) => NodeState::Live {
                parent: parent.and_then(|p| Uuid::parse_str(&p).ok()),
            },
        }
    }

    fn max_root_position(&self) -> Option<i64> {
        self.tx
            .query_row(
                "SELECT MAX(position) FROM nodes WHERE deleted = 0 AND parent IS NULL",
                [],
                |r| r.get::<_, Option<i64>>(0),
            )
            .unwrap_or(None)
    }
}
