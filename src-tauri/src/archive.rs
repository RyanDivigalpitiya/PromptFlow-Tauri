use crate::model::{NodeKind, NodeRec};
use crate::store::Store;
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use uuid::Uuid;

/// File export / import — the SAME versioned JSON document the SwiftUI app writes
/// (`promptflow.outline`, ISO-8601 dates, kind raw strings, nesting = parenthood), so
/// outlines migrate losslessly between the two apps in both directions.

fn iso(ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .unwrap_or_else(|| DateTime::from_timestamp(0, 0).unwrap())
        .to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn parse_iso(s: &str) -> i64 {
    DateTime::parse_from_rfc3339(s)
        .map(|d| d.timestamp_millis())
        .unwrap_or_else(|_| crate::model::now_ms())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct NodeExport {
    pub uuid: Uuid,
    pub text: String,
    pub note: String,
    pub kind: String,
    #[serde(rename = "isCompleted")]
    pub is_completed: bool,
    #[serde(rename = "isCollapsed")]
    pub is_collapsed: bool,
    #[serde(rename = "boldRanges")]
    pub bold_ranges: Vec<i64>,
    /// Only written when non-empty so style-free documents stay byte-identical to
    /// the SwiftUI app's format (which has no italic/underline); its JSONDecoder
    /// ignores unknown keys, so styled exports still import there (styles dropped).
    #[serde(rename = "italicRanges", default, skip_serializing_if = "Vec::is_empty")]
    pub italic_ranges: Vec<i64>,
    #[serde(rename = "underlineRanges", default, skip_serializing_if = "Vec::is_empty")]
    pub underline_ranges: Vec<i64>,
    pub position: i64,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    #[serde(rename = "completedAt", skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    pub children: Vec<NodeExport>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct OutlineDocument {
    pub format: String,
    pub version: i64,
    #[serde(rename = "exportedAt")]
    pub exported_at: String,
    pub roots: Vec<NodeExport>,
}

pub const FORMAT_ID: &str = "promptflow.outline";
pub const CURRENT_VERSION: i64 = 1;

fn export_node(store: &Store, id: Uuid, collapsed: &HashSet<Uuid>, seen: &mut HashSet<Uuid>) -> Option<NodeExport> {
    if !seen.insert(id) {
        return None; // cycle guard
    }
    let rec = store.get(id)?.clone();
    let children = store
        .ordered_children(id)
        .into_iter()
        .filter_map(|c| export_node(store, c, collapsed, seen))
        .collect();
    Some(NodeExport {
        uuid: rec.id,
        text: rec.text,
        note: rec.note,
        kind: rec.kind.raw().to_string(),
        is_completed: rec.is_completed,
        is_collapsed: collapsed.contains(&id),
        bold_ranges: rec.bold_ranges,
        italic_ranges: rec.italic_ranges,
        underline_ranges: rec.underline_ranges,
        position: rec.position,
        created_at: iso(rec.created_at),
        updated_at: iso(rec.updated_at),
        completed_at: rec.completed_at.map(iso),
        children,
    })
}

/// Build the document from specific roots (Clear Completed archives units, the full
/// export passes every root).
pub fn document(store: &Store, roots: &[Uuid], collapsed: &HashSet<Uuid>) -> OutlineDocument {
    let mut seen = HashSet::new();
    OutlineDocument {
        format: FORMAT_ID.into(),
        version: CURRENT_VERSION,
        exported_at: iso(crate::model::now_ms()),
        roots: roots
            .iter()
            .filter_map(|r| export_node(store, *r, collapsed, &mut seen))
            .collect(),
    }
}

/// Flatten a document into fresh records (FRESH ids, like the SwiftUI app's import —
/// reusing file ids could collide with live nodes). Returns the records plus the ids
/// that should seed the importing window's collapsed set.
pub fn to_records(doc: &OutlineDocument) -> (Vec<NodeRec>, Vec<Uuid>) {
    let mut out = Vec::new();
    let mut collapsed = Vec::new();
    fn walk(
        e: &NodeExport,
        parent: Option<Uuid>,
        out: &mut Vec<NodeRec>,
        collapsed: &mut Vec<Uuid>,
    ) {
        let mut rec = NodeRec::new(
            e.text.clone(),
            NodeKind::from_raw(&e.kind),
            parent,
            e.position,
        );
        rec.note = e.note.clone();
        rec.is_completed = e.is_completed;
        rec.is_collapsed = e.is_collapsed;
        rec.bold_ranges = e.bold_ranges.clone();
        rec.italic_ranges = e.italic_ranges.clone();
        rec.underline_ranges = e.underline_ranges.clone();
        rec.created_at = parse_iso(&e.created_at);
        rec.updated_at = parse_iso(&e.updated_at);
        rec.completed_at = e.completed_at.as_deref().map(parse_iso);
        let id = rec.id;
        if e.is_collapsed {
            collapsed.push(id);
        }
        out.push(rec);
        for c in &e.children {
            walk(c, Some(id), out, collapsed);
        }
    }
    for r in &doc.roots {
        walk(r, None, &mut out, &mut collapsed);
    }
    (out, collapsed)
}

pub fn encode(doc: &OutlineDocument) -> Result<String, String> {
    serde_json::to_string_pretty(doc).map_err(|e| e.to_string())
}

pub fn decode(json: &str) -> Result<OutlineDocument, String> {
    let doc: OutlineDocument = serde_json::from_str(json).map_err(|e| e.to_string())?;
    if doc.format != FORMAT_ID {
        return Err(format!("not a {FORMAT_ID} document"));
    }
    Ok(doc)
}

// MARK: Archiver (completed-task hygiene)

/// Retention for auto-archive: completed units older than this age out.
pub const RETENTION_MS: i64 = 3 * 24 * 60 * 60 * 1000;

/// The top-most COMPLETED nodes whose ENTIRE subtree qualifies (all completed, and —
/// when a threshold is given — every completedAt on/before it), as whole units. The
/// walk descends only THROUGH incomplete nodes to reach completed units below, and
/// never slices a partial subtree. Pure; shared by the manual and auto paths.
pub fn collect(store: &Store, older_than_ms: Option<i64>) -> Vec<Uuid> {
    fn qualifies(store: &Store, id: Uuid, older: Option<i64>, seen: &mut HashSet<Uuid>) -> bool {
        if !seen.insert(id) {
            return false; // cycle: treat as not qualifying
        }
        let Some(rec) = store.get(id) else {
            return false;
        };
        if !rec.is_completed {
            return false;
        }
        if let Some(t) = older {
            match rec.completed_at {
                Some(at) if at <= t => {}
                // Legacy completed nodes have no stamp — the manual path (older=None)
                // collects them; the auto sweep never does.
                _ => return false,
            }
        }
        store
            .ordered_children(id)
            .into_iter()
            .all(|c| qualifies(store, c, older, seen))
    }

    let mut units = Vec::new();
    let mut stack: Vec<Uuid> = store.roots().into_iter().rev().collect();
    while let Some(id) = stack.pop() {
        let mut seen = HashSet::new();
        if qualifies(store, id, older_than_ms, &mut seen) {
            units.push(id); // a whole unit — don't descend further
        } else {
            // Descend THROUGH this (incomplete or too-recent) node.
            for c in store.ordered_children(id).into_iter().rev() {
                stack.push(c);
            }
        }
    }
    units
}

/// Where archive files land: `<store dir>/Archive`.
pub fn archive_dir(store_path: &Path) -> PathBuf {
    store_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Archive")
}

/// Write an archive document to a timestamped file; returns the path. Backup-first:
/// callers only delete after this succeeds.
pub fn write_archive(dir: &Path, doc: &OutlineDocument) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let stamp = chrono::Local::now().format("%Y-%m-%d %H-%M-%S");
    let path = dir.join(format!("PromptFlow Archive {stamp}.json"));
    std::fs::write(&path, encode(doc)?).map_err(|e| e.to_string())?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::now_ms;
    use crate::store::Store;

    #[test]
    fn document_round_trips() {
        let mut s = Store::open_in_memory_for_tests();
        let (_, a) = s.append_root(NodeKind::BulletPoint).unwrap();
        let a = a.new_node.unwrap();
        s.set_text(a, "root A".into(), Some(vec![0, 4]), Some(vec![5, 2]), None).unwrap();
        let (_, b) = s.append_child(a, NodeKind::Checkbox).unwrap();
        let b = b.new_node.unwrap();
        s.set_text(b, "child B".into(), None, None, None).unwrap();
        s.set_note(b, "a note".into()).unwrap();
        s.toggle_completed(b).unwrap();

        let roots = s.roots();
        let doc = document(&s, &roots, &HashSet::from([a]));
        let json = encode(&doc).unwrap();
        let parsed = decode(&json).unwrap();
        let (recs, collapsed) = to_records(&parsed);
        assert_eq!(recs.len(), 2);
        assert_eq!(collapsed.len(), 1);
        let ra = recs.iter().find(|r| r.text == "root A").unwrap();
        let rb = recs.iter().find(|r| r.text == "child B").unwrap();
        assert_eq!(ra.bold_ranges, vec![0, 4]);
        assert_eq!(ra.italic_ranges, vec![5, 2]);
        assert!(rb.italic_ranges.is_empty() && rb.underline_ranges.is_empty());
        assert_eq!(rb.parent, Some(ra.id));
        assert!(rb.is_completed);
        assert!(rb.completed_at.is_some());
        assert_eq!(rb.note, "a note");
        // Fresh ids on import (never reuse the file's).
        assert_ne!(ra.id, a);
    }

    #[test]
    fn collect_takes_whole_units_only() {
        let mut s = Store::open_in_memory_for_tests();
        // Root (incomplete) > done (complete, all children complete) > leaf (complete)
        //                    > pending (incomplete)
        let (_, root) = s.append_root(NodeKind::BulletPoint).unwrap();
        let root = root.new_node.unwrap();
        let (_, done) = s.append_child(root, NodeKind::Checkbox).unwrap();
        let done = done.new_node.unwrap();
        let (_, leaf) = s.append_child(done, NodeKind::Checkbox).unwrap();
        let leaf = leaf.new_node.unwrap();
        let (_, pending) = s.append_child(root, NodeKind::Checkbox).unwrap();
        let pending = pending.new_node.unwrap();
        s.toggle_completed(done).unwrap();
        s.toggle_completed(leaf).unwrap();

        // Manual path: the completed unit under an active project IS collected.
        assert_eq!(collect(&s, None), vec![done]);
        // A partial subtree is never sliced: completing root but not `pending`
        // keeps root out while `done` still collects.
        s.toggle_completed(root).unwrap();
        assert_eq!(collect(&s, None), vec![done]);
        let _ = pending;
        // Age gate: nothing is old enough yet.
        assert!(collect(&s, Some(now_ms() - 60_000)).is_empty());
    }
}
