use crate::model::{NodeKind, NodeRec};
use crate::store::Store;
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
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
    /// The ⌘⇧F focus-pane membership. Same only-when-set rule as the style arrays:
    /// highlight-free documents stay byte-identical to the SwiftUI format, and its
    /// JSONDecoder ignores the key where present.
    #[serde(rename = "isHighlighted", default, skip_serializing_if = "is_false")]
    pub is_highlighted: bool,
    /// The exporting DEVICE's focus-pane position (0-based). The pane's order is
    /// device-local (`pf.focusOrder`), and import mints fresh ids, so the file is the
    /// only way order survives an export/import round trip. Written only for ranked
    /// nodes; import sorts by it, ties falling back to document order.
    #[serde(rename = "focusRank", default, skip_serializing_if = "Option::is_none")]
    pub focus_rank: Option<i64>,
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

fn is_false(b: &bool) -> bool {
    !*b
}

fn export_node(
    store: &Store,
    id: Uuid,
    collapsed: &HashSet<Uuid>,
    ranks: &HashMap<Uuid, i64>,
    seen: &mut HashSet<Uuid>,
) -> Option<NodeExport> {
    if !seen.insert(id) {
        return None; // cycle guard
    }
    let rec = store.get(id)?.clone();
    let children = store
        .ordered_children(id)
        .into_iter()
        .filter_map(|c| export_node(store, c, collapsed, ranks, seen))
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
        is_highlighted: rec.is_highlighted,
        // Rank only what is highlighted: the pane's order can briefly name a node
        // un-⌘⇧F'd in another window (the exporting window's copy is only as fresh as
        // its last reconcile), and a rank without the flag imports as a phantom order
        // entry that desyncs the pane's order==members drag invariant.
        focus_rank: if rec.is_highlighted {
            ranks.get(&id).copied()
        } else {
            None
        },
        position: rec.position,
        created_at: iso(rec.created_at),
        updated_at: iso(rec.updated_at),
        completed_at: rec.completed_at.map(iso),
        children,
    })
}

/// Build the document from specific roots (Clear Completed archives units, the full
/// export passes every root). `focus_order` is the exporting device's focus-pane order;
/// the archive paths pass `&[]` (a deleted unit has no pane position to keep).
pub fn document(
    store: &Store,
    roots: &[Uuid],
    collapsed: &HashSet<Uuid>,
    focus_order: &[Uuid],
) -> OutlineDocument {
    let ranks: HashMap<Uuid, i64> = focus_order
        .iter()
        .enumerate()
        .map(|(i, id)| (*id, i as i64))
        .collect();
    let mut seen = HashSet::new();
    OutlineDocument {
        format: FORMAT_ID.into(),
        version: CURRENT_VERSION,
        exported_at: iso(crate::model::now_ms()),
        roots: roots
            .iter()
            .filter_map(|r| export_node(store, *r, collapsed, &ranks, &mut seen))
            .collect(),
    }
}

/// A document decomposed for import: the records plus the two pieces of per-window /
/// per-device state the file carries, already mapped to the FRESH ids.
pub struct Imported {
    pub recs: Vec<NodeRec>,
    /// Ids that should seed the importing window's collapsed set.
    pub collapsed: Vec<Uuid>,
    /// The file's focusRank-carrying nodes in rank order — the importing device's new
    /// focus-pane order (the exporter's `pf.focusOrder` names ids that no longer exist).
    pub focus_order: Vec<Uuid>,
}

