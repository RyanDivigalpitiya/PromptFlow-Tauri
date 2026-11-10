use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Sibling spacing. New nodes are inserted at the midpoint of a gap so a single edit is
/// O(1); a sibling list is only renumbered when its gap is exhausted (same as the SwiftUI app).
pub const GAP: i64 = 1024;

/// Node kinds. Serialized with the SAME raw strings as the SwiftUI app's `NodeKind`
/// (`kindRaw` column / export JSON), so archives round-trip between the two apps.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum NodeKind {
    #[serde(rename = "bulletPoint")]
    BulletPoint,
    #[serde(rename = "checkbox")]
    Checkbox,
    #[serde(rename = "promptDraft")]
    PromptDraft,
    #[serde(rename = "line")]
    Line,
}

impl NodeKind {
    pub fn from_raw(s: &str) -> Self {
        match s {
            "checkbox" => Self::Checkbox,
            "promptDraft" => Self::PromptDraft,
            "line" => Self::Line,
            _ => Self::BulletPoint,
        }
    }

    pub fn raw(self) -> &'static str {
        match self {
            Self::BulletPoint => "bulletPoint",
            Self::Checkbox => "checkbox",
            Self::PromptDraft => "promptDraft",
            Self::Line => "line",
        }
    }

    /// The kind a NEW node spawned from a node of this kind inherits. A divider (`line`)
    /// never propagates — Enter / "+" on a divider yields a plain bullet.
    pub fn inheritable(self) -> Self {
        if self == Self::Line {
            Self::BulletPoint
        } else {
            self
        }
    }
}

/// Where a piece of work is in its lifecycle — the focus pane's stage selector. Every
/// node carries one, but only a PINNED (⌘⇧F) node shows it; un-pinning keeps the value,
/// so re-pinning brings the row back at the stage it left at. A new node always starts at
/// `Planning` — the default is never inherited from the node it was split from.
///
/// Raw strings are lowercase and are what SQLite, the sync wire and the export file all
/// carry. DECODING IS LENIENT: an unknown string (a newer peer that added a stage) reads
/// back as `Planning` rather than failing the whole node, the same forward-compatibility
/// stance the wire module takes on unknown keys — a strict enum here would turn one new
/// stage into a node that cannot be pulled at all.
///
/// `Building` and `Executing` are TWO VALUES FOR ONE SLOT of the selector: the second
/// segment reads "Building" by default, and clicking it while it is lit flips it to
/// "Executing" and back. They are distinct stored values rather than a label preference
/// so that the choice belongs to the node (synced, undoable, exported) exactly as the stage
/// itself does. Declaration order is NOT slot order; the frontend's `STAGE_SLOTS` owns that.
/// The choice OUTLIVES the slot: `NodeRec::prefers_executing` remembers which of the two the
/// node last held, so moving on to Testing and back lands on Executing again.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(from = "String")]
pub enum Stage {
    #[default]
    #[serde(rename = "planning")]
    Planning,
    #[serde(rename = "building")]
    Building,
    #[serde(rename = "executing")]
    Executing,
    #[serde(rename = "testing")]
    Testing,
    #[serde(rename = "deploying")]
    Deploying,
}

impl Stage {
    pub fn from_raw(s: &str) -> Self {
        match s {
            "building" => Self::Building,
            "executing" => Self::Executing,
            "testing" => Self::Testing,
            "deploying" => Self::Deploying,
            _ => Self::Planning,
        }
    }

    pub fn raw(self) -> &'static str {
        match self {
            Self::Planning => "planning",
            Self::Building => "building",
            Self::Executing => "executing",
            Self::Testing => "testing",
            Self::Deploying => "deploying",
        }
    }

    /// For `skip_serializing_if`: the default stage is never written to the wire or the
    /// export file, so every stage-free document stays byte-identical to before.
    pub fn is_default(&self) -> bool {
        *self == Self::Planning
    }

    /// The Building/Executing slot's choice this stage MAKES — `Some(true)` for Executing,
    /// `Some(false)` for Building, `None` for every stage outside that slot. What
    /// `prefers_executing` is set from.
    pub fn building_slot_choice(self) -> Option<bool> {
        match self {
            Self::Building => Some(false),
            Self::Executing => Some(true),
            _ => None,
        }
    }
}

/// For `skip_serializing_if` on a flag whose `false` must never be written.
pub fn is_false(b: &bool) -> bool {
    !*b
}

