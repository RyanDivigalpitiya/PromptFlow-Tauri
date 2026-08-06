use crate::model::{now_ms, sibling_order, NodeKind, NodeRec};
use crate::persist;
use rusqlite::Connection;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

/// Sibling spacing. New nodes are inserted at the midpoint of a gap so a single edit is
/// O(1); a sibling list is only renumbered when its gap is exhausted (same as the SwiftUI app).
pub const GAP: i64 = 1024;

/// Cap on the undo stack (the SwiftUI app relied on NSUndoManager's default; we bound ours).
const UNDO_CAP: usize = 500;
/// Consecutive text edits to the same node within this window coalesce into ONE undo step —
/// the moral equivalent of NSUndoManager's per-event grouping for a typing burst.
const COALESCE_MS: i64 = 2000;

// MARK: - Delta protocol (backend -> every window's mirror)

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DeltaOp {
    Upsert { node: NodeRec },
    Delete { id: Uuid },
}

/// One store change, broadcast to every window. `rev` increments by exactly 1 per delta;
/// a window that observes a gap re-requests the full snapshot.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Delta {
    pub rev: u64,
    /// Window label that caused the mutation ("" for app-level ops like undo from the menu).
    pub origin: String,
    pub ops: Vec<DeltaOp>,
    pub can_undo: bool,
    pub can_redo: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub rev: u64,
    pub nodes: Vec<NodeRec>,
    pub can_undo: bool,
    pub can_redo: bool,
}

/// What a mutation hands back to the CALLING window (deltas go to every window; these
/// hints are per-gesture): the node to focus, and parents this window should expand so
/// the new/moved node is visible (collapse is per-window frontend state).
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MutationOut {
    pub new_node: Option<Uuid>,
    pub expand: Vec<Uuid>,
    pub moved: bool,
}

// MARK: - Undo machinery

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum CoalesceKey {
    Text(Uuid),
    Note(Uuid),
}

#[derive(Debug, Clone)]
struct Change {
    id: Uuid,
    before: Option<NodeRec>,
    after: Option<NodeRec>,
}

#[derive(Debug, Clone)]
struct UndoEntry {
    coalesce: Option<CoalesceKey>,
    at_ms: i64,
    changes: Vec<Change>,
}

/// Before-images for the mutation currently being built. Insertion order is preserved
/// (Vec) so deltas replay deterministically.
#[derive(Default)]
struct TxData {
    order: Vec<Uuid>,
    before: HashMap<Uuid, Option<NodeRec>>,
}

/// Split flat `[loc, len, …]` style pairs at `at`: head keeps runs before the split
/// (clipped), tail keeps runs after it, rebased to 0. Runs straddling `at` split.
/// Style-run offsets are UTF-16 code units — the units the SwiftUI app's `NSRange`s use
/// and the units the frontend's `String` indices use. NEVER `text.len()`, which is BYTES:
/// any non-ASCII character would put every run after it at the wrong offset.
fn utf16_len(s: &str) -> i64 {
    s.encode_utf16().count() as i64
}

/// Append the part of `ranges` covering source `[lo, hi)` onto `out`, rebased so `lo`
/// lands at `dst` — the merge's counterpart to `split_ranges`: where a split rebases runs
/// to a new zero, this rebases them onto a position inside a longer text.
///
/// It clips as well as shifts because the merge no longer places a member's text as ONE
/// piece: every LINE of it gets its own indent prefix, so every line lands at its own
/// offset. A run spanning a newline therefore comes out as two runs with the indent
/// between them unstyled — which is what you want (indentation is structure, not text)
/// and is invisible for bold/italic either way. Zero/negative lengths are dropped rather
/// than carried.
fn push_clipped_ranges(out: &mut Vec<i64>, ranges: &[i64], lo: i64, hi: i64, dst: i64) {
    for pair in ranges.chunks(2) {
        if pair.len() < 2 || pair[1] <= 0 {
            continue;
        }
        let (a, b) = (pair[0].max(lo), (pair[0] + pair[1]).min(hi));
        if b > a {
            out.push(a - lo + dst);
            out.push(b - a);
        }
    }
}

fn split_ranges(ranges: &[i64], at: i64) -> (Vec<i64>, Vec<i64>) {
    let mut head = Vec::new();
    let mut tail = Vec::new();
    for pair in ranges.chunks(2) {
        if pair.len() < 2 {
            break;
        }
        let (lo, hi) = (pair[0], pair[0] + pair[1]);
        if lo < at {
            let h = hi.min(at);
            if h > lo {
                head.push(lo);
                head.push(h - lo);
            }
        }
        if hi > at {
            let l = lo.max(at);
            if hi > l {
                tail.push(l - at);
                tail.push(hi - l);
            }
        }
    }
    (head, tail)
}

// MARK: - Store

pub struct Store {
    nodes: HashMap<Uuid, NodeRec>,
    /// Sibling lists sorted by (position, uuid). Key None = the roots list.
    children: HashMap<Option<Uuid>, Vec<Uuid>>,
    rev: u64,
    undo_stack: Vec<UndoEntry>,
    redo_stack: Vec<UndoEntry>,
    tx: Option<TxData>,
    db: Connection,
}

impl Store {
    pub fn open(path: &std::path::Path) -> Result<Self, String> {
        let db = persist::open(path)?;
        let nodes = persist::load_all(&db)?;
        let mut store = Store {
            nodes,
            children: HashMap::new(),
            rev: 0,
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            tx: None,
            db,
        };
        store.rebuild_index();
        Ok(store)
    }

    fn rebuild_index(&mut self) {
        self.children.clear();
        for (id, rec) in &self.nodes {
            self.children.entry(rec.parent).or_default().push(*id);
        }
        let nodes = &self.nodes;
        for list in self.children.values_mut() {
            list.sort_by(|a, b| sibling_order(&nodes[a], &nodes[b]));
        }
    }

