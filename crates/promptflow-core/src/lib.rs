//! Everything the PromptFlow desktop app, the sync hub and the iPad client have to
//! agree on: the node model, the sync wire format, and the merge rules.
//!
//! Deliberately dependency-light — serde, serde_json and uuid only. No tauri, no
//! rusqlite, no HTTP: this crate is pure logic, so the hub's integration tests and the
//! app's store tests exercise the SAME code the wire does.

pub mod fixtures;
pub mod merge;
pub mod model;
pub mod splice;
pub mod wire;

pub use model::{now_ms, sibling_order, utf16_len, NodeKind, NodeRec, GAP};
pub use wire::{WireNode, PROTOCOL_VERSION};
