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
  `PF_SHIFT=1` shift-clicks. The needle only matches the DEV binary: a release/installed
  bundle's window owner is "PromptFlow" (productName), indistinguishable from the SwiftUI
  app — that's why `verify.sh` matches by its child PID instead, and why release builds
  can't be driven with these scripts. **GOTCHA: synthetic modifier events can LATCH the HID shift
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
- **One live editor** (`RowEditor.tsx`): unfocused rows are static spans; ONLY the
  focused row becomes a CONTROLLED contenteditable div (the textarea died with the
  rich-text upgrade — bold/italic/underline must render while editing). Invariants:
  (1) the editor's children are IMPERATIVE (`buildRunDom`) and the two branches carry
  distinct React keys ("editor"/"static") — without them React appends the static
  span beside the leftover editor spans (shipped bug, fixed); (2) every input is
  serialized (`serializeEditor`: text nodes + `<br>`=\n, sentinel `<br
  data-pf-sentinel>` = zero-width) then re-rendered from the model with the caret
  restored (`selectionOffsets`/`setSelectionOffsets`); the sentinel is appended when
  text ends in \n so the trailing line has a line box; (3) ⌘B/I/U ALWAYS
  preventDefault (the browser's own rich-text engine must never touch the DOM), and
  paste/copy/cut are intercepted (plain text in, RAW text out; ⇧⌘C = markdown);
  (4) style refs seed in a LAYOUT effect declared before the run-DOM builder (a
  passive effect painted one frame unstyled); (5) IME: onKeyDown bails while
  composing (Enter commits the candidate, never splits). **Echo guard**
  (`pendingSent`): every `set_text` pushes the sent text; the adoption effect keys on
  the REC OBJECT (not `rec.text`) so style-only deltas (remote ⌘B, store ⌘Z of a
  style toggle) drain their echo and adopt — keying on text alone made the next
  keystroke silently clobber remote/undone styles (shipped bug, fixed).
- **Virtualized outline** (`OutlineView.tsx`, TanStack Virtual): flatten → one
  virtualizer, `getItemKey` = row id, dynamic heights via `measureElement`.
  **`paddingStart: OutlineLayout.documentVInset`, never CSS padding-top** on the
  container — absolute rows position from the padding-box edge, so CSS padding shifts
  nothing and desynchronizes hit-testing (this bug shipped once; the fix is the
  virtualizer option).
- **Expand/collapse animation** (`collapseAnim.ts`; CSS `.rows-animating` /
  `.node-row.entering` / `.collapse-ghosts`): every MANUAL disclosure gesture (chevron,
  ⌘E/⌘D, ⌘⇧E/⌘⇧D, ⌘↑/⌘↓) routes through the controller wrappers
  `toggleCollapse`/`setCollapsed`/`setCollapsedAll` → `runCollapseAnim`, never
  `useWindowState.*Collapse*` directly (raw calls skip the animation). The one
  deliberate exception is `revealNode`'s `expandMany` (a focus-pane navigation jump,
  not a manual disclosure) — it stays un-animated, like the SwiftUI original.
  **A SINGLE-NODE toggle plays the DRAWER**; only bulk ⌘⇧E/⌘⇧D fall back to the older
  fade + `.collapse-ghosts` dissolve (they have no single parent to hang a drawer off).
  The drawer is three raw-DOM layers appended to `.outline-inner` (React never sees
  them), built by `buildDrawer`: `.drawer-clip` (static, pinned at the parent's bottom
  edge B, `overflow:hidden`) ▸ `.drawer-sweep` (`overflow:hidden`, height H,
  `translateY(-H)→0`) ▸ `.drawer-content` (`translateY(H−CAP)→0` + opacity 0→1) holding
  `.vrow` clones positioned block-local. **The reveal edge is a CLIP boundary, not a
  content boundary** — that's the whole trick: the two clips intersect to exactly
  `[B, B+H·f]`, which is where the rows below now start, so drawer and below-content
  TILE EXACTLY at every instant for any easing. H is correctness; CAP
  (`DRAWER_PULL_PX`) is pure taste. **Do NOT "fix" CAP up to H**: a literal rigid
  drawer is geometrically forced to reveal the subtree BOTTOM-first (the band shows
  block-local `[H(1−f), H]`), needs rows the virtualizer never rendered, and at
  H≈1200px/190ms moves ~100px/frame (strobes). Movement and fade share ONE
  duration+curve — decoupling the fade's timing was tried and reads as jarring.
  Other GPU-composited parts, no per-frame React: (1) below-rows slide via
  a `transition: transform` GATED to a transient `.rows-animating` class on
  `.outline-inner` — an always-on transition makes plain SCROLLING lag (the virtualizer
  repositions every `.vrow` on each scroll tick), so `onWheel` calls `endAnimNow()` to
  bail mid-flight; (2) entering rows (expand) are `visibility:hidden` behind the drawer
  (never `display:none` — they must keep layout boxes so the ResizeObserver still
  measures them), or fade in via a keyframe on the bulk path; `isEntering` = a fresh row
  absent from `prevIds` captured pre-toggle. **`runCollapseAnim` MUST keep its two
  separate `flushSync`es with a forced `offsetHeight` read between** — a CSS transition
  only starts if the element's previously RESOLVED style already carried it, so batching
  the `.rows-animating` class in with the new positions leaves survivors with nothing to
  animate from and they SNAP (shipped bug, fixed). The reflow transition is scoped to SURVIVORS (`:not(.entering-row)`) —
  an entering row has no old position and is placed with an ESTIMATED height until its
  ResizeObserver reports the real one, so transitioning it animated that correction and
  made a parent's FIRST expand visibly re-space its children (the size cache is empty
  only that once). `--collapse-anim-dur` in styles.css is the SINGLE source of truth for
  timing: `animDurationMs()` reads it live so the teardown always tracks it —
  `COLLAPSE_ANIM_MS` is only a fallback (a hardcoded mirror desynced the moment the CSS
  was retuned and tore the ghost overlay out mid-fade). **The webview's rAF is capped at 60Hz (WKWebView on
  macOS), but CSS `transform`/`opacity` animations are handed to Core Animation and
  composite at the display's native rate (120Hz on this ProMotion Mac) — so animate with
  CSS transitions, NEVER an rAF loop.** `perfMeter.ts` samples rAF deltas (auto-fires per
  toggle in dev, plus ⌘⌃⇧8 idle baseline) — because rAF is 60Hz-capped it measures
  MAIN-THREAD health (a steady ~16.7ms ⇒ no jank, the real cause of "choppy"), NOT the
  compositor's true fps; it can't read past 60.
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
  ⌘B/⌘I/⌘U style toggles, ⌘4 → divider (single-node only, then clearFocus — a divider
  has no editor), ⇧⌘C markdown copy, ⌥arrows, ⌘↑/⌘↓ collapse/expand the focused
  parent — childless falls through to the native caret jump, wrap-selection, Escape);
  (2) `App.tsx` window handler (⌘⌥F, ⌘=/−/0 + pinch/ctrl-wheel → `setFont`, ⌘[/],
  ⌘E/⌘D collapse/expand focused, ⌘⇧E/⌘⇧D collapse/expand ALL, ⌘Z fallback,
  ⌘⌃⇧7); (3) `handleSelectionKey` capture-phase (block ops while a node selection is
  live; its Escape yields to an open ⋯ row-menu — one layer per press). Plus native menu accelerators (⌘N/⌘Z/⇧⌘Z + clipboard roles —
  the predefined cut/copy/paste/select_all items are REQUIRED; a macOS webview gets no
  ⌘C/⌘V without them). The Window submenu is registered via
  `set_as_windows_menu_for_nsapp()` AFTER `app.set_menu(...)` — muda resolves the
  NSMenu from the INSTALLED main menu and silently no-ops if called earlier; the
  registration is what makes AppKit auto-append Fill/Center/Move & Resize/tiling/
  move-to-display and the open-window list.
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
  ⌘N-spawned `w*` window fail silently — blank second window. The list must also keep
  `core:window:allow-start-dragging`: `core:default` does NOT include it, and without it
  the title-bar drag region silently fails (the injected drag.js invoke is denied) —
  window can't be moved.
