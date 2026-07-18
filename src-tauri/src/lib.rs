mod commands;
mod model;
mod persist;
mod seed;
mod store;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::utils::config::WindowEffectsConfig;
use tauri::window::Effect as WindowEffect;
use tauri::{AppHandle, Emitter, Manager, TitleBarStyle, WebviewUrl, WebviewWindowBuilder};

use commands::StoreState;
use store::Store;

static WINDOW_SEQ: AtomicUsize = AtomicUsize::new(1);

/// Spawn an additional outline window (⌘N / File → New Window). Every window is a full
/// peer: same URL, own per-window view state, mirror synced by the store's delta events.
pub fn spawn_window(app: &AppHandle) -> tauri::Result<String> {
    let label = loop {
        let n = WINDOW_SEQ.fetch_add(1, Ordering::Relaxed);
        let candidate = format!("w{n}");
        if app.webview_windows().get(&candidate).is_none() {
            break candidate;
        }
    };
    // Cascade off the focused window so new windows don't stack exactly.
    let offset = app
        .webview_windows()
        .values()
        .find(|w| w.is_focused().unwrap_or(false))
        .and_then(|w| w.outer_position().ok())
        .map(|p| (p.x as f64 + 28.0, p.y as f64 + 28.0));
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::default())
        .title("PromptFlow")
        .inner_size(1100.0, 760.0)
        .min_inner_size(480.0, 300.0)
        .transparent(true)
        .hidden_title(true)
        .title_bar_style(TitleBarStyle::Overlay)
        .theme(Some(tauri::Theme::Dark))
        .effects(WindowEffectsConfig {
            effects: vec![WindowEffect::UnderWindowBackground],
            state: None,
            radius: None,
            color: None,
        });
    if let Some((x, y)) = offset {
        builder = builder.position(x, y);
    }
    builder.build()?;
    Ok(label)
}

fn store_path(app: &AppHandle) -> std::path::PathBuf {
    // PROMPTFLOW_STORE overrides for dev/verify isolation (same convention as the
    // SwiftUI app): an absolute path is used as-is; a bare leaf lands in app-data.
    if let Ok(p) = std::env::var("PROMPTFLOW_STORE") {
        let pb = std::path::PathBuf::from(&p);
        if pb.is_absolute() {
            return pb;
        }
        if let Ok(dir) = app.path().app_data_dir() {
            return dir.join(pb);
        }
    }
    app.path()
        .app_data_dir()
        .expect("no app data dir")
        .join("promptflow.sqlite")
}

fn build_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let app_menu = SubmenuBuilder::new(app, "PromptFlow")
        .about(None)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    let new_window = MenuItemBuilder::with_id("pf-new-window", "New Window")
        .accelerator("CmdOrCtrl+N")
        .build(app)?;
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&new_window)
        .separator()
        .close_window()
        .build()?;
    // Undo/redo are CUSTOM items routed to the store's global undo (one history shared
    // by every window, like the SwiftUI app's single UndoManager). The clipboard items
    // are the predefined roles — without them a macOS webview gets no ⌘C/⌘V/⌘X.
    let undo = MenuItemBuilder::with_id("pf-undo", "Undo")
        .accelerator("CmdOrCtrl+Z")
        .build(app)?;
    let redo = MenuItemBuilder::with_id("pf-redo", "Redo")
        .accelerator("CmdOrCtrl+Shift+Z")
        .build(app)?;
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .item(&undo)
        .item(&redo)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .build()?;
    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .fullscreen()
        .build()?;
    MenuBuilder::new(app)
        .items(&[&app_menu, &file_menu, &edit_menu, &window_menu])
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let path = store_path(app.handle());
            let mut store = Store::open(&path).map_err(std::io::Error::other)?;
            if store.is_empty() && std::env::var("PROMPTFLOW_NO_SEED").is_err() {
                let _ = store.insert_tree(seed::welcome_tree());
                store.clear_history(); // the seed is not an undoable user action
            }
            app.manage(Mutex::new(store) as StoreState);

            let menu = build_menu(app.handle())?;
            app.set_menu(menu)?;
            app.on_menu_event(|app, event| match event.id().0.as_str() {
                "pf-new-window" => {
                    let _ = spawn_window(app);
                }
                "pf-undo" => {
                    if let Some(state) = app.try_state::<StoreState>() {
                        if let Ok(delta) = state.lock().unwrap().undo() {
                            if !delta.ops.is_empty() {
                                let mut d = delta;
                                d.origin = "undo".into();
                                let _ = app.emit("store://delta", &d);
                            }
                        }
                    }
                }
                "pf-redo" => {
                    if let Some(state) = app.try_state::<StoreState>() {
                        if let Ok(delta) = state.lock().unwrap().redo() {
                            if !delta.ops.is_empty() {
                                let mut d = delta;
                                d.origin = "redo".into();
                                let _ = app.emit("store://delta", &d);
                            }
                        }
                    }
                }
                _ => {}
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::snapshot,
            commands::commit_new_node,
            commands::append_root,
            commands::append_child,
            commands::insert_sibling_after,
            commands::insert_new_node_relative,
            commands::indent_node,
            commands::outdent_node,
            commands::move_node_by,
            commands::move_node_to,
            commands::delete_node,
            commands::toggle_completed,
            commands::set_text,
            commands::set_note,
            commands::set_kind,
            commands::set_highlighted,
            commands::indent_block,
            commands::outdent_block,
            commands::move_block_by,
            commands::move_block_to,
            commands::toggle_completed_block,
            commands::set_kind_block,
            commands::delete_block,
            commands::undo,
            commands::redo,
            commands::new_window,
            commands::seed_demo,
            commands::node_count,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