    // MARK: Queries

    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            rev: self.rev,
            nodes: self.nodes.values().cloned().collect(),
            can_undo: !self.undo_stack.is_empty(),
            can_redo: !self.redo_stack.is_empty(),
        }
    }

    pub fn get(&self, id: Uuid) -> Option<&NodeRec> {
        self.nodes.get(&id)
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    pub fn roots(&self) -> Vec<Uuid> {
        self.children.get(&None).cloned().unwrap_or_default()
    }

    pub fn ordered_children(&self, id: Uuid) -> Vec<Uuid> {
        self.children.get(&Some(id)).cloned().unwrap_or_default()
    }

    fn has_children(&self, id: Uuid) -> bool {
        self.children.get(&Some(id)).map_or(false, |c| !c.is_empty())
    }

    /// Sibling id list of `id` (the roots list for a root).
    fn sibling_ids(&self, id: Uuid) -> Vec<Uuid> {
        let parent = self.nodes.get(&id).and_then(|n| n.parent);
        self.children.get(&parent).cloned().unwrap_or_default()
    }

    /// `id`'s whole subtree (self included), parents before children.
    pub fn descendants(&self, id: Uuid) -> Vec<Uuid> {
        let mut out = Vec::new();
        let mut stack = vec![id];
        let mut seen = HashSet::new();
        while let Some(cur) = stack.pop() {
            if !seen.insert(cur) {
                continue; // cycle guard (imported data could be malformed)
            }
            out.push(cur);
            if let Some(kids) = self.children.get(&Some(cur)) {
                for k in kids.iter().rev() {
                    stack.push(*k);
                }
            }
        }
        out
    }

    /// Ancestor chain from topmost root down to `id`'s parent (excludes `id`). Cycle-guarded.
    pub fn ancestors(&self, id: Uuid) -> Vec<Uuid> {
        let mut chain = Vec::new();
        let mut seen: HashSet<Uuid> = HashSet::from([id]);
        let mut p = self.nodes.get(&id).and_then(|n| n.parent);
        while let Some(cur) = p {
            if !seen.insert(cur) {
                break;
            }
            chain.push(cur);
            p = self.nodes.get(&cur).and_then(|n| n.parent);
        }
        chain.reverse();
        chain
    }

    // MARK: Index-preserving primitive writes

    /// Insert or replace a record, keeping the children index sorted. The ONLY way any
    /// mutation below writes a node.
    fn put(&mut self, rec: NodeRec) {
        let id = rec.id;
        let old = self.nodes.insert(id, rec.clone());
        match old {
            Some(o) if o.parent == rec.parent && o.position == rec.position => {}
            Some(o) => {
                if let Some(list) = self.children.get_mut(&o.parent) {
                    list.retain(|x| *x != id);
                }
                self.insert_sorted(rec.parent, id);
            }
            None => self.insert_sorted(rec.parent, id),
        }
    }

    fn insert_sorted(&mut self, parent: Option<Uuid>, id: Uuid) {
        let nodes = &self.nodes;
        let list = self.children.entry(parent).or_default();
        let target = &nodes[&id];
        let at = list
            .binary_search_by(|other| sibling_order(&nodes[other], target))
            .unwrap_or_else(|e| e);
        list.insert(at, id);
    }

    fn drop_node(&mut self, id: Uuid) {
        if let Some(old) = self.nodes.remove(&id) {
            if let Some(list) = self.children.get_mut(&old.parent) {
                list.retain(|x| *x != id);
            }
        }
    }

    // MARK: Transaction harness

    fn begin(&mut self) {
        debug_assert!(self.tx.is_none(), "nested store transaction");
        self.tx = Some(TxData::default());
    }

    /// Record `id`'s before-image once per transaction (None = did not exist).
    fn touch(&mut self, id: Uuid) {
        let img = self.nodes.get(&id).cloned();
        if let Some(tx) = self.tx.as_mut() {
            if !tx.before.contains_key(&id) {
                tx.order.push(id);
                tx.before.insert(id, img);
            }
        }
    }

    /// Clone-edit-put: the standard mutation step for an EXISTING node.
    fn edit<F: FnOnce(&mut NodeRec)>(&mut self, id: Uuid, f: F) {
        self.touch(id);
        if let Some(mut rec) = self.nodes.get(&id).cloned() {
            f(&mut rec);
            self.put(rec);
        }
    }

    fn insert_new(&mut self, rec: NodeRec) {
        self.touch(rec.id);
        self.put(rec);
    }

    fn delete_subtree(&mut self, id: Uuid) {
        for d in self.descendants(id) {
            self.touch(d);
            self.drop_node(d);
        }
    }

    /// Close the transaction: diff before/after images, push an undo entry (with optional
    /// text coalescing), persist to SQLite, bump `rev`, and produce the broadcast delta.
    fn commit(&mut self, coalesce: Option<CoalesceKey>) -> Result<Delta, String> {
        let tx = self.tx.take().expect("commit without begin");
        let mut changes: Vec<Change> = Vec::new();
        for id in tx.order {
            let before = tx.before.get(&id).cloned().flatten();
            let after = self.nodes.get(&id).cloned();
            let same = match (&before, &after) {
                (Some(b), Some(a)) => b == a,
                (None, None) => true,
                _ => false,
            };
            if !same {
                changes.push(Change { id, before, after });
            }
        }
        if changes.is_empty() {
            return Ok(self.empty_delta());
        }
        // A failed write must leave NO trace in memory. The mutation has already been
        // applied to `nodes`, but on error we bump no `rev` and emit no delta — so a
        // store that kept the change would diverge from every window permanently, with
        // nothing to tell them about it. Roll back to the before-images instead.
        if let Err(e) = persist::apply(&mut self.db, changes.iter().map(|c| (c.id, c.after.as_ref())))
        {
            let mut discard = Vec::new();
            for ch in &changes {
                self.apply_image(ch.id, ch.before.clone(), &mut discard);
            }
            return Err(e);
        }
        self.push_undo(UndoEntry {
            coalesce: coalesce.clone(),
            at_ms: now_ms(),
            changes: changes.clone(),
        });
        self.redo_stack.clear();
        self.rev += 1;
        Ok(Delta {
            rev: self.rev,
            origin: String::new(),
            ops: changes
                .into_iter()
                .map(|c| match c.after {
                    Some(node) => DeltaOp::Upsert { node },
                    None => DeltaOp::Delete { id: c.id },
                })
                .collect(),
            can_undo: !self.undo_stack.is_empty(),
            can_redo: !self.redo_stack.is_empty(),
        })
    }

    fn empty_delta(&self) -> Delta {
        Delta {
            rev: self.rev,
            origin: String::new(),
            ops: Vec::new(),
            can_undo: !self.undo_stack.is_empty(),
            can_redo: !self.redo_stack.is_empty(),
        }
    }

    fn push_undo(&mut self, entry: UndoEntry) {
        if let (Some(key), Some(top)) = (&entry.coalesce, self.undo_stack.last_mut()) {
            if top.coalesce.as_ref() == Some(key) && entry.at_ms - top.at_ms < COALESCE_MS {
                // Merge: keep the top's before-images, adopt the new after-images.
                for ch in entry.changes {
                    if let Some(existing) = top.changes.iter_mut().find(|c| c.id == ch.id) {
                        existing.after = ch.after;
                    } else {
                        top.changes.push(ch);
                    }
                }
                top.at_ms = entry.at_ms;
                return;
            }
        }
        self.undo_stack.push(entry);
        if self.undo_stack.len() > UNDO_CAP {
            self.undo_stack.remove(0);
        }
    }

    // MARK: Undo / redo

    pub fn undo(&mut self) -> Result<Delta, String> {
        let Some(entry) = self.undo_stack.pop() else {
            return Ok(self.empty_delta());
        };
        // Persist BEFORE touching memory, so a failed write leaves the store exactly as
        // it was. Mutating first would strand the popped entry (never pushed to redo)
        // AND move the tree without bumping `rev` or emitting a delta — a silent,
        // permanent divergence between the store and every window.
        if let Err(e) = persist::apply(
            &mut self.db,
            entry.changes.iter().map(|c| (c.id, c.before.as_ref())),
        ) {
            self.undo_stack.push(entry); // nothing happened — put the step back
            return Err(e);
        }
        let mut ops = Vec::new();
        for ch in &entry.changes {
            self.apply_image(ch.id, ch.before.clone(), &mut ops);
        }
        self.redo_stack.push(entry);
        self.rev += 1;
        Ok(Delta {
            rev: self.rev,
            origin: String::new(),
            ops,
            can_undo: !self.undo_stack.is_empty(),
            can_redo: !self.redo_stack.is_empty(),
        })
    }

    pub fn redo(&mut self) -> Result<Delta, String> {
        let Some(entry) = self.redo_stack.pop() else {
            return Ok(self.empty_delta());
        };
        // Persist before mutating — see the note in `undo`.
        if let Err(e) = persist::apply(
            &mut self.db,
            entry.changes.iter().map(|c| (c.id, c.after.as_ref())),
        ) {
            self.redo_stack.push(entry); // nothing happened — put the step back
            return Err(e);
        }
        let mut ops = Vec::new();
        for ch in &entry.changes {
            self.apply_image(ch.id, ch.after.clone(), &mut ops);
        }
        self.undo_stack.push(entry);
        self.rev += 1;
        Ok(Delta {
            rev: self.rev,
            origin: String::new(),
            ops,
            can_undo: !self.undo_stack.is_empty(),
            can_redo: !self.redo_stack.is_empty(),
        })
    }

    fn apply_image(&mut self, id: Uuid, image: Option<NodeRec>, ops: &mut Vec<DeltaOp>) {
        match image {
            Some(rec) => {
                self.put(rec.clone());
                ops.push(DeltaOp::Upsert { node: rec });
            }
            None => {
                self.drop_node(id);
                ops.push(DeltaOp::Delete { id });
            }
        }
    }

    /// Drop undo/redo history (import/replace-all — a post-import undo must not
    /// resurrect wiped nodes, mirroring the SwiftUI app's `removeAllActions`).
    pub fn clear_history(&mut self) {
        self.undo_stack.clear();
        self.redo_stack.clear();
    }

    // MARK: Position helpers (ported from OutlineStore)

    /// A position that places a new node immediately after `ref` among ref's siblings.
    /// Compacts the sibling list (renumber to 0, gap, 2·gap, …) if the gap is exhausted.
    fn position_after(&mut self, ref_id: Uuid) -> i64 {
        let ref_pos = self.nodes[&ref_id].position;
        let sibs = self.sibling_ids(ref_id);
        let Some(idx) = sibs.iter().position(|x| *x == ref_id) else {
            return ref_pos + GAP;
        };
        let mut lower = ref_pos;
        let mut upper = if idx + 1 < sibs.len() {
            self.nodes[&sibs[idx + 1]].position
        } else {
            lower + 2 * GAP
        };
        if upper - lower < 2 {
            for (i, s) in sibs.iter().enumerate() {
                self.edit(*s, |r| r.position = (i as i64) * GAP);
            }
            let sibs2 = self.sibling_ids(ref_id);
            let i2 = sibs2.iter().position(|x| *x == ref_id).unwrap_or(idx);
            lower = self.nodes[&sibs2[i2]].position;
            upper = if i2 + 1 < sibs2.len() {
                self.nodes[&sibs2[i2 + 1]].position
            } else {
                lower + 2 * GAP
            };
        }
        lower + (upper - lower) / 2
    }

    /// Position for a new FIRST child of `parent`: the midpoint below the current first
    /// child. Compacts the children if there's no room, keeping positions non-negative.
    fn first_child_position(&mut self, parent: Uuid) -> i64 {
        let kids = self.ordered_children(parent);
        let first_pos = kids.first().map(|k| self.nodes[k].position).unwrap_or(GAP);
        if first_pos >= 2 {
            return first_pos / 2;
        }
        for (i, k) in kids.iter().enumerate() {
            self.edit(*k, |r| r.position = ((i as i64) + 1) * GAP);
        }
        0
    }

    /// Roots-list analogue of `first_child_position`.
    fn first_root_position(&mut self) -> i64 {
        let rs = self.roots();
        let first_pos = rs.first().map(|r| self.nodes[r].position).unwrap_or(GAP);
        if first_pos >= 2 {
            return first_pos / 2;
        }
        for (i, r) in rs.iter().enumerate() {
            self.edit(*r, |rec| rec.position = ((i as i64) + 1) * GAP);
        }
        0
    }

    /// The kind a new FIRST child of `node` inherits: the kind of the top child the user can
    /// SEE (with hide-completed on, the first non-completed child), falling back to the raw
    /// first child, then the parent. Shared by Enter and the row's "+" (same rule, one place).
    fn top_child_kind(&self, node: Uuid, hide_completed: bool) -> NodeKind {
        let kids = self.ordered_children(node);
        let visible_top = if hide_completed {
            kids.iter().find(|k| !self.nodes[*k].is_completed)
        } else {
            kids.first()
        };
        visible_top
            .or(kids.first())
            .map(|k| self.nodes[k].kind.inheritable())
            .unwrap_or_else(|| self.nodes[&node].kind.inheritable())
    }

    // MARK: Mutations (each = one transaction = one undo step = one delta)

    /// Enter: split `node` at the caret. Expanded-with-children parent → new node is the
    /// FIRST CHILD (inheriting the visible top child's kind); otherwise the NEXT SIBLING
    /// (inheriting the node's kind). `expanded_in_window` is the calling window's collapse
    /// state for `node` (collapse is per-window). Style runs split with the text: the
    /// source keeps runs clipped to the head, the new node gets the tail rebased — the
    /// offsets are UTF-16 code units (the editor's offset space).
    pub fn commit_new_node(
        &mut self,
        node: Uuid,
        before: String,
        after: String,
        expanded_in_window: bool,
        hide_completed: bool,
    ) -> Result<(Delta, MutationOut), String> {
        self.ensure(node)?;
        let at = before.encode_utf16().count() as i64;
        let src = &self.nodes[&node];
        let (bold_head, bold_tail) = split_ranges(&src.bold_ranges, at);
        let (italic_head, italic_tail) = split_ranges(&src.italic_ranges, at);
        let (under_head, under_tail) = split_ranges(&src.underline_ranges, at);
        self.begin();
        self.edit(node, |r| {
            r.text = before;
            r.bold_ranges = bold_head;
            r.italic_ranges = italic_head;
            r.underline_ranges = under_head;
            r.updated_at = now_ms();
        });
        let mut new_rec = if expanded_in_window && self.has_children(node) {
            let kind = self.top_child_kind(node, hide_completed);
            let pos = self.first_child_position(node);
            NodeRec::new(after, kind, Some(node), pos)
        } else {
            let kind = self.nodes[&node].kind.inheritable();
            let pos = self.position_after(node);
            let parent = self.nodes[&node].parent;
            NodeRec::new(after, kind, parent, pos)
        };
        new_rec.bold_ranges = bold_tail;
        new_rec.italic_ranges = italic_tail;
        new_rec.underline_ranges = under_tail;
        let new_id = new_rec.id;
        self.insert_new(new_rec);
        let delta = self.commit(None)?;
        Ok((
            delta,
            MutationOut {
                new_node: Some(new_id),
                ..Default::default()
            },
        ))
    }

    /// The + button / empty state: append a new root node.
    pub fn append_root(&mut self, kind: NodeKind) -> Result<(Delta, MutationOut), String> {
        self.begin();
        let pos = self
            .roots()
            .last()
            .map(|r| self.nodes[r].position)
            .unwrap_or(-GAP)
            + GAP;
        let rec = NodeRec::new(String::new(), kind, None, pos);
        let id = rec.id;
        self.insert_new(rec);
        let delta = self.commit(None)?;
        Ok((
            delta,
            MutationOut {
                new_node: Some(id),
                ..Default::default()
            },
        ))
    }

    /// The + button while drilled into `parent`: append a new last child.
    pub fn append_child(
        &mut self,
        parent: Uuid,
        kind: NodeKind,
    ) -> Result<(Delta, MutationOut), String> {
        self.ensure(parent)?;
        self.begin();
        let pos = self
            .ordered_children(parent)
            .last()
            .map(|k| self.nodes[k].position)
            .unwrap_or(-GAP)
            + GAP;
        let rec = NodeRec::new(String::new(), kind, Some(parent), pos);
        let id = rec.id;
        self.insert_new(rec);
        let delta = self.commit(None)?;
        Ok((
            delta,
            MutationOut {
                new_node: Some(id),
                expand: vec![parent],
                ..Default::default()
            },
        ))
    }

    /// Completing a task: a fresh empty sibling directly after `node`, same list level.
    pub fn insert_sibling_after(
        &mut self,
        node: Uuid,
        kind: NodeKind,
    ) -> Result<(Delta, MutationOut), String> {
        self.ensure(node)?;
        self.begin();
        let pos = self.position_after(node);
        let parent = self.nodes[&node].parent;
        let rec = NodeRec::new(String::new(), kind, parent, pos);
        let id = rec.id;
        self.insert_new(rec);
        let delta = self.commit(None)?;
        Ok((
            delta,
            MutationOut {
                new_node: Some(id),
                ..Default::default()
            },
        ))
    }

    /// The row's trailing "+": a PARENT (or `force_child`, used by the drill root) gets a
    /// new FIRST CHILD (and the caller window expands it); a LEAF gets a NEXT SIBLING.
    pub fn insert_new_node_relative(
        &mut self,
        node: Uuid,
        force_child: bool,
        hide_completed: bool,
    ) -> Result<(Delta, MutationOut), String> {
        self.ensure(node)?;
        self.begin();
        let mut expand = Vec::new();
        let rec = if self.has_children(node) || force_child {
            expand.push(node);
            let kind = self.top_child_kind(node, hide_completed);
            let pos = self.first_child_position(node);
            NodeRec::new(String::new(), kind, Some(node), pos)
        } else {
            let kind = self.nodes[&node].kind.inheritable();
            let pos = self.position_after(node);
            let parent = self.nodes[&node].parent;
            NodeRec::new(String::new(), kind, parent, pos)
        };
        let id = rec.id;
        self.insert_new(rec);
        let delta = self.commit(None)?;
        Ok((
            delta,
            MutationOut {
                new_node: Some(id),
                expand,
                ..Default::default()
            },
        ))
    }

    /// Tab: nest `node` under the nearest previous VISIBLE sibling (skipping hidden
    /// completed ones). No visible predecessor, or the predecessor is a divider → no-op.
    pub fn indent(
        &mut self,
        node: Uuid,
        hide_completed: bool,
    ) -> Result<(Delta, MutationOut), String> {
        self.ensure(node)?;
        let sibs = self.sibling_ids(node);
        let Some(idx) = sibs.iter().position(|x| *x == node) else {
            return Ok((self.empty_delta(), MutationOut::default()));
        };
        let mut p = idx as i64 - 1;
        while p >= 0 && hide_completed && self.nodes[&sibs[p as usize]].is_completed {
            p -= 1;
        }
        if p < 0 {
            return Ok((self.empty_delta(), MutationOut::default()));
        }
        let new_parent = sibs[p as usize];
        if self.nodes[&new_parent].kind == NodeKind::Line {
            return Ok((self.empty_delta(), MutationOut::default()));
        }
        self.begin();
        let last_child_pos = self
            .ordered_children(new_parent)
            .last()
            .map(|k| self.nodes[k].position)
            .unwrap_or(-GAP);
        self.edit(node, |r| {
            r.parent = Some(new_parent);
            r.position = last_child_pos + GAP;
            r.updated_at = now_ms();
        });
        let delta = self.commit(None)?;
        Ok((
            delta,
            MutationOut {
                expand: vec![new_parent],
                moved: true,
                ..Default::default()
            },
        ))
    }

    /// Shift+Tab: move `node` to be the next sibling of its parent.
    pub fn outdent(&mut self, node: Uuid) -> Result<(Delta, MutationOut), String> {
        self.ensure(node)?;
        let Some(parent) = self.nodes[&node].parent else {
            return Ok((self.empty_delta(), MutationOut::default()));
        };
        self.begin();
        self.outdent_inner(node, parent);
        let delta = self.commit(None)?;
        Ok((
            delta,
            MutationOut {
                moved: true,
                ..Default::default()
            },
        ))
    }

    fn outdent_inner(&mut self, node: Uuid, parent: Uuid) {
        let target = self.position_after(parent);
        let grandparent = self.nodes[&parent].parent;
        self.edit(node, |r| {
            r.parent = grandparent;
            r.position = target;
            r.updated_at = now_ms();
        });
    }

    /// Option+Up/Down: move `node` past the nearest VISIBLE sibling in that direction,
    /// renumbering the whole list with fresh gaps. Returns moved=false at the edge.
    pub fn move_by(
        &mut self,
        node: Uuid,
        offset: i64,
        hide_completed: bool,
    ) -> Result<(Delta, MutationOut), String> {
        self.ensure(node)?;
        let mut sibs = self.sibling_ids(node);
        let Some(idx) = sibs.iter().position(|x| *x == node) else {
            return Ok((self.empty_delta(), MutationOut::default()));
        };
        let dir: i64 = if offset < 0 { -1 } else { 1 };
        let mut target = idx as i64 + dir;
        while target >= 0
            && (target as usize) < sibs.len()
            && hide_completed
            && self.nodes[&sibs[target as usize]].is_completed
        {
            target += dir;
        }
        if target < 0 || target as usize >= sibs.len() {
            return Ok((self.empty_delta(), MutationOut::default()));
        }
        sibs.remove(idx);
        sibs.insert(target as usize, node);
        self.begin();
        for (i, s) in sibs.iter().enumerate() {
            let new_pos = (i as i64) * GAP;
            if self.nodes[s].position != new_pos {
                self.edit(*s, |r| {
                    r.position = new_pos;
                    r.updated_at = now_ms();
                });
            }
        }
        let delta = self.commit(None)?;
        Ok((
            delta,
            MutationOut {
                moved: true,
                ..Default::default()
            },
        ))
    }

    /// Drag-to-reorder: move `node` (whole subtree) to a new spot.
    ///   after=Some(R)                 → next sibling of R (new_parent = R's parent)
    ///   after=None, parent=Some(P)    → FIRST CHILD of P (caller window expands P)
    ///   after=None, parent=None       → FIRST ROOT
    pub fn move_to(
        &mut self,
        node: Uuid,
        new_parent: Option<Uuid>,
        after: Option<Uuid>,
    ) -> Result<(Delta, MutationOut), String> {
        self.ensure(node)?;
        if let Some(np) = new_parent {
            self.ensure(np)?;
            if np == node || self.ancestors(np).contains(&node) {
                return Ok((self.empty_delta(), MutationOut::default()));
            }
        }
        // A drag's projection resolves `after` from the caller window's mirror, which can
        // lag a concurrent delete (another window's ⋯ Delete, the deferred auto-archive
        // sweep). `position_after` indexes `self.nodes[&after]` directly, so a stale id
        // would PANIC under the held store mutex and poison it for every window. Treat a
        // vanished drop target as a graceful no-op, like the cycle guard above.
        if let Some(r) = after {
            if !self.nodes.contains_key(&r) {
                return Ok((self.empty_delta(), MutationOut::default()));
            }
        }
        self.begin();
        let mut expand = Vec::new();
        let new_position = if let Some(r) = after {
            self.position_after(r)
        } else if let Some(np) = new_parent {
            expand.push(np);
            self.first_child_position(np)
        } else {
            self.first_root_position()
        };
        self.edit(node, |rec| {
            rec.parent = new_parent;
            rec.position = new_position;
            rec.updated_at = now_ms();
        });
        let delta = self.commit(None)?;
        Ok((
            delta,
            MutationOut {
                expand,
                moved: true,
                ..Default::default()
            },
        ))
    }

    /// Backspace on an empty node / the ⋯ menu's Delete: remove `node` and its whole subtree.
    pub fn delete(&mut self, node: Uuid) -> Result<(Delta, MutationOut), String> {
        self.ensure(node)?;
        self.begin();
        self.delete_subtree(node);
        let delta = self.commit(None)?;
        Ok((delta, MutationOut::default()))
    }

    pub fn toggle_completed(&mut self, node: Uuid) -> Result<(Delta, MutationOut), String> {
        self.ensure(node)?;
        self.begin();
        self.edit(node, |r| {
            r.is_completed = !r.is_completed;
            if r.is_completed {
                r.is_highlighted = false; // a done item shouldn't stay accented
            }
            r.completed_at = if r.is_completed { Some(now_ms()) } else { None };
            r.updated_at = now_ms();
        });
        let delta = self.commit(None)?;
        Ok((delta, MutationOut::default()))
    }

    /// Text edit from the editor. Coalesces with the previous edit to the same node so a
    /// typing burst is ONE undo step.
    pub fn set_text(
        &mut self,
        node: Uuid,
        text: String,
        bold_ranges: Option<Vec<i64>>,
        italic_ranges: Option<Vec<i64>>,
        underline_ranges: Option<Vec<i64>>,
    ) -> Result<(Delta, MutationOut), String> {
        self.ensure(node)?;
        self.begin();
        self.edit(node, |r| {
            r.text = text;
            if let Some(b) = bold_ranges {
                r.bold_ranges = b;
            }
            if let Some(i) = italic_ranges {
                r.italic_ranges = i;
            }
            if let Some(u) = underline_ranges {
                r.underline_ranges = u;
            }
            r.updated_at = now_ms();
        });
        let delta = self.commit(Some(CoalesceKey::Text(node)))?;
        Ok((delta, MutationOut::default()))
    }

    pub fn set_note(&mut self, node: Uuid, note: String) -> Result<(Delta, MutationOut), String> {
        self.ensure(node)?;
        self.begin();
        self.edit(node, |r| {
            r.note = note;
            r.updated_at = now_ms();
        });
        let delta = self.commit(Some(CoalesceKey::Note(node)))?;
        Ok((delta, MutationOut::default()))
    }

    pub fn set_kind(&mut self, node: Uuid, kind: NodeKind) -> Result<(Delta, MutationOut), String> {
        self.ensure(node)?;
        self.begin();
        self.edit(node, |r| {
            r.kind = kind;
            r.updated_at = now_ms();
        });
        let delta = self.commit(None)?;
        Ok((delta, MutationOut::default()))
    }

    pub fn set_highlighted(
        &mut self,
        node: Uuid,
        on: bool,
    ) -> Result<(Delta, MutationOut), String> {
        self.ensure(node)?;
        if self.nodes[&node].is_highlighted == on {
            return Ok((self.empty_delta(), MutationOut::default()));
        }
        self.begin();
        self.edit(node, |r| {
            r.is_highlighted = on;
            r.updated_at = now_ms();
        });
        let delta = self.commit(None)?;
        Ok((delta, MutationOut::default()))
    }

    // MARK: Multi-select block mutations (one transaction = one undo step)

    /// Defensive normalization: dedupe, keep only nodes sharing the FIRST node's parent,
    /// sort into canonical sibling order.
    fn normalized_block(&self, ids: &[Uuid]) -> Vec<Uuid> {
        let Some(first) = ids.iter().find(|x| self.nodes.contains_key(x)) else {
            return Vec::new();
        };
        let anchor_parent = self.nodes[first].parent;
        let mut seen = HashSet::new();
        let mut block: Vec<Uuid> = ids
            .iter()
            .filter(|x| {
                self.nodes
                    .get(x)
                    .map_or(false, |n| n.parent == anchor_parent)
                    && seen.insert(**x)
            })
            .copied()
            .collect();
        block.sort_by(|a, b| sibling_order(&self.nodes[a], &self.nodes[b]));
        block
    }

    /// Tab on a block: nest ALL members, in order, under the previous VISIBLE sibling of
    /// the block's first node (computed once up front — all-or-nothing).
    pub fn indent_block(
        &mut self,
        ids: &[Uuid],
        hide_completed: bool,
    ) -> Result<(Delta, MutationOut), String> {
        let block = self.normalized_block(ids);
        let Some(first) = block.first().copied() else {
            return Ok((self.empty_delta(), MutationOut::default()));
        };
        let sibs = self.sibling_ids(first);
        let Some(idx) = sibs.iter().position(|x| *x == first) else {
            return Ok((self.empty_delta(), MutationOut::default()));
        };
        let mut p = idx as i64 - 1;
        while p >= 0 && hide_completed && self.nodes[&sibs[p as usize]].is_completed {
            p -= 1;
        }
        if p < 0 {
            return Ok((self.empty_delta(), MutationOut::default()));
        }
        let new_parent = sibs[p as usize];
        if self.nodes[&new_parent].kind == NodeKind::Line {
            return Ok((self.empty_delta(), MutationOut::default()));
        }
        self.begin();
        let mut pos = self
            .ordered_children(new_parent)
            .last()
            .map(|k| self.nodes[k].position)
            .unwrap_or(-GAP);
        for node in &block {
            pos += GAP;
            self.edit(*node, |r| {
                r.parent = Some(new_parent);
                r.position = pos;
                r.updated_at = now_ms();
            });
        }
        let delta = self.commit(None)?;
        Ok((
            delta,
            MutationOut {
                expand: vec![new_parent],
                moved: true,
                ..Default::default()
            },
        ))
    }

    /// Shift+Tab on a block: every member becomes a sibling AFTER the old parent,
    /// preserving order (reverse iteration — each earlier member slots in above).
    pub fn outdent_block(&mut self, ids: &[Uuid]) -> Result<(Delta, MutationOut), String> {
        let block = self.normalized_block(ids);
        let Some(first) = block.first() else {
            return Ok((self.empty_delta(), MutationOut::default()));
        };
        let Some(parent) = self.nodes[first].parent else {
            return Ok((self.empty_delta(), MutationOut::default()));
        };
        self.begin();
        for node in block.iter().rev() {
            self.outdent_inner(*node, parent);
        }
        let delta = self.commit(None)?;
        Ok((
            delta,
            MutationOut {
                moved: true,
                ..Default::default()
            },
        ))
    }

    /// Option+Up/Down on a block: the members move as ONE unit past the nearest visible
    /// sibling beyond the block's edge. Hidden completed siblings keep their slot among
    /// the non-moved siblings while the block lands contiguously past the anchor.
    pub fn move_block_by(
        &mut self,
        ids: &[Uuid],
        offset: i64,
        hide_completed: bool,
    ) -> Result<(Delta, MutationOut), String> {
        let block = self.normalized_block(ids);
        let Some(first) = block.first() else {
            return Ok((self.empty_delta(), MutationOut::default()));
        };
        let sibs = self.sibling_ids(*first);
        let id_set: HashSet<Uuid> = block.iter().copied().collect();
        let dir: i64 = if offset < 0 { -1 } else { 1 };
        let member_idxs: Vec<usize> = sibs
            .iter()
            .enumerate()
            .filter(|(_, s)| id_set.contains(s))
            .map(|(i, _)| i)
            .collect();
        let edge = if dir < 0 {
            member_idxs.first()
        } else {
            member_idxs.last()
        };
        let Some(edge) = edge else {
            return Ok((self.empty_delta(), MutationOut::default()));
        };
        let mut target = *edge as i64 + dir;
        while target >= 0
            && (target as usize) < sibs.len()
            && hide_completed
            && self.nodes[&sibs[target as usize]].is_completed
        {
            target += dir;
        }
        if target < 0 || target as usize >= sibs.len() {
            return Ok((self.empty_delta(), MutationOut::default()));
        }
        let anchor = sibs[target as usize];
        let mut reordered: Vec<Uuid> = sibs
            .iter()
            .filter(|s| !id_set.contains(s))
            .copied()
            .collect();
        let Some(a_idx) = reordered.iter().position(|x| *x == anchor) else {
            return Ok((self.empty_delta(), MutationOut::default()));
        };
        let insert_at = if dir < 0 { a_idx } else { a_idx + 1 };
        for (i, id) in block.iter().enumerate() {
            reordered.insert(insert_at + i, *id);
        }
        self.begin();
        for (i, s) in reordered.iter().enumerate() {
            let new_pos = (i as i64) * GAP;
            if self.nodes[s].position != new_pos {
                self.edit(*s, |r| {
                    r.position = new_pos;
                    r.updated_at = now_ms();
                });
            }
        }
        let delta = self.commit(None)?;
        Ok((
            delta,
            MutationOut {
                moved: true,
                ..Default::default()
            },
        ))
    }

    /// ⌘Return on a block: UNIFORM toggle — any incomplete member → complete all; all
    /// complete → un-complete all. Dividers skipped.
    pub fn toggle_completed_block(&mut self, ids: &[Uuid]) -> Result<(Delta, MutationOut), String> {
        let block: Vec<Uuid> = self
            .normalized_block(ids)
            .into_iter()
            .filter(|x| self.nodes[x].kind != NodeKind::Line)
            .collect();
        if block.is_empty() {
            return Ok((self.empty_delta(), MutationOut::default()));
        }
        let mark_complete = block.iter().any(|x| !self.nodes[x].is_completed);
        let changing: Vec<Uuid> = block
            .into_iter()
            .filter(|x| self.nodes[x].is_completed != mark_complete)
            .collect();
        if changing.is_empty() {
            return Ok((self.empty_delta(), MutationOut::default()));
        }
        self.begin();
        for node in changing {
            self.edit(node, |r| {
                r.is_completed = mark_complete;
                if mark_complete {
                    r.is_highlighted = false;
                }
                r.completed_at = if mark_complete { Some(now_ms()) } else { None };
                r.updated_at = now_ms();
            });
        }
        let delta = self.commit(None)?;
        Ok((delta, MutationOut::default()))
    }

    /// ⌘1/2/3 on a block: set every member's kind. Dividers skipped.
    pub fn set_kind_block(
        &mut self,
        ids: &[Uuid],
        kind: NodeKind,
    ) -> Result<(Delta, MutationOut), String> {
        let changing: Vec<Uuid> = self
            .normalized_block(ids)
            .into_iter()
            .filter(|x| self.nodes[x].kind != NodeKind::Line && self.nodes[x].kind != kind)
            .collect();
        if changing.is_empty() {
            return Ok((self.empty_delta(), MutationOut::default()));
        }
        self.begin();
        for node in changing {
            self.edit(node, |r| {
                r.kind = kind;
                r.updated_at = now_ms();
            });
        }
        let delta = self.commit(None)?;
        Ok((delta, MutationOut::default()))
    }

    /// ⌘B on a block: UNIFORM toggle, the same all-or-nothing shape `toggle_completed_block`
    /// uses — if ANY member's text isn't bold end to end, bold every member whole; only when
    /// they all already are does it clear them. (Per-member toggling would flip a mixed
    /// selection into its own inverse, which reads as nothing having happened.)
    ///
    /// Members with no text are skipped rather than given an empty run: a `[0, 0]` range is
    /// not "bold", so leaving them in would make `full` false forever and the block could
    /// never be un-bolded. Dividers have no text of their own at all.
    pub fn toggle_bold_block(&mut self, ids: &[Uuid]) -> Result<(Delta, MutationOut), String> {
        let block: Vec<Uuid> = self
            .normalized_block(ids)
            .into_iter()
            .filter(|x| self.nodes[x].kind != NodeKind::Line && !self.nodes[x].text.is_empty())
            .collect();
        if block.is_empty() {
            return Ok((self.empty_delta(), MutationOut::default()));
        }
        let whole = |r: &NodeRec| -> Vec<i64> { vec![0, utf16_len(&r.text)] };
        let make_bold = block.iter().any(|x| self.nodes[x].bold_ranges != whole(&self.nodes[x]));
        self.begin();
        for node in block {
            let run = if make_bold {
                whole(&self.nodes[&node])
            } else {
                Vec::new()
            };
            self.edit(node, |r| {
                r.bold_ranges = run;
                r.updated_at = now_ms();
            });
        }
        let delta = self.commit(None)?;
        Ok((delta, MutationOut::default()))
    }

    /// The block in DOCUMENT order (pre-order, sibling order within a level), each node with
    /// its depth relative to the block's own level: every root at 0, then its subtree. Not
    /// "visible" order and not the flatten — collapse is per-window and the store has no
    /// window, so a collapsed or hide-completed-filtered node folds in like any other, the
    /// same nodes `delete_block` would take and `copySubtree` would copy. A DIVIDER
    /// contributes no line of its own —
    /// it renders no text, exactly as every caret path and the markdown copy treat one — but
    /// is still descended through. Explicit stack (never recursion) and cycle-guarded, like
    /// `descendants`, since imported data could be malformed.
    fn fold_lines(&self, roots: &[Uuid]) -> Vec<(Uuid, usize)> {
        let mut out = Vec::new();
        let mut seen = HashSet::new();
        let mut stack: Vec<(Uuid, usize)> = roots.iter().rev().map(|r| (*r, 0)).collect();
        while let Some((cur, depth)) = stack.pop() {
            let Some(rec) = self.nodes.get(&cur) else {
                continue;
            };
            if !seen.insert(cur) {
                continue;
            }
            if rec.kind != NodeKind::Line {
                out.push((cur, depth));
            }
            if let Some(kids) = self.children.get(&Some(cur)) {
                for k in kids.iter().rev() {
                    stack.push((*k, depth + 1));
                }
            }
        }
        out
    }

    /// ⌘3 on a block of NON-prompt nodes: FOLD it into its first member. That node becomes a
    /// `promptDraft` whose text is the whole selected BLOCK as an indented `"- "` list, and
    /// everything else in the block is deleted — the "collect these lines into one prompt"
    /// gesture, as opposed to `set_kind_block`, which converts each member into a prompt of
    /// its own.
    ///
    /// The block is not just the members: a selection is a sibling range with every member's
    /// SUBTREE tinted, so what the user sees selected spans levels. Each descendant therefore
    /// becomes its own bullet, indented two spaces per level below its member — the
    /// bullet-and-indent shape `subtreeLines` (⌘C) already writes to the clipboard. Folding
    /// used to take the members' text only and drop every descendant on the floor with the
    /// nodes; now nothing selected goes unmentioned.
    ///
    /// One transaction, so a single ⌘Z puts the whole block back. The HEAD's own children are
    /// deleted with the rest, because they are now IN its text — leaving them nested under
    /// the new prompt would show every folded line twice. It keeps its note and position,
    /// but NOT its completion: see the edit closure — a childless completed node is exactly
    /// what `archive::collect` sweeps away.
    /// A node's NOTE is not folded in: it is a second field rather than a line of the
    /// outline, and the head's own note survives as a note, so folding the others' in would
    /// put the same content in two different places depending on which member you swept
    /// first.
    ///
    /// Style runs are carried across rather than dropped: each LINE of each node lands at a
    /// known offset in the merged string, so its runs clip and shift by exactly that much
    /// (`push_clipped_ranges`). A node's own multi-line text keeps its shape too — later
    /// lines are indented to the bullet's TEXT column, so a wrapped thought stays visibly
    /// part of its bullet instead of resetting to the left margin.
    ///
    /// Dividers are skipped for the same reason ⌘1/2/3 never converts one — they are inert to
    /// kind operations — so a divider inside the range survives the merge at the top level,
    /// while one nested inside a folded subtree simply contributes no line before going with
    /// its parent.
    ///
    /// `new_node` names the HEAD: it is not newly created, but `MutationOut`'s contract for
    /// that field is "the node the calling window should focus", which is exactly what the
    /// caller wants next.
    pub fn merge_into_prompt(&mut self, ids: &[Uuid]) -> Result<(Delta, MutationOut), String> {
        const BULLET: &str = "- ";
        const INDENT: &str = "  ";
        /// What a continuation line hangs under: the bullet's width, spelled out rather
        /// than measured, since `BULLET.len()` is BYTES — the unit this function is
        /// otherwise at pains never to count in.
        const CONT: &str = "  ";
        let block: Vec<Uuid> = self
            .normalized_block(ids)
            .into_iter()
            .filter(|x| self.nodes[x].kind != NodeKind::Line)
            .collect();
        // Below two members there is nothing to merge; the caller falls back to set_kind.
        // Deliberately counts MEMBERS, not folded lines: ⌘3 on one node — with or without
        // children — is the ordinary "make this a prompt" conversion, and must not silently
        // eat its subtree.
        if block.len() < 2 {
            return Ok((self.empty_delta(), MutationOut::default()));
        }
        let head = block[0];
        // Composed BEFORE any mutation, so the whole text/run computation reads one
        // consistent tree and the transaction below is pure application.
        let lines = self.fold_lines(&block);
        let mut text = String::new();
        let mut bold: Vec<i64> = Vec::new();
        let mut italic: Vec<i64> = Vec::new();
        let mut underline: Vec<i64> = Vec::new();
        // Where the NEXT character lands in the merged text, in UTF-16 units.
        let mut off: i64 = 0;
        for (i, (id, depth)) in lines.iter().enumerate() {
            if i > 0 {
                text.push('\n');
                off += 1;
            }
            let pad = INDENT.repeat(*depth);
            // A continuation line hangs under the bullet's TEXT, not under its dash.
            let cont = format!("{pad}{CONT}");
            let rec = &self.nodes[id];
            // Offset of the current line within `rec.text`, in the same UTF-16 units.
            let mut src: i64 = 0;
            for (j, line) in rec.text.split('\n').enumerate() {
                if j > 0 {
                    text.push('\n');
                    off += 1;
                    src += 1;
                }
                // An empty continuation line takes no prefix — indenting nothing would
                // leave trailing whitespace on a blank line.
                let prefix = if j == 0 {
                    format!("{pad}{BULLET}")
                } else if line.is_empty() {
                    String::new()
                } else {
                    cont.clone()
                };
                text.push_str(&prefix);
                off += utf16_len(&prefix);
                let len = utf16_len(line);
                push_clipped_ranges(&mut bold, &rec.bold_ranges, src, src + len, off);
                push_clipped_ranges(&mut italic, &rec.italic_ranges, src, src + len, off);
                push_clipped_ranges(&mut underline, &rec.underline_ranges, src, src + len, off);
                text.push_str(line);
                off += len;
                src += len;
            }
        }
        self.begin();
        // Everything folded goes: the other members' subtrees, and the head's OWN children,
        // which are in its text now. Resolved as one set first, with the head removed from
        // it, so no subtree walk can take out the node the fold is becoming — `fold_lines`
        // is cycle-guarded but `descendants` is only guarded per call, and `rebuild_index`
        // files a self-parented row (a hand-corrupted store is the only way to get one)
        // under its own id, which would put the head in its own child list.
        let mut doomed: Vec<Uuid> = Vec::new();
        let mut seen: HashSet<Uuid> = HashSet::from([head]);
        for root in block[1..].iter().copied().chain(self.ordered_children(head)) {
            for id in self.descendants(root) {
                if seen.insert(id) {
                    doomed.push(id);
                }
            }
        }
        for id in doomed {
            self.touch(id);
            self.drop_node(id);
        }
        self.edit(head, |r| {
            r.kind = NodeKind::PromptDraft;
            r.text = text;
            r.bold_ranges = bold;
            r.italic_ranges = italic;
            r.underline_ranges = underline;
            // The head's own completion does NOT survive the fold — the one place this
            // diverges from `set_kind`/`set_kind_block`, which leave the flag alone. A kind
            // change keeps the node; a fold makes a NEW document out of many nodes, and
            // "done" described the one that no longer exists in that form. It would also be
            // arbitrary (whichever member was swept first decides) and can be false on its
            // face, since the merged text holds every unfinished line in the block — and
            // the caller focuses this panel to type in, which a struck-through dimmed row is
            // a poor invitation to do. Ageing out into the auto-archive as a childless
            // completed node is then one thing less that can happen to it; that state is
            // reachable plenty of other ways (delete a completed parent's children by any
            // means), so this is not a fix for the sweep, just one fewer way in.
            r.is_completed = false;
            r.completed_at = None;
            r.updated_at = now_ms();
        });
        let delta = self.commit(None)?;
        Ok((
            delta,
            MutationOut {
                new_node: Some(head),
                ..Default::default()
            },
        ))
    }

    /// Batch delete: every selected node (subtrees cascade), one undo step.
    pub fn delete_block(&mut self, ids: &[Uuid]) -> Result<(Delta, MutationOut), String> {
        let block = self.normalized_block(ids);
        if block.is_empty() {
            return Ok((self.empty_delta(), MutationOut::default()));
        }
        self.begin();
        for node in block {
            self.delete_subtree(node);
        }
        let delta = self.commit(None)?;
        Ok((delta, MutationOut::default()))
    }

    /// Group drag-drop: move the whole block contiguously (anchored composition — each
    /// member lands after the previously placed one). One block-level cycle pre-guard.
    pub fn move_block_to(
        &mut self,
        ids: &[Uuid],
        new_parent: Option<Uuid>,
        after: Option<Uuid>,
    ) -> Result<(Delta, MutationOut), String> {
        let block = self.normalized_block(ids);
        if block.is_empty() {
            return Ok((self.empty_delta(), MutationOut::default()));
        }
        let mut expand = Vec::new();
        if let Some(np) = new_parent {
            self.ensure(np)?;
            let block_ids: HashSet<Uuid> = block.iter().copied().collect();
            if block_ids.contains(&np) {
                return Ok((self.empty_delta(), MutationOut::default()));
            }
            if self.ancestors(np).iter().any(|a| block_ids.contains(a)) {
                return Ok((self.empty_delta(), MutationOut::default()));
            }
            if after.is_none() {
                expand.push(np);
            }
        }
        // A stale `after` (concurrently deleted drop target) would panic `position_after`'s
        // direct HashMap index under the held mutex — see `move_to`. No-op instead.
        if let Some(r) = after {
            if !self.nodes.contains_key(&r) {
                return Ok((self.empty_delta(), MutationOut::default()));
            }
        }
        self.begin();
        let mut anchor = after;
        for node in block {
            let pos = if let Some(r) = anchor {
                self.position_after(r)
            } else if let Some(np) = new_parent {
                self.first_child_position(np)
            } else {
                self.first_root_position()
            };
            self.edit(node, |rec| {
                rec.parent = new_parent;
                rec.position = pos;
                rec.updated_at = now_ms();
            });
            anchor = Some(node);
        }
        let delta = self.commit(None)?;
        Ok((
            delta,
            MutationOut {
                expand,
                moved: true,
                ..Default::default()
            },
        ))
    }

    // MARK: Bulk import / seed

    /// Insert a whole tree of records in one transaction (seed / import). Records must
    /// already carry consistent parent/position values.
    pub fn insert_tree(&mut self, recs: Vec<NodeRec>) -> Result<Delta, String> {
        self.begin();
        for rec in recs {
            self.insert_new(rec);
        }
        self.commit(None)
    }

    /// REPLACE the entire outline (import). NOT undoable: history is cleared, mirroring
    /// the SwiftUI app's detached-undo import.
    pub fn replace_all(&mut self, recs: Vec<NodeRec>) -> Result<Delta, String> {
        self.begin();
        for root in self.roots() {
            self.delete_subtree(root);
        }
        for rec in recs {
            self.insert_new(rec);
        }
        let delta = self.commit(None)?;
        self.clear_history();
        Ok(delta)
    }

    /// Archive-and-delete: remove the given roots (whole subtrees) in one NON-undoable
    /// step (the caller has already written the archive file).
    pub fn delete_archived(&mut self, roots: &[Uuid]) -> Result<Delta, String> {
        self.begin();
        for r in roots {
            if self.nodes.contains_key(r) {
                self.delete_subtree(*r);
            }
        }
        let delta = self.commit(None)?;
        // A post-archive undo must not resurrect nodes that now live only on disk.
        self.clear_history();
        Ok(delta)
    }

    // MARK: App settings (device-local key/value, e.g. the auto-archive toggle)

    pub fn get_setting(&self, key: &str) -> Option<String> {
        self.db
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                [key],
                |row| row.get::<_, String>(0),
            )
            .ok()
    }

    pub fn set_setting(&mut self, key: &str, value: &str) -> Result<(), String> {
        self.db
            .execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [key, value],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    fn ensure(&self, id: Uuid) -> Result<(), String> {
        if self.nodes.contains_key(&id) {
            Ok(())
        } else {
            Err(format!("node {id} not found"))
        }
    }
}

