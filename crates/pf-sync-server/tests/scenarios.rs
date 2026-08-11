//! The scenario matrix (§7.1 of the development plan) — the project's main correctness
//! instrument, built before any real client was wired.
//!
//! Each test drives the REAL axum router in-process against a temp database, through
//! two fake devices that keep their own replicas and merge with the same
//! `promptflow-core` code the shipping clients use. Anything that passes here is a
//! property of the protocol, not of one client's implementation.

mod harness;

use harness::{Device, Hub};
use promptflow_core::merge::MAX_FUTURE_SKEW_MS;
use promptflow_core::model::now_ms;
use promptflow_core::wire::{Current, Outcome, Reason};
use uuid::Uuid;

/// T1 — pull-then-push echo divergence. A edits X and pushes; B has an OLDER unpushed
/// edit to the same node. B's pull must not clobber its own newer local text, and after
/// B pushes both replicas read B's text.
#[tokio::test]
async fn t1_a_pull_never_clobbers_a_newer_local_edit() {
    let hub = Hub::new().await;
    let mut a = Device::new("mac");
    let mut b = Device::new("ipad");

    let x = a.create("original");
    a.sync(&hub).await;
    b.sync(&hub).await;
    assert_eq!(b.text(x), "original");

    // A edits and pushes; B edits LATER but has not pushed yet.
    a.edit_text(x, "from A", 1_000);
    a.sync(&hub).await;
    b.edit_text(x, "from B", 2_000);

    // B pulls A's older edit — its own newer text must survive the merge.
    b.pull(&hub).await;
    assert_eq!(b.text(x), "from B", "a pull must not undo a newer local edit");

    b.sync(&hub).await;
    a.sync(&hub).await;
    assert_eq!(a.text(x), "from B");
    assert_eq!(hub.node(x).await.unwrap().text, "from B");
}

/// T2 — repair visibility. A moves X under P while offline; B deletes P's subtree; A
/// pushes afterwards. The hub reparents X to the root as a `"server"` op, and A — whose
/// pull filters out its OWN ops — must still receive it.
#[tokio::test]
async fn t2_a_server_repair_reaches_the_device_that_caused_it() {
    let hub = Hub::new().await;
    let mut a = Device::new("mac");
    let mut b = Device::new("ipad");

    let p = a.create("parent");
    let x = a.create("child");
    a.sync(&hub).await;
    b.sync(&hub).await;

    // B deletes P (and X with it) at t=5000.
    b.delete_subtree(p, 5_000);
    b.sync(&hub).await;

    // A, offline, moved X under P at t=6000 — after the delete in wall-clock terms, so
    // the resurrect test passes and the repair is what is left to do.
    a.move_under(x, Some(p), 6_000);
    let results = a.push(&hub).await;
    let r = results.iter().find(|r| r.id == x).unwrap();
    assert_eq!(r.outcome, Outcome::Partial, "accepted, then repaired");
    match r.current.as_ref().unwrap() {
        Current::Node(n) => assert_eq!(n.parent, None, "X was reparented to the root"),
        _ => panic!("expected the repaired node"),
    }

    // The repair is filed under `"server"`, so A's own pull still sees it...
    a.pull(&hub).await;
    assert_eq!(a.parent_of(x), None);
    // ...and so does B, which never knew X came back.
    b.sync(&hub).await;
    assert_eq!(b.parent_of(x), None);
    assert_eq!(b.text(x), "child");
}

