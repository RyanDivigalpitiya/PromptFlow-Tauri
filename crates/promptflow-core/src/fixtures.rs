//! The cross-language contract fixtures.
//!
//! `fixtures/*.json` beside this crate are the SHARED source of truth for the wire
//! format, the merge rules and the style-run splice. `cargo test` here asserts the Rust
//! implementation against them; `SyncContractTests` in the SwiftUI repo decodes the same
//! files and asserts its hand-written Swift against them. The two implementations meet
//! at these bytes and nowhere else.
//!
//! Comparison is **value-identical after decode**, never byte equality — two JSON
//! serializers will not agree on key order, and requiring them to would make the
//! fixtures a serializer test instead of a protocol test.
//!
//! Any protocol change edits the fixtures FIRST, in one commit with both suites.
//! `PF_REGEN_FIXTURES=1 cargo test -p promptflow-core` rewrites the `expected` halves
//! from the current Rust implementation — a review aid for authoring new cases, never
//! a way to make a red suite green.

use crate::merge::{NodeState, Side, Stored, TreeLookup};
use crate::wire::{Current, Outcome, Reason, WireNode};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

/// Where the fixture directory sits relative to this source file. The Swift side walks
/// up from `#filePath` to find the sibling checkout; here `CARGO_MANIFEST_DIR` is exact.
pub fn fixtures_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures")
}