#[cfg(test)]
impl Store {
    pub fn open_in_memory_for_tests() -> Store {
        Store {
            nodes: HashMap::new(),
            children: HashMap::new(),
            rev: 0,
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            tx: None,
            db: persist::open_in_memory().unwrap(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem_store() -> Store {
        Store::open_in_memory_for_tests()
    }

    #[test]
    fn append_and_order() {
        let mut s = mem_store();
        let (_, a) = s.append_root(NodeKind::BulletPoint).unwrap();
        let (_, b) = s.append_root(NodeKind::BulletPoint).unwrap();
        let roots = s.roots();
        assert_eq!(roots, vec![a.new_node.unwrap(), b.new_node.unwrap()]);
    }

    #[test]
    fn split_ranges_clips_and_rebases() {
        // "abcdef" bold [1,4] ("bcde"), split at 3 → head "abc" bold [1,2] ("bc"),
        // tail "def" bold [0,2] ("de"); a run entirely after the split rebases whole.
        assert_eq!(split_ranges(&[1, 4], 3), (vec![1, 2], vec![0, 2]));
        assert_eq!(split_ranges(&[4, 2], 3), (vec![], vec![1, 2]));
        assert_eq!(split_ranges(&[0, 2], 3), (vec![0, 2], vec![]));
    }

    #[test]
    fn toggle_bold_block_is_uniform() {
        let mut s = mem_store();
        let (_, a) = s.append_root(NodeKind::BulletPoint).unwrap();
        let a = a.new_node.unwrap();
        let (_, b) = s.append_root(NodeKind::BulletPoint).unwrap();
        let b = b.new_node.unwrap();
        s.set_text(a, "alpha".into(), Some(vec![0, 5]), None, None).unwrap();
        s.set_text(b, "beta".into(), None, None, None).unwrap();
        // MIXED (a whole-bold, b not) ⇒ bold everything, never per-member inversion.
        s.toggle_bold_block(&[a, b]).unwrap();
        assert_eq!(s.get(a).unwrap().bold_ranges, vec![0, 5]);
        assert_eq!(s.get(b).unwrap().bold_ranges, vec![0, 4]);
        // Now all bold ⇒ clear.
        s.toggle_bold_block(&[a, b]).unwrap();
        assert_eq!(s.get(a).unwrap().bold_ranges, Vec::<i64>::new());
        assert_eq!(s.get(b).unwrap().bold_ranges, Vec::<i64>::new());
    }

    #[test]
    fn toggle_bold_block_counts_utf16_units() {
        let mut s = mem_store();
        let (_, a) = s.append_root(NodeKind::BulletPoint).unwrap();
        let a = a.new_node.unwrap();
        // "é" is 2 BYTES but 1 UTF-16 unit; "😀" is 4 bytes and 2 units. A byte length
        // here would push every later run past the end of the text.
        s.set_text(a, "é😀x".into(), None, None, None).unwrap();
        s.toggle_bold_block(&[a]).unwrap();
        assert_eq!(s.get(a).unwrap().bold_ranges, vec![0, 4]);
    }

    #[test]
    fn merge_into_prompt_folds_block_and_shifts_runs() {
        let mut s = mem_store();
        let (_, a) = s.append_root(NodeKind::BulletPoint).unwrap();
        let a = a.new_node.unwrap();
        let (_, b) = s.append_root(NodeKind::Checkbox).unwrap();
        let b = b.new_node.unwrap();
        let (_, c) = s.append_root(NodeKind::BulletPoint).unwrap();
        let c = c.new_node.unwrap();
        s.set_text(a, "one".into(), Some(vec![0, 3]), None, None).unwrap();
        s.set_text(b, "two".into(), Some(vec![1, 2]), None, None).unwrap();
        s.set_text(c, "three".into(), None, None, None).unwrap();
        // b gets a child, to pin that a folded member takes its subtree with it — as a
        // nested bullet in the text, and as a deleted node.
        let (_, kid) = s.append_child(b, NodeKind::BulletPoint).unwrap();
        let kid = kid.new_node.unwrap();
        s.set_text(kid, "kid".into(), None, None, None).unwrap();

        let (_, out) = s.merge_into_prompt(&[a, b, c]).unwrap();
        assert_eq!(out.new_node, Some(a));
        let head = s.get(a).unwrap();
        assert_eq!(head.kind, NodeKind::PromptDraft);
        assert_eq!(head.text, "- one\n- two\n  - kid\n- three");
        // "- one" bold [2,3]; "- two" starts at 6, its "wo" run at 6+2+1 = 9.
        assert_eq!(head.bold_ranges, vec![2, 3, 9, 2]);
        assert!(s.get(b).is_none());
        assert!(s.get(c).is_none());
        assert!(s.get(kid).is_none());
        assert_eq!(s.roots(), vec![a]);
        // ONE undo step puts the whole block back.
        s.undo().unwrap();
        assert_eq!(s.get(a).unwrap().text, "one");
        assert_eq!(s.get(a).unwrap().kind, NodeKind::BulletPoint);
        assert_eq!(s.roots(), vec![a, b, c]);
        assert!(s.get(kid).is_some());
    }

    /// A selection is a sibling range with every member's SUBTREE tinted, so the block the
    /// user sees spans levels — and the fold has to say so. Each descendant is its own
    /// bullet, two spaces deeper per level, and the head's own children come along with the
    /// rest (they are in the text now).
    #[test]
    fn merge_into_prompt_nests_descendants_by_depth() {
        let mut s = mem_store();
        let (_, a) = s.append_root(NodeKind::BulletPoint).unwrap();
        let a = a.new_node.unwrap();
        let (_, b) = s.append_root(NodeKind::BulletPoint).unwrap();
        let b = b.new_node.unwrap();
        s.set_text(a, "Alpha".into(), None, None, None).unwrap();
        s.set_text(b, "Beta".into(), None, None, None).unwrap();
        // a ▸ a1 ▸ a1x, a ▸ a2 — the head's own subtree, two levels deep.
        let (_, a1) = s.append_child(a, NodeKind::BulletPoint).unwrap();
        let a1 = a1.new_node.unwrap();
        let (_, a1x) = s.append_child(a1, NodeKind::Checkbox).unwrap();
        let a1x = a1x.new_node.unwrap();
        let (_, a2) = s.append_child(a, NodeKind::BulletPoint).unwrap();
        let a2 = a2.new_node.unwrap();
        let (_, b1) = s.append_child(b, NodeKind::BulletPoint).unwrap();
        let b1 = b1.new_node.unwrap();
        s.set_text(a1, "Child one".into(), None, None, None).unwrap();
        s.set_text(a1x, "Grandchild".into(), Some(vec![0, 5]), None, None)
            .unwrap();
        s.set_text(a2, "Child two".into(), None, None, None).unwrap();
        s.set_text(b1, "Beta's child".into(), None, None, None).unwrap();

        let (_, out) = s.merge_into_prompt(&[a, b]).unwrap();
        assert_eq!(out.new_node, Some(a));
        let head = s.get(a).unwrap();
        assert_eq!(head.kind, NodeKind::PromptDraft);
        assert_eq!(
            head.text,
            "- Alpha\n  - Child one\n    - Grandchild\n  - Child two\n- Beta\n  - Beta's child"
        );
        // "Grandchild" starts after "- Alpha\n  - Child one\n    - " = 8+14+6 = 28.
        assert_eq!(head.bold_ranges, vec![28, 5]);
        // Everything folded is gone — the head's own children included, or every line
        // would show twice (once as text, once as a child of the new prompt).
        for id in [b, a1, a1x, a2, b1] {
            assert!(s.get(id).is_none());
        }
        assert_eq!(s.roots(), vec![a]);
        // Still ONE undo step, whole subtrees and all.
        s.undo().unwrap();
        assert_eq!(s.get(a).unwrap().text, "Alpha");
        assert_eq!(s.ordered_children(a), vec![a1, a2]);
        assert_eq!(s.ordered_children(a1), vec![a1x]);
        assert_eq!(s.get(b1).unwrap().text, "Beta's child");
    }

    /// A node's own text can hold newlines (⇧Enter). Its later lines hang under the
    /// bullet's TEXT column, so the list shape survives — and a run spanning the newline
    /// clips into one run per line rather than sliding by the indent it never saw.
    #[test]
    fn merge_into_prompt_indents_a_members_own_newlines() {
        let mut s = mem_store();
        let (_, a) = s.append_root(NodeKind::BulletPoint).unwrap();
        let a = a.new_node.unwrap();
        let (_, b) = s.append_root(NodeKind::BulletPoint).unwrap();
        let b = b.new_node.unwrap();
        s.set_text(a, "head".into(), None, None, None).unwrap();
        let (_, kid) = s.append_child(a, NodeKind::BulletPoint).unwrap();
        let kid = kid.new_node.unwrap();
        // "one\ntwo" with a bold run covering both lines AND the newline between them.
        s.set_text(kid, "one\ntwo".into(), Some(vec![0, 7]), None, None)
            .unwrap();
        s.set_text(b, "tail".into(), None, None, None).unwrap();

        s.merge_into_prompt(&[a, b]).unwrap();
        let head = s.get(a).unwrap();
        assert_eq!(head.text, "- head\n  - one\n    two\n- tail");
        // "one" at 11 (after "- head\n  - "), "two" at 4 further on: 11+3+1+4 = 19.
        assert_eq!(head.bold_ranges, vec![11, 3, 19, 3]);

        // A BLANK line inside a node takes no prefix — indenting nothing would leave
        // trailing whitespace on an empty line, which is all a reader would see of it.
        s.undo().unwrap();
        s.set_text(kid, "one\n\ntwo".into(), None, None, None).unwrap();
        s.merge_into_prompt(&[a, b]).unwrap();
        assert_eq!(s.get(a).unwrap().text, "- head\n  - one\n\n    two\n- tail");
    }

    /// UTF-16 units, not bytes: the indent has to be measured in the same units the runs
    /// are, or one non-ASCII bullet puts every later run past the end of the text.
    #[test]
    fn merge_into_prompt_counts_utf16_across_levels() {
        let mut s = mem_store();
        let (_, a) = s.append_root(NodeKind::BulletPoint).unwrap();
        let a = a.new_node.unwrap();
        let (_, b) = s.append_root(NodeKind::BulletPoint).unwrap();
        let b = b.new_node.unwrap();
        s.set_text(a, "é😀".into(), None, None, None).unwrap();
        let (_, kid) = s.append_child(a, NodeKind::BulletPoint).unwrap();
        let kid = kid.new_node.unwrap();
        s.set_text(kid, "xy".into(), Some(vec![1, 1]), None, None)
            .unwrap();
        s.set_text(b, "z".into(), None, None, None).unwrap();

        s.merge_into_prompt(&[a, b]).unwrap();
        let head = s.get(a).unwrap();
        assert_eq!(head.text, "- é😀\n  - xy\n- z");
        // "- é😀" is 5 UTF-16 units, + "\n" + "  - " = 10, so "y" is at 11.
        assert_eq!(head.bold_ranges, vec![11, 1]);
    }

    /// The head comes out UNCOMPLETED however it went in. Deleting its children while
    /// keeping it is unique to this mutation, and `archive::collect` qualifies a completed
    /// node only when every child qualifies — so those unfinished children were the guard
    /// keeping an old completed parent out of the auto-sweep. Leaving the stamp on the
    /// childless result would let the sweep archive (and delete, un-undoably) the prompt the
    /// user just built.
    #[test]
    fn merge_into_prompt_clears_the_heads_completion() {
        let mut s = mem_store();
        let (_, a) = s.append_root(NodeKind::Checkbox).unwrap();
        let a = a.new_node.unwrap();
        let (_, b) = s.append_root(NodeKind::Checkbox).unwrap();
        let b = b.new_node.unwrap();
        s.set_text(a, "old parent".into(), None, None, None).unwrap();
        s.set_text(b, "sibling".into(), None, None, None).unwrap();
        let (_, kid) = s.append_child(a, NodeKind::Checkbox).unwrap();
        let kid = kid.new_node.unwrap();
        s.set_text(kid, "unfinished".into(), None, None, None).unwrap();
        // Completed four days ago — past the archive sweep's three-day retention.
        s.toggle_completed(a).unwrap();
        let stale = now_ms() - 4 * 24 * 60 * 60 * 1000;
        s.begin();
        s.edit(a, |r| r.completed_at = Some(stale));
        s.commit(None).unwrap();
        // Its unfinished child is what keeps it out of the sweep today.
        assert!(crate::archive::collect(&s, Some(now_ms() - crate::archive::RETENTION_MS)).is_empty());

        s.merge_into_prompt(&[a, b]).unwrap();
        let head = s.get(a).unwrap();
        assert_eq!(head.text, "- old parent\n  - unfinished\n- sibling");
        assert!(!head.is_completed);
        assert_eq!(head.completed_at, None);
        assert!(crate::archive::collect(&s, Some(now_ms() - crate::archive::RETENTION_MS)).is_empty());
    }

    /// Only a hand-corrupted store can put a parent cycle through the head, but the delete
    /// pass must not be the thing that trips over one: a self-parented row lands in its own
    /// child list, and a subtree walk from there would drop the very node the fold is
    /// becoming — leaving the composed text nowhere to land and `new_node` naming a corpse.
    #[test]
    fn merge_into_prompt_survives_a_self_parented_head() {
        let mut s = mem_store();
        let (_, a) = s.append_root(NodeKind::BulletPoint).unwrap();
        let a = a.new_node.unwrap();
        let (_, b) = s.append_root(NodeKind::BulletPoint).unwrap();
        let b = b.new_node.unwrap();
        s.set_text(a, "one".into(), None, None, None).unwrap();
        s.set_text(b, "two".into(), None, None, None).unwrap();
        // What loading a corrupted row looks like: the head is filed under itself.
        s.children.entry(Some(a)).or_default().push(a);

        let (_, out) = s.merge_into_prompt(&[a, b]).unwrap();
        assert_eq!(out.new_node, Some(a));
        let head = s.get(a).expect("the head must survive its own child list");
        assert_eq!(head.kind, NodeKind::PromptDraft);
        assert_eq!(head.text, "- one\n- two");
    }

    /// A divider nested inside a folded subtree renders no text, so it contributes no
    /// bullet — but it still goes with its parent, exactly as `delete_block` takes it.
    #[test]
    fn merge_into_prompt_folds_over_a_nested_divider() {
        let mut s = mem_store();
        let (_, a) = s.append_root(NodeKind::BulletPoint).unwrap();
        let a = a.new_node.unwrap();
        let (_, b) = s.append_root(NodeKind::BulletPoint).unwrap();
        let b = b.new_node.unwrap();
        s.set_text(a, "one".into(), None, None, None).unwrap();
        s.set_text(b, "two".into(), None, None, None).unwrap();
        let (_, rule) = s.append_child(a, NodeKind::Line).unwrap();
        let rule = rule.new_node.unwrap();
        let (_, after) = s.append_child(a, NodeKind::BulletPoint).unwrap();
        let after = after.new_node.unwrap();
        s.set_text(after, "after the rule".into(), None, None, None)
            .unwrap();

        s.merge_into_prompt(&[a, b]).unwrap();
        assert_eq!(s.get(a).unwrap().text, "- one\n  - after the rule\n- two");
        assert!(s.get(rule).is_none());
    }

    #[test]
    fn merge_into_prompt_skips_dividers_and_needs_two() {
        let mut s = mem_store();
        let (_, a) = s.append_root(NodeKind::BulletPoint).unwrap();
        let a = a.new_node.unwrap();
        let (_, d) = s.append_root(NodeKind::Line).unwrap();
        let d = d.new_node.unwrap();
        s.set_text(a, "solo".into(), None, None, None).unwrap();
        // One mergeable member + a divider is not a merge: nothing happens at all.
        let (delta, out) = s.merge_into_prompt(&[a, d]).unwrap();
        assert!(delta.ops.is_empty());
        assert_eq!(out.new_node, None);
        assert_eq!(s.get(a).unwrap().kind, NodeKind::BulletPoint);
        // With a second real member the divider is left standing, not folded or deleted.
        let (_, b) = s.append_root(NodeKind::BulletPoint).unwrap();
        let b = b.new_node.unwrap();
        s.set_text(b, "two".into(), None, None, None).unwrap();
        s.merge_into_prompt(&[a, d, b]).unwrap();
        assert_eq!(s.get(a).unwrap().text, "- solo\n- two");
        assert_eq!(s.get(d).unwrap().kind, NodeKind::Line);
        assert!(s.get(b).is_none());
    }

    #[test]
    fn commit_new_node_splits_style_runs() {
        let mut s = mem_store();
        let (_, a) = s.append_root(NodeKind::BulletPoint).unwrap();
        let a = a.new_node.unwrap();
        s.set_text(a, "abcdef".into(), Some(vec![1, 4]), Some(vec![0, 6]), None)
            .unwrap();
        let (_, out) = s
            .commit_new_node(a, "abc".into(), "def".into(), false, false)
            .unwrap();
        let b = out.new_node.unwrap();
        assert_eq!(s.get(a).unwrap().bold_ranges, vec![1, 2]);
        assert_eq!(s.get(a).unwrap().italic_ranges, vec![0, 3]);
        assert_eq!(s.get(b).unwrap().bold_ranges, vec![0, 2]);
        assert_eq!(s.get(b).unwrap().italic_ranges, vec![0, 3]);
    }

    #[test]
    fn commit_new_node_sibling_and_first_child() {
        let mut s = mem_store();
        let (_, a) = s.append_root(NodeKind::Checkbox).unwrap();
        let a = a.new_node.unwrap();
        // Leaf: Enter → next sibling, inherits kind.
        let (_, b) = s
            .commit_new_node(a, "left".into(), "right".into(), true, false)
            .unwrap();
        let b = b.new_node.unwrap();
        assert_eq!(s.get(a).unwrap().text, "left");
        assert_eq!(s.get(b).unwrap().text, "right");
        assert_eq!(s.get(b).unwrap().kind, NodeKind::Checkbox);
        assert_eq!(s.roots(), vec![a, b]);
        // Give a a child; Enter on expanded a → new FIRST child inheriting top child's kind.
        let (_, c) = s.append_child(a, NodeKind::PromptDraft).unwrap();
        let c = c.new_node.unwrap();
        let (_, d) = s
            .commit_new_node(a, "left".into(), "".into(), true, false)
            .unwrap();
        let d = d.new_node.unwrap();
        assert_eq!(s.ordered_children(a), vec![d, c]);
        assert_eq!(s.get(d).unwrap().kind, NodeKind::PromptDraft);
    }

    #[test]
    fn indent_outdent_roundtrip() {
        let mut s = mem_store();
        let (_, a) = s.append_root(NodeKind::BulletPoint).unwrap();
        let a = a.new_node.unwrap();
        let (_, b) = s.append_root(NodeKind::BulletPoint).unwrap();
        let b = b.new_node.unwrap();
        s.indent(b, false).unwrap();
        assert_eq!(s.ordered_children(a), vec![b]);
        s.outdent(b).unwrap();
        assert_eq!(s.roots(), vec![a, b]);
    }

    #[test]
    fn undo_redo_structure() {
        let mut s = mem_store();
        let (_, a) = s.append_root(NodeKind::BulletPoint).unwrap();
        let a = a.new_node.unwrap();
        let (_, b) = s.append_root(NodeKind::BulletPoint).unwrap();
        let b = b.new_node.unwrap();
        s.indent(b, false).unwrap();
        assert_eq!(s.ordered_children(a), vec![b]);
        s.undo().unwrap();
        assert_eq!(s.roots(), vec![a, b]);
        assert!(s.get(b).unwrap().parent.is_none());
        s.redo().unwrap();
        assert_eq!(s.ordered_children(a), vec![b]);
    }

    #[test]
    fn text_coalescing_is_one_undo() {
        let mut s = mem_store();
        let (_, a) = s.append_root(NodeKind::BulletPoint).unwrap();
        let a = a.new_node.unwrap();
        s.set_text(a, "h".into(), None, None, None).unwrap();
        s.set_text(a, "he".into(), None, None, None).unwrap();
        s.set_text(a, "hello".into(), None, None, None).unwrap();
        s.undo().unwrap();
        assert_eq!(s.get(a).unwrap().text, "");
    }

    #[test]
    fn delete_cascades_and_undo_restores() {
        let mut s = mem_store();
        let (_, a) = s.append_root(NodeKind::BulletPoint).unwrap();
        let a = a.new_node.unwrap();
        let (_, b) = s.append_child(a, NodeKind::BulletPoint).unwrap();
        let b = b.new_node.unwrap();
        let (_, c) = s.append_child(b, NodeKind::BulletPoint).unwrap();
        let c = c.new_node.unwrap();
        s.delete(a).unwrap();
        assert_eq!(s.node_count(), 0);
        s.undo().unwrap();
        assert_eq!(s.node_count(), 3);
        assert_eq!(s.ordered_children(a), vec![b]);
        assert_eq!(s.ordered_children(b), vec![c]);
    }

    #[test]
    fn gap_compaction() {
        let mut s = mem_store();
        let (_, a) = s.append_root(NodeKind::BulletPoint).unwrap();
        let mut prev = a.new_node.unwrap();
        // Repeatedly inserting after the same node halves the gap — force compaction.
        let first = prev;
        for _ in 0..15 {
            let (_, out) = s.insert_sibling_after(first, NodeKind::BulletPoint).unwrap();
            prev = out.new_node.unwrap();
            let _ = prev;
        }
        assert_eq!(s.roots().len(), 16);
        // All positions distinct and ordered.
        let positions: Vec<i64> = s.roots().iter().map(|r| s.get(*r).unwrap().position).collect();
        let mut sorted = positions.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), positions.len());
    }

    #[test]
    fn move_to_stale_after_is_noop_not_panic() {
        // A drag whose `after` target was deleted concurrently must NOT panic the store
        // (which would poison the mutex for every window) — it does nothing.
        let mut s = mem_store();
        let (_, a) = s.append_root(NodeKind::BulletPoint).unwrap();
        let a = a.new_node.unwrap();
        let (_, b) = s.append_root(NodeKind::BulletPoint).unwrap();
        let b = b.new_node.unwrap();
        let ghost = Uuid::new_v4(); // never in the store
        let (delta, out) = s.move_to(b, None, Some(ghost)).unwrap();
        assert!(delta.ops.is_empty(), "stale drop target should move nothing");
        assert!(!out.moved);
        assert_eq!(s.roots(), vec![a, b]); // unchanged
        // The block variant too.
        let (delta2, _) = s.move_block_to(&[b], None, Some(ghost)).unwrap();
        assert!(delta2.ops.is_empty());
        assert_eq!(s.roots(), vec![a, b]);
    }

    #[test]
    fn block_move_and_toggle() {
        let mut s = mem_store();
        let mut ids = Vec::new();
        for _ in 0..4 {
            let (_, o) = s.append_root(NodeKind::Checkbox).unwrap();
            ids.push(o.new_node.unwrap());
        }
        // Move the first two down past the third.
        let block = [ids[0], ids[1]];
        let (_, out) = s.move_block_by(&block, 1, false).unwrap();
        assert!(out.moved);
        assert_eq!(s.roots(), vec![ids[2], ids[0], ids[1], ids[3]]);
        // Uniform toggle: mixed → all complete; one undo step restores.
        s.toggle_completed(ids[3]).unwrap();
        s.toggle_completed_block(&ids).unwrap();
        assert!(ids.iter().all(|i| s.get(*i).unwrap().is_completed));
    }
}
