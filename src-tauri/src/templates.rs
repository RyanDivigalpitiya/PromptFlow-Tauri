//! Prompt templates: the `.md` files in `<store dir>/Prompt Templates`, read at launch and
//! again on Settings ▸ Prompt Templates ▸ Refresh, plus the per-device display names.
//!
//! The folder is the only source at run time. The app holds what it last read in
//! `TemplatesState`, so the ⋯ menu and an applied template both use that copy, and an edit
//! on disk takes effect at Refresh and not before. Nothing watches the folder.
//!
//! The folder sits beside the store, like `Archive`, so `PROMPTFLOW_STORE` isolates it too
//! and a dev run can't touch the real one. `prompt-templates/` in the repo is only what
//! fills a folder that doesn't exist yet (`build.rs` compiles it in as `DEFAULTS`): an
//! existing folder is never written to, so an edit or a deleted default stays that way.
//!
//! Names are DERIVED from the file name and overridable in Settings. The override map
//! lives in the backend `settings` table, NOT localStorage, because the ⋯ menu is built in
//! Rust and localStorage is invisible from here — which also means a rename takes effect
//! in every window the next time the menu opens, with no delta and no broadcast.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub struct Template {
    pub id: String,
    pub file: String,
    pub default_name: String,
    pub body: String,
}

include!(concat!(env!("OUT_DIR"), "/templates_generated.rs"));

/// The templates as of the last scan. Its own lock, not a field on the store: every
/// keystroke waits on the store's mutex, and this has nothing to do with the outline.
pub struct TemplatesState(pub Mutex<Vec<Template>>);

/// The settings-table key holding the `{id: name}` override map, as JSON.
pub const NAMES_KEY: &str = "promptTemplateNames";

/// Larger than this is not a prompt, and would land in a single node's text.
const MAX_BYTES: u64 = 256 * 1024;
/// Longer derived names are cut, so one long file name can't stretch the whole submenu.
const MAX_NAME_CHARS: usize = 48;

/// One row of the Settings ▸ Prompt Templates list.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TemplateInfo {
    pub id: String,
    /// The file on disk, which is what the row is labelled with.
    pub file: String,
    /// The file-name-derived default, shown as the input's placeholder.
    pub default_name: String,
    /// What the menu actually says: the override when set, else the default.
    pub name: String,
}

/// A `.md` file the scan could not use. Reported rather than dropped, or a template that
/// never appears just looks like Refresh doesn't work.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkippedFile {
    pub file: String,
    pub reason: String,
}

pub struct Scan {
    pub templates: Vec<Template>,
    pub skipped: Vec<SkippedFile>,
}

/// What a Refresh found, by id. An edit shows nothing in the list, so these counts are the
/// only proof it was picked up.
#[derive(Debug, Default, PartialEq)]
pub struct Change {
    pub added: usize,
    pub edited: usize,
    pub removed: usize,
}

/// Where the templates live: `<store dir>/Prompt Templates`.
pub fn dir_for(store_path: &Path) -> PathBuf {
    store_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Prompt Templates")
}

/// Create the folder with the defaults in it if it does not exist. Keyed on the FOLDER
/// and not on the files, so emptying it stays empty: the only way back to the defaults is
/// deleting the folder itself.
pub fn ensure_dir(dir: &Path) -> std::io::Result<()> {
    if dir.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(dir)?;
    for (file, body) in DEFAULTS {
        std::fs::write(dir.join(file), body)?;
    }
    Ok(())
}

/// Read every template in the folder. An `Err` means the folder itself could not be read,
/// and the caller keeps what it had rather than emptying the menu.
pub fn scan(dir: &Path) -> std::io::Result<Scan> {
    ensure_dir(dir)?;
    // Sorted before the id check, so which of two colliding files wins can't depend on
    // the order the filesystem happens to list them in.
    let mut paths: Vec<PathBuf> = std::fs::read_dir(dir)?
        .flatten()
        .map(|e| e.path())
        .filter(|p| is_template_file(p))
        .collect();
    paths.sort();

    let mut templates: Vec<Template> = Vec::new();
    let mut skipped: Vec<SkippedFile> = Vec::new();
    let mut seen: HashMap<String, String> = HashMap::new();
    for path in paths {
        let file = lossy_name(path.file_name());
        let stem = lossy_name(path.file_stem());
        let id = template_id(&stem);
        // Only reachable on a case-sensitive volume (`a.md` beside `a.MD`), where both
        // would otherwise answer to one id.
        if let Some(first) = seen.get(&id) {
            let reason = format!("same name as {first}");
            skipped.push(SkippedFile { file, reason });
            continue;
        }
        match read_body(&path) {
            Ok(body) => {
                seen.insert(id.clone(), file.clone());
                templates.push(Template {
                    id,
                    file,
                    default_name: display_name(&stem),
                    body,
                });
            }
            Err(reason) => skipped.push(SkippedFile { file, reason }),
        }
    }
    templates.sort_by(|a, b| {
        a.default_name
            .to_lowercase()
            .cmp(&b.default_name.to_lowercase())
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(Scan { templates, skipped })
}

/// A visible `.md` that isn't a directory. A symlink counts when it points at a file, so
/// `std::fs::metadata` (which follows it) and not the dir entry's own. A BROKEN link still
/// counts here, so that it gets reported by `read_body` instead of vanishing.
fn is_template_file(path: &Path) -> bool {
    let is_md = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("md"));
    let hidden = path
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with('.'));
    is_md && !hidden && std::fs::metadata(path).map_or(true, |m| m.is_file())
}

