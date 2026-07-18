use crate::model::{NodeKind, NodeRec};
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
  completed_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
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
    Ok(())
}

pub fn load_all(db: &Connection) -> Result<HashMap<Uuid, NodeRec>, String> {
    let mut stmt = db
        .prepare("SELECT id, parent, position, text, note, kind, is_completed, is_highlighted, is_collapsed, bold_ranges, italic_ranges, underline_ranges, created_at, updated_at, completed_at FROM nodes")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let id: String = row.get(0)?;
            let parent: Option<String> = row.get(1)?;
            let bold_json: String = row.get(9)?;
            let italic_json: String = row.get(10)?;
            let underline_json: String = row.get(11)?;
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
                updated_at: row.get(13)?,
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

/// Apply a mutation's changed rows in ONE SQLite transaction: `Some(rec)` upserts,
/// `None` deletes.
pub fn apply<'a>(
    db: &mut Connection,
    changes: impl Iterator<Item = (Uuid, Option<&'a NodeRec>)>,
) -> Result<(), String> {
    let tx = db.transaction().map_err(|e| e.to_string())?;
    {
        let mut upsert = tx
            .prepare_cached(
                "INSERT INTO nodes (id, parent, position, text, note, kind, is_completed, is_highlighted, is_collapsed, bold_ranges, italic_ranges, underline_ranges, created_at, updated_at, completed_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
                 ON CONFLICT(id) DO UPDATE SET
                   parent=excluded.parent, position=excluded.position, text=excluded.text,
                   note=excluded.note, kind=excluded.kind, is_completed=excluded.is_completed,
                   is_highlighted=excluded.is_highlighted, is_collapsed=excluded.is_collapsed,
                   bold_ranges=excluded.bold_ranges, italic_ranges=excluded.italic_ranges,
                   underline_ranges=excluded.underline_ranges, created_at=excluded.created_at,
                   updated_at=excluded.updated_at, completed_at=excluded.completed_at",
            )
            .map_err(|e| e.to_string())?;
        let mut delete = tx
            .prepare_cached("DELETE FROM nodes WHERE id = ?1")
            .map_err(|e| e.to_string())?;
        for (id, rec) in changes {
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
                        ])
                        .map_err(|e| e.to_string())?;
                }
                None => {
                    delete
                        .execute(params![id.to_string()])
                        .map_err(|e| e.to_string())?;
                }
            }
        }
    }
    tx.commit().map_err(|e| e.to_string())
}
