//! WebKit text-substitution defaults for the embedded WKWebView.
//!
//! The editors deliberately leave the `spellcheck` attribute ENABLED, because in
//! WebKit that attribute gates the entire text-checking pipeline — including macOS
//! TEXT SUBSTITUTION (System Settings ▸ Keyboard ▸ Text Replacements, e.g. "->" ⇒
//! "→"). `spellcheck="false"` made `Editor::markAllMisspellingsAndBadGrammarInRanges`
//! early-return before it ever resolved which check types to run, so replacements
//! silently never fired. See the comment in `RowEditor.tsx`.
//!
//! Opening that gate un-gates the OTHER substitutions too, and they default to the
//! user's system setting (ON). Smart quotes turning `"` into `“ ”` and smart dashes
//! turning `--` into `—` inside PROMPT text is a corruption, not a nicety, so they
//! are turned off here.
//!
//! Three things are deliberately NOT registered:
//!   * `WebAutomaticTextReplacementEnabled` — absent means WebKit falls back to
//!     `[NSSpellChecker isAutomaticTextReplacementEnabled]`, i.e. the user's own
//!     System Settings choice. That inheritance IS the feature; forcing it would
//!     override a user who deliberately turned replacements off.
//!   * `WebContinuousSpellCheckingEnabled` — read with a bare `boolForKey:`, so an
//!     absent key already means NO. Writing it buys nothing: leaving the element
//!     gate open costs no red squiggles.
//!   * `WebAutomaticLinkDetectionEnabled` — same bare `boolForKey:`, absent ⇒ NO.
//!
//! TIMING IS LOAD-BEARING: WebKit's `TextChecker::state()` is a Meyers singleton,
//! latched once by the `WebProcessPool` constructor and then snapshotted into each
//! web process. Tauri builds the config windows (and their WKWebViews) BEFORE it
//! invokes the `.setup()` closure, so registering there would be too late — this
//! must run before `tauri::Builder`.

use objc2::runtime::AnyObject;
use objc2_foundation::{NSDictionary, NSNumber, NSString, NSUserDefaults};

/// Register the WebKit substitution defaults. Idempotent; safe to call once at
/// startup, before any webview exists.
pub fn register_text_substitution_defaults() {
    let off = NSNumber::new_bool(false);
    let value: &AnyObject = off.as_ref();

    let keys = [
        // Straight quotes must stay straight in prompt text.
        NSString::from_str("WebAutomaticQuoteSubstitutionEnabled"),
        // "--" must stay "--", not become an em dash.
        NSString::from_str("WebAutomaticDashSubstitutionEnabled"),
        // Autocorrect. Currently unreachable anyway (WebKit gates Correction behind
        // spelling, which is off), but WebKit's `shouldAutomaticSpellingCorrection-
        // BeEnabled()` falls back to `isAutomaticTextReplacementEnabled` — a
        // copy-paste slip in the engine that would otherwise let this ride in on the
        // very setting we depend on. Pinned off so it cannot rewrite prompt text.
        NSString::from_str("WebAutomaticSpellingCorrectionEnabled"),
    ];
    let key_refs: Vec<&NSString> = keys.iter().map(|k| k.as_ref()).collect();
    let values = [value, value, value];

    let dict = NSDictionary::<NSString, AnyObject>::from_slices(&key_refs, &values);
    // SAFETY: the dictionary is NSString -> NSNumber, the type registerDefaults:
    // documents. Registered defaults live in NSRegistrationDomain: process-local,
    // never written to disk, and outranked by anything the user sets themselves.
    unsafe { NSUserDefaults::standardUserDefaults().registerDefaults(&dict) };
}
