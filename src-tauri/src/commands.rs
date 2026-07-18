use crate::model::NodeKind;
use crate::store::{Delta, MutationOut, Snapshot, Store};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State, WebviewWindow};
use uuid::Uuid;

pub type StoreState = Mutex<Store>;

/// Broadcast a mutation's delta to EVERY window (the caller included — each window's
/// mirror applies deltas uniformly, keyed by `rev`). No-op mutations don't broadcast.
fn emit_delta(app: &AppHandle, mut delta: Delta, origin: &str) {
    if delta.ops.is_empty() {
        return;
    }
    delta.origin = origin.to_string();
    let _ = app.emit("store://delta", &delta);
}

fn run_mutation(
    app: &AppHandle,
    window: &WebviewWindow,
    result: Result<(Delta, MutationOut), String>,
) -> Result<MutationOut, String> {
    let (delta, out) = result?;
    emit_delta(app, delta, window.label());
    Ok(out)
}

#[tauri::command]
pub fn snapshot(state: State<StoreState>) -> Result<Snapshot, String> {
    Ok(state.lock().unwrap().snapshot())
}

#[tauri::command]
pub fn commit_new_node(
    app: AppHandle,
    window: WebviewWindow,
    state: State<StoreState>,
    node: Uuid,
    before: String,
    after: String,
    expanded_in_window: bool,
    hide_completed: bool,
) -> Result<MutationOut, String> {
    let r = state
        .lock()
        .unwrap()
        .commit_new_node(node, before, after, expanded_in_window, hide_completed);
    run_mutation(&app, &window, r)
}

#[tauri::command]
pub fn append_root(
    app: AppHandle,
    window: WebviewWindow,
    state: State<StoreState>,
    kind: Option<NodeKind>,
) -> Result<MutationOut, String> {
    let r = state
        .lock()
        .unwrap()
        .append_root(kind.unwrap_or(NodeKind::BulletPoint));
    run_mutation(&app, &window, r)
}

#[tauri::command]
pub fn append_child(
    app: AppHandle,
    window: WebviewWindow,
    state: State<StoreState>,
    parent: Uuid,
    kind: Option<NodeKind>,
) -> Result<MutationOut, String> {
    let r = state
        .lock()
        .unwrap()
        .append_child(parent, kind.unwrap_or(NodeKind::BulletPoint));
    run_mutation(&app, &window, r)
}

#[tauri::command]
pub fn insert_sibling_after(
    app: AppHandle,
    window: WebviewWindow,
    state: State<StoreState>,
    node: Uuid,
    kind: NodeKind,
) -> Result<MutationOut, String> {
    let r = state.lock().unwrap().insert_sibling_after(node, kind);
    run_mutation(&app, &window, r)
}

#[tauri::command]
pub fn insert_new_node_relative(
    app: AppHandle,
    window: WebviewWindow,
    state: State<StoreState>,
    node: Uuid,
    force_child: bool,
    hide_completed: bool,
) -> Result<MutationOut, String> {
    let r = state
        .lock()
        .unwrap()
        .insert_new_node_relative(node, force_child, hide_completed);
    run_mutation(&app, &window, r)
}

#[tauri::command]
pub fn indent_node(
    app: AppHandle,
    window: WebviewWindow,
    state: State<StoreState>,
    node: Uuid,
    hide_completed: bool,
) -> Result<MutationOut, String> {
    let r = state.lock().unwrap().indent(node, hide_completed);
    run_mutation(&app, &window, r)
}

#[tauri::command]
pub fn outdent_node(
    app: AppHandle,
    window: WebviewWindow,
    state: State<StoreState>,
    node: Uuid,
) -> Result<MutationOut, String> {
    let r = state.lock().unwrap().outdent(node);
    run_mutation(&app, &window, r)
}

#[tauri::command]
pub fn move_node_by(
    app: AppHandle,
    window: WebviewWindow,
    state: State<StoreState>,
    node: Uuid,
    offset: i64,
    hide_completed: bool,
) -> Result<MutationOut, String> {
    let r = state.lock().unwrap().move_by(node, offset, hide_completed);
    run_mutation(&app, &window, r)
}

#[tauri::command]
pub fn move_node_to(
    app: AppHandle,
    window: WebviewWindow,
    state: State<StoreState>,
    node: Uuid,
    new_parent: Option<Uuid>,
    after: Option<Uuid>,
) -> Result<MutationOut, String> {
    let r = state.lock().unwrap().move_to(node, new_parent, after);
    run_mutation(&app, &window, r)
}

#[tauri::command]
pub fn delete_node(
    app: AppHandle,
    window: WebviewWindow,
    state: State<StoreState>,
    node: Uuid,
) -> Result<MutationOut, String> {
    let r = state.lock().unwrap().delete(node);
    run_mutation(&app, &window, r)
}