// MARK: - Wire-node encode/decode vectors

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireNodeFile {
    pub version: u32,
    pub cases: Vec<WireNodeCase>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireNodeCase {
    pub name: String,
    /// What arrives on the wire — may omit defaulted keys and may carry unknown ones.
    pub json: serde_json::Value,
    /// What a re-encode of the decoded value must equal, key for key.
    pub canonical: serde_json::Value,
}

// MARK: - Merge vectors

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeFile {
    pub version: u32,
    pub cases: Vec<MergeCase>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeCase {
    pub name: String,
    pub side: FixtureSide,
    #[serde(default)]
    pub tree: FixtureTree,
    pub stored: FixtureStored,
    pub incoming: FixtureIncoming,
    pub expected: FixtureExpected,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FixtureSide {
    Hub,
    Client,
}

impl From<FixtureSide> for Side {
    fn from(s: FixtureSide) -> Self {
        match s {
            FixtureSide::Hub => Side::Hub,
            FixtureSide::Client => Side::Client,
        }
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FixtureTree {
    #[serde(default)]
    pub nodes: HashMap<Uuid, FixtureNodeState>,
    #[serde(default)]
    pub max_root_position: Option<i64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FixtureNodeState {
    /// "live" | "deleted"
    pub state: FixtureLiveness,
    #[serde(default)]
    pub parent: Option<Uuid>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FixtureLiveness {
    Live,
    Deleted,
}

impl TreeLookup for FixtureTree {
    fn state(&self, id: Uuid) -> NodeState {
        match self.nodes.get(&id) {
            None => NodeState::Missing,
            Some(s) => match s.state {
                FixtureLiveness::Live => NodeState::Live { parent: s.parent },
                FixtureLiveness::Deleted => NodeState::Deleted,
            },
        }
    }
    fn max_root_position(&self) -> Option<i64> {
        self.max_root_position
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FixtureStored {
    Missing,
    Live { node: Box<WireNode> },
    #[serde(rename_all = "camelCase")]
    Tombstone { deleted_at: i64 },
}

impl From<&FixtureStored> for Stored {
    fn from(f: &FixtureStored) -> Self {
        match f {
            FixtureStored::Missing => Stored::Missing,
            FixtureStored::Live { node } => Stored::Live(node.clone()),
            FixtureStored::Tombstone { deleted_at } => Stored::Tombstone {
                deleted_at: *deleted_at,
            },
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FixtureIncoming {
    Upsert {
        node: Box<WireNode>,
    },
    #[serde(rename_all = "camelCase")]
    Delete {
        id: Uuid,
        deleted_at: i64,
    },
}

#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FixtureExpected {
    pub outcome: Outcome,
    #[serde(default)]
    pub reason: Option<Reason>,
    /// The node to store, when the merge writes one.
    #[serde(default)]
    pub write: Option<Box<WireNode>>,
    /// The tombstone instant to store, when the merge writes one.
    #[serde(default)]
    pub write_tombstone: Option<i64>,
    #[serde(default)]
    pub current: Option<Current>,
    #[serde(default)]
    pub repaired: bool,
    #[serde(default)]
    pub cascade: bool,
}

impl Default for Outcome {
    fn default() -> Self {
        Outcome::Applied
    }
}

/// Run one merge case through the real implementation.
pub fn run_merge_case(case: &MergeCase) -> FixtureExpected {
    let stored = Stored::from(&case.stored);
    match &case.incoming {
        FixtureIncoming::Upsert { node } => {
            let r = crate::merge::merge_upsert(node, &stored, &case.tree, case.side.into());
            FixtureExpected {
                outcome: r.outcome,
                reason: r.reason,
                write: r.write.map(Box::new),
                write_tombstone: None,
                current: r.current,
                repaired: r.repaired,
                cascade: false,
            }
        }
        FixtureIncoming::Delete { deleted_at, .. } => {
            let r = crate::merge::merge_delete(*deleted_at, &stored);
            FixtureExpected {
                outcome: r.outcome,
                reason: r.reason,
                write: None,
                write_tombstone: r.write_tombstone,
                current: r.current,
                repaired: false,
                cascade: r.cascade,
            }
        }
    }
}

// MARK: - Splice vectors

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpliceFile {
    pub version: u32,
    pub cases: Vec<SpliceCase>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpliceCase {
    pub name: String,
    pub ranges: Vec<i64>,
    pub old_length: i64,
    pub location: i64,
    pub length: i64,
    pub replacement_length: i64,
    pub expected: Vec<i64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn regenerating() -> bool {
        std::env::var("PF_REGEN_FIXTURES").is_ok()
    }

    fn read(name: &str) -> String {
        let p = fixtures_dir().join(name);
        std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("reading {}: {e}", p.display()))
    }

    fn write(name: &str, value: &impl Serialize) {
        let p = fixtures_dir().join(name);
        let json = serde_json::to_string_pretty(value).unwrap();
        std::fs::write(&p, format!("{json}\n")).unwrap();
        eprintln!("regenerated {}", p.display());
    }

    #[test]
    fn wire_nodes_round_trip() {
        let mut file: WireNodeFile = serde_json::from_str(&read("wire_nodes.json")).unwrap();
        for case in &mut file.cases {
            let decoded: WireNode = serde_json::from_value(case.json.clone())
                .unwrap_or_else(|e| panic!("{}: decode failed: {e}", case.name));
            let reencoded = serde_json::to_value(&decoded).unwrap();
            if regenerating() {
                case.canonical = reencoded;
                continue;
            }
            assert_eq!(
                reencoded, case.canonical,
                "{}: re-encode differs from the canonical form",
                case.name
            );
            // And the canonical form must itself decode to the same value — the
            // property the Swift side asserts, since its encoder orders keys its own
            // way.
            let again: WireNode = serde_json::from_value(case.canonical.clone()).unwrap();
            assert_eq!(again, decoded, "{}: canonical form is not stable", case.name);
        }
        if regenerating() {
            write("wire_nodes.json", &file);
        }
    }

    #[test]
    fn merge_vectors_match() {
        let mut file: MergeFile = serde_json::from_str(&read("merge_vectors.json")).unwrap();
        for case in &mut file.cases {
            let actual = run_merge_case(case);
            if regenerating() {
                case.expected = actual;
                continue;
            }
            assert_eq!(actual, case.expected, "merge vector `{}`", case.name);
        }
        if regenerating() {
            write("merge_vectors.json", &file);
        }
    }

    #[test]
    fn splice_vectors_match() {
        let mut file: SpliceFile = serde_json::from_str(&read("splice_vectors.json")).unwrap();
        for case in &mut file.cases {
            let actual = crate::splice::splice_ranges(
                &case.ranges,
                case.old_length,
                case.location,
                case.length,
                case.replacement_length,
            );
            if regenerating() {
                case.expected = actual;
                continue;
            }
            assert_eq!(actual, case.expected, "splice vector `{}`", case.name);
        }
        if regenerating() {
            write("splice_vectors.json", &file);
        }
    }

    /// A verifier that passes everything proves nothing: corrupt one expectation and
    /// the suite above must notice.
    #[test]
    fn the_checks_can_actually_fail() {
        let file: SpliceFile = serde_json::from_str(&read("splice_vectors.json")).unwrap();
        let case = &file.cases[0];
        let mut wrong = case.expected.clone();
        wrong.push(999);
        let actual = crate::splice::splice_ranges(
            &case.ranges,
            case.old_length,
            case.location,
            case.length,
            case.replacement_length,
        );
        assert_ne!(actual, wrong);
    }
}
