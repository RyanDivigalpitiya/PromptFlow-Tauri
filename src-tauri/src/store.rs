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
        persist::apply(&mut self.db, changes.iter().map(|c| (c.id, c.after.as_ref())))?;
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
        let mut ops = Vec::new();
        for ch in &entry.changes {
            self.apply_image(ch.id, ch.before.clone(), &mut ops);
        }
        persist::apply(
            &mut self.db,
            entry.changes.iter().map(|c| (c.id, c.before.as_ref())),
        )?;
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
        let mut ops = Vec::new();
        for ch in &entry.changes {
            self.apply_image(ch.id, ch.after.clone(), &mut ops);
        }
        persist::apply(
            &mut self.db,
            entry.changes.iter().map(|c| (c.id, c.after.as_ref())),
        )?;
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
    /// state for `node` (collapse is per-window).
    pub fn commit_new_node(
        &mut self,
        node: Uuid,
        before: String,
        after: String,
        expanded_in_window: bool,
        hide_completed: bool,
    ) -> Result<(Delta, MutationOut), String> {
        self.ensure(node)?;
        self.begin();
        self.edit(node, |r| {
            r.text = before;
            r.updated_at = now_ms();
        });
        let new_rec = if expanded_in_window && self.has_children(node) {
            let kind = self.top_child_kind(node, hide_completed);
            let pos = self.first_child_position(node);
            NodeRec::new(after, kind, Some(node), pos)
        } else {
            let kind = self.nodes[&node].kind.inheritable();
            let pos = self.position_after(node);
            let parent = self.nodes[&node].parent;
            NodeRec::new(after, kind, parent, pos)
        };
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
    ) -> Result<(Delta, MutationOut), String> {
        self.ensure(node)?;
        self.begin();
        self.edit(node, |r| {
            r.text = text;
            if let Some(b) = bold_ranges {
                r.bold_ranges = b;
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

    fn ensure(&self, id: Uuid) -> Result<(), String> {
        if self.nodes.contains_key(&id) {
            Ok(())
        } else {
            Err(format!("node {id} not found"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem_store() -> Store {
        let db = persist::open_in_memory().unwrap();
        Store {
            nodes: HashMap::new(),
            children: HashMap::new(),
            rev: 0,
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            tx: None,
            db,
        }
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
        s.set_text(a, "h".into(), None).unwrap();
        s.set_text(a, "he".into(), None).unwrap();
        s.set_text(a, "hello".into(), None).unwrap();
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
