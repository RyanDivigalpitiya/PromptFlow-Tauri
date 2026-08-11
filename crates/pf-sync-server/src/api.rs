//! The four endpoints, plus the auth layer in front of all of them.
//!
//! Every response — success or failure — carries `protocolVersion`, so a client can
//! tell "the hub said no" from "something else answered on this hostname".

use crate::auth::{self, AuthError, ACCESS_JWT_HEADER};
use crate::config::Config;
use crate::hub::{Hub, HubError};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use promptflow_core::wire::{
    ErrorResponse, PushRequest, CONFIRM_MASS_DELETE_HEADER, PROTOCOL_VERSION,
};
use serde::Deserialize;
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct AppState {
    pub hub: Arc<Mutex<Hub>>,
    pub config: Arc<Config>,
    /// Set once the hub has logged the `iss` it actually receives, so the first-deploy
    /// discovery line appears once rather than on every request.
    pub logged_iss: Arc<std::sync::atomic::AtomicBool>,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/v1/snapshot", get(snapshot))
        .route("/v1/changes", get(changes))
        .route("/v1/push", post(push))
        .route("/v1/health", get(health))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            authenticate,
        ))
        .with_state(state)
}

// MARK: - Auth middleware

async fn authenticate(
    State(state): State<AppState>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    if let Err(e) = check(&state, req.headers()) {
        return match e {
            AuthError::Unauthorized(m) => error(StatusCode::UNAUTHORIZED, m),
            AuthError::Forbidden(m) => {
                tracing::warn!("access denied: {m}");
                // Deliberately vague to the caller, specific in the log: a probe must
                // not learn WHICH of the two gates it failed.
                error(StatusCode::FORBIDDEN, "forbidden")
            }
        };
    }
    next.run(req).await
}

fn check(state: &AppState, headers: &HeaderMap) -> Result<(), AuthError> {
    let cfg = &state.config;

    if cfg.require_access {
        let token = headers
            .get(ACCESS_JWT_HEADER)
            .and_then(|v| v.to_str().ok())
            .ok_or(AuthError::Unauthorized("missing Access assertion"))?;
        let claims = auth::verify_access_jwt(
            token,
            &cfg.access_certs_url,
            &cfg.access_aud,
            &cfg.access_client_id,
            &cfg.access_team_domain,
        )?;
        if cfg.access_team_domain.is_empty()
            && !state
                .logged_iss
                .swap(true, std::sync::atomic::Ordering::Relaxed)
        {
            // The FIRST-DEPLOY discovery step: the team domain was auto-provisioned by
            // Cloudflare's merged dashboard and never written down. Signature, `aud` and
            // `common_name` are already enforced above; this is the one claim still
            // unpinned. Copy the value into `access_team_domain` and restart.
            tracing::warn!(
                iss = %claims.iss,
                "Access `iss` is NOT pinned — set access_team_domain to this value and restart"
            );
        }
    }

    let bearer = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(AuthError::Unauthorized("missing bearer token"))?;
    if !auth::secret_eq(bearer, &cfg.bearer_token) {
        // A bodyless 401: nothing to distinguish a wrong token from a missing one.
        return Err(AuthError::Unauthorized("bad bearer token"));
    }
    Ok(())
}

// MARK: - Endpoints

async fn snapshot(State(state): State<AppState>) -> Response {
    let mut hub = state.hub.lock().await;
    match hub.snapshot() {
        Ok(r) => Json(r).into_response(),
        Err(e) => hub_error(e),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangesQuery {
    #[serde(default)]
    since: i64,
    device: String,
}

async fn changes(State(state): State<AppState>, Query(q): Query<ChangesQuery>) -> Response {
    let mut hub = state.hub.lock().await;
    match hub.changes(q.since, &q.device) {
        Ok(r) => Json(r).into_response(),
        Err(e) => hub_error(e),
    }
}

async fn push(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Json<PushRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Json(req) = match body {
        Ok(b) => b,
        Err(e) => return error(StatusCode::BAD_REQUEST, &format!("malformed push: {e}")),
    };
    if req.protocol_version != PROTOCOL_VERSION {
        return error(
            StatusCode::BAD_REQUEST,
            &format!(
                "protocol version {} is not {PROTOCOL_VERSION}",
                req.protocol_version
            ),
        );
    }
    // Clients NEVER set this on their own — it is an explicit "confirm mass delete"
    // action in each app's sync-error UI, sent once for the same pending batch.
    let confirm = headers
        .get(CONFIRM_MASS_DELETE_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);

    let mut hub = state.hub.lock().await;
    match hub.push(&req, confirm) {
        Ok(r) => Json(r).into_response(),
        Err(e) => hub_error(e),
    }
}

async fn health(State(state): State<AppState>) -> Response {
    let hub = state.hub.lock().await;
    match hub.health() {
        Ok(r) => Json(r).into_response(),
        Err(e) => hub_error(e),
    }
}

// MARK: - Errors

fn error(status: StatusCode, message: &str) -> Response {
    (
        status,
        Json(ErrorResponse {
            protocol_version: PROTOCOL_VERSION,
            error: message.to_string(),
            deletes: None,
            threshold: None,
        }),
    )
        .into_response()
}

fn hub_error(e: HubError) -> Response {
    match e {
        // The client re-bootstraps from /v1/snapshot and merges it through its normal
        // apply path.
        HubError::Gone => error(StatusCode::GONE, "cursor predates the retained oplog"),
        HubError::MassDelete { deletes, threshold } => (
            StatusCode::PRECONDITION_REQUIRED,
            Json(ErrorResponse {
                protocol_version: PROTOCOL_VERSION,
                error: "this push deletes an unusual number of nodes".into(),
                deletes: Some(deletes),
                threshold: Some(threshold),
            }),
        )
            .into_response(),
        HubError::BadRequest(m) => error(StatusCode::BAD_REQUEST, &m),
        other => {
            tracing::error!("hub error: {other}");
            error(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
        }
    }
}