#[tauri::command]
pub fn toggle_completed(
    app: AppHandle,
    window: WebviewWindow,
    state: State<StoreState>,
    node: Uuid,
) -> Result<MutationOut, String> {
    let r = state.lock().unwrap().toggle_completed(node);
    run_mutation(&app, &window, r)
}

#[tauri::command]
pub fn set_text(
    app: AppHandle,
    window: WebviewWindow,
    state: State<StoreState>,
    node: Uuid,
    text: String,
    bold_ranges: Option<Vec<i64>>,
    italic_ranges: Option<Vec<i64>>,
    underline_ranges: Option<Vec<i64>>,
) -> Result<MutationOut, String> {
    let r = state
        .lock()
        .unwrap()
        .set_text(node, text, bold_ranges, italic_ranges, underline_ranges);
    run_mutation(&app, &window, r)
}

#[tauri::command]
pub fn set_note(
    app: AppHandle,
    window: WebviewWindow,
    state: State<StoreState>,
    node: Uuid,
    note: String,
) -> Result<MutationOut, String> {
    let r = state.lock().unwrap().set_note(node, note);
    run_mutation(&app, &window, r)
}

#[tauri::command]
pub fn set_kind(
    app: AppHandle,
    window: WebviewWindow,
    state: State<StoreState>,
    node: Uuid,
    kind: NodeKind,
) -> Result<MutationOut, String> {
    let r = state.lock().unwrap().set_kind(node, kind);
    run_mutation(&app, &window, r)
}

#[tauri::command]
pub fn set_highlighted(
    app: AppHandle,
    window: WebviewWindow,
    state: State<StoreState>,
    node: Uuid,
    on: bool,
) -> Result<MutationOut, String> {
    let r = state.lock().unwrap().set_highlighted(node, on);
    run_mutation(&app, &window, r)
}

// MARK: Block (multi-select) commands

#[tauri::command]
pub fn indent_block(
    app: AppHandle,
    window: WebviewWindow,
    state: State<StoreState>,
    ids: Vec<Uuid>,
    hide_completed: bool,
) -> Result<MutationOut, String> {
    let r = state.lock().unwrap().indent_block(&ids, hide_completed);
    run_mutation(&app, &window, r)
}

#[tauri::command]
pub fn outdent_block(
    app: AppHandle,
    window: WebviewWindow,
    state: State<StoreState>,
    ids: Vec<Uuid>,
) -> Result<MutationOut, String> {
    let r = state.lock().unwrap().outdent_block(&ids);
    run_mutation(&app, &window, r)
}

#[tauri::command]
pub fn move_block_by(
    app: AppHandle,
    window: WebviewWindow,
    state: State<StoreState>,
    ids: Vec<Uuid>,
    offset: i64,
    hide_completed: bool,
) -> Result<MutationOut, String> {
    let r = state
        .lock()
        .unwrap()
        .move_block_by(&ids, offset, hide_completed);
    run_mutation(&app, &window, r)
}

#[tauri::command]
pub fn move_block_to(
    app: AppHandle,
    window: WebviewWindow,
    state: State<StoreState>,
    ids: Vec<Uuid>,
    new_parent: Option<Uuid>,
    after: Option<Uuid>,
) -> Result<MutationOut, String> {
    let r = state.lock().unwrap().move_block_to(&ids, new_parent, after);
    run_mutation(&app, &window, r)
}

#[tauri::command]
pub fn toggle_completed_block(
    app: AppHandle,
    window: WebviewWindow,
    state: State<StoreState>,
    ids: Vec<Uuid>,
) -> Result<MutationOut, String> {
    let r = state.lock().unwrap().toggle_completed_block(&ids);
    run_mutation(&app, &window, r)
}

#[tauri::command]
pub fn set_kind_block(
    app: AppHandle,
    window: WebviewWindow,
    state: State<StoreState>,
    ids: Vec<Uuid>,
    kind: NodeKind,
) -> Result<MutationOut, String> {
    let r = state.lock().unwrap().set_kind_block(&ids, kind);
    run_mutation(&app, &window, r)
}

#[tauri::command]
pub fn delete_block(
    app: AppHandle,
    window: WebviewWindow,
    state: State<StoreState>,
    ids: Vec<Uuid>,
) -> Result<MutationOut, String> {
    let r = state.lock().unwrap().delete_block(&ids);
    run_mutation(&app, &window, r)
}

// MARK: Undo / redo

#[tauri::command]
pub fn undo(app: AppHandle, state: State<StoreState>) -> Result<(), String> {
    let delta = state.lock().unwrap().undo()?;
    emit_delta(&app, delta, "undo");
    Ok(())
}