/// T3 — a delete cascades to children the deleting device never knew about. A creates C
/// under P and pushes; B (which has not pulled) deletes P. B must learn C died.
#[tokio::test]
async fn t3_a_delete_cascades_to_unknown_children() {
    let hub = Hub::new().await;
    let mut a = Device::new("mac");
    let mut b = Device::new("ipad");

    let p = a.create("parent");
    a.sync(&hub).await;
    b.sync(&hub).await;

    // A adds a child B has never seen.
    let c = a.create_child("new child", p, 3_000);
    a.sync(&hub).await;

    // B deletes P from its own (stale) replica — it can only name P.
    b.delete_subtree(p, 4_000);
    let results = b.push(&hub).await;
    assert_eq!(results.len(), 1, "B could only name the node it knew about");
    assert_eq!(results[0].outcome, Outcome::Applied);

    // The cascade tombstone for C is a `"server"` op, which is exactly what makes it
    // reach B (whose pull filters out B's own ops).
    b.pull(&hub).await;
    assert!(b.get(c).is_none(), "B must learn the cascade killed C");
    a.sync(&hub).await;
    assert!(a.get(c).is_none());
    assert!(a.get(p).is_none());
}

/// T4 — the bootstrap gate. A fresh device with local state of its own must NOT push
/// until it has adopted the hub's outline, and the adopt must leave nothing pending: a
/// journal carried through the wipe would push thousands of junk tombstones on the very
/// first cycle and trip the mass-delete tripwire.
#[tokio::test]
async fn t4_a_device_cannot_push_before_it_has_adopted_hub_state() {
    let hub = Hub::new().await;
    let mut mac = Device::new("mac");
    mac.create("the real outline");
    mac.sync(&hub).await;

    let mut ipad = Device::new("ipad");
    ipad.bootstrapped = false;
    // Stale local data, plus deletes the user made before ever configuring sync.
    let stale: Vec<Uuid> = (0..3).map(|i| ipad.create(&format!("stale {i}"))).collect();
    ipad.delete_subtree(stale[0], 1_000);
    assert!(!ipad.journal_is_empty());

    let refused = ipad.push(&hub).await;
    assert!(refused.is_empty(), "an un-bootstrapped device must refuse to push");
    assert_eq!(hub.live_count().await, 1, "and nothing of its state reached the hub");
    assert!(!ipad.outbox_is_empty(), "the refusal consumed nothing");

    ipad.bootstrap(&hub).await;
    assert!(ipad.bootstrapped);
    assert!(ipad.outbox_is_empty(), "the wipe must not leave junk tombstones");
    assert!(ipad.journal_is_empty());
    assert_eq!(ipad.live_count(), 1);

    // Normal syncing from here.
    let fresh = ipad.create("typed on the iPad");
    ipad.sync(&hub).await;
    mac.sync(&hub).await;
    assert_eq!(mac.text(fresh), "typed on the iPad");
}

/// T5 — a delete that loses to a newer edit repairs the DELETING device from the push
/// response alone, with no pull in between.
#[tokio::test]
async fn t5_a_losing_delete_reconverges_from_the_response() {
    let hub = Hub::new().await;
    let mut a = Device::new("mac");
    let mut b = Device::new("ipad");

    let x = a.create("keep me");
    a.sync(&hub).await;
    b.sync(&hub).await;

    a.edit_text(x, "edited later", 9_000);
    a.sync(&hub).await;

    b.delete_subtree(x, 5_000);
    let results = b.push(&hub).await;
    assert_eq!(results[0].outcome, Outcome::Rejected);
    assert_eq!(results[0].reason, Some(Reason::Stale));

    // No pull — the response alone puts the node back on B.
    assert_eq!(b.text(x), "edited later");
    assert!(b.journal_is_empty(), "the delete must leave the journal");
}

/// T6 — an identical full-state re-push costs nothing: no oplog entries, no sequence
/// movement, and every op reported as `applied`.
#[tokio::test]
async fn t6_an_identical_repush_is_free() {
    let hub = Hub::new().await;
    let mut a = Device::new("mac");
    for i in 0..5 {
        a.create(&format!("node {i}"));
    }
    a.sync(&hub).await;
    let seq_after_first = hub.latest_seq().await;

    // Push the SAME live state again, the way the iPad client does every cycle.
    let results = a.push_full_state(&hub).await;
    assert_eq!(results.len(), 5);
    assert!(results.iter().all(|r| r.outcome == Outcome::Applied));
    assert!(results.iter().all(|r| r.current.is_none()));
    assert_eq!(
        hub.latest_seq().await,
        seq_after_first,
        "a no-op push must not burn a sequence, or every cycle would flood the log"
    );
}

