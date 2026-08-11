//! Two independent gates, both required.
//!
//! 1. **Cloudflare Access.** The edge already refused anonymous traffic, but the origin
//!    must not take that on faith: anything that can reach `127.0.0.1:9273` — another
//!    process on the shared mini, a future tunnel misconfiguration — would otherwise be
//!    inside. So the `Cf-Access-Jwt-Assertion` header is verified here: signature
//!    against Access's JWKS, `aud` = this application's tag, `iss` = the team domain,
//!    and `common_name` = the ONE service token allowed to speak to it.
//!
//! 2. **An app bearer token**, compared in constant time. Access proves the request came
//!    through the front door; this proves it came from PromptFlow.
//!
//! The JWKS is fetched over the public hostname (verified live: Access serves the keys
//! at `https://pf-sync.ryan-div.com/cdn-cgi/access/certs`, so no team-domain URL is
//! needed to fetch them) and cached until an unknown `kid` shows up — which is what a
//! key rotation looks like from here.

use jsonwebtoken::jwk::JwkSet;
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

pub const ACCESS_JWT_HEADER: &str = "cf-access-jwt-assertion";

/// Never refetch the key set more often than this, however many unknown-kid requests
/// arrive — an attacker must not be able to turn a bad token into an outbound request
/// per attempt.
const MIN_REFETCH_INTERVAL: Duration = Duration::from_secs(60);
/// Refresh even without an unknown kid, so a rotated-out key stops being accepted.
const MAX_KEY_AGE: Duration = Duration::from_secs(6 * 3600);

#[derive(Debug, Clone, Deserialize)]
pub struct AccessClaims {
    /// Present on service-token requests: the token's Client ID.
    #[serde(default)]
    pub common_name: String,
    #[serde(default)]
    pub email: String,
    pub iss: String,
}

#[derive(Debug)]
pub enum AuthError {
    /// No credentials at all, or a bearer token that does not match.
    Unauthorized(&'static str),
    /// Credentials present but not acceptable — a JWT for another application, a
    /// different service token, an unverifiable signature.
    Forbidden(String),
}

struct KeyCache {
    keys: JwkSet,
    fetched_at: Instant,
}

static CACHE: OnceLock<Mutex<Option<KeyCache>>> = OnceLock::new();

fn cache() -> &'static Mutex<Option<KeyCache>> {
    CACHE.get_or_init(|| Mutex::new(None))
}

/// Constant-time equality. A short-circuiting `==` on a secret leaks its prefix to
/// anything that can time the response, and this endpoint is reachable from the
/// internet.
pub fn secret_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    // Fold the length difference into the accumulator rather than returning early.
    let mut diff = (a.len() ^ b.len()) as u8;
    let n = a.len().max(b.len());
    for i in 0..n {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        diff |= x ^ y;
    }
    diff == 0
}

/// Verify one Access assertion. Returns the claims so the caller can log the `iss` on
/// the first deploy, where the team domain is not yet known.
pub fn verify_access_jwt(
    token: &str,
    certs_url: &str,
    expected_aud: &str,
    expected_client_id: &str,
    expected_iss: &str,
) -> Result<AccessClaims, AuthError> {
    let header =
        decode_header(token).map_err(|e| AuthError::Forbidden(format!("malformed JWT: {e}")))?;
    let kid = header
        .kid
        .clone()
        .ok_or_else(|| AuthError::Forbidden("JWT has no kid".into()))?;

    let jwk = find_key(&kid, certs_url)?;
    let key = DecodingKey::from_jwk(&jwk)
        .map_err(|e| AuthError::Forbidden(format!("unusable Access key: {e}")))?;

        // Access signs with RS256. Pin it rather than trusting `header.alg`, which is
    // attacker-controlled — the classic JWT algorithm-confusion hole.
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_audience(&[expected_aud]);
    if !expected_iss.is_empty() {
        validation.set_issuer(&[expected_iss]);
    }
    // `exp` is validated by default; Access tokens are short-lived.
    let data = decode::<AccessClaims>(token, &key, &validation)
        .map_err(|e| AuthError::Forbidden(format!("Access JWT rejected: {e}")))?;

    if !expected_client_id.is_empty() && !secret_eq(&data.claims.common_name, expected_client_id) {
        return Err(AuthError::Forbidden(
            "Access JWT is for a different service token".into(),
        ));
    }
    Ok(data.claims)
}

fn find_key(kid: &str, certs_url: &str) -> Result<jsonwebtoken::jwk::Jwk, AuthError> {
    {
        let guard = cache().lock().unwrap();
        if let Some(c) = guard.as_ref() {
            if c.fetched_at.elapsed() < MAX_KEY_AGE {
                if let Some(k) = c.keys.find(kid) {
                    return Ok(k.clone());
                }
            }
        }
    }
    // Unknown kid (or stale cache) — this is what a rotation looks like from here.
    let fresh = fetch_keys(certs_url)?;
    let found = fresh.find(kid).cloned();
    {
        let mut guard = cache().lock().unwrap();
        *guard = Some(KeyCache {
            keys: fresh,
            fetched_at: Instant::now(),
        });
    }
    found.ok_or_else(|| AuthError::Forbidden(format!("no Access key for kid {kid}")))
}

fn fetch_keys(certs_url: &str) -> Result<JwkSet, AuthError> {
    {
        // Rate-limit outbound fetches even on repeated unknown kids.
        let guard = cache().lock().unwrap();
        if let Some(c) = guard.as_ref() {
            if c.fetched_at.elapsed() < MIN_REFETCH_INTERVAL {
                return Err(AuthError::Forbidden(
                    "unknown Access key id (key fetch rate-limited)".into(),
                ));
            }
        }
    }
    let body = ureq::get(certs_url)
        .config()
        .timeout_global(Some(Duration::from_secs(10)))
        .build()
        .call()
        .map_err(|e| AuthError::Forbidden(format!("cannot fetch Access keys: {e}")))?
        .body_mut()
        .read_to_string()
        .map_err(|e| AuthError::Forbidden(format!("cannot read Access keys: {e}")))?;
    serde_json::from_str(&body)
        .map_err(|e| AuthError::Forbidden(format!("cannot parse Access keys: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_comparison_is_length_safe_and_correct() {
        assert!(secret_eq("abcdef", "abcdef"));
        assert!(!secret_eq("abcdef", "abcdeg"));
        assert!(!secret_eq("abcdef", "abcde"));
        assert!(!secret_eq("", "x"));
        assert!(secret_eq("", ""));
        // A prefix must not compare equal — the exact failure a short-circuiting `==`
        // would leak one byte at a time.
        assert!(!secret_eq("secret", "secretlonger"));
    }
}
