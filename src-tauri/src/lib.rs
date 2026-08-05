mod archive;
mod commands;
#[cfg(target_os = "macos")]
mod macos_defaults;
mod model;
mod persist;
mod seed;
mod store;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::utils::config::WindowEffectsConfig;
use tauri::window::{Effect as WindowEffect, EffectState as WindowEffectState};
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
        // y=24 centers the 12px lights at 22 — the midline of the 44px .topbar strip.
        // (tao's inset resizes the titlebar container to height y+12 and the buttons
        // keep an 8px bottom offset inside it, so button center lands at y-2 from top.)
        .traffic_light_position(tauri::LogicalPosition::new(18.0, 24.0))
        .theme(Some(tauri::Theme::Dark))
        // `Active`, never the NSVisualEffectView default (`FollowsWindowActiveState`,
        // which is also what `state: None` leaves it at): the glass is the app's whole
        // look, and following the active state swaps the material for a flat fill the
        // moment the window stops being key — so a background window read as OPAQUE. The
        // app's own wash (--bg-tint, 45% dark) is constant, so the blur behind it is the
        // only thing that was changing. Must match tauri.conf.json's main window.
        .effects(WindowEffectsConfig {
            effects: vec![WindowEffect::UnderWindowBackground],
            state: Some(WindowEffectState::Active),
            radius: None,
            color: None,
        });
    if let Some((x, y)) = offset {
        builder = builder.position(x, y);
    }
    builder.build()?;
    Ok(label)
}

/// Fraction of the screen's usable WIDTH the app opens at. Height is always the full
/// work area, and the window is centred horizontally in it.
const LAUNCH_WIDTH_FRACTION: f64 = 0.75;

/// Place the app's first window at its launch default: full work-area height, 75% of the
/// work-area width, centred horizontally.
///
/// It has to be code, not config: `tauri.conf.json` takes absolute px only, and the right
/// size depends on the display the app happens to open on. The config window is therefore
/// created `"visible": false` and shown once this has run — resizing a VISIBLE window
/// would make every launch jump from the placeholder rect to the real one.
///
/// The WORK AREA, never `monitor.size()`: on macOS the display bounds include the menu bar
/// and the Dock, so a full-display-height window gets shoved down by AppKit's own frame
/// constraining and hangs its bottom off the screen. Physical units end to end, because
/// that is what the work area is reported in — going through logical points would round
/// twice against the scale factor and leave a seam at the screen edge.
///
/// ⌘N peers deliberately keep their own cascade (see `spawn_window`): this is where the
/// app OPENS, not a rule imposed on every window.
fn place_launch_window(win: &tauri::WebviewWindow) {
    let Some(monitor) = win
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| win.primary_monitor().ok().flatten())
    else {
        return; // no monitor to measure — leave the config's placeholder rect alone
    };
    let area = *monitor.work_area();
    let width = ((area.size.width as f64) * LAUNCH_WIDTH_FRACTION).round() as u32;
    let _ = win.set_size(tauri::PhysicalSize::new(
        width.max(1),
        area.size.height.max(1),
    ));
    let _ = win.set_position(tauri::PhysicalPosition::new(
        area.position.x + (area.size.width as i32 - width as i32) / 2,
        area.position.y,
    ));
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

fn build_menu(
    app: &AppHandle,
) -> tauri::Result<(tauri::menu::Menu<tauri::Wry>, tauri::menu::Submenu<tauri::Wry>)> {
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
    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &file_menu, &edit_menu, &window_menu])
        .build()?;
    Ok((menu, window_menu))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // BEFORE tauri::Builder: it creates the config windows (and their WKWebViews)
    // before the .setup() closure runs, and WebKit latches its TextChecker state
    // once, in the WebProcessPool constructor. Registering later is a no-op.
    #[cfg(target_os = "macos")]
    macos_defaults::register_text_substitution_defaults();

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
            app.manage(commands::AppPaths(path.clone()));

            // Auto-archive sweep (deferred a few seconds so windows can load first):
            // completed units older than the retention age out to a JSON archive, then
            // delete. Gated by the "autoArchive" setting (default on).
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(4));
                let Some(state) = handle.try_state::<StoreState>() else {
                    return;
                };
                let mut store = state.lock().unwrap();
                if store.get_setting("autoArchive").as_deref() == Some("0") {
                    return;
                }
                let cutoff = model::now_ms() - archive::RETENTION_MS;
                let units = archive::collect(&store, Some(cutoff));
                if units.is_empty() {
                    return;
                }
                let dir = archive::archive_dir(&path);
                let doc = archive::document(&store, &units, &Default::default());
                let Ok(_) = archive::write_archive(&dir, &doc) else {
                    return; // backup failed ⇒ delete nothing
                };
                if let Ok(delta) = store.delete_archived(&units) {
                    if !delta.ops.is_empty() {
                        let mut d = delta;
                        d.origin = "auto-archive".into();
                        let _ = handle.emit("store://delta", &d);
                    }
                }
            });

            let (menu, window_menu) = build_menu(app.handle())?;
            app.set_menu(menu)?;
            // Must come AFTER set_menu: muda resolves the submenu's NSMenu from
            // the INSTALLED main menu and silently no-ops if it isn't there yet.
            // Registration makes AppKit auto-append the system window-management
            // items (Fill / Center / Move & Resize / Full Screen Tile / Move to
            // <display> / Bring All to Front + the open-window list) — the same
            // set the SwiftUI original gets for free.
            #[cfg(target_os = "macos")]
            window_menu.set_as_windows_menu_for_nsapp()?;
            #[cfg(not(target_os = "macos"))]
            let _ = &window_menu;
            app.on_menu_event(|app, event| match event.id().0.as_str() {
                // Native row (⋯) menu selection: id = pf-row:<action>:<window>:<node>.
                // Route it back to the window that opened the menu so the frontend runs
                // its own drill/copy/delete logic on the right node.
                s if s.starts_with("pf-row:") => {
                    let mut parts = s.splitn(4, ':');
                    let _ = parts.next(); // "pf-row"
                    if let (Some(action), Some(label), Some(node)) =
                        (parts.next(), parts.next(), parts.next())
                    {
                        #[derive(Clone, serde::Serialize)]
                        struct RowMenuAction<'a> {
                            action: &'a str,
                            node: &'a str,
                        }
                        let _ = app.emit_to(
                            tauri::EventTarget::webview_window(label),
                            "row-menu-action",
                            RowMenuAction { action, node },
                        );
                    }
                }
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

            // Last in setup, so the window appears with the menu already installed. `show`
            // runs even if the placement bailed: the config keeps the window hidden purely
            // so the resize can't be seen, and a window that never appears at all is far
            // worse than one at the placeholder size.
            if let Some(main) = app.get_webview_window("main") {
                place_launch_window(&main);
                let _ = main.show();
            }
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
            commands::toggle_bold_block,
            commands::merge_into_prompt,
            commands::delete_block,
            commands::undo,
            commands::redo,
            commands::new_window,
            commands::seed_demo,
            commands::node_count,
            commands::log_msg,
            commands::export_to_file,
            commands::import_from_file,
            commands::completed_units_info,
            commands::clear_completed,
            commands::archive_dir_path,
            commands::get_setting,
            commands::set_setting,
            commands::popup_row_menu,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