/// T7 — a renumber (structure clock) and typing (content clock) on the same rows both
/// survive. This is the whole reason the clocks are split.
#[tokio::test]
async fn t7_a_renumber_and_typing_both_survive() {
    let hub = Hub::new().await;
    let mut a = Device::new("mac");
    let mut b = Device::new("ipad");

    let one = a.create("one");
    let two = a.create("two");
    a.sync(&hub).await;
    b.sync(&hub).await;

    // A renumbers the sibling list (structure only).
    a.set_position(one, 4096, 3_000);
    a.set_position(two, 8192, 3_000);
    // B types into both (content only), slightly later.
    b.edit_text(one, "ONE typed on B", 4_000);
    b.edit_text(two, "TWO typed on B", 4_000);

    a.sync(&hub).await;
    b.sync(&hub).await;
    a.sync(&hub).await;

    for (id, text, pos) in [(one, "ONE typed on B", 4096), (two, "TWO typed on B", 8192)] {
        let n = hub.node(id).await.unwrap();
        assert_eq!(n.text, text, "B's typing must survive A's renumber");
        assert_eq!(n.position, pos, "A's positions must survive B's typing");
        assert_eq!(a.text(id), text);
        assert_eq!(b.position_of(id), pos);
    }
}

/// T8 — undo restamps, so an undone edit propagates and wins. The negative half matters
/// as much: WITHOUT the restamp the same sequence loses, which is what "undo un-undoes
/// itself" means.
#[tokio::test]
async fn t8_an_undo_only_propagates_because_it_restamps() {
    let hub = Hub::new().await;
    let mut a = Device::new("mac");
    let mut b = Device::new("ipad");

    let x = a.create("original");
    a.sync(&hub).await;
    b.sync(&hub).await;

    // B types at t=5000 and pushes.
    b.edit_text(x, "typed on B", 5_000);
    b.sync(&hub).await;
    a.sync(&hub).await;
    assert_eq!(a.text(x), "typed on B");

    // A undoes back to "original". The restored image carries PRE-EDIT content, so its
    // clock is what decides whether the undo means anything.
    a.edit_text(x, "original", 9_000); // restamped, as the store now does
    a.sync(&hub).await;
    assert_eq!(hub.node(x).await.unwrap().text, "original");

    // The counter-case: the same restore carrying its ORIGINAL clock loses outright.
    let mut c = Device::new("third");
    c.sync(&hub).await;
    c.edit_text(x, "un-restamped undo", 1); // a pre-edit clock
    let results = c.push(&hub).await;
    assert_eq!(
        results[0].outcome,
        Outcome::Rejected,
        "an un-restamped undo silently loses — this is the bug the restamp prevents"
    );
    assert_eq!(hub.node(x).await.unwrap().text, "original");
}

/// T9 — style ranges the pushing client cannot even render survive a round trip. The
/// iPad paints bold only, so italic/underline must ride through it opaquely.
#[tokio::test]
async fn t9_style_ranges_round_trip_through_a_client_that_cannot_paint_them() {
    let hub = Hub::new().await;
    let mut mac = Device::new("mac");
    let mut ipad = Device::new("ipad");

    let x = mac.create("bold italic under");
    mac.set_styles(x, vec![0, 4], vec![5, 6], vec![12, 5], 1_000);
    mac.sync(&hub).await;
    ipad.sync(&hub).await;

    // The iPad edits the TEXT. Its splice adjuster shifts every array; nothing is
    // dropped just because the app has no UI for it.
    ipad.splice_text(x, 0, 0, "XX", 2_000);
    ipad.sync(&hub).await;
    mac.sync(&hub).await;

    let n = hub.node(x).await.unwrap();
    assert_eq!(n.text, "XXbold italic under");
    assert_eq!(n.bold_ranges, vec![2, 4]);
    assert_eq!(n.italic_ranges, vec![7, 6], "italic survived a bold-only client");
    assert_eq!(n.underline_ranges, vec![14, 5]);
    assert_eq!(mac.get(x).unwrap().italic_ranges, vec![7, 6]);
}