fn lossy_name(name: Option<&std::ffi::OsStr>) -> String {
    name.map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

fn read_body(path: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_BYTES {
        return Err("larger than 256 KB".into());
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let text = String::from_utf8(bytes).map_err(|_| "not UTF-8 text".to_string())?;
    let body = normalize_body(&text);
    // A blank template can only wipe the prompt it is applied to.
    if body.trim().is_empty() {
        return Err("empty".into());
    }
    Ok(body)
}

/// A file's conventions, not its content. `\r` would land in the node's text, where the
/// line-based markdown renderer and the caret offsets both assume `\n`; a BOM would stop a
/// first-line `# ` reading as a heading; and the final newline every editor appends would
/// show as a blank last line in the prompt. Only `\n` is trimmed, because a trailing space
/// can be meaningful (`- ` waiting to be filled in).
fn normalize_body(raw: &str) -> String {
    raw.strip_prefix('\u{feff}')
        .unwrap_or(raw)
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .trim_end_matches('\n')
        .to_string()
}

/// A file's stem as an id, with everything outside `[A-Za-z0-9._-]` percent-encoded.
///
/// It MUST stay colon-free: the row menu encodes item ids as
/// `pf-row:<action>:<window>:<node>` and `lib.rs` parses them with `splitn(4, ':')`, so a
/// colon would misroute the event to a nonexistent window label, where `emit_to` silently
/// no-ops. APFS allows `:` in a file name. Encoded rather than replaced, because these are
/// names typed at run time and two of them collapsing into one id must not be possible
/// (with `_`, every two-character Japanese name is the same id). The extension is left
/// out so an id stays what it was when the files had none, which is what existing renames
/// in the settings table are keyed on.
fn template_id(stem: &str) -> String {
    let mut id = String::with_capacity(stem.len());
    for b in stem.bytes() {
        if b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-' {
            id.push(b as char);
        } else {
            id.push_str(&format!("%{b:02X}"));
        }
    }
    id
}

/// `New-Feature-Discuss-Plan` -> `New Feature Discuss Plan`. Purely the DEFAULT: any
/// template can be renamed in Settings.
fn display_name(stem: &str) -> String {
    let spaced: String = stem
        .chars()
        .map(|c| if c == '-' || c == '_' { ' ' } else { c })
        .collect();
    let trimmed = spaced.trim();
    // `---.md` has no words left to show, and a menu item can't be blank.
    let name = if trimmed.is_empty() { stem } else { trimmed };
    if name.chars().count() > MAX_NAME_CHARS {
        name.chars().take(MAX_NAME_CHARS).collect::<String>().trim_end().to_string()
    } else {
        name.to_string()
    }
}

pub fn by_id<'a>(templates: &'a [Template], id: &str) -> Option<&'a Template> {
    templates.iter().find(|t| t.id == id)
}

pub fn change_between(old: &[Template], new: &[Template]) -> Change {
    let new_ids: HashSet<&str> = new.iter().map(|t| t.id.as_str()).collect();
    let mut change = Change {
        removed: old.iter().filter(|t| !new_ids.contains(t.id.as_str())).count(),
        ..Change::default()
    };
    for t in new {
        match by_id(old, &t.id) {
            None => change.added += 1,
            Some(before) if before.body != t.body => change.edited += 1,
            Some(_) => {}
        }
    }
    change
}

/// Parse the override map. A malformed value is treated as "no overrides" rather than an
/// error: a corrupt settings row must never be able to empty the submenu.
pub fn overrides(raw: Option<String>) -> HashMap<String, String> {
    raw.and_then(|s| serde_json::from_str::<HashMap<String, String>>(&s).ok())
        .unwrap_or_default()
}

