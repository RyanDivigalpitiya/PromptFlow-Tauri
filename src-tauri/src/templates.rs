//! Prompt templates: the scaffolds a prompt's ⋯ menu fills its panel from, created and
//! edited IN THE APP (TopBar ▸ Templates ▸ the template editor).
//!
//! They live in the store's own SQLite file, in the `prompt_templates` table, so a save is
//! one statement and there is no file name to sanitize, no folder to watch and no second
//! copy to drift. (They used to be `.md` files in `<store dir>/Prompt Templates`, edited in
//! a desktop markdown editor and picked up by a Refresh button; that folder is no longer
//! read or written, and is left on disk exactly as it was.)
//!
//! NOT synced: like the rest of the `settings` table they are this Mac's, and the hub's
//! wire format has no place for them.
//!
//! `prompt-templates/` in the repo is what fills an EMPTY table, once: `build.rs` compiles
//! it in as `DEFAULTS`, and `seed` writes it the first time a store opens with this code.
//! Keyed on a settings flag rather than on the table being empty, so deleting every
//! template stays deleted — the same rule the folder followed.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::HashMap;

include!(concat!(env!("OUT_DIR"), "/templates_generated.rs"));

/// One template, as the editor, the TopBar menu and the ⋯ submenu all see it.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Template {
    /// Opaque and COLON-FREE by construction: a seeded default's is its file stem (checked
    /// by `every_default_has_a_safe_id`), a new one's is a UUID. Menu item ids embed it
    /// and `lib.rs` splits them on ':' — see `menu_action`.
    pub id: String,
    pub name: String,
    pub body: String,
}

/// Set once the defaults have been written, so an emptied table is never refilled.
pub const SEEDED_KEY: &str = "promptTemplatesSeeded";
/// The folder era's `{id: name}` rename map. Read once, by `seed`, so a template the user
/// renamed keeps that name; never written again, and left in place.
pub const LEGACY_NAMES_KEY: &str = "promptTemplateNames";

/// Larger than this is not a prompt, and it all lands in a single node's text.
pub const MAX_BODY_BYTES: usize = 256 * 1024;
/// Long enough for "New Feature: Discuss + Plan" several times over, short enough that one
/// name cannot stretch a menu across the screen.
pub const MAX_NAME_CHARS: usize = 80;

