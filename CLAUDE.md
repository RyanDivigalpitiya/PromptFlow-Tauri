# CLAUDE.md

Guidance for AI agents working in this repo. (User-facing docs are in `README.md`.)

## What this is

PromptFlow-Tauri — the **Tauri v2 + React port** of the SwiftUI/SwiftData outliner at
`../PromptFlow` (Workflowy-style infinite nesting + prompt drafting, dark "liquid glass").
A **Rust store** is the single source of truth; every window is a full peer synced by
delta events — built for many nodes (verified smooth at ~11k) and many windows (4+
verified). Deliberately NOT ported: CloudKit/iCloud sync, the Apple-Intelligence
"Improve prompt" action, and the iPadOS target — do not reintroduce them. When porting
further behavior, `../PromptFlow/CLAUDE.md` is the authoritative spec of the original's
semantics; this file documents where this port matches it and where it deliberately
diverges.

## Build / run / verify (CLI — no IDE needed)

```sh
npm install                  # once
scripts/dev.sh [store.sqlite]  # tauri dev against an ISOLATED store (default /tmp/promptflow-tauri-dev.sqlite)
scripts/build.sh             # release bundle -> src-tauri/target/release/bundle/macos/PromptFlow.app
scripts/verify.sh            # launch smoke test of the release build (throwaway store, polls for a window)
npm test                     # vitest: 4 suites / 24 tests (resolveKey, wrap, bold, projectDrop)
cd src-tauri && cargo test   # 10 tests (store mutations/undo, archive round-trip + collect)
npx tsc --noEmit             # typecheck (strict; noUnusedLocals/Parameters)
```

- **Env vars** (read in `src-tauri/src/lib.rs`): `PROMPTFLOW_STORE` overrides the SQLite
  path (absolute used as-is; bare leaf joins app-data dir; default
  `app_data_dir()/promptflow.sqlite` = `~/Library/Application Support/com.ryandiv.promptflow-tauri/`).
  `PROMPTFLOW_NO_SEED=1` skips the welcome seed on an empty store. **Never point a dev
  run at the real store** — `scripts/dev.sh` isolates by default.
- **⌘⌃⇧7** in-app (dev hook in `App.tsx`) seeds `seed_demo(40, 25, 10)` ≈ 11k nodes for
  perf work. The flatten logs `flatten: N rows in Xms` to the dev terminal when it
  exceeds 8ms — treat any such log as a regression signal.
- **Frontend diagnostics reach the dev terminal**: the `error`/`unhandledrejection`
  window listeners (in `main.tsx`) and `dbg()` (in `controller.ts`) invoke the `log_msg`
  command, printed as `[js:<window label>] …`. A webview has no visible console — grep
  the tauri dev log.
- **UI driving** (`scripts/*.swift`, CGEvent-based): `clickwin.swift dx dy`,
  `dragwin.swift x1 y1 x2 y2 [steps]`, `scroll.swift dx dy delta reps`, `shot.sh out.png
  [needle]` (window screenshot), `winids.swift [needle]` (all windows + origins). All
  match windows by owner name, defaulting to `promptflow-tauri` — clickwin/dragwin/scroll
  override via env `PF_NEEDLE`; shot.sh and winids.swift take the needle as an argument
  instead. **The user's REAL SwiftUI PromptFlow app is often running with owner
  "PromptFlow"; never loosen the needle** or you will click into their daily driver.
  `PF_SHIFT=1` shift-clicks. **GOTCHA: synthetic modifier events can LATCH the HID shift
  state** (every later click acts shift-modified, keystrokes misroute) — if interactions
  go weird, run `scripts/clearmods.swift` and re-check `CGEventSource.flagsState`.

## Architecture (store → delta → mirror; keep this shape)

```
window "main" ── React + zustand mirror ──┐            ┌── window "w1" (⌘N peer) …
        invoke (commands) │  ▲ "store://delta" events  │
┌─────────────────────────▼──┴─────────────────────────▼───┐
│ Rust store (src-tauri/src/store.rs) — single source of   │
│ truth: in-memory tree + SQLite (WAL) + global undo       │
└──────────────────────────────────────────────────────────┘
```

- **Rust store** (`store.rs`): tree = `HashMap<Uuid, NodeRec>` + sibling index
  `HashMap<Option<Uuid>, Vec<Uuid>>` sorted by `(position, uuid-bytes)` — the same
  deterministic order the frontend mirrors. Gapped positions (`GAP = 1024`, midpoint
  insert, renumber only on gap exhaustion). Every mutation is one transaction:
  `begin() → edit()/insert_new()/delete_subtree() → commit()` — commit diffs
  before/after images, persists via ONE SQLite transaction (`persist::apply`), pushes an
  undo entry, clears redo, bumps `rev` by exactly 1, and yields the broadcast delta.
  **All writes go through `put()`/`drop_node()`** so the sibling index can never drift;
  never mutate `nodes` directly.
