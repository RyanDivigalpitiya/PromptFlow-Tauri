use crate::model::{now_ms, NodeKind, NodeRec};
use promptflow_core::wire::{TombstoneRef, WireNode, WireOp};
use rusqlite::{params, Connection};
use std::collections::HashMap;
use uuid::Uuid;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS nodes (
  id            TEXT PRIMARY KEY,
  parent        TEXT,
  position      INTEGER NOT NULL,
  text          TEXT NOT NULL,
  note          TEXT NOT NULL DEFAULT '',
  kind          TEXT NOT NULL,
  is_completed  INTEGER NOT NULL DEFAULT 0,
  is_highlighted INTEGER NOT NULL DEFAULT 0,
  is_collapsed  INTEGER NOT NULL DEFAULT 0,
  bold_ranges   TEXT NOT NULL DEFAULT '[]',
  italic_ranges TEXT NOT NULL DEFAULT '[]',
  underline_ranges TEXT NOT NULL DEFAULT '[]',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  structure_updated_at INTEGER NOT NULL DEFAULT 0,
  completed_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- The sync outbox. It lives in the SAME database as the nodes precisely so a row can be
-- queued inside the very transaction that persists the change it describes: split across
-- two files, a crash between them would either lose an edit's sync forever or queue one
-- that never happened. Coalesced per node by the primary key — the latest image wins, and
-- a delete replaces a queued upsert (and an upsert a queued delete, which is what an
-- undone deletion is).
CREATE TABLE IF NOT EXISTS outbox (
  node_id   TEXT PRIMARY KEY,
  op        TEXT NOT NULL,    -- 'upsert' | 'delete'
  payload   TEXT NOT NULL,    -- WireNode JSON, or {id, deletedAt}
  queued_at INTEGER NOT NULL  -- guards the clear: a row re-queued since we read it stays
);
";

pub fn open(path: &std::path::Path) -> Result<Connection, String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let db = Connection::open(path).map_err(|e| e.to_string())?;
    init(&db)?;
    Ok(db)
}

#[cfg(test)]
pub fn open_in_memory() -> Result<Connection, String> {
    let db = Connection::open_in_memory().map_err(|e| e.to_string())?;
    init(&db)?;
    Ok(db)
}

fn init(db: &Connection) -> Result<(), String> {
    // WAL keeps per-keystroke upserts cheap and lets reads (none today) proceed during writes.
    let _ = db.pragma_update(None, "journal_mode", "WAL");
    let _ = db.pragma_update(None, "synchronous", "NORMAL");
    db.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
    // Migrate stores created before italic/underline existed. ALTER errors mean the
    // column is already there (fresh stores get it from SCHEMA) — ignore them.
    for col in ["italic_ranges", "underline_ranges"] {
        let _ = db.execute(
            &format!("ALTER TABLE nodes ADD COLUMN {col} TEXT NOT NULL DEFAULT '[]'"),
            [],
        );
    }
    // Same idempotent-ALTER shape for the sync structure clock. Rows written before the
    // two-clock split have only one history, so they inherit it: the backfill runs once
    // (its WHERE clause makes a second run a no-op) and `load_all` normalizes any 0 it
    // still reads back, so a row can never present a 1970 structure clock and lose every
    // merge it takes part in.
    let _ = db.execute(
        "ALTER TABLE nodes ADD COLUMN structure_updated_at INTEGER NOT NULL DEFAULT 0",
        [],
    );
    let _ = db.execute(
        "UPDATE nodes SET structure_updated_at = updated_at WHERE structure_updated_at = 0",
        [],
    );
    Ok(())
}

