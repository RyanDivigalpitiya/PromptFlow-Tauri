# PromptFlow Sync — end-to-end development plan

> **IMPLEMENTATION STATUS, 2026-08-11.** Phases 0–5 are **built and green**. What is left is entirely **[RYAN]**: deploy the hub to the mini, point the Mac at it, and bootstrap the iPad. See §10 at the bottom for the handover checklist and for the six places the implementation deviated from this document (each with its reason).

Handoff document for the implementing agent (Opus 5). Written 2026-08-06 after a full recon of both codebases, an adversarial design review, verification of the Cloudflare/domain/office-network prerequisites, and a three-way review of this document itself (repo-anchor verification, implementer dry-run, critique-register audit — all findings folded in). Decisions in this document are **made** — do not reopen them without flagging to Ryan. Steps tagged **[RYAN]** need the human (browser logins, GoDaddy/Cloudflare dashboards, sudo passwords, device testing, secrets). Everything else is implementable autonomously.

## 0. Goal, topology, non-goals

Goal: bidirectional sync of the outline between PromptFlow-Tauri (macOS desktop, `~/Code/PromptFlow-Tauri`, Ryan's daily driver) and the SwiftUI iPad app (`~/Code/PromptFlow`, currently CloudKit-synced — CloudKit is to be **removed entirely**), reachable from anywhere (office LAN, home, cellular), explicitly **not** dependent on Tailscale. An iPhone target may be added to the Swift app later; the sync client must not assume iPad-only.

Topology: hub-and-spoke. A new Rust service `promptflow-sync` runs on the Calumix Mac Mini (Ryan's office), holds the **canonical replica** in its own SQLite store, and is fronted by a **Cloudflare Named Tunnel** at `https://pf-sync.ryan-div.com`. Each device keeps its own local store (Tauri SQLite / SwiftData) and converges on the hub via per-node LWW merge. One URL for all devices in all locations — no LAN fast path, no Bonjour, no `.local`, no Local Network permission surface on iOS or macOS. The hub being unreachable only pauses sync; every device remains fully functional offline.

Non-goals (v1): character-level merge / CRDTs, multi-user, end-to-end encryption (Cloudflare terminates TLS — Ryan has accepted this; the fallback if he reverses is a VPS TCP relay, out of scope), op-based outbox on the iPad (it pushes full state, see Phase 4), WebSocket push (poll first; WS is a Phase 5 nicety), oplog compaction (keep everything; policy stated in §3.6), the Forge app's `forge-ws.ryan-div.com` hostname (same zone/tunnel infra makes it trivial later, but it is a separate project).

## 1. Ground rules for the implementer

- Read `~/Code/PromptFlow-Tauri/CLAUDE.md` and `~/Code/PromptFlow/CLAUDE.md` before touching either repo. All their rules stand (store→delta→mirror shape, no local mirror mutation, `put()`/`drop_node()` discipline, non-undoable detached writes, export byte-compatibility, markdown never hard-wrapped, commit trailer).
- Never run a dev build against Ryan's real stores. Tauri: `scripts/dev.sh` isolates by default; keep it that way. Swift: **`scripts/run.sh` does NOT isolate** — it sets only `PROMPTFLOW_NO_CLOUDKIT=1` and opens the real store (its own header says so); for any dev launch use `scripts/scenario.sh` (which sets `PROMPTFLOW_STORE`) or pass an explicit `PROMPTFLOW_STORE=/tmp/...` yourself.
- Never touch anything SPARC on the Mac Mini: ports 9000–9010, Postgres (5432), the `com.calumix.sparc.*` launchd agents, their repo/venv/`deploy/.env`. The mini is reachable via `ssh server`; treat every ssh command as running on shared production hardware.
- Ryan drives device/UI testing. At each phase gate, hand him a short concrete test checklist rather than driving his machines.
- Per-phase commits, pushed to origin, ending with the `Co-Authored-By: Claude` trailer per repo convention. Update both CLAUDE.md files at the end of any phase that changes architecture-level behavior.
- The `promptflow.outline` export format is untouched by this project. It stays byte-compatible in both apps (it has its own `NodeExport` types in both codebases, so model/wire changes cannot leak into it accidentally — keep it that way). The sync wire format is a **separate** serialization (§3.2) — do not conflate them; the export's seconds-precision ISO dates are too coarse for merge clocks.

## 2. Verified environment facts (do not re-derive)

- Mac Mini (`ssh server`): M4, arm64, macOS 26.4, 16 GB, never sleeps, application firewall off. LAN 192.168.0.101; tailnet 100.71.221.96 (irrelevant here). User is in the `admin` group (sudo with password; no passwordless sudo). No rust/cargo/docker/caddy on the box — binaries are **built on Ryan's Mac (same arch/OS) and scp'd**. Homebrew present. `cloudflared` 2026.3.0 installed via brew (upgrade it in Phase 0); no tunnel, no `~/.cloudflared`, no cloudflared service exists yet.
- Office egress verified 2026-08-06: TCP 7844 open to `region1.v2.argotunnel.com` and `region2.v2.argotunnel.com`; TCP 443 open. cloudflared will connect (a Forge Quick Tunnel historically ran from this box).
- Domain `ryan-div.com`: owned by Ryan, GoDaddy registrar, expires 2027-06, **no DNSSEC DS records, no MX/SPF** — nothing rides on this zone except a currently-broken Webflow site (`A @ → 198.202.211.1` = Webflow's IP, `CNAME www → cdn.webflow.com`). NS currently `ns11/ns12.domaincontrol.com`; the zone must move to a free Cloudflare account (full-setup; subdomain delegation is Enterprise-only, partial/CNAME setup is Business-only — verified).
- Cloudflare free-plan constraints that shape the protocol: **100 MB request-body cap** (413 above), **100 s origin-response deadline** (524 — no long-polls; WebSockets are supported on all plans if used later, with keepalive pings). JSON API traffic is squarely within ToS. Access (Zero Trust) free tier: 50 users; service tokens send `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers, default 1-year lifetime; authenticated requests reach the origin with a `Cf-Access-Jwt-Assertion` JWT verifiable against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` (check `iss` and `aud`; service-token requests carry `common_name` = the token's Client ID).
- `sudo cloudflared service install <token>` installs a **system LaunchDaemon** (`/Library/LaunchDaemons/com.cloudflare.cloudflared.plist`, pre-login, survives reboot). The sync server itself will be a **user LaunchAgent** (matches the SPARC house pattern; the mini's auto-login is evidently on since SPARC's agents run) — note the standing dependency: no GUI login ⇒ agents down (cloudflared will 502 until login; acceptable, documented).
- Tauri store facts that matter here: `rev` is in-memory (resets per launch — useless as a sync cursor); deltas are ephemeral; undo entries are full before/after node images restored verbatim (no restamp today); `updated_at` is stamped by every user mutation **except** gap-exhaustion renumbering (`position_after`, `first_child_position`, `first_root_position`) and undo/redo; import mints fresh UUIDs; `Store` lives behind a `std::sync::Mutex` and background work follows the auto-archive precedent (`std::thread` + lock + `emit_delta`, `lib.rs`).
- Swift app facts that matter here: single `@Model Node` with the same field semantics as `NodeRec` (same GAP=1024 gapped positions, same `(position, uuid)` sibling tiebreaker, same kind raw strings, `boldRanges` only — **no italic/underline fields exist**); **plain typing does NOT stamp `updatedAt`** — FOUR editor surfaces write straight through bindings, bypassing `OutlineStore`: `NodeTextView.swift` (~:700, `textDidChange`), `NoteTextView.swift` (~:150), `IPadNodeTextView.swift` (~:308, `textViewDidChange`), `IPadNoteTextView.swift` (~:132); `boldRanges` is maintained by **re-extraction from NSTextStorage attribute runs** (`BoldRuns.extract`) after each edit — there is NO splice-style range adjuster anywhere in the Swift repo (the single-splice adjuster lives only in the Tauri frontend's TS `adjustRangesForEdit`); no change tracking / persistent-history reads anywhere; one shared `UndoManager` on `mainContext` (undo is SwiftData's automatic change tracking — the app registers no undo actions of its own) with an existing temporary-detach pattern (`context.undoManager = nil` + `defer` restore) used by `archiveAndDelete`/`replaceAll`; the Xcode project has **no test target at all** today; target is iPad-only (`TARGETED_DEVICE_FAMILY = 2`), min iOS 26.0, bundle `com.ryandiv.PromptFlow`, team `8CFYV5CWDL`.
- The two stores' node IDs do **not** overlap (the Tauri migration minted fresh ids). The iPad's data is stale by Ryan's own account. Bootstrap is therefore: hub seeded from the Mac through the normal push path (see Phase 3's first-configuration full enqueue); iPad does a **destructive first pull**, hard-gated before it may ever push (Phase 4's bootstrap gate).

## 3. Protocol v1 (the contract; lives in `promptflow-core`)

### 3.1 Identity, clocks, device ids

- Node identity: the existing UUIDs. Sync-applied inserts must **preserve** the incoming id on every platform (unlike `.outline` import, which keeps minting fresh ids — leave import alone).
- Two merge clocks per node, ms-epoch UTC: `updatedAt` (kept under its existing name; semantics narrow to the **content clock**: text, note, bold/italic/underline ranges) and `structureUpdatedAt` (new: parent, position, kind, isCompleted, completedAt, isHighlighted). Creation sets both = `createdAt`. Rationale: whole-node single-clock LWW lets a move/complete/renumber carry stale text over concurrent typing; the split confines each class of edit to its own group.
- `isCollapsed` is **excluded from sync** (legacy/per-window in both apps; it stays in the export format only).
- Device id: a persistent UUID string minted once per store — Tauri: `settings` table key `sync.device_id`; iPad: the `SyncState` SwiftData entity (Phase 4). It must never regenerate per launch/install (echo-exclusion depends on it). Reserved id `"server"` marks hub-originated repair ops.

### 3.2 Wire node

A dedicated `WireNode` struct in `promptflow-core` — **not** `NodeRec`'s own serde output, which carries `isCollapsed` and must not leak it onto the wire. Fields (camelCase): `{id, parent, position, text, note, kind, isCompleted, isHighlighted, boldRanges, italicRanges, underlineRanges, createdAt, updatedAt, structureUpdatedAt, completedAt}`. Dates ms-epoch integers. `parent: null` = root. Conversions `NodeRec ⇄ WireNode` live beside the struct. The Swift client hand-mirrors this in `Codable`; §7.2's shared fixtures pin the two implementations together. Unknown JSON keys must be ignored on decode everywhere (forward compatibility).

The iPad must **round-trip `italicRanges`/`underlineRanges` opaquely**: `Node` gains both arrays as additive-default fields (Phase 1), they are stored verbatim and echoed on push, and when the iPad's own edit changes `text` a **new splice-style adjuster** (Phase 4; derive the splice from `shouldChangeTextIn`'s edited range) shifts/clips both arrays — the existing `BoldRuns.extract` re-extraction mechanism cannot carry styles the iPad never paints into its text storage, so an adjuster must be written; ranges are never dropped wholesale (dropping styling was a confirmed failure mode).

### 3.3 Endpoints

All under `https://pf-sync.ryan-div.com`, all behind Cloudflare Access + app bearer token (§8; the bearer is generated in Phase 2). All responses carry `protocolVersion: 1`; requests carry the same and are rejected `400` on major mismatch.

- `GET /v1/snapshot` → `{protocolVersion, nodes: [WireNode], latestSeq}`. Live nodes only (no tombstones). State and seq **must be read in one SQLite transaction** (a torn read here permanently skips ops for a bootstrapping client). Used for bootstrap and 410 recovery.
- `POST /v1/push` body `{protocolVersion, deviceId, ops: [{type:"upsert", node: WireNode} | {type:"delete", id, deletedAt}]}` → HTTP 200 `{protocolVersion, latestSeq, results: [{id, outcome: "applied"|"partial"|"rejected", reason?, current?}]}`. One request shape for both clients: the Tauri client sends its outbox (true deltas); the iPad sends its full live state as upserts plus its explicit delete journal. Semantics: `outcome` is `applied` when the op changed the stored row as pushed, `partial` when only one clock-group won (§3.4), `rejected` when nothing changed; `reason` ∈ `{stale, tombstone, tie, clockSkew, invalid}`; `current` is the stored `WireNode` (or `{id, deletedAt}` for a standing tombstone) and is included **whenever the stored result differs from what the client pushed** (i.e. on every `partial` and every `rejected` except `clockSkew`/`invalid`). **Client handling, both platforms: every op named in `results` leaves the outbox/journal regardless of outcome, and every `current` is applied locally through the normal merge-apply path** — this is what repairs the pusher immediately after a tie or partial loss and prevents infinite re-push loops. Each push is processed in **one server-side transaction**. Mass-delete tripwire: if `ops` contains more deletes than `max(50, 20% of live node count)`, reject the whole push `428` unless header `X-PF-Confirm-Mass-Delete: true` is present; clients never auto-set it — each client's sync-error UI offers an explicit "confirm mass delete" action that re-sends the same pending batch once with the header (§Phase 3/Phase 4).
- `GET /v1/changes?since=<seq>&device=<deviceId>` → `{protocolVersion, ops: [{seq, deviceId, op}], latestSeq}`. Returns oplog entries with `seq > since`, **excluding** entries whose `deviceId` equals the caller's — but never excluding `"server"` entries (repairs must reach the device whose push triggered them). If `since` predates the retained log (only possible post-compaction, a non-goal for v1, but implement the check now): `410 Gone` → client re-bootstraps from `/v1/snapshot`, merging it through the normal apply path. (Known v1 limitation, deliberate: a snapshot-merge cannot delete local nodes absent from the snapshot; that only matters once compaction can drop tombstones, so closing it — tombstoning local ids missing from the snapshot — is a hard requirement OF the future compaction project, not of v1.)
- `GET /v1/health` → `{protocolVersion, latestSeq, liveNodes, tombstones, uptime, perDevice: [{deviceId, lastPushAt, lastPullSeq}]}`. Behind the same auth as everything else.

### 3.4 Merge rules (THE core; one implementation in `promptflow-core`, used by the server on push and by the Tauri client on pull/`current`-repair; the Swift client implements the same rules, pinned by shared fixtures)

Tie policy (global): **the hub is canonical, and ties converge to hub state.** On the hub (merging a pushed op into stored state), an equal clock means the stored value stands. On a client (merging a pulled op or a push-response `current` into local state), an equal clock means the incoming hub value wins. Strictly-newer always wins on both sides. There is no per-device tie-break state to persist anywhere; a pusher that loses a tie learns the winner from `results[].current` in the same round-trip. (T12 pins convergence under both arrival orders.)

Upsert of incoming `n` against stored state:

- No stored row → insert (subject to tree validation below).
- Stored tombstone → resurrect iff `max(n.updatedAt, n.structureUpdatedAt) > deletedAt`; else the tombstone stands and the op is `rejected` with `reason: "tombstone"` (no oplog entry). A resurrected node whose parent is dead/missing reparents to root (repair). Its previously-tombstoned descendants **stay dead** — a deliberate, documented semantics choice: resurrect brings back the node, not its subtree.
- Stored live → merge per clock-group: content fields (`text, note, boldRanges, italicRanges, underlineRanges` + `updatedAt`) replace iff `n.updatedAt` beats stored per the tie policy; structure fields (`parent, position, kind, isCompleted, completedAt, isHighlighted` + `structureUpdatedAt`) likewise on `structureUpdatedAt`. The result row may mix groups from both sides (`outcome: "partial"` when exactly one group won).
- Tree validation after group-merge, deterministic and identical on server and clients: (a) parent missing or tombstoned → parent := root, position := max(root positions) + GAP (repair); (b) the structure change would create a cycle (walk new ancestors) → the incoming structure group is rejected wholesale, stored structure kept (content merge still applies). Every repair the server performs is written to the oplog as an additional upsert under deviceId `"server"`.

Delete `{id, deletedAt}` against stored state:

- Stored live → delete wins iff `deletedAt > max(stored.updatedAt, stored.structureUpdatedAt)`; on win, tombstone the node **and cascade-tombstone every currently-live descendant** with the same `deletedAt` (each cascade tombstone is its own oplog entry under `"server"` — the pusher computed its delete set from its own replica and must learn about children it didn't know). On loss (a stored edit is newer), `rejected` with `reason: "stale"` and `current` = the live node; the pusher's replica re-converges immediately via `current` (T5).
- Stored tombstone → no-op (`applied`; idempotent). No stored row → record the tombstone anyway (a delete may arrive before its node from a lagging device).

Write discipline (idempotency): a merged result **identical to the stored row is a no-op** — no oplog entry, no `server_seq` bump. Only actual changes append. Pushes are therefore retry-safe and full-state pushes don't flood the log.

Clock hygiene: any op whose clocks exceed `server_now + 24h` (broken clock) is `rejected` per-op with `reason: "clockSkew"` — the rest of the batch still applies (T10); the server logs a warning whenever a push's skew exceeds 60 s. No clamping (silent value rewrites cause client/server clock disagreement); all devices are NTP-synced Apple hardware, so warn-and-reject-only-the-absurd is the v1 posture.

### 3.5 Undo and the live editor (both clients — this is where naive LWW visibly misbehaves)

- Applying remote ops must never create undo entries: Tauri `apply_remote` bypasses `push_undo`; Swift applies under the existing `undoManager = nil` detach pattern.
- After a remote apply, **drop** local undo AND redo entries that touch any remotely-changed node id (Tauri: filter both stacks; Swift: scoped-drop is not achievable with `NSUndoManager`, so full `removeAllActions()` on any remote apply that changed ≥1 node is the accepted v1 cost on the iPad). Rationale: a state-image undo would otherwise revert remote changes to fields the local edit never touched, then export the reversion.
- Undo/redo application stamps **both clocks fresh** on every restored node. Tauri: in the store's undo/redo paths after images are restored. Swift: the app registers no undo actions (SwiftData's automatic tracking), so the hook is **`NSUndoManager` notifications on `mainContext.undoManager`** — on `willUndoChange`/`willRedoChange` snapshot a map of `nodeId → (clocks + content/structure hash)`, on `didUndoChange`/`didRedoChange` diff against it and restamp the changed nodes; this covers the Undo/Redo buttons, key equivalents, AND system undo gestures, which all route through the same manager. Without the restamp, an undone state carries pre-edit clocks and silently loses the next merge — "undo un-undoes itself" (T8).
- Remote apply vs the focused Tauri editor — accepted v1 semantics, stated so nobody "fixes" it ad hoc: remote adoption follows the existing multi-window path (`pendingSent` echo guard, IME composition protected). Consequence: a remote WIN on the exact node being actively typed in can be skipped by the echo guard and then overwritten by the next keystroke's fresh clock — the active typist wins. Same-node concurrent cross-device editing is rare for a single user; revisit only if it bites. Named in the Phase 3 gate checklist as an observe-and-log item, not a bug.

### 3.6 Retention

Tombstones and oplog are kept forever in v1 (a personal outline; rows are small). This is a stated policy, not an omission: any future GC must respect `min(all device cursors)` with an age floor, because a long-offline device pushing against GC'd tombstones mass-resurrects deletions — and must also close the snapshot-merge deletion gap noted in §3.3. The `410`-and-rebootstrap path is implemented now so compaction later is a config change, not a protocol change.

## 4. Repository layout and the shared crate

- `~/Code/PromptFlow-Tauri` gains a root `Cargo.toml` **workspace with members `crates/promptflow-core` and `crates/pf-sync-server` only** — `src-tauri` is explicitly `exclude`d and gets an empty `[workspace]` table in its own Cargo.toml, so it stays standalone and its `src-tauri/target/...` paths keep working for `scripts/build.sh`, `scripts/verify.sh`, and the tauri CLI (verified: no root Cargo.toml exists today; verify.sh hardcodes `src-tauri/target/release/bundle/macos/...`). `src-tauri` depends on `promptflow-core` by path (`../crates/promptflow-core`).
- `promptflow-core` (lib): `NodeRec` + serde (moved from `src-tauri/src/model.rs`; keep a re-export so `src-tauri` diffs stay small), `NodeKind`, GAP/order helpers, the `WireNode` struct + `NodeRec ⇄ WireNode` conversions (§3.2), wire types (ops, push/pull request/response), the merge + tree-validation + repair implementation (§3.4), and the JSON fixtures (§7.2). No tauri, no rusqlite, no HTTP dependencies — pure logic + serde.
- `pf-sync-server` (bin `promptflow-sync`): axum + tokio + rusqlite (bundled) + `jsonwebtoken` for the Access JWT + `ureq` (rustls) for JWKS fetch. Single-threaded write model: one rusqlite connection behind a tokio `Mutex`, WAL, every push/pull/snapshot a single transaction — correctness over throughput; two clients.
- The Swift app stays in `~/Code/PromptFlow`. Its sync engine is hand-written Swift (Phase 4); the contract is pinned by fixtures read from the sibling checkout at `../PromptFlow-Tauri/crates/promptflow-core/fixtures/` (see §7.2 for the resolution mechanics — the repo has no test target today; one is created in Phase 4).

Server SQLite schema (hub store, `~/PromptFlow-Sync/sync.sqlite`):

```sql
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  parent TEXT,                       -- materialized for tree validation
  deleted INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER,
  content_at INTEGER NOT NULL,       -- = wire updatedAt
  structure_at INTEGER NOT NULL,
  server_seq INTEGER NOT NULL,       -- last oplog seq that touched this row
  payload TEXT NOT NULL              -- full WireNode JSON, opaque (forward-compatible)
);
CREATE INDEX idx_nodes_parent ON nodes(parent);
CREATE TABLE oplog (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  op TEXT NOT NULL,                  -- 'upsert' | 'delete'
  payload TEXT NOT NULL,             -- WireNode JSON or {id, deletedAt}
  server_ts INTEGER NOT NULL
);
CREATE TABLE devices (device_id TEXT PRIMARY KEY, last_push_at INTEGER, last_pull_seq INTEGER);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

(No per-group writer-id columns: the tie policy in §3.4 needs none.)

## 5. Phase 0 — Cloudflare front door (mostly [RYAN], ~1–2 h wall clock)

**STATUS: COMPLETED 2026-08-11.** Gate results, verified live: DNS `pf-sync.ryan-div.com` → Cloudflare edge (172.64.80.1); anonymous request → **403** (Access blocking); authenticated request with the service token → **502** (Access passed, no origin yet — correct); connector installed as a system LaunchDaemon on the mini with three registered QUIC connections to three Toronto POPs (yyz01/03/06); TLS valid. The Access app is named `pf-sync` (not "PromptFlow Sync"), its policy is `devices` (action Service Auth), and the service-token Client ID is `00e0de7f97b61a6ae9ab945972a09298.access` (secret in Ryan's password manager + Keychains only). **The AUD tag IS captured** (from the `cf-access-aud` response header on a blocked request, verified 2026-08-11): `88c0e03ef09503d5df316ac21d34bdb7075a49bff979f348adbec5284316c79d`. Also verified live: the Access JWKS is served on the app's own hostname at `https://pf-sync.ryan-div.com/cdn-cgi/access/certs`, so JWT verification needs no team-domain URL for key fetching. **The team domain (`<team>.cloudflareaccess.com`) was auto-provisioned by the merged dashboard and is still unrecorded** — capture the `iss` claim via the Phase 2 log-then-lock step (or read it from the dashboard's bottom-left Settings, where the team domain is shown). The steps below are kept for reference/rebuild only.

1. **[RYAN]** Create a free Cloudflare account (none exists — Quick Tunnels needed no account). Add site `ryan-div.com`, Free plan. When Cloudflare imports records, ensure these exist and are set to **DNS only (grey cloud)**: `A @ → 198.202.211.1`, `CNAME www → cdn.webflow.com`, `TXT _webflow → "one-time-verification=0a4ecd94-81f3-4e42-a1f9-cb274244ff17"`. Skip `_domainconnect` (GoDaddy plumbing). Nothing is live yet after this step.
2. **[RYAN]** At GoDaddy → ryan-div.com → Nameservers: replace `ns11/ns12.domaincontrol.com` with the two Cloudflare-assigned nameservers. (Registrar stays GoDaddy; this is reversible by restoring the old pair; the standard domain-lock flags do not block NS edits from your own dashboard — if the save errors, toggle Domain Lock off temporarily.) Wait for Cloudflare's "site active" email (minutes–hours; nothing user-visible can break: no email on the zone, site already down).
3. **[RYAN]** In the Cloudflare dash (Zero Trust / Cloudflare One area): pick a team name (creates `<team>.cloudflareaccess.com` — note it), then Networks → Tunnels → create tunnel `promptflow-sync` (remotely-managed). Copy the connector install token. Add a published-application route: hostname `pf-sync.ryan-div.com` → service `http://localhost:9273`.
4. **[RYAN]** Access → Applications → self-hosted app for `pf-sync.ryan-div.com` (protect the whole hostname), policy action **Service Auth**; create a service token `promptflow-devices`; record the Client ID + Client Secret (shown once) and the app's **Audience (aud) tag**. Hand the agent: team domain, aud tag, tunnel token (transient), and the service-token pair (these will live in client configs/Keychain; the app bearer token is separate and generated in Phase 2).
5. **[RYAN + agent]** Over `ssh server`: `brew upgrade cloudflared`, then `sudo cloudflared service install <token>` — the sudo password is Ryan's to type (interactive ssh session he runs, or he executes the two commands himself); never store or embed it. Verify `/Library/LaunchDaemons/com.cloudflare.cloudflared.plist` exists and the tunnel shows **healthy** in the dash.
6. Gate: from any network, anonymous `curl -s -o /dev/null -w '%{http_code}' https://pf-sync.ryan-div.com/` → **403 or a 302 redirect to `<team>.cloudflareaccess.com`** (both mean Access is blocking anonymous traffic); same request with `CF-Access-Client-Id/Secret` headers → `502` (Access passed, no origin yet — correct until Phase 2 deploys). Record both results in the phase commit message.

## 6. Implementation phases

### Phase 1 — `promptflow-core`, two-clock schema, stamping fixes (both repos)

- Create the workspace + core crate per §4; move/re-export the model types; `cd src-tauri && cargo test` and `npm test` and `npx tsc --noEmit` must stay green (the app-internal delta/snapshot shape gains `structureUpdatedAt` — additive; the TS `NodeRec` interface in `src/lib/types.ts` and mirror are unaffected by an extra runtime field under strict tsc, verified).
- Tauri migration (idempotent `ALTER TABLE`, same pattern as `italic_ranges` in `persist.rs`): add `structure_updated_at INTEGER`; backfill once with `UPDATE nodes SET structure_updated_at = updated_at WHERE structure_updated_at IS NULL`. `NodeRec` gains the field (serde `structureUpdatedAt`, default 0 → treat 0 as `updated_at` on read for pre-migration rows).
- Re-route Tauri stamping: content clock (`updated_at`) only in `set_text`, `set_note`, and the style-toggle paths; structure clock in `commit_new_node` (both clocks — creation), `indent`/`outdent_inner`, `move_by`/`move_to`, `toggle_completed` (+`completed_at`), `set_kind`, `set_highlighted`, `merge_into_prompt` (head: both clocks), every `*_block` variant correspondingly, **and the gap-exhaustion renumber paths** (`position_after`, `first_child_position`, `first_root_position`) — renumbering must stamp structure so renumbered positions propagate, and must NOT stamp content (a renumber sweeping a sibling list must never beat concurrent typing; this exact interaction is test T7).
- Tauri undo/redo: after restoring images, stamp both clocks on every restored node (§3.5).
- Swift mirror of the same: add `structureUpdatedAt: Date = .now` **and `italicRanges: [Int] = []` + `underlineRanges: [Int] = []`** to `Node` (all additive-with-default — the established safe migration shape; keep `NodeSchemaV1` untouched per its own checksum-collision warning, which blesses exactly this case); re-route stamping across `OutlineStore` mutations to match the Tauri table above; **fix the typing gap on all FOUR editor surfaces** — stamp `updatedAt` where the bindings are written: `NodeTextView.swift` `textDidChange` (~:700), `NoteTextView.swift` (~:150), `IPadNodeTextView.swift` `textViewDidChange` (~:308), `IPadNoteTextView.swift` (~:132); wire the undo-notification restamp hook (§3.5).
- Gate: both apps build and pass their suites; a new `cargo test` in core covers clock assignment per mutation class; manual smoke — typing on the iPad build updates `updatedAt` (was the shipped gap).

### Phase 2 — the hub (`pf-sync-server`)

- Implement §3 exactly: schema §4, merge via `promptflow-core`, the four endpoints, per-push single transaction, oplog append only on real change, `"server"` repair ops, per-op `results` with `current` repair payloads, tripwire, clock checks, `410` path, health.
- Auth middleware, two layers: (1) verify `Cf-Access-Jwt-Assertion` — fetch JWKS from `https://pf-sync.ryan-div.com/cdn-cgi/access/certs` (verified live; cache keys, refresh on unknown-kid) and check `aud` = `88c0e03ef09503d5df316ac21d34bdb7075a49bff979f348adbec5284316c79d` (captured, see Phase 0 status) and `common_name` = the expected service-token Client ID. **The `iss` (team domain) is not yet recorded**: on first deploy, log the incoming `iss` claim while enforcing signature + `aud` + `common_name`; take the logged `https://<team>.cloudflareaccess.com` value, set `access_team_domain` in config, restart, confirm requests still pass. Never ship past the Phase 2 gate without `iss` pinned; (2) require `Authorization: Bearer <app token>` — constant-time compare, bodyless 401. Config from `~/PromptFlow-Sync/config.toml` (mode 0600): `port` (9273, loopback bind only — `127.0.0.1`), `db_path`, `bearer_token`, `access_team_domain`, `access_aud`, `access_client_id`. Generate the bearer token in the deploy step (`openssl rand -hex 32`); it goes into the same config + each client's Keychain **[RYAN]** + Ryan's password manager **[RYAN]**.
- Startup hygiene (KeepAlive discipline): resolve absolute paths from `$HOME`, `mkdir -p` the data dir, and on unrecoverable config errors log one clear line and **exit 0** (so `KeepAlive = {SuccessfulExit: false}` stops the loop instead of hammering every ThrottleInterval).
- Integration test harness in the server crate: spin the axum app in-process against a temp DB and script two fake devices through the full scenario matrix (§7.1). This harness is the project's main correctness instrument — build it before wiring any real client.
- Deploy: `scripts/sync-deploy.sh` — `cargo build --release -p pf-sync-server` locally, `scp` to `server:~/PromptFlow-Sync/promptflow-sync.new`, `ssh server 'mv ~/PromptFlow-Sync/promptflow-sync.new ~/PromptFlow-Sync/promptflow-sync && launchctl kickstart -k gui/$(id -u)/com.ryandiv.promptflow-sync'` — **never scp over the running binary in place** (Apple Silicon kills the process on text-page invalidation and can wedge subsequent execs with `Killed: 9` under KeepAlive). LaunchAgent plist `~/Library/LaunchAgents/com.ryandiv.promptflow-sync.plist`: `KeepAlive = {SuccessfulExit: false}`, `ThrottleInterval` 30, `StandardOutPath/StandardErrorPath` → `/opt/homebrew/var/log/promptflow-sync.log` (distinct from SPARC's `sparc-*` names), bootstrap via `launchctl bootstrap gui/$(id -u) …`.
- Log rotation (launchd never rotates `StandardOutPath` files): add `/etc/newsyslog.d/promptflow-sync.conf` with `/opt/homebrew/var/log/promptflow-sync.log <user>:staff 644 5 10240 * J` (rotate at 10 MB, keep 5, compressed) — needs one sudo, do it in the same **[RYAN]** session as the cloudflared install; if that session has passed, fall back to size-check + copy-truncate inside the nightly backup agent. Either way the log must have a stated cap on the shared mini.
- Backup: a second LaunchAgent `com.ryandiv.promptflow-sync-backup` with `StartCalendarInterval` (03:30) running a small script: `mkdir -p "$HOME/PromptFlow-Sync/backups"` then `sqlite3 "$HOME/PromptFlow-Sync/sync.sqlite" "VACUUM INTO '$HOME/PromptFlow-Sync/backups/sync-$(date +%F).sqlite'"` + prune to last 14 (note: `$HOME`, never `~` inside quoted SQL — launchd's cwd is `/` and SQLite won't expand tildes). Never raw-copy the live WAL DB.
- Gate: full scenario matrix green in-process; deployed to the mini; `curl` through the tunnel with all three credentials → `/v1/health` 200 and sane JSON; without bearer → 401; without Access headers → 403/302 at the edge. Kill/relaunch drill: `kickstart -k` mid-`curl` loop shows clean recovery.

### Phase 3 — Tauri client

- `outbox` table in the app store (same DB, so atomicity is free): `(node_id TEXT PRIMARY KEY, op TEXT, payload TEXT, queued_at INTEGER)` — coalesced per node (latest image wins; a delete replaces a queued upsert). Rows written **inside the same transaction** as `persist::apply` for every commit. Deletes capture `deletedAt = now` at enqueue.
- **First-configuration seeding (this is how the hub gets Ryan's outline)**: when sync becomes configured and no cursor exists in `settings`, enqueue **every live node** into the outbox in one transaction before the first cycle runs (T16). Without this, the outbox only ever carries post-configuration edits and the hub starts empty forever.
- Special mutation sources, decided: the **welcome seed** — if sync is configured and the store is empty, skip the seed and bootstrap from `/v1/snapshot` instead; an unconfigured store seeds as today (T14). The **auto-archive sweep** — its deletes are ordinary commits and ride the outbox like any others; asymmetric archive files across devices are accepted (the sweeping device holds the JSON backup; the nodes were completed 3+ days). **Import (`replace_all`)** — while sync is configured it enqueues deletes for every replaced live id plus upserts for every imported node (the user chose to replace the document; sync propagates that); a large import may trip the 428 tripwire and rides the confirm affordance below.
- Sync loop: `std::thread` (auto-archive precedent) owning an `ureq` agent. Serial cycle, debounced 2 s after the last commit and every 30 s idle — **pull → apply → push**, same order as the iPad, one mental model: (1) under the store lock, read cursor, **release the lock**; (2) GET `changes`; (3) re-take the lock once — `apply_remote` all pulled ops through the `promptflow-core` merge (local row vs incoming, including rows still pending in the outbox — local-strictly-newer wins locally, hub wins ties, §3.4), advance the cursor, all **in one SQLite transaction** — then `emit_delta` with origin `"sync"` (one commit, one rev bump, no undo entry, drop conflicting undo/redo entries per §3.5); (4) snapshot outbox rows under the lock, release, POST `push`; (5) re-take the lock: process `results` — every named op leaves the outbox *unless re-queued meanwhile* (compare `queued_at`), every `current` applies through the same merge path as step 3, one transaction, `emit_delta` if anything changed. Network I/O must never run under the store mutex (a hung request would freeze every keystroke's `set_text`).
- Cursor + device id live in the `settings` table; the cursor advances only inside the apply transaction (a crash between apply and cursor-advance replays ops, which merge idempotently — T11).
- 428 handling: the sync-error state in the SettingsPanel shows the pending delete count and a **"Confirm mass delete"** button that re-sends the same batch once with `X-PF-Confirm-Mass-Delete: true` (§3.3). Never automatic.
- Config UI: server URL + bearer + Access client id/secret in the existing SettingsPanel (macOS Keychain via the `security` CLI for the secrets; URL in settings table); a last-synced timestamp + error line in the panel, and a subtle TopBar indicator only for the persistent-failure state. Timeouts: 15 s connect / 60 s total per request — every failure mode must resolve to a visible "last synced X ago" rather than a hang.
- Gate: two app instances with isolated stores against a **local** server instance converge through the full matrix driven manually. Note `vite.config.ts` pins port 1420 with fail-if-unavailable, so two `scripts/dev.sh` cannot coexist — either parameterize the dev port (env var through vite.config + tauri devUrl) or run one dev instance plus a release build with its own `PROMPTFLOW_STORE`; pick whichever is less invasive, don't ship a broken second-instance story silently. Observe (not fix) the §3.5 focused-editor semantics. Then **[RYAN]** points his real app at the production hub (credentials into his Keychain) — the first-configuration full enqueue seeds the hub — and runs a short smoke checklist you hand him.

### Phase 4 — iPad: CloudKit removal + sync client

- CloudKit removal (verified checklist; nothing functionally breaks — keep the CloudKit-imposed model shape, do NOT revert optionals/uniques): `PromptFlowApp.swift` — delete `SyncConfig`, the `cloudKitDatabase:` selection, and the CloudKit-failure fallback branch; both `.entitlements` — drop `aps-environment`, `icloud-container-identifiers`, `icloud-services` (keep macOS sandbox/network/file keys); `Info.plist` — drop `UIBackgroundModes`; make the three seed gates unconditional (`OutlineView.swift` ~:281, `IPadOutlineView.swift` ~:181, `PromptFlowApp.swift` ~:201); strip the now-dead `CODE_SIGN_ENTITLEMENTS`/`PROMPTFLOW_NO_CLOUDKIT` plumbing in `build.sh`/`build-ios.sh`/`run.sh`/`verify.sh` **and `install.sh`** (whose keep-the-entitlement rationale goes stale with CloudKit); update the repo's CLAUDE.md and stale docs.
- New SwiftData entities (additive): `SyncState {deviceId, cursor, lastSyncAt, lastError, bootstrapped: Bool}` and `DeletedNode {uuid, deletedAt}`. The delete journal is written in `OutlineStore`'s delete paths, including `archiveAndDelete` (auto-archive deletes sync like any delete — same decision as the Tauri side) — enumerate the subtree ids **before** the cascade delete (SwiftData cascade won't tell you afterwards). Journal rows are cleared for every op named in a push's `results` (any outcome, §3.3).
- The splice adjuster (§3.2): implement `RangeSplice.apply(ranges: [Int], edit: NSRange, replacementLength: Int) -> [Int]` and run it over `italicRanges`/`underlineRanges` (and nothing else — `boldRanges` stays on the existing `BoldRuns.extract` path) in all four editor-commit surfaces; UTF-16 units end to end. Pin it with fixture vectors (§7.2).
- `SyncEngine` (actor, owned by the app): serial cycle, same order as the Tauri client — pull → apply fully (main context, undo detached, `removeAllActions()` if anything changed, preserve incoming UUIDs, hub wins ties per §3.4) → save applied ops + cursor **in the same SwiftData save** (never UserDefaults for the cursor — an iOS kill between cursor-advance and store-save is the silent-op-loss footgun) → then snapshot full live state + journal and push → apply `results[].current` repairs + clear journal/state flags in one save. Triggers: `scenePhase == .active`, 3 s debounce after local edits, and a `beginBackgroundTask`-wrapped flush on backgrounding (without it you get ~5 s, not 30). `URLSession` with `waitsForConnectivity = false` for sync ticks (fail fast, show state) and `timeoutIntervalForResource = 60`.
- Bootstrap hard gate: until `SyncState.bootstrapped`, the engine refuses to push (assert in debug). First-run flow: settings screen (server URL prefilled, bearer + Access credentials into Keychain **[RYAN]**) → explicit "Adopt server data — erases this iPad's outline" confirmation → wipe store via the detached-undo bulk-delete pattern **with journal capture bypassed for the wipe, and any existing `DeletedNode` rows cleared in the same save that sets `bootstrapped`** (otherwise the first push carries thousands of junk tombstones and a guaranteed 428) → `/v1/snapshot` → insert preserving ids → set cursor + `bootstrapped` in the same save → normal syncing begins (T4).
- Auth headers on every request: `CF-Access-Client-Id`, `CF-Access-Client-Secret`, `Authorization: Bearer` — all from Keychain. No ATS exceptions, no Local Network keys, no Bonjour — the endpoint is a public TLS hostname; none of that surface exists in this design.
- Sync status UI: last-synced + error in the iPad settings/sidebar; distinct copy for auth failure (401/403 — "check sync credentials"), unreachable (offline/timeout), `428` ("sync paused: large delete pending — confirm below", with the same confirm-once affordance as the Mac), and `413` ("outline too large to sync" — copy only; the realistic payload is a few MB).
- Gate **[RYAN]**, on device (simulator is fine for logic; credentials/Keychain/background flows want hardware): checklist — bootstrap adopts Mac data; edit iPad → appears on Mac ≤35 s; edit Mac → appears on iPad on foreground; offline edits both sides converge per LWW; delete on iPad propagates; force-kill mid-sync then relaunch converges; wrong bearer shows the auth error state.

### Phase 5 — cutover + hardening

- Cutover order: Phase 3 gate seeded the hub from the Mac; Ryan bootstraps the iPad (Phase 4 gate); then watch `/v1/health` `perDevice` for a week of real use. Add a `scripts/sync-status.sh` (curl + jq of health) for quick checks.
- Hardening backlog, in priority order, each optional and separately shippable: WebSocket change-ping channel (desktop first; keepalive pings under the 100 s edge rule), oplog compaction behind `min(cursor)` + age floor (the 410 path already exists; must also close the snapshot-merge deletion gap, §3.3/§3.6), Access service-token rotation runbook (1-year expiry — put a reminder note in the config file), push-payload chunking if the outline ever approaches the 100 MB cap, iPhone target (`TARGETED_DEVICE_FAMILY` + UI pass; sync engine unchanged).

## 7. Verification plan

### 7.1 Scenario matrix (server-crate integration tests; each traces to a reviewed failure mode)

- T1 pull-then-push echo divergence: A edits X, B has older unpushed edit to X; B pulls (must keep its newer local via client-side merge), pushes, both converge on B's text.
- T2 repair visibility: A moves X under P offline; B deletes P subtree; A pushes after B — server reparents X to root under `"server"`; A's next pull (excluding its own ops) still receives the repair; B receives X-at-root.
- T3 delete cascades to unknown children: B deletes P while A concurrently created child C under P; A's C-upsert lands first; B's delete must tombstone C via cascade `"server"` op; A learns C died.
- T4 bootstrap gate: fresh device with `bootstrapped=false` and non-empty local state must not push; after adopt-pull, pushes flow; the bootstrap wipe leaves the delete journal EMPTY (no junk tombstones, no 428).
- T5 delete vs newer edit: delete with `deletedAt` older than stored clocks is `rejected` with `current`; the deleting device re-converges to the live node from the push response alone (no pull needed).
- T6 idempotent full-state re-push: identical push twice → zero new oplog entries, `latestSeq` unchanged, all `applied` (no-op) outcomes.
- T7 renumber vs typing: device A renumber (structure stamp) concurrent with device B typing (content stamp) on the same siblings → converged rows carry A's positions AND B's text.
- T8 undo restamp: undo restores old text with fresh clocks → propagates and wins; without restamp this test must fail (assert the stamp exists).
- T9 style-range round-trip: node with italic ranges edited (text change) on the bold-only client fixture → ranges spliced by the adjuster, never dropped.
- T10 clock skew: op 25 h in the future → per-op `rejected {reason: "clockSkew"}`, others in the same batch still apply (HTTP 200).
- T11 crash seams: replayed push after unacked response (no-op), pull re-applied after cursor non-advance (idempotent), snapshot consistency under concurrent push (single-tx assertion).
- T12 tie-break determinism: same-clock different-bytes upserts from two devices → hub keeps first-to-arrive; the second pusher gets `rejected {reason: "tie"}` + `current` and adopts it; both replicas converge identically regardless of arrival order.
- T13 cycle repair: A moves n1 under n2; B moves n2 under n1; later push's structure group rejected deterministically; both replicas converge acyclic.
- T14 configured-empty Tauri store bootstraps from snapshot instead of seeding.
- T15 tripwire: push with > threshold deletes → 428; with confirm header → applies.
- T16 first-configuration seeding: a store with N live nodes and no cursor enqueues all N on configuration; the hub holds N nodes after the first cycle.
- T17 no rejection loops: a push where every op is `rejected` empties the outbox/journal and applies `current` repairs; the next cycle pushes nothing.
- T18 import propagation: `replace_all` while configured enqueues deletes for all replaced ids + upserts for all new nodes; a second device converges to the imported document.

### 7.2 Cross-language contract fixtures

`crates/promptflow-core/fixtures/`: (a) wire-node encode/decode vectors (every field, null/absent variants, unknown-key tolerance); (b) merge vectors — `{stored, incoming, expected, outcome}` triples covering every §3.4 branch including tie policy on both sides; (c) splice-adjuster vectors for T9. `cargo test` in core asserts them. On the Swift side, **create a new XCTest unit-test target** (`PromptFlowTests` — the project has none today; real pbxproj work) whose `SyncContractTests` locate the fixtures by walking up from `#filePath` to `~/Code/PromptFlow` and taking the sibling `../PromptFlow-Tauri/crates/promptflow-core/fixtures/` (never cwd — test bundles run from DerivedData), with a clear "fixtures not found — clone PromptFlow-Tauri as a sibling" failure. Assert **value-identical outcomes after decode** (canonical re-encode comparison, not byte equality — two JSON serializers won't agree on key order). Any protocol change edits fixtures first, in one commit with both suites.

### 7.3 Standing regression suites

`npm test`, `npx tsc --noEmit`, `cd src-tauri && cargo test`, `cargo test` at the workspace root (core + server), Swift build + tests, and `scripts/qa.mjs` must all stay green at every phase gate; the sync feature adds no UI animation surface, so qa.mjs changes should be zero — treat any needed change there as a smell.

## 8. Secrets inventory (nothing in git, ever)

- Tunnel connector token: transient (Phase 0 step 5), discard after install.
- Access service token (Client ID + Secret): mini keeps only the expected Client ID (config, for `common_name` pinning — the ID is in this doc's Phase 0 status; it is not secret); Mac client Keychain; iPad Keychain; recorded once by Ryan in his password manager **[RYAN]**. Expires in 1 year — rotation is a 10-minute runbook (new token in dash → update two Keychains). **The Secret is pre-staged in the login Keychain on Ryan's MacBook** under service name `pf-sync-access-client-secret` (account = login user): read it with `security find-generic-password -s pf-sync-access-client-secret -w` for the Phase 2 gate curls and the Phase 3 client wiring — never copy it into the repo, the plan, or a commit; the first read in a session may pop a Keychain permission dialog for Ryan to approve.
- App bearer token: generated Phase 2; lives in `~/PromptFlow-Sync/config.toml` (0600) on the mini + both device Keychains + Ryan's password manager **[RYAN]**.
- `.gitignore` additions: none needed if discipline holds (config lives outside both repos); still add `**/sync-secrets*` defensively.

## 9. Decision register (settled — flag before deviating)

| Decision | Choice |
|---|---|
| Front door | Cloudflare Named Tunnel, `pf-sync.ryan-div.com`, one URL everywhere; no LAN path |
| Hub | Rust axum + rusqlite on the mini, loopback :9273, canonical replica + oplog |
| Merge | Per-node LWW, two clocks (content/structure), deterministic repairs, tombstones forever (v1); **ties are hub-authoritative and rejected/partial pushes return the winning node (`current`) for immediate repair** |
| Wire | Dedicated `WireNode` (NodeRec minus `isCollapsed`, plus `structureUpdatedAt`), camelCase, ms-epoch; `.outline` format untouched |
| Sync cycle | Both clients: pull → apply → push, serial, cursor advanced atomically with applies |
| Tauri transport | `ureq` blocking in a `std::thread`; poll 30 s + 2 s debounce; no network I/O under the store mutex |
| iPad v1 | Full-state push + explicit delete journal; destructive bootstrap (journal-bypassed wipe), hard-gated; foreground sync + background-task flush |
| Undo policy | Remote applies non-undoable; conflicting entries dropped; undo/redo restamps clocks (Swift via UndoManager will/did notifications + diff) |
| Auto-archive & import | Their deletes/replacements sync as ordinary ops; 428 tripwire has an explicit confirm-once affordance in both clients, never automatic |
| Auth | CF Access service token + origin JWT verification + app bearer; plaintext-at-Cloudflare accepted by Ryan |
| Deploy | Build on dev Mac, scp-to-temp + mv + kickstart; LaunchAgent + auto-login (cloudflared is a LaunchDaemon); newsyslog rotation; nightly `VACUUM INTO` backups |
| Out of scope v1 | CRDTs, E2E encryption, WS push, compaction, iPhone target, Forge hostname |

## 10. Implementation status and handover (2026-08-11)

### 10.1 What was built

| Phase | State | Where it lives |
|---|---|---|
| 0 — Cloudflare front door | **done** (2026-08-11, pre-existing) | Access app `pf-sync`, tunnel `promptflow-sync` |
| 1 — `promptflow-core`, two clocks, stamping | **done** | `crates/promptflow-core/`, `src-tauri/src/{model,persist,store}.rs`, `PromptFlow/Model/` |
| 2 — the hub | **done** | `crates/pf-sync-server/`, `deploy/`, `scripts/sync-deploy.sh` |
| 3 — Tauri client | **done** | `src-tauri/src/sync.rs`, the `outbox` table, `src/state/sync.ts`, the Settings panel |
| 4 — iPad: CloudKit out, client in | **done** | `PromptFlow/Sync/`, `PromptFlowTests/` |
| 5 — cutover + docs | **done** except the [RYAN] steps | `scripts/sync-status.sh`, both `CLAUDE.md`s |

Test coverage, all green:

- `cargo test` (workspace): **23** in `promptflow-core` (merge, splice, the three fixture files), **26** in `pf-sync-server` (the T1–T18 matrix against the real router, plus auth, the 410 path, snapshot atomicity, orphan repair and the reserved device id).
- `cargo test --manifest-path src-tauri/Cargo.toml`: **42** unit + **6** end-to-end, the latter driving two real `Store`s against the real `promptflow-sync` binary over real HTTP.
- `npm test` 97, `npx tsc --noEmit` clean, `scripts/qa.mjs` green with **zero** changes — as §7.3 predicted, sync adds no animation surface.
- `xcodebuild test` in `../PromptFlow`: **23**, including the 32 shared merge vectors. iOS and macOS both build clean.

The suites are non-vacuous: inverting the hub's tie policy by one character fails 6 tests across two crates.

### 10.2 Deviations from this document, and why

1. **`merge_delete` takes the tie policy** (§3.4 said strict `>` on both sides). The stated reasoning — "the oplog only carries deletes the hub already applied, so a client tie is unreachable" — is false for CASCADE tombstones: the hub mints those itself, stamping every live descendant with the PARENT's `deletedAt`, clocks it never compared against those children. A child edited in that exact millisecond ended up dead on the hub and alive on every device permanently, with nothing able to correct it. Found by the Phase 3 end-to-end test; pinned by two new fixture vectors.
2. **`apply_remote` reads the outbox's pending deletes as local tombstones.** §Phase 3 step (3) asked for this ("including rows still pending in the outbox") and the first implementation missed it. Every cycle pulls before it pushes, so the hub sends a just-deleted subtree straight back; the rows reappeared in the outline and stayed until a later cycle brought the tombstones round — at a 30 s poll, half a minute of a deletion visibly undoing itself. Same fix on the iPad, via the `DeletedNode` journal.
3. **The hub's `nodes` table materializes `position`** as well as `parent` (§4's schema listed only `parent`). A repair needs `max(root positions)`, and reading it back out of the JSON payload on every orphan is both slower and dependent on SQLite's JSON1 being compiled in.
4. **`/v1/changes` applies its LIMIT to the raw sequence range**, before the caller's own ops are filtered out, so the returned `latestSeq` always names a sequence the caller has definitely considered. Filtering first would let a long run of the caller's own ops produce an empty page whose cursor could not safely advance past them.
5. **The iPad's splice adjuster derives its splice from the before/after STRINGS**, not from `shouldChangeTextIn` (§Phase 4 suggested the latter). Recon found that two of the four editor surfaces have no such delegate method at all, and that on the two that do, the wrap/unwrap gesture deliberately vetoes the delegate change and edits the text storage directly — so a range taken from there would miss exactly the edits most likely to move a run. The commit points always hold both strings, and the same code then handles IME and the two-splice wrap gesture for free.
6. **`SyncState`/`DeletedNode` join `NodeSchemaV1.models`** rather than getting a V2. `NodeMigration.swift`'s checksum warning is about a second `VersionedSchema` describing the same shape; a whole new entity is additive in exactly the sense a new column is.

**A six-lens adversarial review after Phase 5 found eight more, all now fixed and mutation-tested** (revert the fix, the test fails). Three were severe enough to be worth naming here, because each would have hit on the very first sync or the first bad day:

- **Nothing ordered ops parent-before-child.** Tree validation repairs a node whose parent it cannot find by moving it to the ROOT, and every batch order is arbitrary with respect to the tree — the outbox sorts by `(queued_at, node_id)` and a first-configuration seed stamps ONE `queued_at` on every row, so it degenerates to uuid order. The repair does not move the structure clock, so the sender adopts the flattening back through `current`. Half a nested outline at the top level, non-undoably, on step B below.
- **A cascade tombstoned children without weighing them**, stamping the parent's `deletedAt` onto clocks it never compared against — so a child edited after the delete was made ended up dead on the hub and alive on every device under a parent that no longer exists: invisible in the outline and unreachable by any later op.
- **A cycle rejection returned the STORED structure clock**, strictly older than the move being rejected, so the losing device could never adopt it. T13 passed anyway because it asserted only acyclicity — which is not the same as converged.

The rest: toggling sync off and on stranded everything written in between; a cycle that pulled then failed to push discarded the deltas it had already committed; a `410` re-bootstrap could only ADD; a `clockSkew` rejection cleared its outbox row despite carrying no `current`; and five on the iPad (the bootstrap gate ran after the pull, the journal clear was keyed on every id in a full-state push, the undo restamp §3.5 required was missing, the engine re-triggered itself every 3 s forever, and the merge's tree lookup was a stale value snapshot).

Two open questions in the recon were answered by choosing, not by discovering: the iPad's seed gates are re-gated on `SyncState.isConfigured` rather than made unconditional (an empty store with a hub behind it is a device waiting to be filled, not a first launch), and `insertExported` keeps restoring the file's `updatedAt` while minting fresh uuids — an imported node is new to the hub either way, so its content age is the more useful fact.

### 10.3 What is left, all [RYAN]

**A. Deploy the hub** (~10 minutes, needs one sudo):

```sh
scripts/sync-deploy.sh --install      # builds here, ships the binary, writes config, bootstraps the agents
```

It prints the generated bearer token ONCE. Put it in three places — this Mac's login Keychain (`security add-generic-password -U -s pf-sync-bearer -a "$USER" -w '<token>'`), your password manager, and later the iPad's settings screen — then clear the scrollback. Two follow-ups it will remind you about: the `newsyslog` rule (one `sudo install`, ideally in the same session as the cloudflared install), and the Access `iss` claim, which Phase 0 never recorded. For the second: make one authenticated request, then

```sh
ssh server "grep 'NOT pinned' /opt/homebrew/var/log/promptflow-sync.log"
```

put that `https://<team>.cloudflareaccess.com` value into `~/PromptFlow-Sync/config.toml` as `access_team_domain`, and re-run `scripts/sync-deploy.sh`. **Do not consider Phase 2 gated until `iss` is pinned** — until then the hub verifies signature, `aud` and `common_name` but accepts any issuer.

Then `scripts/sync-status.sh` should print a healthy hub. It asks through the tunnel, so a green answer proves DNS, the Cloudflare edge, Access, the connector, the LaunchAgent and the database all at once.

**B. Point this Mac at it.** Settings ▸ Sync: server `https://pf-sync.ryan-div.com`, Access client ID `00e0de7f97b61a6ae9ab945972a09298.access`, the bearer, and the Access client secret (already staged in your Keychain as `pf-sync-access-client-secret`). Turn Sync on and Save. **This is the moment the hub is seeded** — the first-configuration enqueue pushes your whole outline.

Then check, in order:

1. `scripts/sync-status.sh` shows `liveNodes` equal to your node count.
2. Type something; within ~5 s "Last synced" updates and nothing is pending.
3. ⌘N a second window, edit in one, watch the other — that path is unchanged, but it is worth confirming sync did not disturb it.
4. Delete a small subtree, then check `sync-status.sh` shows the tombstones.
5. Pull the office offline (or stop the hub): the error line should say the server is not answering, and the TopBar indicator should appear after the second failure — not the first.

**C. Bootstrap the iPad.** Build and install it, open Settings ▸ Sync, enter the same three credentials, Save. It will refuse to push and offer **"Adopt server data — erases this iPad's outline"**; that is correct and deliberate — the iPad's copy is stale by your own account. Confirm it. Then the on-device checklist from §Phase 4's gate:

- the adopt brings across the Mac's outline, ids and all;
- edit on the iPad → appears on the Mac within ~35 s;
- edit on the Mac → appears on the iPad when you foreground it;
- edit both while the iPad is in airplane mode, then reconnect — the later edit wins on both;
- delete on the iPad → the node dies on the Mac;
- force-quit mid-sync, relaunch — nothing is lost or duplicated;
- put a wrong bearer in and confirm the error says to check the credentials rather than something generic.

**D. Watch it for a week.** `scripts/sync-status.sh` shows `perDevice` last-push and last-pull. Two things to observe rather than fix: whether the focus pane's ordering feels different on the iPad (it now orders by last EDIT, since typing finally stamps the content clock — it used to order by last structural change), and §3.5's accepted semantics that a remote change to the node you are actively typing in loses to your next keystroke.
