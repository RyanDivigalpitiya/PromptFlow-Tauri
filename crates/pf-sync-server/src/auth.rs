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

    // A throwaway 2048-bit RSA keypair, generated for this test and used nowhere else.
    // It exists so the test below runs REAL RS256 crypto — jsonwebtoken 11 ships no
    // signature backend by default (`default = ["use_pem"]`), so a missing
    // `rust_crypto` feature compiles clean and panics at the first decode(). That
    // panic reached production as a 502 on the hub's first authenticated request; the
    // scenario suite never saw it because it runs with `require_access = false`.
    const TEST_RSA_PEM: &str = "-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDRyR1Suwj2jdeP
tEYzCDeUtg9OVtQ9UHacaJiioh3DP2q/0GnmTWF2mgnRZIP7UqpqtpYe5GfWwBmF
3C1nS2JBpSbfoOm+JyAtcE/3nq1LAR9oJHjLNQo4sIXJxIvbvIHO4neFjAnr9rvB
NlUGilEYaarMU6Xq0toMBeGYSBPCVoO3KVcAfoO81K7PjMcmKJ2Wz0P031OvuHC4
otVS5Q0xvzUcVXeHX8qe8YzxorHZBujRxx3zqZXFIG6rUodWHR+q8rIwSTq6UhqW
FSribM7II9NXapGkYNjl6WLosoAtwpCuus1Fmo5MRH22YTmildL5wHw2qy84EMpJ
BS2lGh6pAgMBAAECggEAAmzvHoawJQqyQzWeyI//5IOcOwb6gtQKIoDRfaIFJc7D
5mbIezO5CWzP2IPNIlFJ9txLtaVUAtL2CaaS/BUF2Jsfj0WOv10EthcdrQunJ60d
6dgSG93DZJ/eZbryj0kJedklzbDQrRXir7czopkwq+kN646ZXbLjM08NkNFOH5Ro
u//FEaaEu1s3en6joD4VENvl+fab75xkwN7paqFGMs8cAlsD6v+Mm3PkSnSecvE+
SrUiliiMmadiaOkvRbG2hAYJDnPNaGv4UX9CPf1LjBz3DVLD2E8sa5FKOJxxoFPF
d21G1gNAOBiB55pZRQ1WqdfrVQoia32d1GrCicm06QKBgQDsMkgWHQjSunu6u9Bc
AUdm/Ig/HD2MsTNkdCnsrLvvriZYKgN640D6d46cYI0LQ6Tm6fLLG4Z90h7nkJVi
rBRr/yr/+4PnBE/SduSBsvBBnN9h8PTuMT3iIuICKDpoSSqT5RoDO2H3LilA5b+j
SEuhwaN8PbrqmTmMSlaDgUatawKBgQDjX/OWRH6SVGUPKFPenbQKOqIL1IPa9zNv
e8R9dS/RT+RmbfFE+z2IdiO8YCB4vTfJhhd00qnAfXwId/y7dCQE7x5oB50813ao
S9bKdWuLkSt/t72LKsNPBzE1IpTMRPjFsjkX2a0uyP46NcPu78Y2Li+z1cHT0LHy
qmGJkPs1OwKBgCgiYx1e0aD9Dwkr4LvBe+CECKKwqcS+V306P+V3dHfFn75bZTv8
YY4two3P2ieP1vVly1u30aKPkbDHYJrjopS3Rxc4JbGbifS5PxrKzQhZH5wE1Zmj
xGAojT7QlxwhUprO0xy5emwF6/ybDXUxU6iovp7d3mT+pEiyWQD/doMBAoGBAM70
L99vOpFv9YgFWck/W3cQBRylctpjtFJdoevbNQncIPTGTxtNXqWNeltkV0nuWA+6
WDFB6bZFwRZoOAZa4MoI53EitRCCwQLP/JHMrHWdTa1zDTfVVW3iCvzlG/CNOq2e
2W6G96Wk1hkfhNY/MfdwtISIJGLqCn3obNzstGmvAoGATyPOi6CqWZFg3KWotvg6
6O0idG6dBhyJ3lQsxIV4ASnf395+uTGqzD+5pXiIK5aNxGccgW/LNWXZW0RnrBow
YfMW/s+75eEWwr1DJZnFSx0yWMwwWCZ0X3YmGsW6YJdL8FxbeN7BewYemeMTo0i1
3XNu4GXmPQK/vglCkmJCx8Y=
-----END PRIVATE KEY-----";

    // The matching public half, in the shape Access serves keys: a JWKS.
    const TEST_JWKS: &str = r#"{"keys":[{"kty":"RSA","kid":"test-kid","use":"sig","alg":"RS256","n":"0ckdUrsI9o3Xj7RGMwg3lLYPTlbUPVB2nGiYoqIdwz9qv9Bp5k1hdpoJ0WSD-1KqaraWHuRn1sAZhdwtZ0tiQaUm36DpvicgLXBP956tSwEfaCR4yzUKOLCFycSL27yBzuJ3hYwJ6_a7wTZVBopRGGmqzFOl6tLaDAXhmEgTwlaDtylXAH6DvNSuz4zHJiidls9D9N9Tr7hwuKLVUuUNMb81HFV3h1_KnvGM8aKx2Qbo0ccd86mVxSBuq1KHVh0fqvKyMEk6ulIalhUq4mzOyCPTV2qRpGDY5eli6LKALcKQrrrNRZqOTER9tmE5opXS-cB8NqsvOBDKSQUtpRoeqQ","e":"AQAB"}]}"#;

    #[derive(serde::Serialize)]
    struct TestClaims {
        aud: String,
        iss: String,
        common_name: String,
        exp: u64,
    }

    /// Signs and verifies a REAL RS256 token through the same jsonwebtoken calls
    /// `verify_access_jwt` makes (`from_jwk` + `decode`). This is the test that fails
    /// — by panicking — if the crate's crypto backend feature is ever dropped again.
    #[test]
    fn rs256_round_trip_has_a_crypto_backend() {
        let signing = jsonwebtoken::EncodingKey::from_rsa_pem(TEST_RSA_PEM.as_bytes())
            .expect("test key parses");
        let mut header = jsonwebtoken::Header::new(Algorithm::RS256);
        header.kid = Some("test-kid".into());
        let claims = TestClaims {
            aud: "test-aud".into(),
            iss: "https://team.cloudflareaccess.com".into(),
            common_name: "svc.access".into(),
            exp: 4102444800, // 2100-01-01
        };
        let token = jsonwebtoken::encode(&header, &claims, &signing).expect("signs");

        let set: JwkSet = serde_json::from_str(TEST_JWKS).unwrap();
        let jwk = set.find("test-kid").expect("kid present");
        let key = DecodingKey::from_jwk(jwk).expect("JWK usable");
        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_audience(&["test-aud"]);
        validation.set_issuer(&["https://team.cloudflareaccess.com"]);

        let data = decode::<AccessClaims>(&token, &key, &validation).expect("verifies");
        assert_eq!(data.claims.common_name, "svc.access");

        // A bad signature must come back as an Err, never a panic.
        let (head_and_body, _sig) = token.rsplit_once('.').unwrap();
        let forged = format!("{head_and_body}.AAAA");
        assert!(decode::<AccessClaims>(&forged, &key, &validation).is_err());
    }

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