pub fn load_all(db: &Connection) -> Result<HashMap<Uuid, NodeRec>, String> {
    let mut stmt = db
        .prepare("SELECT id, parent, position, text, note, kind, is_completed, is_highlighted, is_collapsed, bold_ranges, italic_ranges, underline_ranges, created_at, updated_at, completed_at, structure_updated_at FROM nodes")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let id: String = row.get(0)?;
            let parent: Option<String> = row.get(1)?;
            let bold_json: String = row.get(9)?;
            let italic_json: String = row.get(10)?;
            let underline_json: String = row.get(11)?;
            let updated_at: i64 = row.get(13)?;
            // A 0 here is a row the backfill never reached (a store restored from a
            // pre-migration backup, say). The content clock is the only history it has.
            let structure_updated_at = match row.get::<_, i64>(15)? {
                0 => updated_at,
                s => s,
            };
            Ok(NodeRec {
                id: Uuid::parse_str(&id).unwrap_or_default(),
                parent: parent.and_then(|p| Uuid::parse_str(&p).ok()),
                position: row.get(2)?,
                text: row.get(3)?,
                note: row.get(4)?,
                kind: NodeKind::from_raw(&row.get::<_, String>(5)?),
                is_completed: row.get::<_, i64>(6)? != 0,
                is_highlighted: row.get::<_, i64>(7)? != 0,
                is_collapsed: row.get::<_, i64>(8)? != 0,
                bold_ranges: serde_json::from_str(&bold_json).unwrap_or_default(),
                italic_ranges: serde_json::from_str(&italic_json).unwrap_or_default(),
                underline_ranges: serde_json::from_str(&underline_json).unwrap_or_default(),
                created_at: row.get(12)?,
                updated_at,
                structure_updated_at,
                completed_at: row.get(14)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = HashMap::new();
    for r in rows {
        let rec = r.map_err(|e| e.to_string())?;
        out.insert(rec.id, rec);
    }
    Ok(out)
}

/// Everything one store commit writes, so it can all land in ONE SQLite transaction.
///
/// The point is the outbox: a local edit and the sync row describing it MUST commit
/// together. Written afterwards, a crash in between loses the edit's sync silently and
/// forever (nothing later re-derives it); written first, a failed node write leaves a
/// queued op for a change that never happened.
pub struct ApplyPlan<'a> {
    /// `Some(rec)` upserts, `None` deletes.
    pub changes: Vec<(Uuid, Option<&'a NodeRec>)>,
    /// Queue these changes for the hub. LOCAL mutations do; a remote apply does not —
    /// echoing back what the hub just told us is the definition of a sync loop.
    pub enqueue: bool,
    /// Queue DELETES even when `enqueue` is off — the configured-but-disabled store's
    /// tombstone journal (see `ApplyPlan::local`).
    pub journal_deletes: bool,
    /// Settings written in the same transaction. The sync CURSOR is the one that
    /// matters: advanced separately from the ops it covers, a crash between them either
    /// replays ops (harmless — they merge idempotently) or SKIPS them (silent data
    /// loss). Only the first of those is acceptable, so the cursor moves with the apply.
    pub settings: Vec<(String, String)>,
    /// Outbox rows to clear, each guarded by the `queued_at` it carried when the pusher
    /// read it: a row the user re-queued mid-flight is left alone rather than dropped.
    pub clear_outbox: Vec<(Uuid, i64)>,
}

impl<'a> ApplyPlan<'a> {
    /// The ordinary local-mutation plan. `journal_deletes` queues TOMBSTONES even when
    /// `enqueue` is off: a configured-but-disabled store must remember what stopped
    /// existing, or re-enabling sync re-offers every live node while the hub keeps the
    /// deleted ones alive and the next pull resurrects them — for an import that
    /// replaced the whole outline, that is the entire old world coming back (the
    /// 2026-08-12 chimera). Upserts need no journal: `enqueue_all_live` re-offers them
    /// wholesale on re-enable, and its ON CONFLICT upsert also clears any stale
    /// tombstone row for a node that was deleted and then restored while off.
    pub fn local(
        changes: Vec<(Uuid, Option<&'a NodeRec>)>,
        enqueue: bool,
        journal_deletes: bool,
    ) -> Self {
        ApplyPlan {
            changes,
            enqueue,
            journal_deletes,
            settings: Vec::new(),
            clear_outbox: Vec::new(),
        }
    }
}

pub fn apply_plan(db: &mut Connection, plan: ApplyPlan<'_>) -> Result<(), String> {
    let queued_at = now_ms();
    let tx = db.transaction().map_err(|e| e.to_string())?;
    {
        let mut upsert = tx
            .prepare_cached(
                "INSERT INTO nodes (id, parent, position, text, note, kind, is_completed, is_highlighted, is_collapsed, bold_ranges, italic_ranges, underline_ranges, created_at, updated_at, completed_at, structure_updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
                 ON CONFLICT(id) DO UPDATE SET
                   parent=excluded.parent, position=excluded.position, text=excluded.text,
                   note=excluded.note, kind=excluded.kind, is_completed=excluded.is_completed,
                   is_highlighted=excluded.is_highlighted, is_collapsed=excluded.is_collapsed,
                   bold_ranges=excluded.bold_ranges, italic_ranges=excluded.italic_ranges,
                   underline_ranges=excluded.underline_ranges, created_at=excluded.created_at,
                   updated_at=excluded.updated_at, completed_at=excluded.completed_at,
                   structure_updated_at=excluded.structure_updated_at",
            )
            .map_err(|e| e.to_string())?;
        let mut delete = tx
            .prepare_cached("DELETE FROM nodes WHERE id = ?1")
            .map_err(|e| e.to_string())?;
        let mut enqueue = tx
            .prepare_cached(
                "INSERT INTO outbox (node_id, op, payload, queued_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(node_id) DO UPDATE SET
                   op=excluded.op, payload=excluded.payload, queued_at=excluded.queued_at",
            )
            .map_err(|e| e.to_string())?;
        for (id, rec) in &plan.changes {
            let (id, rec) = (*id, *rec);
            match rec {
                Some(r) => {
                    upsert
                        .execute(params![
                            r.id.to_string(),
                            r.parent.map(|p| p.to_string()),
                            r.position,
                            r.text,
                            r.note,
                            r.kind.raw(),
                            r.is_completed as i64,
                            r.is_highlighted as i64,
                            r.is_collapsed as i64,
                            serde_json::to_string(&r.bold_ranges).unwrap_or_else(|_| "[]".into()),
                            serde_json::to_string(&r.italic_ranges).unwrap_or_else(|_| "[]".into()),
                            serde_json::to_string(&r.underline_ranges).unwrap_or_else(|_| "[]".into()),
                            r.created_at,
                            r.updated_at,
                            r.completed_at,
                            r.structure_updated_at,
                        ])
                        .map_err(|e| e.to_string())?;
                }
                None => {
                    delete
                        .execute(params![id.to_string()])
                        .map_err(|e| e.to_string())?;
                }
            }
            if plan.enqueue || (plan.journal_deletes && rec.is_none()) {
                let (op, payload) = match rec {
                    Some(r) => (
                        "upsert",
                        serde_json::to_string(&WireNode::from(r)).map_err(|e| e.to_string())?,
                    ),
                    // `deletedAt` is stamped at ENQUEUE, not at push: the instant the
                    // user deleted is what the hub weighs against a concurrent edit, and
                    // an offline device might not push for hours.
                    None => (
                        "delete",
                        serde_json::to_string(&TombstoneRef {
                            id,
                            deleted_at: queued_at,
                        })
                        .map_err(|e| e.to_string())?,
                    ),
                };
                enqueue
                    .execute(params![id.to_string(), op, payload, queued_at])
                    .map_err(|e| e.to_string())?;
            }
        }

        let mut setting = tx
            .prepare_cached(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            )
            .map_err(|e| e.to_string())?;
        for (k, v) in &plan.settings {
            setting
                .execute(params![k, v])
                .map_err(|e| e.to_string())?;
        }

        let mut clear = tx
            .prepare_cached("DELETE FROM outbox WHERE node_id = ?1 AND queued_at <= ?2")
            .map_err(|e| e.to_string())?;
        for (id, at) in &plan.clear_outbox {
            clear
                .execute(params![id.to_string(), at])
                .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())
}

/// One queued op, as the sync loop reads it.
pub struct OutboxRow {
    pub node_id: Uuid,
    pub op: WireOp,
    pub queued_at: i64,
}

pub fn outbox_batch(db: &Connection, limit: usize) -> Result<Vec<OutboxRow>, String> {
    let mut stmt = db
        .prepare("SELECT node_id, op, payload, queued_at FROM outbox ORDER BY queued_at, node_id LIMIT ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![limit as i64], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let (id, kind, payload, queued_at) = row.map_err(|e| e.to_string())?;
        let node_id = Uuid::parse_str(&id).map_err(|e| e.to_string())?;
        let op = if kind == "delete" {
            let t: TombstoneRef = serde_json::from_str(&payload).map_err(|e| e.to_string())?;
            WireOp::Delete {
                id: t.id,
                deleted_at: t.deleted_at,
            }
        } else {
            WireOp::upsert(serde_json::from_str(&payload).map_err(|e| e.to_string())?)
        };
        out.push(OutboxRow {
            node_id,
            op,
            queued_at,
        });
    }
    Ok(out)
}

/// Nodes this device has deleted but not yet pushed, and when.
///
/// The outbox IS the desktop client's tombstone record — it keeps no others. A pull runs
/// BEFORE the push in every cycle, so without this a pulled upsert re-inserts a node the
/// user just deleted, and it sits there visibly alive until the next cycle brings the
/// hub's own tombstone back. Reading these as local tombstones lets the ordinary merge
/// rule decide instead: an incoming edit older than the delete loses, a newer one
/// legitimately resurrects.
pub fn pending_deletes(db: &Connection) -> Result<HashMap<Uuid, i64>, String> {
    let mut stmt = db
        .prepare("SELECT node_id, payload FROM outbox WHERE op = 'delete'")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    let mut out = HashMap::new();
    for row in rows {
        let (id, payload) = row.map_err(|e| e.to_string())?;
        if let (Ok(id), Ok(t)) = (
            Uuid::parse_str(&id),
            serde_json::from_str::<TombstoneRef>(&payload),
        ) {
            out.insert(id, t.deleted_at);
        }
    }
    Ok(out)
}

pub fn outbox_count(db: &Connection) -> i64 {
    db.query_row("SELECT COUNT(*) FROM outbox", [], |r| r.get(0))
        .unwrap_or(0)
}

/// Every node id with a pending outbox UPSERT — what the pusher's batch deferral
/// weighs a drained batch against (see `plan_push` in sync.rs). Deletes are excluded:
/// waiting on a parent that is queued to DIE would defer the child for nothing the
/// hub's cascade doesn't already decide.
pub fn outbox_pending_ids(db: &Connection) -> Result<std::collections::HashSet<Uuid>, String> {
    let mut stmt = db
        .prepare("SELECT node_id FROM outbox WHERE op = 'upsert'")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut out = std::collections::HashSet::new();
    for r in rows {
        if let Ok(Ok(id)) = r.map(|s| s.parse()) {
            out.insert(id);
        }
    }
    Ok(out)
}

/// How many DELETES are pending — what the mass-delete confirmation has to state.
pub fn outbox_delete_count(db: &Connection) -> i64 {
    db.query_row(
        "SELECT COUNT(*) FROM outbox WHERE op = 'delete'",
        [],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

/// First-configuration seeding: queue EVERY live node in one transaction. Without it
/// the outbox would only ever carry post-configuration edits, and the hub would start
/// empty forever while the Mac believed it was syncing (test T16).
pub fn enqueue_all_live(db: &mut Connection, nodes: &HashMap<Uuid, NodeRec>) -> Result<usize, String> {
    // PRE-ORDER, with queued_at increasing per row, so the outbox drains parents before
    // children ACROSS push batches. A single queued_at drained ORDER BY (queued_at,
    // node_id) is uuid order, and the hub's parents-first reorder only works WITHIN one
    // request — on the 2026-08-12 seed that stranded ~167 children whose parents sat in
    // the next batch, and the hub's orphan repair promoted every one of them to root,
    // permanently (the repair keeps the structure clock, so the flat version wins every
    // later tie). Ordering the queue is the fix at the source; sync.rs's batch deferral
    // is the belt for edits queued in arbitrary order later.
    let queued_at = now_ms();
    let mut ordered: Vec<&NodeRec> = Vec::with_capacity(nodes.len());
    {
        let mut children: HashMap<Option<Uuid>, Vec<&NodeRec>> = HashMap::new();
        for rec in nodes.values() {
            // A parent id that isn't in the live set walks as a root — unreachable
            // nodes still ship rather than silently dropping from the seed.
            let key = rec.parent.filter(|p| nodes.contains_key(p));
            children.entry(key).or_default().push(rec);
        }
        for v in children.values_mut() {
            v.sort_by_key(|r| (r.position, r.id));
        }
        let mut stack: Vec<&NodeRec> = children.remove(&None).unwrap_or_default();
        stack.reverse();
        while let Some(rec) = stack.pop() {
            ordered.push(rec);
            if let Some(mut kids) = children.remove(&Some(rec.id)) {
                kids.reverse();
                stack.append(&mut kids);
            }
        }
        // A cycle (corrupted data) leaves rows unreachable from any root; append them
        // rather than lose them — the hub's validation is the judge of what they are.
        let seen: std::collections::HashSet<Uuid> = ordered.iter().map(|r| r.id).collect();
        for rec in nodes.values() {
            if !seen.contains(&rec.id) {
                ordered.push(rec);
            }
        }
    }
    let tx = db.transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare_cached(
                "INSERT INTO outbox (node_id, op, payload, queued_at) VALUES (?1, 'upsert', ?2, ?3)
                 ON CONFLICT(node_id) DO UPDATE SET
                   op='upsert', payload=excluded.payload, queued_at=excluded.queued_at",
            )
            .map_err(|e| e.to_string())?;
        for (i, rec) in ordered.iter().enumerate() {
            let payload =
                serde_json::to_string(&WireNode::from(*rec)).map_err(|e| e.to_string())?;
            stmt.execute(params![rec.id.to_string(), payload, queued_at + i as i64])
                .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(nodes.len())
}