/// The name to show for `t`, with the override applied. An override that is blank or
/// whitespace-only falls back to the default, so clearing the field in Settings resets it.
pub fn name_of(t: &Template, ov: &HashMap<String, String>) -> String {
    match ov.get(&t.id) {
        Some(v) if !v.trim().is_empty() => v.trim().to_string(),
        _ => t.default_name.clone(),
    }
}

pub fn list(templates: &[Template], ov: &HashMap<String, String>) -> Vec<TemplateInfo> {
    templates
        .iter()
        .map(|t| TemplateInfo {
            id: t.id.clone(),
            file: t.file.clone(),
            default_name: t.default_name.clone(),
            name: name_of(t, ov),
        })
        .collect()
}

/// A display name as an NSMenu item title. On macOS muda treats a lone `&` as a mnemonic
/// marker and eats it, so it has to be doubled — and the shipped template's own body says
/// "Context & Current Problem", which is exactly the kind of name a user would type here.
pub fn menu_label(name: &str) -> String {
    name.replace('&', "&&")
}

/// The menu action for a template: `tpl-<id>`. `id` is colon-free by construction
/// (`template_id`), which is what keeps `lib.rs`'s `splitn(4, ':')` parse of
/// `pf-row:<action>:<window>:<node>` intact.
pub fn menu_action(id: &str) -> String {
    format!("tpl-{id}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempdir::TempDir;

    const SHIPPED: &str = "New-Feature-Discuss-Plan";

    /// A folder path that does not exist yet, which is what a first launch sees.
    fn absent_folder() -> (TempDir, PathBuf) {
        let t = TempDir::new("pf-templates").unwrap();
        let dir = t.path().join("Prompt Templates");
        (t, dir)
    }

    fn empty_folder() -> (TempDir, PathBuf) {
        let (t, dir) = absent_folder();
        fs::create_dir(&dir).unwrap();
        (t, dir)
    }

    fn ov(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    fn files(scan: &Scan) -> Vec<&str> {
        scan.templates.iter().map(|t| t.file.as_str()).collect()
    }

    fn tpl(id: &str, body: &str) -> Template {
        Template {
            id: id.into(),
            file: format!("{id}.md"),
            default_name: id.into(),
            body: body.into(),
        }
    }

    #[test]
    fn the_folder_sits_beside_the_store() {
        assert_eq!(
            dir_for(Path::new("/a/b/promptflow.sqlite")),
            PathBuf::from("/a/b/Prompt Templates")
        );
    }

    /// If this fails, `prompt-templates/` was not committed: a fresh clone that lacks it
    /// builds an empty table rather than failing to compile.
    #[test]
    fn a_missing_folder_is_created_with_the_shipped_template() {
        let (_t, dir) = absent_folder();
        let scan = scan(&dir).unwrap();
        assert!(dir.join(format!("{SHIPPED}.md")).is_file());
        let t = by_id(&scan.templates, SHIPPED).expect("no shipped template");
        assert_eq!(t.file, format!("{SHIPPED}.md"));
        assert_eq!(t.default_name, "New Feature Discuss Plan");
        assert!(t.body.starts_with("# New Feature: Discuss & Plan"));
        // It must exercise the markdown renderer, or picking it demonstrates nothing.
        assert!(t.body.contains("\n## Overall Goal"));
        assert!(t.body.contains("\n1. First,"));
    }

    /// A default the scan itself would refuse would be seeded and then never listed.
    #[test]
    fn every_default_survives_its_own_scan() {
        let (_t, dir) = absent_folder();
        let scan = scan(&dir).unwrap();
        assert_eq!(scan.templates.len(), DEFAULTS.len());
        assert!(scan.skipped.is_empty(), "{:?}", scan.skipped);
    }

    /// The whole point of keying the seed on the folder: deleting a default must stick.
    #[test]
    fn an_existing_folder_is_never_seeded_again() {
        let (_t, dir) = absent_folder();
        scan(&dir).unwrap();
        fs::remove_file(dir.join(format!("{SHIPPED}.md"))).unwrap();
        assert!(scan(&dir).unwrap().templates.is_empty());
        assert!(!dir.join(format!("{SHIPPED}.md")).exists());
    }

    #[test]
    fn an_edited_default_is_never_overwritten() {
        let (_t, dir) = absent_folder();
        scan(&dir).unwrap();
        fs::write(dir.join(format!("{SHIPPED}.md")), "# Mine").unwrap();
        let again = scan(&dir).unwrap();
        assert_eq!(by_id(&again.templates, SHIPPED).unwrap().body, "# Mine");
    }

    /// The feature itself: files changed while the app runs show up on the next scan, and
    /// the counts say what happened.
    #[test]
    fn a_rescan_picks_up_new_edited_and_removed_files() {
        let (_t, dir) = empty_folder();
        fs::write(dir.join("keep.md"), "same").unwrap();
        fs::write(dir.join("edit.md"), "before").unwrap();
        fs::write(dir.join("gone.md"), "x").unwrap();
        let first = scan(&dir).unwrap();

        fs::write(dir.join("edit.md"), "after").unwrap();
        fs::write(dir.join("new.md"), "fresh").unwrap();
        fs::remove_file(dir.join("gone.md")).unwrap();
        let second = scan(&dir).unwrap();

        assert_eq!(files(&second), ["edit.md", "keep.md", "new.md"]);
        assert_eq!(by_id(&second.templates, "edit").unwrap().body, "after");
        assert_eq!(
            change_between(&first.templates, &second.templates),
            Change { added: 1, edited: 1, removed: 1 }
        );
    }

    #[test]
    fn a_rescan_with_no_changes_reports_none() {
        let (_t, dir) = empty_folder();
        fs::write(dir.join("a.md"), "a").unwrap();
        let first = scan(&dir).unwrap();
        let second = scan(&dir).unwrap();
        assert_eq!(change_between(&first.templates, &second.templates), Change::default());
    }

    #[test]
    fn only_visible_md_files_are_templates() {
        let (_t, dir) = empty_folder();
        fs::write(dir.join("a.md"), "a").unwrap();
        fs::write(dir.join("b.MD"), "b").unwrap();
        fs::write(dir.join("c.txt"), "c").unwrap();
        fs::write(dir.join("noext"), "d").unwrap();
        fs::write(dir.join(".hidden.md"), "e").unwrap();
        fs::write(dir.join(".DS_Store"), [0u8, 159, 146, 150]).unwrap();
        fs::create_dir(dir.join("folder.md")).unwrap();
        let scan = scan(&dir).unwrap();
        assert_eq!(files(&scan), ["a.md", "b.MD"]);
        assert!(scan.skipped.is_empty(), "{:?}", scan.skipped);
    }

    #[test]
    fn a_symlink_counts_and_a_broken_one_is_reported() {
        let (t, dir) = empty_folder();
        let target = t.path().join("elsewhere.txt");
        fs::write(&target, "linked").unwrap();
        std::os::unix::fs::symlink(&target, dir.join("good.md")).unwrap();
        std::os::unix::fs::symlink(t.path().join("nope"), dir.join("bad.md")).unwrap();
        let scan = scan(&dir).unwrap();
        assert_eq!(by_id(&scan.templates, "good").unwrap().body, "linked");
        assert_eq!(scan.skipped.len(), 1);
        assert_eq!(scan.skipped[0].file, "bad.md");
    }

    #[test]
    fn an_unusable_md_file_is_reported_rather_than_dropped() {
        let (_t, dir) = empty_folder();
        fs::write(dir.join("ok.md"), "fine").unwrap();
        fs::write(dir.join("blank.md"), "  \n\n").unwrap();
        fs::write(dir.join("zero.md"), "").unwrap();
        fs::write(dir.join("binary.md"), [0xffu8, 0xfe, 0x00]).unwrap();
        fs::write(dir.join("huge.md"), "x".repeat(MAX_BYTES as usize + 1)).unwrap();
        fs::write(dir.join("max.md"), "x".repeat(MAX_BYTES as usize)).unwrap();
        let scan = scan(&dir).unwrap();
        assert_eq!(files(&scan), ["max.md", "ok.md"]);
        let reasons: Vec<(&str, &str)> = scan
            .skipped
            .iter()
            .map(|s| (s.file.as_str(), s.reason.as_str()))
            .collect();
        assert_eq!(
            reasons,
            [
                ("binary.md", "not UTF-8 text"),
                ("blank.md", "empty"),
                ("huge.md", "larger than 256 KB"),
                ("zero.md", "empty"),
            ]
        );
    }

    /// A folder that can't be read must be an error: the refresh command bails on it
    /// before replacing the table, so a bad read can't empty the ⋯ menu.
    #[test]
    fn an_unreadable_folder_is_an_error() {
        let (t, _dir) = absent_folder();
        let not_a_folder = t.path().join("file");
        fs::write(&not_a_folder, "x").unwrap();
        assert!(scan(&not_a_folder).is_err());
    }

    #[test]
    fn file_conventions_do_not_reach_the_text() {
        assert_eq!(normalize_body("\u{feff}# T\r\nline\rend\n\n"), "# T\nline\nend");
        assert_eq!(normalize_body("no newline"), "no newline");
        // Blank lines inside are content, and so is an item's trailing space.
        assert_eq!(normalize_body("a\n\nb\n- \n"), "a\n\nb\n- ");
    }

    /// Every file name must come back out of `lib.rs`'s `splitn(4, ':')` parse intact, or
    /// the menu event goes to a window that doesn't exist and nothing happens.
    #[test]
    fn any_file_name_survives_the_menu_route() {
        let (_t, dir) = empty_folder();
        let names = ["a:b", "a b", "a_b", "日本", "中文", "100%", "a%20b", "A & B", "---"];
        for name in names {
            fs::write(dir.join(format!("{name}.md")), "x").unwrap();
        }
        let scan = scan(&dir).unwrap();
        assert_eq!(scan.templates.len(), names.len(), "{:?}", scan.skipped);
        for t in &scan.templates {
            let item = format!("pf-row:{}:w12:node-id", menu_action(&t.id));
            let parts: Vec<&str> = item.splitn(4, ':').collect();
            assert_eq!(parts[1], format!("tpl-{}", t.id));
            assert_eq!(parts[2], "w12", "`{}` shifted the window label", t.file);
            assert!(!t.default_name.is_empty(), "`{}` has a blank menu item", t.file);
        }
    }

    /// The rename already in the settings table is keyed on the id from when the shipped
    /// file had no extension. Adding `.md` must not lose it.
    #[test]
    fn adding_the_extension_keeps_the_existing_id() {
        assert_eq!(template_id(SHIPPED), SHIPPED);
    }

    #[test]
    fn derived_names_read_like_names() {
        assert_eq!(display_name(SHIPPED), "New Feature Discuss Plan");
        assert_eq!(display_name("snake_case name"), "snake case name");
        assert_eq!(display_name("---"), "---");
        assert_eq!(display_name(&"x".repeat(60)).chars().count(), MAX_NAME_CHARS);
        assert_eq!(display_name(&"é".repeat(60)).chars().count(), MAX_NAME_CHARS);
    }

    #[test]
    fn templates_sort_by_name_whatever_the_case() {
        let (_t, dir) = empty_folder();
        for name in ["zebra", "Apple", "mango"] {
            fs::write(dir.join(format!("{name}.md")), "x").unwrap();
        }
        assert_eq!(files(&scan(&dir).unwrap()), ["Apple.md", "mango.md", "zebra.md"]);
    }

    #[test]
    fn an_override_replaces_the_derived_name() {
        let t = Template {
            default_name: "New Feature Discuss Plan".into(),
            ..tpl(SHIPPED, "x")
        };
        assert_eq!(name_of(&t, &ov(&[])), "New Feature Discuss Plan");
        assert_eq!(
            name_of(&t, &ov(&[(SHIPPED, "New Feature: Discuss & Plan")])),
            "New Feature: Discuss & Plan"
        );
        // Blank or whitespace-only clears back to the default — that IS the Reset button.
        assert_eq!(name_of(&t, &ov(&[(SHIPPED, "   ")])), "New Feature Discuss Plan");
        assert_eq!(name_of(&t, &ov(&[(SHIPPED, "")])), "New Feature Discuss Plan");
        // Surrounding space is the user's typo, not their intent.
        assert_eq!(name_of(&t, &ov(&[(SHIPPED, "  Spaced  ")])), "Spaced");
    }

    #[test]
    fn a_corrupt_override_row_does_not_empty_the_menu() {
        assert!(overrides(Some("not json".into())).is_empty());
        assert!(overrides(Some("[1,2,3]".into())).is_empty());
        assert!(overrides(None).is_empty());
        assert_eq!(overrides(Some(r#"{"a":"b"}"#.into())).get("a").unwrap(), "b");
    }

    /// muda eats a lone `&` as a mnemonic marker on macOS.
    #[test]
    fn menu_labels_double_the_ampersand() {
        assert_eq!(menu_label("Context & Problem"), "Context && Problem");
        assert_eq!(menu_label("plain"), "plain");
        assert_eq!(menu_label("A & B & C"), "A && B && C");
    }

    #[test]
    fn list_reports_file_default_and_effective_names_separately() {
        let t = Template {
            default_name: "New Feature Discuss Plan".into(),
            ..tpl(SHIPPED, "x")
        };
        let rows = list(&[t], &ov(&[(SHIPPED, "Renamed")]));
        assert_eq!(rows[0].file, format!("{SHIPPED}.md"));
        assert_eq!(rows[0].default_name, "New Feature Discuss Plan");
        assert_eq!(rows[0].name, "Renamed");
    }
}
