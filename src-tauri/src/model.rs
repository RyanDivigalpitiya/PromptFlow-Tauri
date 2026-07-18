use serde::{Deserialize, Serialize};
use uuid::Uuid;

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

/// One outline node — the flat record shape shared by the store, SQLite, and the
/// frontend mirror. The tree is expressed by `parent` + `position` (gapped sibling
/// ordering, exactly like the SwiftUI app's SwiftData model).
///
/// `is_collapsed` is NOT live UI state: collapse is per-window and lives in each
/// window's frontend state. The flag here is only an import/export seed so documents
/// round-trip with the SwiftUI app.
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
    pub is_collapsed: bool,
    /// Bold character ranges over `text` as flat `[location, length, …]` pairs.
    pub bold_ranges: Vec<i64>,
    /// Milliseconds since the Unix epoch.
    pub created_at: i64,
    pub updated_at: i64,
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
            is_collapsed: false,
            bold_ranges: Vec::new(),
            created_at: now,
            updated_at: now,
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