/// T10 — one broken clock does not poison a batch.
#[tokio::test]
async fn t10_a_skewed_clock_is_rejected_per_op() {
    let hub = Hub::new().await;
    let mut a = Device::new("mac");

    let sane = a.create("sane");
    let broken = a.create("broken");
    a.set_clock(broken, now_ms() + MAX_FUTURE_SKEW_MS + 3_600_000);

    let results = a.push(&hub).await;
    let sane_r = results.iter().find(|r| r.id == sane).unwrap();
    let broken_r = results.iter().find(|r| r.id == broken).unwrap();
    assert_eq!(sane_r.outcome, Outcome::Applied);
    assert_eq!(broken_r.outcome, Outcome::Rejected);
    assert_eq!(broken_r.reason, Some(Reason::ClockSkew));
    assert!(hub.node(sane).await.is_some());
    assert!(hub.node(broken).await.is_none());
}

/// T11 — the crash seams. A push replayed after an unacknowledged response is a no-op;
/// a pull re-applied because the cursor never advanced is idempotent.
#[tokio::test]
async fn t11_replayed_pushes_and_pulls_are_idempotent() {
    let hub = Hub::new().await;
    let mut a = Device::new("mac");
    let mut b = Device::new("ipad");

    let x = a.create("state");
    a.sync(&hub).await;
    let seq = hub.latest_seq().await;

    // The response never reached A, so A pushes the same outbox again.
    a.push_full_state(&hub).await;
    assert_eq!(hub.latest_seq().await, seq, "the replay changed nothing");

    // B pulls but crashes before advancing its cursor, then pulls the same range again.
    b.pull(&hub).await;
    let before = b.snapshot_texts();
    b.cursor = 0;
    b.pull(&hub).await;
    assert_eq!(b.snapshot_texts(), before, "re-applying a pull is idempotent");
    assert_eq!(b.text(x), "state");
}

/// T12 — an exact clock tie is hub-authoritative, and BOTH arrival orders converge to
/// the same replica everywhere.
#[tokio::test]
async fn t12_ties_converge_under_either_arrival_order() {
    for (first, second) in [("mac", "ipad"), ("ipad", "mac")] {
        let hub = Hub::new().await;
        let mut seed = Device::new("seed");
        let x = seed.create("seed");
        seed.sync(&hub).await;

        let mut a = Device::new(first);
        let mut b = Device::new(second);
        a.sync(&hub).await;
        b.sync(&hub).await;

        // Same clock, different bytes.
        a.edit_text(x, &format!("{first} wins?"), 7_000);
        b.edit_text(x, &format!("{second} wins?"), 7_000);

        a.sync(&hub).await;
        let results = b.push(&hub).await;
        assert_eq!(results[0].outcome, Outcome::Rejected);
        assert_eq!(results[0].reason, Some(Reason::Tie));

        // The loser adopts `current` from the response alone; both replicas and the hub
        // now read the same thing, whichever device pushed first.
        let winner = format!("{first} wins?");
        assert_eq!(b.text(x), winner);
        assert_eq!(a.text(x), winner);
        assert_eq!(hub.node(x).await.unwrap().text, winner);
    }
}

