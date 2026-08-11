//! The node model now lives in `promptflow-core`, so the sync hub and the app cannot
//! drift apart on it. This module is a thin re-export: `crate::model::NodeRec` keeps
//! resolving everywhere it already did.

pub use promptflow_core::model::{now_ms, sibling_order, utf16_len, NodeKind, NodeRec, GAP};