- **Chrome-less title bar is a three-part coupling — change all or none**: `.topbar`
  height 44px (styles.css) ⟷ `trafficLightPosition {x:18, y:24}` in BOTH
  `tauri.conf.json` (main window) and the ⌘N builder in `lib.rs`. On this macOS the
  traffic-light y-inset resolves to button center = y−2 from the window top (tao resizes
  the titlebar container to y+12 and the buttons keep an 8px top offset), so y=24
  centers the lights on the 44px strip's midline; derive a new y as `midline + 2` if the
  height changes. The strip is `data-tauri-drag-region="deep"` (whole subtree drags;
  `<button>`s still click). Alignment is verified by pixel-measuring screenshots, not
  eyeballing.
- **Programmatic focus needs `e.preventDefault()` on mousedown** (static row, glyphs,
  buttons): the mousedown default action steals focus to body AFTER handlers run,
  blurring the textarea the click just focused.
- **Chrome scales with ⌘+/⌘− via em units off an inline font-size** — rows set
  `fontSize` on `.node-row` (cluster/menu/prompt internals are em), the TopBar sets
  `16·clamp(scale,1,1.8)` (CAPPED: icons must never outgrow the fixed 44px strip or
  they'd break traffic-light alignment), SettingsPanel sets `13·clamp(scale,.9,2.2)`.
  New chrome CSS should be em, not px. The ⋯ menu has NO backdrop div (position:fixed
  degrades inside the transformed virtual rows) — a window-level capture
  mousedown/Escape pair closes it and SWALLOWS the dismissing press+click (macOS menu
  convention; without the swallow the click lands underneath and mutates data). The
  `.grow-wrap::after` mirror appends `\200B` (never a real space — that widened the
  editor and made the cluster jump on click-to-edit).
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
- **Style runs (bold/italic/underline)**: three flat `[location, length, …]` arrays
  (UTF-16 code units) on every node; the editor adjusts each through every text change
  via `adjustRangesForEdit` (SINGLE-splice diff — a wrap/unwrap is TWO splices, so it
  adjusts old→`mid`→final using `applyWrap().mid`) and sends all three WITH each
  `set_text`. `commit_new_node` splits the arrays at the caret (`split_ranges`) so an
  Enter split keeps styling on both halves. Export writes `italicRanges`/
  `underlineRanges` ONLY when non-empty — style-free documents stay byte-identical to
  the SwiftUI format (whose decoder ignores the extra keys on styled ones).
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
