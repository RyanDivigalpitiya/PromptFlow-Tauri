//! Prompt templates: the bodies compiled into the binary by `build.rs` from the repo's
//! `prompt-templates/` folder, plus the per-device display-name overrides.
//!
//! Why compiled in rather than a folder on disk: the templates are content the repo
//! owns, so "drop a file in `prompt-templates/`, `/release`" is the whole workflow — no
//! `bundle.resources` key, no `fs:` capability, no directory that resolves differently
//! under `tauri dev` than in the shipped .app, and the table is `cargo test`-able.
//!
//! Names are DERIVED from the file name (`build.rs::display_name`) and overridable in
//! Settings. The override map lives in the backend `settings` table, NOT localStorage,
//! because the ⋯ menu is built in Rust and localStorage is invisible from here — which
//! also means a rename takes effect in every window the next time the menu opens, with
//! no delta and no broadcast.

use serde::Serialize;
use std::collections::HashMap;

pub struct Template {
    pub id: &'static str,
    pub default_name: &'static str,
    pub body: &'static str,
}

include!(concat!(env!("OUT_DIR"), "/templates_generated.rs"));

/// The settings-table key holding the `{id: name}` override map, as JSON.
pub const NAMES_KEY: &str = "promptTemplateNames";

/// One row of the Settings ▸ Prompt Templates list.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TemplateInfo {
    pub id: String,
    /// The file-name-derived default, shown as the input's placeholder.
    pub default_name: String,
    /// What the menu actually says: the override when set, else the default.
    pub name: String,
}

pub fn all() -> &'static [Template] {
    TEMPLATES
}

pub fn by_id(id: &str) -> Option<&'static Template> {
    TEMPLATES.iter().find(|t| t.id == id)
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
    match ov.get(t.id) {
        Some(v) if !v.trim().is_empty() => v.trim().to_string(),
        _ => t.default_name.to_string(),
    }
}

pub fn list(ov: &HashMap<String, String>) -> Vec<TemplateInfo> {
    TEMPLATES
        .iter()
        .map(|t| TemplateInfo {
            id: t.id.to_string(),
            default_name: t.default_name.to_string(),
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
/// (`build.rs::sanitize`), which is what keeps `lib.rs`'s `splitn(4, ':')` parse of
/// `pf-row:<action>:<window>:<node>` intact.
pub fn menu_action(id: &str) -> String {
    format!("tpl-{id}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ov(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    /// The one template the repo ships. If this fails, `prompt-templates/` was not
    /// committed — `include_str!` makes it a build dependency, so a fresh clone that
    /// lacks it produces an empty table rather than a compile error.
    #[test]
    fn the_shipped_template_is_compiled_in() {
        let t = by_id("New-Feature-Discuss-Plan").expect("template table is empty");
        assert_eq!(t.default_name, "New Feature Discuss Plan");
        assert!(t.body.starts_with("# New Feature: Discuss & Plan"));
        // It must exercise the markdown renderer, or picking it demonstrates nothing.
        assert!(t.body.contains("\n## Overall Goal"));
        assert!(t.body.contains("\n1. First,"));
    }

    /// Every id must survive `lib.rs`'s `splitn(4, ':')` — a colon would misroute the
    /// menu event to a window label that doesn't exist, where `emit_to` silently no-ops.
    #[test]
    fn no_id_contains_a_colon() {
        for t in all() {
            assert!(!t.id.contains(':'), "id `{}` contains a colon", t.id);
            assert!(!menu_action(t.id).contains(':'));
        }
    }

    #[test]
    fn ids_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for t in all() {
            assert!(seen.insert(t.id), "duplicate id `{}`", t.id);
        }
    }

    #[test]
    fn an_override_replaces_the_derived_name() {
        let t = by_id("New-Feature-Discuss-Plan").unwrap();
        assert_eq!(name_of(t, &ov(&[])), "New Feature Discuss Plan");
        assert_eq!(
            name_of(t, &ov(&[("New-Feature-Discuss-Plan", "New Feature: Discuss & Plan")])),
            "New Feature: Discuss & Plan"
        );
        // Blank or whitespace-only clears back to the default — that IS the Reset button.
        assert_eq!(name_of(t, &ov(&[("New-Feature-Discuss-Plan", "   ")])), "New Feature Discuss Plan");
        assert_eq!(name_of(t, &ov(&[("New-Feature-Discuss-Plan", "")])), "New Feature Discuss Plan");
        // Surrounding space is the user's typo, not their intent.
        assert_eq!(name_of(t, &ov(&[("New-Feature-Discuss-Plan", "  Spaced  ")])), "Spaced");
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
    fn list_reports_default_and_effective_names_separately() {
        let rows = list(&ov(&[("New-Feature-Discuss-Plan", "Renamed")]));
        let row = rows.iter().find(|r| r.id == "New-Feature-Discuss-Plan").unwrap();
        assert_eq!(row.default_name, "New Feature Discuss Plan");
        assert_eq!(row.name, "Renamed");
    }
}