/// T13 — two devices move each other's node under the other. Whichever push lands
/// second has its structure group rejected wholesale, and both replicas end acyclic.
#[tokio::test]
async fn t13_a_mutual_move_converges_acyclic() {
    let hub = Hub::new().await;
    let mut a = Device::new("mac");
    let mut b = Device::new("ipad");

    let n1 = a.create("one");
    let n2 = a.create("two");
    a.sync(&hub).await;
    b.sync(&hub).await;

    a.move_under(n1, Some(n2), 3_000);
    b.move_under(n2, Some(n1), 3_500);

    a.sync(&hub).await;
    let results = b.push(&hub).await;
    assert_eq!(results[0].outcome, Outcome::Rejected);
    assert_eq!(results[0].reason, Some(Reason::Invalid));

    b.pull(&hub).await;
    a.sync(&hub).await;
    for dev in [&a, &b] {
        assert!(!dev.has_cycle(), "a replica must never hold a parent loop");
    }
    assert_eq!(hub.node(n1).await.unwrap().parent, Some(n2));
    assert_eq!(hub.node(n2).await.unwrap().parent, None);
    // Acyclic is not the same as CONVERGED, and the difference is the whole bug: the
    // losing device has to be able to ADOPT the rejection. Every other losing group comes
    // back at a clock at least as new as the pusher's, so its own `>=` takes it; a cycle
    // rejection returning the stored clock would be strictly older than the move being
    // rejected, and B would keep its own parent forever while the hub said otherwise.
    for dev in [&a, &b] {
        assert_eq!(dev.parent_of(n1), Some(n2), "{}: n1 agrees with the hub", dev.id);
        assert_eq!(dev.parent_of(n2), None, "{}: n2 agrees with the hub", dev.id);
    }
}

/// The batch-ordering guarantee, which is not a nicety: tree validation repairs a node
/// whose parent it cannot find by moving it to the ROOT, and every client's batch order is
/// arbitrary with respect to the tree. A nested outline pushed child-first would arrive
/// flat — on the hub AND, because the repair does not move the structure clock, on the
/// device that sent it.
#[tokio::test]
async fn a_batch_that_names_a_child_before_its_parent_still_nests() {
    let hub = Hub::new().await;
    let mut a = Device::new("mac");

    // Three levels, pushed in the WORST possible order.
    let grandparent = a.create("grandparent");
    let parent = a.create_child("parent", grandparent, 2_000);
    let child = a.create_child("child", parent, 2_000);
    a.reverse_outbox();

    a.push(&hub).await;
    assert_eq!(hub.node(child).await.unwrap().parent, Some(parent));
    assert_eq!(hub.node(parent).await.unwrap().parent, Some(grandparent));
    assert_eq!(hub.node(grandparent).await.unwrap().parent, None);

    // And the sender is not flattened by the repairs it would otherwise get back.
    assert_eq!(a.parent_of(child), Some(parent));
    assert_eq!(a.parent_of(parent), Some(grandparent));

    // A device bootstrapping from the snapshot gets it nested too — it applies in one
    // pass and nothing ever re-queues a node it adopted from there.
    let mut b = Device::new("ipad");
    b.bootstrap(&hub).await;
    assert_eq!(b.parent_of(child), Some(parent));
    assert_eq!(b.parent_of(parent), Some(grandparent));
}

