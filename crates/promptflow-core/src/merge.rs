//! Per-node last-writer-wins merge with TWO clocks — the one implementation of the
//! protocol's §3.4, used by:
//!   * the hub, merging a pushed op into its stored state;
//!   * the Tauri client, merging a pulled op or a push response's `current` into local
//!     state;
//!   * the Swift client, which hand-mirrors it and is pinned to this one by the shared
//!     fixtures in `fixtures/merge_vectors.json`.
//!
//! TIE POLICY (global): **the hub is canonical, and ties converge to hub state.** On
//! the hub an equal clock means the stored value stands; on a client an equal clock
//! means the incoming hub value wins. Strictly-newer always wins on both sides. There
//! is no per-device tie-break state to persist anywhere: a pusher that loses a tie
//! learns the winner from `results[].current` in the same round trip.

use crate::model::GAP;
use crate::wire::{Current, Outcome, Reason, TombstoneRef, WireNode};
use uuid::Uuid;

/// Which side of the protocol is merging. The ONLY thing it changes is who wins an
/// exactly-equal clock.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    /// The hub: stored state stands on a tie.
    Hub,
    /// A device: the incoming hub value wins on a tie.
    Client,
}

impl Side {
    /// Does `incoming` beat `stored` for one clock group?
    fn beats(self, incoming: i64, stored: i64) -> bool {
        match self {
            Side::Hub => incoming > stored,
            Side::Client => incoming >= stored,
        }
    }
}

/// What the merger currently holds for the node being merged.
#[derive(Debug, Clone, PartialEq)]
pub enum Stored {
    /// No row at all — never seen, or dropped by a compaction that also dropped the
    /// tombstone.
    Missing,
    Live(Box<WireNode>),
    Tombstone { deleted_at: i64 },
}

impl Stored {
    pub fn live(n: WireNode) -> Self {
        Stored::Live(Box::new(n))
    }
}

/// Enough of the tree to validate a structure change without handing the merger the
/// whole store. Implemented over rusqlite on the hub and over the in-memory mirror on
/// the Tauri client.
pub trait TreeLookup {
    /// The node's parent, and whether it exists at all / is tombstoned.
    fn state(&self, id: Uuid) -> NodeState;