/// Every template, sorted by name the way a person reads a list (case-insensitive), with
/// the id as the tiebreak so two of the same name keep a stable order between menus.
pub fn load(db: &Connection) -> Result<Vec<Template>, String> {
    let mut stmt = db
        .prepare("SELECT id, name, body FROM prompt_templates")
        .map_err(|e| e.to_string())?;
    let mut out: Vec<Template> = stmt
        .query_map([], |row| {
            Ok(Template {
                id: row.get(0)?,
                name: row.get(1)?,
                body: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    out.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(out)
}

pub fn get(db: &Connection, id: &str) -> Result<Option<Template>, String> {
    db.query_row(
        "SELECT id, name, body FROM prompt_templates WHERE id = ?1",
        [id],
        |row| {
            Ok(Template {
                id: row.get(0)?,
                name: row.get(1)?,
                body: row.get(2)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Create or update. `id` names an existing template to overwrite; anything else — `None`,
/// or an id that is not in the table (deleted in another window while this one's editor
/// was open) — CREATES one under a fresh UUID. Never under the caller's id: it reaches
/// menu item ids, and only ids minted here are known to be colon-free.
pub fn save(
    db: &Connection,
    id: Option<&str>,
    name: &str,
    body: &str,
    now: i64,
) -> Result<Template, String> {
    let (name, body) = validate(name, body)?;
    if let Some(id) = id {
        let n = db
            .execute(
                "UPDATE prompt_templates SET name = ?2, body = ?3, updated_at = ?4 WHERE id = ?1",
                params![id, name, body, now],
            )
            .map_err(|e| e.to_string())?;
        if n == 1 {
            return Ok(Template { id: id.to_string(), name, body });
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    insert(db, &id, &name, &body, now)?;
    Ok(Template { id, name, body })
}

/// Idempotent: deleting a template that is already gone is not an error, since the only
/// way to get there is two windows deleting the same one.
pub fn delete(db: &Connection, id: &str) -> Result<(), String> {
    db.execute("DELETE FROM prompt_templates WHERE id = ?1", [id])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Write `DEFAULTS` into the table the first time a store opens with this code, in ONE
/// transaction with the flag that stops it ever happening again. Returns how many it wrote.
///
/// A default's name is the user's rename from the folder era when there is one, else its
/// first-line `# ` heading, else its file stem made readable.
pub fn seed(db: &Connection, now: i64) -> Result<usize, String> {
    let seeded: Option<String> = db
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            [SEEDED_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if seeded.is_some() {
        return Ok(0);
    }
    let legacy: HashMap<String, String> = db
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            [LEGACY_NAMES_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut n = 0;
    for (file, raw) in DEFAULTS {
        let stem = file.rsplit_once('.').map_or(*file, |(s, _)| s);
        let body = normalize_body(raw);
        let name = seed_name(stem, &body, &legacy);
        // A default that fails its own validation would be written and then be unsavable
        // from the editor; `every_default_survives_validation` keeps this unreachable.
        let Ok((name, body)) = validate(&name, &body) else {
            continue;
        };
        let id = if is_safe_id(stem) {
            stem.to_string()
        } else {
            uuid::Uuid::new_v4().to_string()
        };
        tx.execute(
            "INSERT OR IGNORE INTO prompt_templates (id, name, body, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![id, name, body, now],
        )
        .map_err(|e| e.to_string())?;
        n += 1;
    }
    tx.execute(
        "INSERT INTO settings (key, value) VALUES (?1, '1')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [SEEDED_KEY],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(n)
}

fn insert(db: &Connection, id: &str, name: &str, body: &str, now: i64) -> Result<(), String> {
    db.execute(
        "INSERT INTO prompt_templates (id, name, body, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4)",
        params![id, name, body, now],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// The rules a save must pass, returning the name and body as stored. The editor checks
/// the same things before it lets Save be pressed; this is the backstop.
pub fn validate(name: &str, body: &str) -> Result<(String, String), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("A template needs a name.".into());
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(format!("A name can be at most {MAX_NAME_CHARS} characters."));
    }
    let body = normalize_body(body);
    // A blank template can only wipe the prompt it is applied to.
    if body.trim().is_empty() {
        return Err("A template needs some text.".into());
    }
    if body.len() > MAX_BODY_BYTES {
        return Err("A template can be at most 256 KB.".into());
    }
    Ok((name.to_string(), body))
}

/// Text conventions that must not reach a node. `\r` would land in text the line-based
/// markdown renderer and the caret offsets both treat as `\n`-separated; a BOM would stop
/// a first-line `# ` reading as a heading; and a trailing newline would be a blank last
/// line in every prompt the template fills. Only `\n` is trimmed, because a trailing space
/// can be meaningful (`- ` waiting to be filled in).
pub fn normalize_body(raw: &str) -> String {
    raw.strip_prefix('\u{feff}')
        .unwrap_or(raw)
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .trim_end_matches('\n')
        .to_string()
}

fn is_safe_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
}

fn seed_name(stem: &str, body: &str, legacy: &HashMap<String, String>) -> String {
    if let Some(v) = legacy.get(stem).map(|v| v.trim()).filter(|v| !v.is_empty()) {
        return clip(v);
    }
    let first = body.lines().next().unwrap_or("");
    if let Some(h) = first.strip_prefix("# ").map(str::trim).filter(|h| !h.is_empty()) {
        return clip(h);
    }
    let spaced: String = stem
        .chars()
        .map(|c| if c == '-' || c == '_' { ' ' } else { c })
        .collect();
    let spaced = spaced.trim();
    clip(if spaced.is_empty() { stem } else { spaced })
}

fn clip(name: &str) -> String {
    name.chars().take(MAX_NAME_CHARS).collect::<String>().trim_end().to_string()
}

/// A name as an NSMenu item title. On macOS muda treats a lone `&` as a mnemonic marker
/// and eats it, so it has to be doubled — and "Discuss & Plan" is exactly the kind of name
/// a template gets.
pub fn menu_label(name: &str) -> String {
    name.replace('&', "&&")
}

/// The ⋯ submenu action for a template: `tpl-<id>`. `id` is colon-free (see `Template`),
/// which is what keeps `lib.rs`'s `splitn(4, ':')` parse of
/// `pf-row:<action>:<window>:<node>` intact.
pub fn menu_action(id: &str) -> String {
    format!("tpl-{id}")
}

/// The TopBar Templates menu's CONTENTS, as `(action, label)` — pure, so `cargo test` can
/// pin them without an NSMenu. One `edit-<id>` per template, then `new`. Item ids are
/// `pf-tpl:<window>:<action>`, parsed with `splitn(3, ':')`, so the action is the LAST
/// field and a colon in it could not misroute the event — but the ids are colon-free
/// anyway, and the test says so.
pub fn topbar_menu_items(templates: &[Template]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = templates
        .iter()
        .map(|t| (format!("edit-{}", t.id), menu_label(&t.name)))
        .collect();
    out.push(("new".into(), "New Template…".into()));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        crate::persist::open_in_memory().unwrap()
    }

    fn names(db: &Connection) -> Vec<String> {
        load(db).unwrap().into_iter().map(|t| t.name).collect()
    }

    /// If this fails, `prompt-templates/` was not committed: a fresh clone that lacks it
    /// builds an empty table rather than failing to compile.
    #[test]
    fn a_new_store_is_seeded_with_both_shipped_templates() {
        let db = db();
        assert_eq!(seed(&db, 1).unwrap(), 2);
        let all = load(&db).unwrap();
        assert_eq!(
            all.iter().map(|t| (t.id.as_str(), t.name.as_str())).collect::<Vec<_>>(),
            [
                ("New-Feature-Discuss-Plan", "New Feature: Discuss & Plan"),
                ("New-Feature-Plan", "New Feature: Plan"),
            ]
        );
        let plan = &all[1];
        assert!(plan.body.starts_with("# New Feature: Plan\n\n/plan-with-me ___"));
        // It must exercise the markdown renderer, or picking it demonstrates nothing.
        assert!(plan.body.contains("\n## Context & Current Problem"));
        assert!(plan.body.contains("\n1. Answer the questions"));
        // The file's own trailing newline is a convention, not a blank last line.
        assert!(!plan.body.ends_with('\n'));
    }

    /// The whole point of the flag: deleting every template must stick.
    #[test]
    fn an_emptied_table_is_never_seeded_again() {
        let db = db();
        seed(&db, 1).unwrap();
        for t in load(&db).unwrap() {
            delete(&db, &t.id).unwrap();
        }
        assert_eq!(seed(&db, 2).unwrap(), 0);
        assert!(load(&db).unwrap().is_empty());
    }

    #[test]
    fn an_edited_default_is_never_overwritten_by_a_reseed() {
        let db = db();
        seed(&db, 1).unwrap();
        save(&db, Some("New-Feature-Plan"), "Mine", "# Mine", 2).unwrap();
        seed(&db, 3).unwrap();
        let t = get(&db, "New-Feature-Plan").unwrap().unwrap();
        assert_eq!((t.name.as_str(), t.body.as_str()), ("Mine", "# Mine"));
    }

    /// A rename made in the folder era's Settings sheet survives the move into the table.
    #[test]
    fn the_folder_eras_renames_carry_over() {
        let db = db();
        db.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)",
            params![
                LEGACY_NAMES_KEY,
                r#"{"New-Feature-Discuss-Plan":"New Feature: Discuss + Plan","New-Feature-Plan":"  "}"#
            ],
        )
        .unwrap();
        seed(&db, 1).unwrap();
        // A blank override was the folder era's "reset", so the heading wins there.
        assert_eq!(names(&db), ["New Feature: Discuss + Plan", "New Feature: Plan"]);
    }

    #[test]
    fn a_corrupt_legacy_rename_row_does_not_stop_the_seed() {
        let db = db();
        db.execute(
            "INSERT INTO settings (key, value) VALUES (?1, 'not json')",
            [LEGACY_NAMES_KEY],
        )
        .unwrap();
        assert_eq!(seed(&db, 1).unwrap(), 2);
    }

    #[test]
    fn every_default_has_a_safe_id_and_survives_validation() {
        for (file, raw) in DEFAULTS {
            let stem = file.rsplit_once('.').map_or(*file, |(s, _)| s);
            assert!(is_safe_id(stem), "{file}: stem is not a safe menu id");
            let name = seed_name(stem, &normalize_body(raw), &HashMap::new());
            assert!(validate(&name, raw).is_ok(), "{file} would be unsavable");
        }
    }

    #[test]
    fn save_without_an_id_creates_one() {
        let db = db();
        let t = save(&db, None, "  Launch Checklist ", "- [ ] ship\n\n", 1).unwrap();
        assert_eq!(t.name, "Launch Checklist");
        assert_eq!(t.body, "- [ ] ship");
        assert!(uuid::Uuid::parse_str(&t.id).is_ok());
        assert_eq!(get(&db, &t.id).unwrap(), Some(t));
    }

    #[test]
    fn save_with_an_existing_id_updates_it_in_place() {
        let db = db();
        let a = save(&db, None, "A", "one", 1).unwrap();
        let b = save(&db, Some(&a.id), "B", "two", 2).unwrap();
        assert_eq!(a.id, b.id);
        assert_eq!(load(&db).unwrap(), vec![b]);
    }

    /// Deleted in another window while this one's editor was open: the save must not be
    /// lost, and must not trust an id it did not mint.
    #[test]
    fn save_with_an_unknown_id_creates_a_fresh_one() {
        let db = db();
        let t = save(&db, Some("x:y"), "Kept", "body", 1).unwrap();
        assert_ne!(t.id, "x:y");
        assert!(!t.id.contains(':'));
        assert_eq!(load(&db).unwrap().len(), 1);
    }

    #[test]
    fn save_refuses_what_a_template_cannot_be() {
        let db = db();
        assert!(save(&db, None, "   ", "body", 1).is_err());
        assert!(save(&db, None, "Name", " \n\n ", 1).is_err());
        assert!(save(&db, None, &"n".repeat(MAX_NAME_CHARS + 1), "b", 1).is_err());
        assert!(save(&db, None, &"n".repeat(MAX_NAME_CHARS), "b", 1).is_ok());
        assert!(save(&db, None, "Big", &"x".repeat(MAX_BODY_BYTES + 1), 1).is_err());
        assert!(save(&db, None, "Max", &"x".repeat(MAX_BODY_BYTES), 1).is_ok());
        assert_eq!(load(&db).unwrap().len(), 2);
    }

    #[test]
    fn delete_is_idempotent() {
        let db = db();
        let t = save(&db, None, "A", "a", 1).unwrap();
        delete(&db, &t.id).unwrap();
        delete(&db, &t.id).unwrap();
        assert!(load(&db).unwrap().is_empty());
    }

    #[test]
    fn templates_sort_by_name_whatever_the_case() {
        let db = db();
        for name in ["zebra", "Apple", "mango"] {
            save(&db, None, name, "x", 1).unwrap();
        }
        assert_eq!(names(&db), ["Apple", "mango", "zebra"]);
    }

    #[test]
    fn text_conventions_do_not_reach_the_body() {
        assert_eq!(normalize_body("\u{feff}# T\r\nline\rend\n\n"), "# T\nline\nend");
        assert_eq!(normalize_body("no newline"), "no newline");
        // Blank lines inside are content, and so is an item's trailing space.
        assert_eq!(normalize_body("a\n\nb\n- \n"), "a\n\nb\n- ");
    }

    #[test]
    fn a_seeded_name_falls_back_from_rename_to_heading_to_stem() {
        let none = HashMap::new();
        assert_eq!(seed_name("a-b", "# Title\nx", &none), "Title");
        assert_eq!(seed_name("a-b", "#Title\nx", &none), "a b");
        assert_eq!(seed_name("a-b", "## Sub\nx", &none), "a b");
        assert_eq!(seed_name("---", "x", &none), "---");
        let ov: HashMap<String, String> = [("a-b".to_string(), " Mine ".to_string())].into();
        assert_eq!(seed_name("a-b", "# Title", &ov), "Mine");
        assert_eq!(seed_name("a-b", &format!("# {}", "é".repeat(90)), &none).chars().count(), MAX_NAME_CHARS);
    }

    /// muda eats a lone `&` as a mnemonic marker on macOS.
    #[test]
    fn menu_labels_double_the_ampersand() {
        assert_eq!(menu_label("Context & Problem"), "Context && Problem");
        assert_eq!(menu_label("plain"), "plain");
        assert_eq!(menu_label("A & B & C"), "A && B && C");
    }

    #[test]
    fn the_topbar_menu_lists_every_template_then_new() {
        let db = db();
        seed(&db, 1).unwrap();
        let made = save(&db, None, "A & B", "x", 1).unwrap();
        let items = topbar_menu_items(&load(&db).unwrap());
        assert_eq!(
            items,
            vec![
                (format!("edit-{}", made.id), "A && B".to_string()),
                ("edit-New-Feature-Discuss-Plan".into(), "New Feature: Discuss && Plan".into()),
                ("edit-New-Feature-Plan".into(), "New Feature: Plan".into()),
                ("new".into(), "New Template…".into()),
            ]
        );
    }

    /// An empty table still offers a way to make one.
    #[test]
    fn an_empty_topbar_menu_still_offers_new() {
        assert_eq!(topbar_menu_items(&[]), vec![("new".into(), "New Template…".into())]);
    }

    /// Every item must come back out of `lib.rs`'s parse intact, or the selection is
    /// routed to a window that does not exist and nothing happens.
    #[test]
    fn every_topbar_item_survives_the_menu_route() {
        let db = db();
        seed(&db, 1).unwrap();
        save(&db, None, "a:b", "x", 1).unwrap();
        for (action, _) in topbar_menu_items(&load(&db).unwrap()) {
            assert!(!action.contains(':'), "`{action}` has a colon");
            let item = format!("pf-tpl:w12:{action}");
            let parts: Vec<&str> = item.splitn(3, ':').collect();
            assert_eq!(parts, ["pf-tpl", "w12", action.as_str()]);
        }
    }
}