impl From<String> for Stage {
    fn from(s: String) -> Self {
        Self::from_raw(&s)
    }
}

/// One outline node — the flat record shape shared by the store, SQLite, and the
/// frontend mirror. The tree is expressed by `parent` + `position` (gapped sibling
/// ordering, exactly like the SwiftUI app's SwiftData model).
///
/// `is_collapsed` is NOT live UI state: collapse is per-window and lives in each
/// window's frontend state. The flag here is only an import/export seed so documents
/// round-trip with the SwiftUI app. It is also the one field the SYNC wire format
/// deliberately drops (see `WireNode`).
///
/// TWO merge clocks, both ms-epoch UTC (see the sync protocol):
///   * `updated_at` — the CONTENT clock: text, note, bold/italic/underline ranges.
///   * `structure_updated_at` — parent, position, kind, is_completed, completed_at,
///     is_highlighted, stage, prefers_executing.
/// Creation sets both to `created_at`. Splitting them is what keeps a move or a
/// completion from carrying stale text over concurrent typing on another device.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeRec {
    pub id: Uuid,
    pub parent: Option<Uuid>,
    pub position: i64,
    pub text: String,
    pub note: String,
    pub kind: NodeKind,
    pub is_completed: bool,
    pub is_highlighted: bool,
    /// The focus pane's stage. `serde(default)` so snapshots from before it existed
    /// still deserialize.
    #[serde(default)]
    pub stage: Stage,
    /// Which of the stage selector's Building/Executing pair this node last HELD — so the
    /// second segment keeps reading Executing while the node is at Testing, and a click on
    /// it lands there. Written only by `set_stage`, from whichever end of a transition sits
    /// in that slot (the new stage wins), which is also what lets a node stored at
    /// Executing before this field existed keep its choice the first time it moves on.
    /// While the node IS in the slot the stage itself is authoritative; this only speaks
    /// for it when the node is elsewhere. Structure group, beside `stage`; never inherited.
    #[serde(default)]
    pub prefers_executing: bool,
    pub is_collapsed: bool,
    /// Bold character ranges over `text` as flat `[location, length, …]` pairs.
    pub bold_ranges: Vec<i64>,
    /// Italic / underline ranges — same flat-pair format. `serde(default)` so
    /// snapshots and archives from before these existed still deserialize.
    #[serde(default)]
    pub italic_ranges: Vec<i64>,
    #[serde(default)]
    pub underline_ranges: Vec<i64>,
    /// Milliseconds since the Unix epoch.
    pub created_at: i64,
    pub updated_at: i64,
    /// Structure clock. `serde(default)` for the same reason the style ranges have one:
    /// snapshots written before the two-clock split still deserialize. A 0 read back
    /// from a pre-migration SQLite row is normalized to `updated_at` on load.
    #[serde(default)]
    pub structure_updated_at: i64,
    pub completed_at: Option<i64>,
}

impl NodeRec {
    pub fn new(text: String, kind: NodeKind, parent: Option<Uuid>, position: i64) -> Self {
        let now = now_ms();
        Self {
            id: Uuid::new_v4(),
            parent,
            position,
            text,
            note: String::new(),
            kind,
            is_completed: false,
            is_highlighted: false,
            stage: Stage::Planning,
            prefers_executing: false,
            is_collapsed: false,
            bold_ranges: Vec::new(),
            italic_ranges: Vec::new(),
            underline_ranges: Vec::new(),
            created_at: now,
            updated_at: now,
            structure_updated_at: now,
            completed_at: None,
        }
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Deterministic sibling ordering: by explicit `position`, then the uuid as a stable
/// tiebreaker (the SwiftUI app compares uuid strings for the same reason — convergent
/// order when positions collide).
pub fn sibling_order(a: &NodeRec, b: &NodeRec) -> std::cmp::Ordering {
    a.position
        .cmp(&b.position)
        .then_with(|| a.id.as_bytes().cmp(b.id.as_bytes()))
}

/// Length of `s` in UTF-16 code units — the unit every style range in this project is
/// measured in (the SwiftUI app's `NSRange`s and the frontend's `String` indices agree
/// on it). NEVER `str::len()`, which is BYTES: one non-ASCII character puts every run
/// after it at the wrong offset.
pub fn utf16_len(s: &str) -> i64 {
    s.encode_utf16().count() as i64
}