/// A cascade stamps the PARENT's `deletedAt` onto children whose clocks the hub never
/// compared against. A child edited after the delete was made must not be tombstoned by
/// it: every client would refuse that tombstone through its own merge, leaving the node
/// dead on the hub and alive on the devices under a parent that no longer exists —
/// invisible in the outline and unreachable by any later op.
#[tokio::test]
async fn a_cascade_never_kills_a_child_that_outlived_the_delete() {
    let hub = Hub::new().await;
    let mut a = Device::new("mac");
    let mut b = Device::new("ipad");

    let p = a.create("parent");
    let c = a.create_child("child", p, 1_000);
    a.sync(&hub).await;
    b.sync(&hub).await;

    // B deletes the parent at 5000, offline. A keeps working on the child afterwards.
    b.delete_subtree(p, 5_000);
    a.edit_text(c, "still being written at 9000", 9_000);
    a.sync(&hub).await;

    let results = b.push(&hub).await;
    // The explicit delete of the child loses on its own merits...
    let child_result = results.iter().find(|r| r.id == c).unwrap();
    assert_eq!(child_result.outcome, Outcome::Rejected);
    assert_eq!(child_result.reason, Some(Reason::Stale));
    // ...and the parent's cascade must NOT go behind its back and kill it anyway.
    let stored = hub.node(c).await.expect("the child outlived the delete");
    assert_eq!(stored.text, "still being written at 9000");
    assert_eq!(stored.parent, None, "and it was re-rooted, not left under a corpse");

    b.pull(&hub).await;
    a.sync(&hub).await;
    for dev in [&a, &b] {
        assert_eq!(
            dev.text(c),
            "still being written at 9000",
            "{}: every replica agrees the child is alive",
            dev.id
        );
        assert_eq!(dev.parent_of(c), None, "{}: and reachable from the root", dev.id);
    }
}

/// T15 — the mass-delete tripwire refuses the batch outright, and the confirm header
/// (an explicit user action, never automatic) lets exactly that batch through.
#[tokio::test]
async fn t15_the_mass_delete_tripwire_needs_an_explicit_confirmation() {
    let hub = Hub::new().await;
    let mut a = Device::new("mac");
    let ids: Vec<Uuid> = (0..60).map(|i| a.create(&format!("node {i}"))).collect();
    a.sync(&hub).await;

    for id in &ids {
        a.delete_subtree(*id, now_ms());
    }
    let refused = a.try_push(&hub, false).await;
    assert_eq!(refused.status, 428);
    assert_eq!(
        hub.live_count().await,
        60,
        "a refused batch must leave no trace at all"
    );
    assert!(!a.journal_is_empty(), "the deletes stay pending");

    let confirmed = a.try_push(&hub, true).await;
    assert_eq!(confirmed.status, 200);
    assert_eq!(hub.live_count().await, 0);
}

/// T16 — first-configuration seeding. A store with N live nodes and no cursor enqueues
/// all N, and the hub holds N after one cycle. Without it the outbox would only ever
/// carry post-configuration edits and the hub would start empty forever.
#[tokio::test]
async fn t16_first_configuration_seeds_the_hub_from_an_existing_store() {
    let hub = Hub::new().await;
    let mut mac = Device::new("mac");
    // An outline that existed long before sync was configured: nothing is queued.
    for i in 0..25 {
        mac.create_quietly(&format!("existing {i}"));
    }
    assert!(mac.outbox_is_empty(), "ordinary edits queue; a pre-existing store does not");

    mac.enqueue_everything();
    mac.sync(&hub).await;
    assert_eq!(hub.live_count().await, 25);

    let mut ipad = Device::new("ipad");
    ipad.bootstrap(&hub).await;
    assert_eq!(ipad.live_count(), 25);
}

/// T17 — a push where EVERY op is rejected still empties the outbox and leaves the next
/// cycle with nothing to send. Without that, a losing device re-pushes the same batch
/// forever.
#[tokio::test]
async fn t17_a_wholly_rejected_push_does_not_loop() {
    let hub = Hub::new().await;
    let mut a = Device::new("mac");
    let mut b = Device::new("ipad");

    let x = a.create("shared");
    let y = a.create("also shared");
    a.sync(&hub).await;
    b.sync(&hub).await;

    // A wins both nodes decisively.
    a.edit_text(x, "A's x", 9_000);
    a.edit_text(y, "A's y", 9_000);
    a.sync(&hub).await;

    // B pushes older edits to both — everything loses.
    b.edit_text(x, "B's x", 1_000);
    b.edit_text(y, "B's y", 1_000);
    let results = b.push(&hub).await;
    assert!(results.iter().all(|r| r.outcome == Outcome::Rejected));
    assert!(b.outbox_is_empty(), "every named op leaves the outbox, whatever the outcome");
    assert_eq!(b.text(x), "A's x", "and `current` repaired the replica");
    assert_eq!(b.text(y), "A's y");

    let seq = hub.latest_seq().await;
    b.sync(&hub).await;
    assert_eq!(hub.latest_seq().await, seq, "the next cycle pushes nothing");
}