#[tauri::command]
pub fn redo(app: AppHandle, state: State<StoreState>) -> Result<(), String> {
    let delta = state.lock().unwrap().redo()?;
    emit_delta(&app, delta, "redo");
    Ok(())
}

// MARK: Windows / dev

#[tauri::command]
pub fn new_window(app: AppHandle) -> Result<String, String> {
    crate::spawn_window(&app).map_err(|e| e.to_string())
}

/// Seed a synthetic tree for performance testing (adds to the existing outline).
#[tauri::command]
pub fn seed_demo(
    app: AppHandle,
    window: WebviewWindow,
    state: State<StoreState>,
    roots: usize,
    children: usize,
    grandchildren: usize,
) -> Result<usize, String> {
    let recs = crate::seed::demo_tree(roots, children, grandchildren);
    let n = recs.len();
    let delta = state.lock().unwrap().insert_tree(recs)?;
    emit_delta(&app, delta, window.label());
    Ok(n)
}

#[tauri::command]
pub fn node_count(state: State<StoreState>) -> Result<usize, String> {
    Ok(state.lock().unwrap().node_count())
}

/// Frontend diagnostics land in the dev terminal (window.onerror etc.).
#[tauri::command]
pub fn log_msg(window: WebviewWindow, msg: String) {
    eprintln!("[js:{}] {}", window.label(), msg);
}

// MARK: Export / import / archive

/// The store's sqlite path, stashed at setup (archive dir derives from it).
pub struct AppPaths(pub std::path::PathBuf);

#[tauri::command]
pub fn export_to_file(
    state: State<StoreState>,
    path: String,
    collapsed: Vec<Uuid>,
) -> Result<usize, String> {
    let store = state.lock().unwrap();
    let roots = store.roots();
    let doc = crate::archive::document(&store, &roots, &collapsed.into_iter().collect());
    let json = crate::archive::encode(&doc)?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(store.node_count())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOut {
    pub imported: usize,
    /// Ids to seed the importing window's collapsed set (per-window state).
    pub collapsed: Vec<Uuid>,
}

/// REPLACE the whole outline from a `.promptflow.outline` JSON file. Destructive by
/// design — the frontend confirms first. NOT undoable (history cleared).
#[tauri::command]
pub fn import_from_file(
    app: AppHandle,
    window: WebviewWindow,
    state: State<StoreState>,
    path: String,
) -> Result<ImportOut, String> {
    let json = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let doc = crate::archive::decode(&json)?;
    let (recs, collapsed) = crate::archive::to_records(&doc);
    let n = recs.len();
    let delta = state.lock().unwrap().replace_all(recs)?;
    emit_delta(&app, delta, window.label());
    Ok(ImportOut {
        imported: n,
        collapsed,
    })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletedInfo {
    pub units: usize,
    pub nodes: usize,
}

/// What "Clear Completed" WOULD remove (for the confirmation dialog).
#[tauri::command]
pub fn completed_units_info(state: State<StoreState>) -> Result<CompletedInfo, String> {
    let store = state.lock().unwrap();
    let units = crate::archive::collect(&store, None);
    let nodes = units.iter().map(|u| store.descendants(*u).len()).sum();
    Ok(CompletedInfo {
        units: units.len(),
        nodes,
    })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearOut {
    pub archived: usize,
    pub path: String,
}

/// Manual "Clear Completed": archive every completed unit to disk FIRST, then delete
/// (never lose data we couldn't back up). Non-undoable, mirroring the SwiftUI app.
#[tauri::command]
pub fn clear_completed(
    app: AppHandle,
    window: WebviewWindow,
    state: State<StoreState>,
    paths: State<AppPaths>,
) -> Result<ClearOut, String> {
    let mut store = state.lock().unwrap();
    let units = crate::archive::collect(&store, None);
    if units.is_empty() {
        return Ok(ClearOut {
            archived: 0,
            path: String::new(),
        });
    }
    let doc = crate::archive::document(&store, &units, &Default::default());
    let dir = crate::archive::archive_dir(&paths.0);
    let path = crate::archive::write_archive(&dir, &doc)?;
    let nodes: usize = units.iter().map(|u| store.descendants(*u).len()).sum();
    let delta = store.delete_archived(&units)?;
    drop(store);
    emit_delta(&app, delta, window.label());
    Ok(ClearOut {
        archived: nodes,
        path: path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub fn archive_dir_path(paths: State<AppPaths>) -> Result<String, String> {
    let dir = crate::archive::archive_dir(&paths.0);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn get_setting(state: State<StoreState>, key: String) -> Result<Option<String>, String> {
    Ok(state.lock().unwrap().get_setting(&key))
}

#[tauri::command]
pub fn set_setting(state: State<StoreState>, key: String, value: String) -> Result<(), String> {
    state.lock().unwrap().set_setting(&key, &value)
}