    /// Where a repaired node lands when its parent is gone: `max(root positions) + GAP`.
    /// Implementations must reflect writes made earlier in the SAME transaction, so two
    /// nodes repaired by one push do not collide on a position.
    fn max_root_position(&self) -> Option<i64>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeState {
    Missing,
    Live { parent: Option<Uuid> },
    Deleted,
}

/// A parent that is missing or tombstoned cannot hold a child.
fn parent_is_usable<T: TreeLookup>(tree: &T, parent: Option<Uuid>) -> bool {
    match parent {
        None => true, // the root list always exists
        Some(p) => matches!(tree.state(p), NodeState::Live { .. }),
    }
}

/// Would parenting `node` under `parent` close a loop? Walks the PROPOSED ancestors
/// through stored parenthood. Bounded by a visited set, because a store that already
/// holds a cycle (hand-corrupted data, an import) must make this return true rather
/// than spin.
fn would_cycle<T: TreeLookup>(tree: &T, node: Uuid, parent: Option<Uuid>) -> bool {
    let mut cur = parent;
    let mut seen = std::collections::HashSet::new();
    while let Some(p) = cur {
        if p == node {
            return true;
        }
        if !seen.insert(p) {
            return true; // an existing loop above us — treat as a cycle
        }
        cur = match tree.state(p) {
            NodeState::Live { parent } => parent,
            // A dead or missing ancestor ends the walk; the parent repair below deals
            // with it.
            _ => return false,
        };
    }
    false
}

/// Reparent `n` to the root list if its parent cannot hold it. Returns whether it
/// changed anything. The position is `max(root positions) + GAP` so a repaired node
/// lands at the END of the outline rather than silently interleaving with real work.
fn repair_parent<T: TreeLookup>(tree: &T, n: &mut WireNode) -> bool {
    if parent_is_usable(tree, n.parent) {
        return false;
    }
    n.parent = None;
    n.position = tree.max_root_position().map_or(0, |m| m + GAP);
    true
}

/// The outcome of merging one upsert.
#[derive(Debug, Clone, PartialEq)]
pub struct UpsertMerge {
    pub outcome: Outcome,
    pub reason: Option<Reason>,
    /// The row to store. `None` = the merged result is byte-identical to what is
    /// already stored, so nothing is written, no oplog entry is appended and no
    /// sequence is burned. This is what makes a full-state re-push free (T6).
    pub write: Option<WireNode>,
    /// The resulting stored state, when it differs from what the caller pushed. The
    /// pusher applies it through its own merge path and is immediately converged.
    pub current: Option<Current>,
    /// True when tree validation moved the result away from BOTH sides' intent — the
    /// hub logs these to the oplog under the reserved `"server"` device id.
    pub repaired: bool,
}

/// Merge an incoming upsert against stored state.
pub fn merge_upsert<T: TreeLookup>(
    incoming: &WireNode,
    stored: &Stored,
    tree: &T,
    side: Side,
) -> UpsertMerge {
    match stored {
        Stored::Missing => insert_fresh(incoming, tree),

        Stored::Tombstone { deleted_at } => {
            // Resurrect only if the node was touched AFTER it died. The clock compared
            // is the newer of the two: a pure move of a node someone else deleted is
            // just as much a "this still matters" signal as retyping its text.
            if incoming.newest_clock() > *deleted_at {
                // A resurrected node whose parent is dead or missing goes to root.
                // Its own previously-tombstoned descendants deliberately STAY dead:
                // resurrect brings back the node, not the subtree.
                insert_fresh(incoming, tree)
            } else {
                UpsertMerge {
                    outcome: Outcome::Rejected,
                    reason: Some(Reason::Tombstone),
                    write: None,
                    current: Some(Current::Tombstone(TombstoneRef {
                        id: incoming.id,
                        deleted_at: *deleted_at,
                    })),
                    repaired: false,
                }
            }
        }

        Stored::Live(s) => merge_live(incoming, s, tree, side),
    }
}

/// The insert / resurrect path: the incoming node is taken whole, then validated.
fn insert_fresh<T: TreeLookup>(incoming: &WireNode, tree: &T) -> UpsertMerge {
    let mut n = incoming.clone();
    let mut reason = None;
    // A self-parent (or a parent whose own ancestry already loops back here) is the
    // only cycle a fresh insert can carry, and it is not a merge conflict — it is
    // malformed input. Drop it to root like any other unusable parent.
    if would_cycle(tree, n.id, n.parent) {
        n.parent = None;
        n.position = tree.max_root_position().map_or(0, |m| m + GAP);
        reason = Some(Reason::Invalid);
    }
    let repaired = repair_parent(tree, &mut n) || reason.is_some();
    let differs = n != *incoming;
    UpsertMerge {
        outcome: if differs {
            Outcome::Partial
        } else {
            Outcome::Applied
        },
        reason: if differs { reason } else { None },
        current: differs.then(|| Current::node(n.clone())),
        write: Some(n),
        repaired,
    }
}

fn merge_live<T: TreeLookup>(
    incoming: &WireNode,
    stored: &WireNode,
    tree: &T,
    side: Side,
) -> UpsertMerge {
    let content_wins = side.beats(incoming.updated_at, stored.updated_at);
    let structure_wins = side.beats(incoming.structure_updated_at, stored.structure_updated_at);

    let mut n = stored.clone();
    if content_wins {
        n.take_content(incoming);
    }
    let mut structure_rejected = false;
    if structure_wins {
        n.take_structure(incoming);
        // (b) A structure change that would close a loop is rejected WHOLESALE — the
        // stored structure group is kept in full — while the content merge still
        // stands. Deterministic on both sides, so two devices that moved each other's
        // nodes converge acyclic whichever push arrives second (T13).
        if would_cycle(tree, n.id, n.parent) {
            n.take_structure(stored);
            structure_rejected = true;
        }
    }

    // (a) A parent that is missing or tombstoned cannot hold this node. Only run the
    // repair when the structure group actually came from the incoming op: repairing a
    // structure group that did not change would write a row nobody asked to change and
    // break the idempotency guarantee (T6).
    let repaired = if structure_wins && !structure_rejected {
        repair_parent(tree, &mut n)
    } else {
        false
    };

    // `createdAt` is immutable per node and is never a merge field: a node's birth
    // instant belongs to whoever minted its id. Stored wins by construction.
    n.created_at = stored.created_at;

    let took_content = content_wins;
    // A REPAIRED structure group still came from the incoming op — the tree simply
    // could not hold it where it asked. Counting the repair as "not taken" would label
    // an accepted-then-relocated move `rejected`, and the pusher would read that as
    // "nothing of mine survived" when in fact its node moved.
    let took_structure = structure_wins && !structure_rejected;
    let matches_incoming = n == *incoming;

    let outcome = if matches_incoming {
        Outcome::Applied
    } else if took_content || took_structure {
        Outcome::Partial
    } else {
        Outcome::Rejected
    };

    // Why did the pusher not get exactly what it asked for? Diagnostic only — a client
    // acts on `current`, never on this — but it is what shows up in a log when a sync
    // misbehaves, so it names the losing group's ACTUAL failure. `stale` outranks `tie`
    // when both happened: strictly-older data is the more interesting fact.
    let content_lost_stale = !content_wins && incoming.updated_at < stored.updated_at;
    let content_lost_tie = !content_wins && incoming.updated_at == stored.updated_at;
    let structure_lost_stale =
        !structure_wins && incoming.structure_updated_at < stored.structure_updated_at;
    let structure_lost_tie =
        !structure_wins && incoming.structure_updated_at == stored.structure_updated_at;
    let reason = if matches_incoming {
        None
    } else if structure_rejected {
        Some(Reason::Invalid)
    } else if content_lost_stale || structure_lost_stale {
        Some(Reason::Stale)
    } else if content_lost_tie || structure_lost_tie {
        Some(Reason::Tie)
    } else {
        // Nothing lost — the tree simply could not hold the node where it asked.
        None
    };

    UpsertMerge {
        outcome,
        reason,
        write: (n != *stored).then(|| n.clone()),
        current: (!matches_incoming).then(|| Current::node(n)),
        repaired,
    }
}

// MARK: - Deletes

#[derive(Debug, Clone, PartialEq)]
pub struct DeleteMerge {
    pub outcome: Outcome,
    pub reason: Option<Reason>,
    /// `Some(deleted_at)` = write a tombstone at this instant. `None` = leave stored
    /// state alone (either the delete lost, or the node is already dead).
    pub write_tombstone: Option<i64>,
    pub current: Option<Current>,
    /// The delete won against a LIVE node, so the hub must cascade-tombstone every
    /// currently-live descendant at the same instant. Clients never cascade from a
    /// merge: their own delete paths already cascade locally, and a pulled delete
    /// arrives with the hub's explicit per-descendant tombstones behind it.
    pub cascade: bool,
}

/// Merge an incoming delete against stored state.
///
/// Strict `>` on both sides, deliberately NOT the tie policy: the oplog only ever
/// carries deletes the hub ALREADY applied, so a pulled delete whose instant exactly
/// equals a client's clock is unreachable — the client's copy is by definition the one
/// the hub deleted.
pub fn merge_delete(deleted_at: i64, stored: &Stored) -> DeleteMerge {
    match stored {
        Stored::Live(s) => {
            if deleted_at > s.newest_clock() {
                DeleteMerge {
                    outcome: Outcome::Applied,
                    reason: None,
                    write_tombstone: Some(deleted_at),
                    current: None,
                    cascade: true,
                }
            } else {
                // A stored edit is newer than the delete. The deleting device
                // re-converges to the live node from this response alone (T5).
                DeleteMerge {
                    outcome: Outcome::Rejected,
                    reason: Some(Reason::Stale),
                    write_tombstone: None,
                    current: Some(Current::node((**s).clone())),
                    cascade: false,
                }
            }
        }
        // Already dead: idempotent, and the stored instant stands (re-deleting must
        // not move a tombstone's clock, or a retry could out-race a legitimate
        // resurrect).
        Stored::Tombstone { .. } => DeleteMerge {
            outcome: Outcome::Applied,
            reason: None,
            write_tombstone: None,
            current: None,
            cascade: false,
        },
        // A delete may arrive before its node does, from a device that is further
        // ahead. Record the tombstone so the late upsert loses.
        Stored::Missing => DeleteMerge {
            outcome: Outcome::Applied,
            reason: None,
            write_tombstone: Some(deleted_at),
            current: None,
            cascade: false,
        },
    }
}

// MARK: - Clock hygiene

/// How far ahead of the hub a device's clock may be before its ops are refused
/// outright. All devices here are NTP-synced Apple hardware; this catches a battery-
/// dead clock, not drift.
pub const MAX_FUTURE_SKEW_MS: i64 = 24 * 60 * 60 * 1000;

/// Above this the hub logs a warning but still applies the op.
pub const WARN_SKEW_MS: i64 = 60 * 1000;

/// How far into the future an op's clocks reach, in ms (0 when it is not ahead).
pub fn clock_skew_ms(op_clock: i64, server_now: i64) -> i64 {
    (op_clock - server_now).max(0)
}

/// Is this op's clock so far ahead that it must be rejected rather than merged?
/// No clamping: silently rewriting a value would leave the client and the hub
/// disagreeing about what was stored, with nothing in the response to say so.
pub fn is_clock_absurd(op_clock: i64, server_now: i64) -> bool {
    op_clock > server_now + MAX_FUTURE_SKEW_MS
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::NodeKind;
    use std::collections::HashMap;

    /// A tiny in-memory tree for the unit tests below (the server's own impl is over
    /// rusqlite, and the fixture suite covers the shared vectors).
    #[derive(Default)]
    pub struct MapTree {
        pub nodes: HashMap<Uuid, NodeState>,
        pub max_root: Option<i64>,
    }

    impl TreeLookup for MapTree {
        fn state(&self, id: Uuid) -> NodeState {
            self.nodes.get(&id).copied().unwrap_or(NodeState::Missing)
        }
        fn max_root_position(&self) -> Option<i64> {
            self.max_root
        }
    }

    fn node(id: Uuid, text: &str, content: i64, structure: i64) -> WireNode {
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
            created_at: 1,
            updated_at: content,
            structure_updated_at: structure,
            completed_at: None,
        }
    }