/// T18 — an import (`replace_all`) propagates as deletes for everything replaced plus
/// upserts for everything imported, and a second device converges on the new document.
#[tokio::test]
async fn t18_an_import_propagates_as_deletes_plus_upserts() {
    let hub = Hub::new().await;
    let mut mac = Device::new("mac");
    let mut ipad = Device::new("ipad");

    let old: Vec<Uuid> = (0..5).map(|i| mac.create(&format!("old {i}"))).collect();
    mac.sync(&hub).await;
    ipad.sync(&hub).await;
    assert_eq!(ipad.live_count(), 5);

    // `replace_all` while sync is configured: the user chose to replace the document.
    let imported = mac.replace_all(&["imported A", "imported B", "imported C"]);
    // Enough deletes to matter but under the 50-node floor, so the tripwire stays out
    // of the way — the confirm affordance has its own test (T15).
    mac.sync(&hub).await;

    ipad.sync(&hub).await;
    assert_eq!(ipad.live_count(), 3);
    for id in &old {
        assert!(ipad.get(*id).is_none(), "a replaced node must die everywhere");
    }
    for id in &imported {
        assert!(ipad.get(*id).is_some());
    }
}

/// The 410 path: a cursor the log can no longer serve sends the client back to
/// `/v1/snapshot`. Compaction is a v1 non-goal, so the reachable case is a hub restored
/// from a backup — a cursor from the FUTURE.
#[tokio::test]
async fn a_cursor_the_log_cannot_serve_sends_the_client_to_the_snapshot() {
    let hub = Hub::new().await;
    let mut a = Device::new("mac");
    a.create("something");
    a.sync(&hub).await;

    let gone = hub.raw_changes(9_999, "ipad").await;
    assert_eq!(gone.status, 410);

    // And the recovery path actually recovers.
    let mut b = Device::new("ipad");
    b.cursor = 9_999;
    b.sync(&hub).await;
    assert_eq!(b.live_count(), 1);
}

/// Auth is not optional, and a probe cannot tell which gate it failed.
#[tokio::test]
async fn every_endpoint_needs_both_credentials() {
    let hub = Hub::new().await;
    assert_eq!(hub.raw_health(None).await.status, 401, "no bearer at all");
    assert_eq!(
        hub.raw_health(Some("wrong-token")).await.status,
        401,
        "a wrong bearer is indistinguishable from a missing one"
    );
    assert_eq!(hub.raw_health(Some(harness::BEARER)).await.status, 200);
}

/// A protocol-version mismatch is a hard 400, not a best-effort merge.
#[tokio::test]
async fn a_future_protocol_version_is_refused() {
    let hub = Hub::new().await;
    let body = serde_json::json!({
        "protocolVersion": 2,
        "deviceId": "mac",
        "ops": []
    });
    assert_eq!(hub.raw_push(&body, false).await.status, 400);
}

/// The reserved device id cannot be claimed by a real device — it is what makes a
/// repair reach the device that caused it.
#[tokio::test]
async fn the_server_device_id_is_reserved() {
    let hub = Hub::new().await;
    let body = serde_json::json!({
        "protocolVersion": 1,
        "deviceId": "server",
        "ops": []
    });
    assert_eq!(hub.raw_push(&body, false).await.status, 400);
    assert_eq!(hub.raw_changes(0, "server").await.status, 400);
}