/// Flatten a document into fresh records (FRESH ids, like the SwiftUI app's import —
/// reusing file ids could collide with live nodes).
pub fn to_records(doc: &OutlineDocument) -> Imported {
    let mut out = Vec::new();
    let mut collapsed = Vec::new();
    let mut ranked: Vec<(i64, Uuid)> = Vec::new();
    fn walk(
        e: &NodeExport,
        parent: Option<Uuid>,
        out: &mut Vec<NodeRec>,
        collapsed: &mut Vec<Uuid>,
        ranked: &mut Vec<(i64, Uuid)>,
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
        rec.is_highlighted = e.is_highlighted;
        rec.created_at = parse_iso(&e.created_at);
        rec.updated_at = parse_iso(&e.updated_at);
        rec.completed_at = e.completed_at.as_deref().map(parse_iso);
        let id = rec.id;
        if e.is_collapsed {
            collapsed.push(id);
        }
        // The highlight gate mirrors the exporter's: a hand-edited file carrying a
        // rank without the flag must not seed a phantom id into every window's order.
        if let Some(r) = e.focus_rank {
            if e.is_highlighted {
                ranked.push((r, id));
            }
        }
        out.push(rec);
        for c in &e.children {
            walk(c, Some(id), out, collapsed, ranked);
        }
    }
    for r in &doc.roots {
        walk(r, None, &mut out, &mut collapsed, &mut ranked);
    }
    // Stable, so duplicate ranks (a hand-edited file) fall back to document order.
    ranked.sort_by_key(|(r, _)| *r);
    Imported {
        recs: out,
        collapsed,
        focus_order: ranked.into_iter().map(|(_, id)| id).collect(),
    }
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
            continue;
        }
        // A node whose whole subtree is completed IS a unit; it just isn't old enough
        // yet. Descending into it would archive (and DELETE) the children that have
        // aged out while the parent stays on screen — slicing the very unit this
        // function promises to take whole. Leave it for a later sweep, when the newest
        // stamp in it has aged out too and it qualifies as one piece.
        if older_than_ms.is_some() && qualifies(store, id, None, &mut HashSet::new()) {
            continue;
        }
        // Descend THROUGH this node to reach completed units below it.
        for c in store.ordered_children(id).into_iter().rev() {
            stack.push(c);
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
///
/// The stamp resolves only to the SECOND, and two archives can share one wall-clock
/// second (the launch+4s sweep landing with a manual Clear Completed) — or the same
/// repeated hour on a DST fall-back. A plain truncating `fs::write` would silently
/// destroy the earlier backup, whose nodes are deleted from the store right after — the
/// one case the backup-first guarantee must never allow. So open with `create_new` and
/// disambiguate with a counter: a collision makes a NEW file instead of overwriting one.
pub fn write_archive(dir: &Path, doc: &OutlineDocument) -> Result<PathBuf, String> {
    use std::io::Write;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let stamp = chrono::Local::now().format("%Y-%m-%d %H-%M-%S");
    let json = encode(doc)?;
    for n in 0..1000 {
        let name = if n == 0 {
            format!("PromptFlow Archive {stamp}.json")
        } else {
            format!("PromptFlow Archive {stamp} ({n}).json")
        };
        let path = dir.join(name);
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut f) => {
                f.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
                return Ok(path);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("could not find a free archive filename".into())
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
        s.set_highlighted(a, true).unwrap();
        s.set_highlighted(b, true).unwrap();

        let roots = s.roots();
        // Pane order REVERSED from document order, so the round trip proves the rank
        // carried the order rather than the walk happening to reproduce it.
        let doc = document(&s, &roots, &HashSet::from([a]), &[b, a]);
        let json = encode(&doc).unwrap();
        let parsed = decode(&json).unwrap();
        let Imported {
            recs,
            collapsed,
            focus_order,
        } = to_records(&parsed);
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
        assert!(ra.is_highlighted && rb.is_highlighted);
        assert_eq!(focus_order, vec![rb.id, ra.id]);
        // Fresh ids on import (never reuse the file's).
        assert_ne!(ra.id, a);
    }

    #[test]
    fn focus_keys_absent_without_highlights() {
        // The byte-compat rule: a document with no pane state carries NEITHER new key,
        // exactly like the style arrays — so plain exports stay identical to the
        // SwiftUI app's format.
        let mut s = Store::open_in_memory_for_tests();
        let (_, a) = s.append_root(NodeKind::BulletPoint).unwrap();
        let a = a.new_node.unwrap();
        s.set_text(a, "plain".into(), None, None, None).unwrap();
        let json = encode(&document(&s, &s.roots(), &HashSet::new(), &[])).unwrap();
        assert!(!json.contains("isHighlighted"));
        assert!(!json.contains("focusRank"));
        // A stale pane id (node since deleted) writes no rank either.
        let ghost = Uuid::new_v4();
        let json = encode(&document(&s, &s.roots(), &HashSet::new(), &[ghost])).unwrap();
        assert!(!json.contains("focusRank"));
        // Nor does a LIVE node the pane order still names but that is no longer
        // highlighted (un-⌘⇧F'd in another window before this one reconciled): a rank
        // without the flag would import as a phantom order entry.
        let json = encode(&document(&s, &s.roots(), &HashSet::new(), &[a])).unwrap();
        assert!(!json.contains("focusRank"));
    }

    #[test]
    fn import_ignores_a_rank_without_the_flag() {
        // The decode-side twin of the export guard, for hand-edited files: a focusRank
        // on a node that is not highlighted must not reach the adopted order.
        let json = r#"{
            "format": "promptflow.outline", "version": 1,
            "exportedAt": "2026-08-13T00:00:00Z",
            "roots": [
                {"uuid": "11111111-1111-1111-1111-111111111111", "text": "unflagged",
                 "note": "", "kind": "bulletPoint", "isCompleted": false,
                 "isCollapsed": false, "boldRanges": [], "position": 0,
                 "createdAt": "2026-08-13T00:00:00Z", "updatedAt": "2026-08-13T00:00:00Z",
                 "focusRank": 0, "children": []},
                {"uuid": "22222222-2222-2222-2222-222222222222", "text": "flagged",
                 "note": "", "kind": "bulletPoint", "isCompleted": false,
                 "isCollapsed": false, "boldRanges": [], "position": 1024,
                 "createdAt": "2026-08-13T00:00:00Z", "updatedAt": "2026-08-13T00:00:00Z",
                 "isHighlighted": true, "focusRank": 1, "children": []}
            ]
        }"#;
        let doc = decode(json).unwrap();
        let imported = to_records(&doc);
        let flagged = imported.recs.iter().find(|r| r.text == "flagged").unwrap();
        assert_eq!(imported.focus_order, vec![flagged.id]);
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

    #[test]
    fn write_archive_never_overwrites_a_prior_backup() {
        // Two writes in the same wall-clock second must produce TWO files — the backup-
        // first guarantee is void if the second write truncates the first.
        let dir = std::env::temp_dir().join(format!("pf-archive-test-{}", now_ms()));
        let mut s = Store::open_in_memory_for_tests();
        let (_, a) = s.append_root(NodeKind::BulletPoint).unwrap();
        s.set_text(a.new_node.unwrap(), "first".into(), None, None, None)
            .unwrap();
        let doc1 = document(&s, &s.roots(), &HashSet::new(), &[]);
        let (_, b) = s.append_root(NodeKind::BulletPoint).unwrap();
        s.set_text(b.new_node.unwrap(), "second".into(), None, None, None)
            .unwrap();
        let doc2 = document(&s, &s.roots(), &HashSet::new(), &[]);

        let p1 = write_archive(&dir, &doc1).unwrap();
        let p2 = write_archive(&dir, &doc2).unwrap();
        assert_ne!(p1, p2, "second archive overwrote the first's path");
        assert!(p1.exists() && p2.exists());
        // The first file's content survived intact.
        let back1 = decode(&std::fs::read_to_string(&p1).unwrap()).unwrap();
        assert_eq!(back1.roots.len(), 1);
        assert_eq!(back1.roots[0].text, "first");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn age_gate_never_slices_a_completed_unit() {
        // A completed parent whose stamp is too RECENT, over an old completed child:
        // complete the child on day 1, the parent on day 10, sweep on day 11. The unit
        // is the parent — the sweep must take it whole or leave it alone, never reach
        // past a completed node to pull its children out from under it.
        let day = 24 * 60 * 60 * 1000i64;
        let now = now_ms();
        let mut parent = NodeRec::new("parent".into(), NodeKind::Checkbox, None, 0);
        parent.is_completed = true;
        parent.completed_at = Some(now - day); // recent: inside a 3-day retention
        let mut child = NodeRec::new("child".into(), NodeKind::Checkbox, Some(parent.id), 0);
        child.is_completed = true;
        child.completed_at = Some(now - 10 * day); // old
        let (pid, cid) = (parent.id, child.id);

        let mut s = Store::open_in_memory_for_tests();
        s.insert_tree(vec![parent, child]).unwrap();

        // Threshold sits between the two stamps: the parent is too recent, the child old.
        let units = collect(&s, Some(now - 3 * day));
        assert!(
            !units.contains(&cid),
            "child archived out of a still-present completed parent: {units:?}",
        );
        assert!(units.is_empty() || units == vec![pid]);
    }
}