    #[test]
    fn insert_when_missing() {
        let tree = MapTree::default();
        let n = node(Uuid::new_v4(), "hi", 10, 10);
        let r = merge_upsert(&n, &Stored::Missing, &tree, Side::Hub);
        assert_eq!(r.outcome, Outcome::Applied);
        assert_eq!(r.write, Some(n));
        assert!(r.current.is_none());
    }

    #[test]
    fn identical_repush_writes_nothing() {
        let tree = MapTree::default();
        let n = node(Uuid::new_v4(), "hi", 10, 10);
        let r = merge_upsert(&n, &Stored::live(n.clone()), &tree, Side::Hub);
        assert_eq!(r.outcome, Outcome::Applied, "the hub holds what was pushed");
        assert_eq!(r.write, None, "no write ⇒ no oplog entry, no seq burned");
        assert!(r.current.is_none());
    }

    #[test]
    fn groups_merge_independently() {
        // A renumbered positions (structure) while B typed (content) — the converged
        // row must carry A's position AND B's text (T7).
        let tree = MapTree::default();
        let id = Uuid::new_v4();
        let mut stored = node(id, "typed by B", 200, 100);
        stored.position = 0;
        let mut incoming = node(id, "old text", 100, 300);
        incoming.position = 4096;

        let r = merge_upsert(&incoming, &Stored::live(stored), &tree, Side::Hub);
        assert_eq!(r.outcome, Outcome::Partial);
        let w = r.write.unwrap();
        assert_eq!(w.text, "typed by B");
        assert_eq!(w.position, 4096);
        // The pusher is repaired from `current` alone.
        match r.current.unwrap() {
            Current::Node(c) => assert_eq!(c.text, "typed by B"),
            _ => panic!("expected a node"),
        }
    }