- **Undo** is global (one history for all windows, like the original's single
  `NSUndoManager`): state-image entries (`before`/`after` per touched node), cap 500,
  text/note coalescing 2000ms via `CoalesceKey::Text/Note` so a typing burst is one ⌘Z.
  ⌘Z/⇧⌘Z are CUSTOM menu items (`pf-undo`/`pf-redo`) routed to the store — NOT the
  predefined roles (those would trigger the textarea's native undo). **Non-undoable by
  design** (each calls `clear_history()`): the first-launch seed, `replace_all` (import),
  `delete_archived` (Clear Completed + auto-archive) — mirrors the SwiftUI app's
  detached-undo rules; don't "fix" them into undo.
- **Delta protocol**: every mutation broadcasts `store://delta` to EVERY window (caller
  included) — `{rev, origin, ops: [{type:"upsert",node}|{type:"delete",id}], canUndo,
  canRedo}`. `origin` = the mutating window's label (or `undo`/`redo`/`auto-archive`).
  Empty-ops deltas are never emitted. Per-gesture hints that must NOT sync (focus target,
  parents to expand) return only to the caller as `MutationOut {newNode, expand, moved}` —
  collapse is per-window, so an `expand` hint applied globally would be a bug.
- **Mirror** (`src/state/mirror.ts`): module-level Maps + two-grain React subscriptions —
  per-node (`subscribeNode`; a text keystroke re-renders exactly one row) and a structure
  version (`subscribeStructure`; the flatten recomputes only on shape changes). An upsert
  is "structural" when it inserts, reparents/repositions, or flips `isCompleted` (hide-
  completed visibility + parent wedges) or `isHighlighted` (the ancestor-breadcrumb walk);
  deletes always are. Parent ids are bumped too (chevron/ring). **Rev-gap ⇒ full snapshot
  resync** (`delta.rev !== rev+1 → reload()`); stale echoes (`rev <= current`) are
  dropped. A window can never silently drift — preserve that invariant.
- **Per-window view state** (`src/state/windowState.ts` — the original's
  `CollapseState`/`NavigationModel`/`OutlineFocus` split): collapsed set, drill +
  back/forward, focus (id/field/caretIntent/focusEpoch), fontSize, hideCompleted,
  keepVisible grace set, focusPaneExpanded. Only the subset `{collapsed, hideCompleted,
  fontSize, drill, focusPaneExpanded}` persists (250ms debounce) to localStorage
  `pf.win.<label>` — focus, back/forward history, and keepVisible are session-only, and
  a new field does NOT persist unless added to `PersistedShape`. The same payload also
  writes `pf.lastWindowState`, the DEVICE seed a fresh ⌘N window inherits. Other
  device-local keys: `pf.appearance` (settings), `pf.focusOrder` (focus-pane order). The
  backend `settings` table holds only `autoArchive` — backend-stored because the sweep
  runs in Rust at launch with no frontend involvement (deferred ~4s so windows load
  first; they then receive its `auto-archive` delta).
- **One live editor** (`RowEditor.tsx`): unfocused rows are static spans (bold runs,
  strikethrough `#06FF9A`, highlight); ONLY the focused row mounts a textarea (grid
  grow-wrap auto-size). This is the port of AppKit's first-responder economy and what
  keeps 10k+ rows cheap — do not make rows permanently editable. **Echo guard**
  (`pendingSent`): every `set_text` pushes the sent text; a delta whose `rec.text`
  matches an in-flight entry is an acknowledged echo (skipped); a remote edit adopts
  only when nothing is in flight. Without this, in-flight keystroke echoes clobber the
  textarea mid-burst.
- **Virtualized outline** (`OutlineView.tsx`, TanStack Virtual): flatten → one
  virtualizer, `getItemKey` = row id, dynamic heights via `measureElement`.
  **`paddingStart: OutlineLayout.documentVInset`, never CSS padding-top** on the
  container — absolute rows position from the padding-box edge, so CSS padding shifts
  nothing and desynchronizes hit-testing (this bug shipped once; the fix is the
  virtualizer option).
- **Drag** (`drag.ts` + `dragGesture.ts`): `projectDrop` is the pure port of the Swift
  projection (gap by `midY <= pointerY`, depth band `[minDepth, prev.depth+1]`, divider
  can't parent, drill floor 1). Frames come from `virtualizer.measurementsCache`
  published via `publishDragEnv` — content space (y includes scrollTop), scroll-invariant.
  Glyph mousedown is a state machine: still click = drill (bullet/prompt) or toggle
  (checkbox); >4px = drag; dragging a selection member drags the whole block.
- **Selection** (`selection.ts`): contiguous sibling range (anchor→head resolved to one
  level), tint = members + descendants. Keys while active run in `handleSelectionKey`
  (CAPTURE-phase window listener) since nothing is focused then. `refresh()` re-resolves
  on every structural change (wired in `App.tsx`).
- **Export/import/archive** (`archive.rs`): the JSON is the SwiftUI app's EXACT
  `promptflow.outline` format (nested children, ISO-8601 UTC seconds, camelCase field
  names, kind raw strings) — outlines migrate in both directions; keep it byte-compatible.
  Import creates FRESH ids (file ids could collide with live nodes) and is not undoable.
  `collect()` takes whole completed units only (never slices a partial subtree; descends
  through incomplete nodes); un-stamped legacy completions are manual-only. Archives are
  backup-FIRST (write succeeds, then delete) into `<store dir>/Archive`.

## Conventions & gotchas

- **Keyboard handling is split three ways — check all three before adding a shortcut**:
  (1) `RowEditor.onKeyDown` (focused editing: `resolveKey` routing, ⌘B/⌘1-3/⌘⇧F/⌘⇧N,
  ⌥arrows, wrap-selection, Escape); (2) `App.tsx` window handler (⌘⌥F, ⌘=/−/0, ⌘[/],
  ⌘⇧D/E, ⌘Z fallback, ⌘⌃⇧7); (3) `handleSelectionKey` capture-phase (block ops while a
  node selection is live). Plus native menu accelerators (⌘N/⌘Z/⇧⌘Z + clipboard roles —
  the predefined cut/copy/paste/select_all items are REQUIRED; a macOS webview gets no
  ⌘C/⌘V without them).
- **`resolveKey` (`lib/keys.ts`) is the pure keyboard truth table** (same semantics as
  the Swift original: bullet/checkbox Enter=new node, ⇧Enter=newline; prompt Enter AND
  ⇧Enter=newline — a prompt's "new node" is ⌥Enter, not ⇧Enter; ⌘Enter completes any
  kind; boundary-line arrows cross nodes). It's pinned by `keys.test.ts` — change
  semantics there first, then the handler.
- **Stateful modules decline HMR** — every module in `src/state/` (tests excepted) ends
  with `import.meta.hot.accept(() => import.meta.hot?.invalidate())`. A hot swap of a module
  holding module-level state (the mirror's Maps, controller's rows) strands components
  on a fresh EMPTY instance — measured failure: blank outline until reload. Keep the
  footer on any new stateful module; force a full reload by touching `src/main.tsx`.
- **Capabilities must stay `"windows": ["*"]`** (`src-tauri/capabilities/default.json`).
  Tauri permissions are per-window; the template's `["main"]` made every invoke from a
  ⌘N-spawned `w*` window fail silently — blank second window.
- **Programmatic focus needs `e.preventDefault()` on mousedown** (static row, glyphs,
  buttons): the mousedown default action steals focus to body AFTER handlers run,
  blurring the textarea the click just focused.
- **Column math**: `OutlineLayout` (`lib/layout.ts`) matches the Swift constants exactly
  (indent 22, hInset 18, glyph slot 18·s, gap 6; `guideX(level) = glyphCenterX(level−1)`).
  The ONE deliberate divergence: `lineHeight = fontSize × 1.35`, locked to CSS
  `--row-line-height: 1.35` — change both or neither. Indent guides anchor on the ROW
  element at `documentHInset + guideX(level)` (inside the indent gutter); drop-marker x
  comes from `bulletCenterInset` (sibling) / `contentLeadingInset` (first child).
- **Row interaction map** (matches the original): click bullet/prompt-line = drill;
  click checkbox = toggle complete; drag any glyph = reorder; chevron = per-window
  collapse; trailing ⋯ = Zoom In / Copy / Delete (delete confirms at ≥10 descendants);
  completing the LAST sibling via ⌘Enter spawns a fresh sibling (never for the drill
  root); an abandoned empty node is pruned on defocus (`exemptPruneOnce` protects
  Enter-at-line-start splits); dividers (`line`) never drill, never parent, never
  propagate their kind, and ⌘1/2/3 never convert them.
- **Bold runs**: flat `[location, length, …]` pairs; the editor adjusts them through
  every text change via `adjustRangesForEdit` (single-splice diff) and sends them WITH
  each `set_text` — dropping that coupling silently loses bold under concurrent edits.
- **The mutation surface is the Rust commands** (36 registered in `lib.rs`; typed
  wrappers in `src/lib/api.ts`). Never mutate the mirror locally — apply state only from
  deltas. New mutations follow the pattern: store method → command → `emit_delta` →
  `MutationOut` hints for the caller.
- After UI-affecting changes, verify in the running app (scripts above + screenshots),
  and re-run `npm test` + `cargo test`; both suites are fast.

## Git

Default branch `main`, remote `git@github.com:RyanDivigalpitiya/PromptFlow-Tauri.git`;
per-phase commits, pushed to origin. End commit messages with the `Co-Authored-By`
trailer.