/// `/v1/snapshot` must read state and `latestSeq` at ONE instant: a client that
/// bootstraps from a torn read skips every op that landed between the two halves, and
/// nothing ever tells it.
#[tokio::test]
async fn a_snapshot_and_its_sequence_come_from_one_instant() {
    let hub = Hub::new().await;
    let mut a = Device::new("mac");
    for i in 0..40 {
        a.create(&format!("n{i}"));
    }
    a.sync(&hub).await;

    let snap = hub.raw_snapshot().await;
    let nodes = snap.json["nodes"].as_array().unwrap().len();
    let latest = snap.json["latestSeq"].as_i64().unwrap();
    assert_eq!(nodes, 40);
    assert_eq!(latest, hub.latest_seq().await);

    // Everything the snapshot holds was written at or before `latestSeq`, so a client
    // that starts pulling from there misses nothing.
    let after = hub.raw_changes(latest, "ipad").await;
    assert_eq!(after.json["ops"].as_array().unwrap().len(), 0);
}

/// A node whose parent is missing from the hub entirely (a client pushed a child before
/// its parent) is repaired to the root rather than becoming invisible.
#[tokio::test]
async fn an_orphan_lands_at_the_root_rather_than_vanishing() {
    let hub = Hub::new().await;
    let mut a = Device::new("mac");
    let ghost = Uuid::new_v4();
    let child = a.create("orphan");
    a.move_under(child, Some(ghost), 2_000);

    let results = a.push(&hub).await;
    assert_eq!(results[0].outcome, Outcome::Partial);
    let stored = hub.node(child).await.unwrap();
    assert_eq!(stored.parent, None);
    assert_eq!(stored.text, "orphan", "the content is not collateral damage");
}

/// Two orphans repaired in ONE push must not collide on a position — the tree lookup
/// reads through the same transaction it is writing in.
#[tokio::test]
async fn two_repairs_in_one_push_get_distinct_positions() {
    let hub = Hub::new().await;
    let mut a = Device::new("mac");
    let ghost = Uuid::new_v4();
    let one = a.create("orphan one");
    let two = a.create("orphan two");
    a.move_under(one, Some(ghost), 2_000);
    a.move_under(two, Some(ghost), 2_000);

    a.push(&hub).await;
    let p1 = hub.node(one).await.unwrap().position;
    let p2 = hub.node(two).await.unwrap().position;
    assert_ne!(p1, p2, "a second repair must see the first one's position");
}

/// Health reports what an operator actually needs: how far the log has run, how much is
/// live, and when each device last spoke.
#[tokio::test]
async fn health_reports_per_device_progress() {
    let hub = Hub::new().await;
    let mut a = Device::new("mac");
    let mut b = Device::new("ipad");
    a.create("one");
    a.sync(&hub).await;
    b.sync(&hub).await;
    b.delete_subtree(a.first_id(), now_ms());
    b.sync(&hub).await;

    let h = hub.raw_health(Some(harness::BEARER)).await;
    assert_eq!(h.json["liveNodes"], 0);
    assert_eq!(h.json["tombstones"], 1);
    let devices = h.json["perDevice"].as_array().unwrap();
    assert_eq!(devices.len(), 2);
    for d in devices {
        assert!(d["lastPullSeq"].as_i64().is_some());
    }
}

/// A resurrect brings back the NODE, not the subtree — a deliberate, documented
/// semantics choice that must not quietly drift.
#[tokio::test]
async fn a_resurrect_does_not_bring_back_the_subtree() {
    let hub = Hub::new().await;
    let mut a = Device::new("mac");
    let p = a.create("parent");
    let kid = a.create_child("child", p, 1_000);
    a.sync(&hub).await;

    let mut b = Device::new("ipad");
    b.sync(&hub).await;
    b.delete_subtree(p, 5_000);
    b.sync(&hub).await;

    // A revives only P.
    a.edit_text(p, "back from the dead", 9_000);
    a.push(&hub).await;

    assert!(hub.node(p).await.is_some());
    assert!(
        hub.node(kid).await.is_none(),
        "resurrect brings back the node, not its subtree"
    );
}