    #[test]
    fn tie_goes_to_the_hub_and_to_the_incoming_on_a_client() {
        let tree = MapTree::default();
        let id = Uuid::new_v4();
        let stored = node(id, "stored", 100, 100);
        let incoming = node(id, "incoming", 100, 100);

        let hub = merge_upsert(&incoming, &Stored::live(stored.clone()), &tree, Side::Hub);
        assert_eq!(hub.outcome, Outcome::Rejected);
        assert_eq!(hub.reason, Some(Reason::Tie));
        assert_eq!(hub.write, None);
        match hub.current.unwrap() {
            Current::Node(c) => assert_eq!(c.text, "stored"),
            _ => panic!(),
        }

        let client = merge_upsert(&incoming, &Stored::live(stored), &tree, Side::Client);
        assert_eq!(client.outcome, Outcome::Applied);
        assert_eq!(client.write.unwrap().text, "incoming");
    }

    #[test]
    fn tombstone_outlives_an_older_edit_and_loses_to_a_newer_one() {
        let tree = MapTree::default();
        let id = Uuid::new_v4();
        let old = node(id, "stale", 50, 50);
        let r = merge_upsert(&old, &Stored::Tombstone { deleted_at: 100 }, &tree, Side::Hub);
        assert_eq!(r.outcome, Outcome::Rejected);
        assert_eq!(r.reason, Some(Reason::Tombstone));
        assert!(matches!(r.current, Some(Current::Tombstone(_))));

        let fresh = node(id, "revived", 150, 50);
        let r2 = merge_upsert(
            &fresh,
            &Stored::Tombstone { deleted_at: 100 },
            &tree,
            Side::Hub,
        );
        assert_eq!(r2.outcome, Outcome::Applied);
        assert_eq!(r2.write.unwrap().text, "revived");
    }

