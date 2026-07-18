use crate::model::{NodeKind, NodeRec};
use uuid::Uuid;

/// The first-launch starter outline (mirrors the SwiftUI app's `Seeder`).
pub fn welcome_tree() -> Vec<NodeRec> {
    let mut out = Vec::new();
    let mut root = |text: &str, kind: NodeKind, position: i64| -> Uuid {
        let rec = NodeRec::new(text.into(), kind, None, position);
        let id = rec.id;
        out.push(rec);
        id
    };
    let welcome = root("Welcome to PromptFlow", NodeKind::BulletPoint, 0);
    let prompts_pos = 1024;
    let mut child = |parent: Uuid, text: &str, kind: NodeKind, position: i64| {
        out.push(NodeRec::new(text.into(), kind, Some(parent), position));
    };
    child(
        welcome,
        "Press the + at the bottom to add a node",
        NodeKind::BulletPoint,
        0,
    );
    child(
        welcome,
        "Cmd+1 bullet · Cmd+2 checkbox · Cmd+3 prompt",
        NodeKind::Checkbox,
        1024,
    );
    child(
        welcome,
        "Click a bullet to drill in · Cmd+= / Cmd+- to resize text",
        NodeKind::BulletPoint,
        2048,
    );
    let prompts = NodeRec::new("Prompt drafts".into(), NodeKind::BulletPoint, None, prompts_pos);
    let prompts_id = prompts.id;
    out.push(prompts);
    out.push(NodeRec::new(
        "You are a helpful coding agent. Refactor the function below...".into(),
        NodeKind::PromptDraft,
        Some(prompts_id),
        0,
    ));
    out
}

/// A synthetic tree for performance testing: `roots` top-level nodes, each with
/// `children` children, each of those with `grandchildren` children.
pub fn demo_tree(roots: usize, children: usize, grandchildren: usize) -> Vec<NodeRec> {
    let mut out = Vec::new();
    for r in 0..roots {
        let root = NodeRec::new(
            format!("Project {r} — planning notes and tasks"),
            NodeKind::BulletPoint,
            None,
            (r as i64) * 1024,
        );
        let root_id = root.id;
        out.push(root);
        for c in 0..children {
            let kind = if c % 3 == 1 {
                NodeKind::Checkbox
            } else {
                NodeKind::BulletPoint
            };
            let child = NodeRec::new(
                format!("Task {r}.{c}: flesh out the details of this work item"),
                kind,
                Some(root_id),
                (c as i64) * 1024,
            );
            let child_id = child.id;
            out.push(child);
            for g in 0..grandchildren {
                let mut leaf = NodeRec::new(
                    format!("Note {r}.{c}.{g}: a smaller step with enough text to wrap on narrow windows"),
                    NodeKind::Checkbox,
                    Some(child_id),
                    (g as i64) * 1024,
                );
                leaf.is_completed = g % 4 == 0;
                if leaf.is_completed {
                    leaf.completed_at = Some(crate::model::now_ms());
                }
                out.push(leaf);
            }
        }
    }
    out
}
