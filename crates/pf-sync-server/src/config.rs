//! `~/PromptFlow-Sync/config.toml` (mode 0600) — the hub's only input besides its
//! database.
//!
//! Startup hygiene, and the reason for it: this process runs under a launchd
//! LaunchAgent with `KeepAlive = {SuccessfulExit: false}`. A config error is not
//! transient, so exiting NON-zero would have launchd relaunch it every
//! `ThrottleInterval` forever, filling the shared mini's log with the same line. On any
//! unrecoverable config problem the binary logs ONE clear line and exits **0**, which
//! stops the loop dead until a human fixes the file.

use serde::Deserialize;
use std::path::PathBuf;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    /// Loopback only — the Cloudflare tunnel connector is the sole thing that may reach
    /// this port, and the mini is shared hardware.
    #[serde(default = "default_port")]
    pub port: u16,

    /// `~` and `$HOME` are expanded; a relative path resolves against `$HOME`. launchd
    /// starts agents with cwd `/`, so a bare relative path would otherwise mean `/`.
    #[serde(default = "default_db_path")]
    pub db_path: String,

    /// The app-level shared secret, checked in constant time. Separate from the
    /// Cloudflare Access service token: Access proves the REQUEST came through the
    /// tunnel's front door, this proves it came from PromptFlow.
    pub bearer_token: String,

    /// `https://<team>.cloudflareaccess.com` — the `iss` claim to pin. Left empty on the
    /// very first deploy, where the hub LOGS the incoming `iss` instead (it is the one
    /// Phase 0 value that could not be captured ahead of time). Never ship past the
    /// Phase 2 gate without it set.
    #[serde(default)]
    pub access_team_domain: String,

    /// The Access application's Audience tag.
    #[serde(default)]
    pub access_aud: String,

    /// The service token's Client ID, pinned as the JWT's `common_name`, so a different
    /// token in the same Access account cannot reach this origin.
    #[serde(default)]
    pub access_client_id: String,

    /// Where the Access signing keys live. Verified live: Access serves them on the
    /// APP's own hostname, so no team-domain URL is needed to fetch keys — only to pin
    /// `iss`.
    #[serde(default = "default_certs_url")]
    pub access_certs_url: String,

    /// Turn OFF only for a local run with no tunnel in front (the Phase 3 two-instance
    /// convergence gate). With it off the bearer token is the ONLY thing between the
    /// port and the outline, which is why the port binds to loopback unconditionally.
    #[serde(default = "default_true")]
    pub require_access: bool,
}

fn default_port() -> u16 {
    9273
}
fn default_db_path() -> String {
    "~/PromptFlow-Sync/sync.sqlite".into()
}
fn default_certs_url() -> String {
    "https://pf-sync.ryan-div.com/cdn-cgi/access/certs".into()
}
fn default_true() -> bool {
    true
}

impl Config {
    pub fn load(path: &std::path::Path) -> Result<Config, String> {
        let text = std::fs::read_to_string(path)
            .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
        let cfg: Config =
            toml::from_str(&text).map_err(|e| format!("cannot parse {}: {e}", path.display()))?;
        cfg.validate()?;
        Ok(cfg)
    }

    fn validate(&self) -> Result<(), String> {
        if self.bearer_token.len() < 32 {
            return Err("bearer_token must be at least 32 characters \
                        (generate with `openssl rand -hex 32`)"
                .into());
        }
        if self.require_access {
            if self.access_aud.is_empty() {
                return Err("access_aud is required when require_access = true".into());
            }
            if self.access_client_id.is_empty() {
                return Err("access_client_id is required when require_access = true".into());
            }
        }
        Ok(())
    }

    /// The database path, absolute. Resolved from `$HOME` rather than the process cwd,
    /// which launchd sets to `/`.
    pub fn resolved_db_path(&self) -> PathBuf {
        expand_home(&self.db_path)
    }

    /// Default config location, honouring `PF_SYNC_CONFIG` for tests and dev runs.
    pub fn default_path() -> PathBuf {
        if let Ok(p) = std::env::var("PF_SYNC_CONFIG") {
            return expand_home(&p);
        }
        expand_home("~/PromptFlow-Sync/config.toml")
    }
}

pub fn expand_home(p: &str) -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
    let s = if let Some(rest) = p.strip_prefix("~/") {
        format!("{home}/{rest}")
    } else if p == "~" {
        home.clone()
    } else if let Some(rest) = p.strip_prefix("$HOME/") {
        format!("{home}/{rest}")
    } else {
        p.to_string()
    };
    let pb = PathBuf::from(&s);
    if pb.is_absolute() {
        pb
    } else {
        PathBuf::from(home).join(pb)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn home_expansion_covers_every_shape_launchd_can_hand_us() {
        std::env::set_var("HOME", "/Users/test");
        assert_eq!(expand_home("~/a/b"), PathBuf::from("/Users/test/a/b"));
        assert_eq!(expand_home("$HOME/a"), PathBuf::from("/Users/test/a"));
        assert_eq!(expand_home("/abs/path"), PathBuf::from("/abs/path"));
        // launchd's cwd is `/`, so a bare relative path must NOT resolve against it.
        assert_eq!(expand_home("rel/path"), PathBuf::from("/Users/test/rel/path"));
    }

    #[test]
    fn a_weak_bearer_token_is_a_startup_error_not_a_warning() {
        let cfg: Config = toml::from_str(
            r#"
            bearer_token = "short"
            require_access = false
        "#,
        )
        .unwrap();
        assert!(cfg.validate().is_err());
    }

    #[test]
    fn access_settings_are_required_when_access_is_enforced() {
        let missing_aud: Config = toml::from_str(
            r#"
            bearer_token = "0123456789012345678901234567890123456789"
            access_client_id = "abc.access"
        "#,
        )
        .unwrap();
        assert!(missing_aud.validate().is_err());

        let complete: Config = toml::from_str(
            r#"
            bearer_token = "0123456789012345678901234567890123456789"
            access_aud = "deadbeef"
            access_client_id = "abc.access"
        "#,
        )
        .unwrap();
        assert!(complete.validate().is_ok());
        assert_eq!(complete.port, 9273);
    }
}