    #[test]
    fn resurrect_under_a_dead_parent_lands_at_root() {
        let dead = Uuid::new_v4();
        let mut tree = MapTree::default();
        tree.nodes.insert(dead, NodeState::Deleted);
        tree.max_root = Some(2048);

        let id = Uuid::new_v4();
        let mut n = node(id, "orphan", 500, 500);
        n.parent = Some(dead);
        let r = merge_upsert(&n, &Stored::Tombstone { deleted_at: 100 }, &tree, Side::Hub);
        assert!(r.repaired);
        let w = r.write.unwrap();
        assert_eq!(w.parent, None);
        assert_eq!(w.position, 2048 + GAP);
        assert!(r.current.is_some(), "the pusher must learn about the repair");
    }

    #[test]
    fn a_cycle_rejects_only_the_structure_group() {
        // n1's proposed parent is n2, whose stored parent is already n1.
        let n1 = Uuid::new_v4();
        let n2 = Uuid::new_v4();
        let mut tree = MapTree::default();
        tree.nodes.insert(n1, NodeState::Live { parent: None });
        tree.nodes
            .insert(n2, NodeState::Live { parent: Some(n1) });

        let stored = node(n1, "stored text", 100, 100);
        let mut incoming = node(n1, "new text", 200, 200);
        incoming.parent = Some(n2);

        let r = merge_upsert(&incoming, &Stored::live(stored), &tree, Side::Hub);
        let w = r.write.unwrap();
        assert_eq!(w.text, "new text", "content still merges");
        assert_eq!(w.parent, None, "structure kept from stored");
        assert_eq!(r.outcome, Outcome::Partial);
        assert_eq!(r.reason, Some(Reason::Invalid));
    }

    #[test]
    fn delete_loses_to_a_newer_edit() {
        let live = node(Uuid::new_v4(), "edited after the delete", 500, 100);
        let r = merge_delete(300, &Stored::live(live.clone()));
        assert_eq!(r.outcome, Outcome::Rejected);
        assert_eq!(r.reason, Some(Reason::Stale));
        assert_eq!(r.write_tombstone, None);
        match r.current.unwrap() {
            Current::Node(c) => assert_eq!(c.text, "edited after the delete"),
            _ => panic!(),
        }

        let r2 = merge_delete(600, &Stored::live(live));
        assert_eq!(r2.outcome, Outcome::Applied);
        assert_eq!(r2.write_tombstone, Some(600));
        assert!(r2.cascade);
    }

    #[test]
    fn delete_is_idempotent_and_may_precede_its_node() {
        let dead = merge_delete(500, &Stored::Tombstone { deleted_at: 400 });
        assert_eq!(dead.outcome, Outcome::Applied);
        assert_eq!(dead.write_tombstone, None, "a retry must not move the clock");

        let early = merge_delete(500, &Stored::Missing);
        assert_eq!(early.write_tombstone, Some(500));
        assert!(!early.cascade);
    }

    #[test]
    fn absurd_clocks_are_refused_not_clamped() {
        let now = 1_000_000;
        assert!(!is_clock_absurd(now + WARN_SKEW_MS, now));
        assert!(is_clock_absurd(now + MAX_FUTURE_SKEW_MS + 1, now));
        assert_eq!(clock_skew_ms(now - 5, now), 0);
        assert_eq!(clock_skew_ms(now + 5, now), 5);
    }
}
