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
npm test                     # vitest: 6 suites / 41 tests (resolveKey, wrap, bold, projectDrop, rowBands, kindMorph)
cd src-tauri && cargo test   # 12 tests (store mutations/undo, archive round-trip + collect)
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
- **Focus pane** (`FocusPane.tsx` + `focusPane.ts`): the ⌘⇧F highlight SET lives on the
  nodes (shared store, synced by delta); only the numbered `pf.focusOrder` is per-device.
  Two subscription grains, both load-bearing: (1) each `FocusRow`/`Crumb` subscribes to
  ITS node via `subscribeNode` (`useNodeRec`) so a title/breadcrumb tracks a live text
  edit — a highlight flip is structural but a keystroke is NOT, so the pane's own
  structure subscription alone left mirrored titles stale (shipped bug, fixed); (2)
  `reconcile()` runs in a `useEffect` keyed on the structure version, NEVER during render
  — a `set()` during render is dropped when the ONLY re-render is the idle structural
  delta, so a node ⌘⇧F-pinned in one window never appeared in the others' panes (shipped
  bug, fixed). Breadcrumb color is position-only: leftmost crumb `--text`, deeper crumbs
  `--text-faint`, a lone crumb white (never accent). The handle drag paints a
  `.focus-drop-marker` at the nearest row gap (content-space y = `edge − paneTop +
  scrollTop`); `move()` operates on `order`, which `reconcile` keeps equal to the rendered
  members, so the member index and the order index coincide. ⌥⇧F opens/closes it as a
  DRAWER: `.focus-pane-shell` animates `grid-template-rows: 0fr↔1fr` (the CSS-only
  auto-height trick — interpolates in WebKit, no JS height measuring), with a `min-height:0;
  overflow:hidden` clip and the pane's 40% cap + internal scroll moved onto the shell.
  The pane stays MOUNTED while collapsed (an unmount would snap it shut, and the close
  animation needs the rows on screen) — `.open` is the only thing that toggles. Its own
  clock, `--focus-pane-anim-dur`/`-ease` (a plain ease-in-out), NOT the outline drawer's
  `--collapse-anim-*` (which gets dialled past 500ms to debug). The height animation is
  main-thread, but the pane is a few rows and the outline below only recomputes its virtual
  RANGE (rows stay absolutely positioned), so it holds. The numbered disc is `1.84em` = an
  ODD 17px at base font, so its centre is a pixel, not a seam.
  DOCKING (`focusPaneLayout`, the TopBar switcher next to ★): the pane + outline share the
  `.app-body` GRID, whose `grid-template-areas` restacks — `top` stacks them (strip above
  outline), `sidebar` puts them side by side (focus left, outline pushed right). Both stay
  mounted across a switch, so the outline never remounts. In `sidebar` the shell animates
  WIDTH (a known px from `--focus-sidebar-width`, so a plain `width` transition, NOT the
  grid-rows trick — that's for auto/content sizing) between 0 and the resizable width; the
  clipped pane holds that fixed width so it doesn't reflow as the drawer slides. A dock
  switch changes the shell's size discontinuously, so a `useLayoutEffect` pins `.no-anim`
  for one frame (before paint) so the reshape doesn't animate as a morph. The right-edge
  `.focus-resize-handle` (sidebar+open only) drags the width straight onto the shell's
  var with `.resizing` suppressing the transition for a 1:1 grab, committing to
  `setFocusSidebarWidth` (clamped [180,640], persisted per window) on release. The `.resizing`
  transition-off uses `!important` — the sidebar layout rule outweighs a bare 2-class
  selector, so a plain `transition:none` lost to it and the width lagged the pointer.
  In `top`, the SAME grip sits on the BOTTOM edge and drags the strip HEIGHT
  (`focusTopHeight`): "auto" is content-fit via the grid trick (bottom edge tracks the last
  pinned row, grows with pins); dragging within ~12px of that last-row bottom SNAPS back to
  "auto" (`.snapping` lights the grip), otherwise it commits a fixed px (`.fixed-top`, a
  height drawer like the sidebar's width). Layout, width, and height live in
  `windowState`/`PersistedShape` alongside `focusPaneExpanded`.
  The top cap is `max-height: 60vh`, NOT `60%` (shipped bug, fixed): a `%` max-height
  resolves against the shell's grid AREA — the `.app-body` `auto` focus track, i.e. the
  shell's own content — so `60%` computed 0.6×content and capped the pane BELOW its content
  (auto looked "very small", fixed rendered at 0.6×its px). `vh` resolves against the
  definite viewport. The JS drag clamps to `FOCUS_TOP_MAX_FRACTION`×app-body height.
- **One live editor** (`RowEditor.tsx`): unfocused rows are static spans; ONLY the
  focused row becomes a CONTROLLED contenteditable div (the MAIN row's textarea died with
  the rich-text upgrade — bold/italic/underline must render while editing; the NOTE field
  is still a plain `<textarea>`). Invariants:
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
  composing (Enter commits the candidate, never splits); (6) macOS TEXT
  SUBSTITUTION (System Settings ▸ Keyboard ▸ Text Replacements, "->" ⇒ "→") needs
  TWO things, neither obvious. FIRST, `spellcheck` must NOT be false on either
  editing surface: in WebKit that attribute is a HARD GATE —
  `Editor::markAllMisspellingsAndBadGrammarInRanges` early-returns on
  `!isSpellCheckingEnabledFor()` BEFORE resolving which check types to run, so
  "false" kills substitution along with the squiggles (shipped bug, fixed). It costs
  no red underlines: continuous spell checking is a SEPARATE bit, read from the app's
  `WebContinuousSpellCheckingEnabled` default with a bare `boolForKey:` (absent ⇒ NO),
  and nothing sets it. SECOND, the run-DOM rebuild must be SKIPPED when it would
  change nothing (`domMatchesRuns` in `runs.ts`): on Cocoa `TypingCommand` dispatches
  `input` SYNCHRONOUSLY and runs `markMisspellingsAfterTyping` AFTER it, so a
  `replaceChildren` in our handler hands the substitution pass a DETACHED subtree and
  it silently does nothing — fixing only the attribute changes nothing observable.
  Same reason the caret restore is skipped when the selection is already correct: a
  redundant `removeAllRanges`/`addRange` fires `selectionchange` and unseats the
  pass. `domMatchesRuns` is deliberately STRICT (spans only, text nodes only, no
  extra attributes) — a false positive strands the editor on stray browser DOM,
  the exact failure the controlled-editor invariant exists to prevent. Smart
  quotes/dashes ride the SAME gate and default ON, which would corrupt prompt text,
  so they are pinned off in `macos_defaults.rs` (`registerDefaults:`, so it never
  writes the user's prefs to disk) — registered BEFORE `tauri::Builder`, because
  WebKit latches its TextChecker state once in the WebProcessPool constructor and
  tauri builds the windows before `.setup()` runs. `WebAutomaticTextReplacement-
  Enabled` is deliberately left UNSET so it inherits the user's System Settings
  choice. NOT verifiable headlessly: `WebEditorClient::isAutomaticTextReplacement-
  Enabled` returns false under `isControlledByAutomation()`, so Playwright can never
  reproduce this — it is a manual check. **Echo guard**
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
  **A SINGLE-NODE toggle plays the DRAWER**; bulk ⌘⇧E/⌘⇧D pass NO roots (there's no
  single parent to hang a drawer off), so they get only the gated reflow slide plus, on
  expand, the `.node-row.entering` fade — never ghosts (`captureGhosts` returns early on
  empty roots). `.collapse-ghosts` has TWO owners: the single-node COLLAPSE fallback for
  when `buildDrawer` returns false, and the enter/leave path below, which clones every
  leaving row into it.
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
  absent from `prevOrder` captured pre-toggle. **`runCollapseAnim` MUST keep its two
  separate `flushSync`es with a forced `offsetHeight` read between** — a transition needs
  its FROM value resolved as a SEPARATE style change, on an element already mounted at its
  old position, so batching the `.rows-animating` class in with the new positions leaves
  survivors with nothing to animate from and they SNAP (shipped bug, fixed). **NOTE the
  rule is NOT "a transition only starts if the previously resolved style already carried
  it"** — this file said that for a while and it is false: a transition takes its property
  and duration from the AFTER-change style, which is exactly why `startDrawer` can add
  `.drawer-anim` and the new transform together. Designing on the wrong version produced a
  Tab glide with literally 0px of travel (see the tab-glide entry). **The real rule also
  caps the animation at the VIRTUALIZER's window**, so `OutlineView`'s `rangeExtractor`
  unions the natural range with `mountBand()` — the ~one screenful of rows immediately
  after the toggled block — for the toggle's duration. `overscan` (14) alone reaches only ~14 rows past the
  viewport, so any taller subtree left the rows that must glide un-rendered at commit 1:
  on collapse they were created fresh in commit 2 wearing only their FINAL transform and
  snapped from a seam downward, and on expand they were UNMOUNTED instead, leaving a blank
  strip under the sweeping edge (one cause, two symptoms; shipped bug, fixed). The band is
  anchored to the block END, so it re-derives itself in whichever index space it's called
  in and costs nothing when the block is absent; it is bounded by the viewport, NOT by H —
  because the anchor's own y is already displaced by H. (The enter/leave paths anchor
  differently and have to earn that property another way; see their entry.)
  Its `useCallback` identity must change on the anim bump — at commit 1 `count` and the
  range are unchanged, so a stable identity gets memoized away and mounts nothing. Never
  extend the band ABOVE the natural window: virtual-core issues a real `scrollTo` the
  first time it measures a never-sized row starting above the scroll offset. Raising
  `overscan` globally is NOT the fix — it pays the mount cost on every scroll tick.
  The reflow transition is scoped to SURVIVORS (`:not(.entering-row)`) —
  an entering row has no old position and is placed with an ESTIMATED height until its
  ResizeObserver reports the real one, so transitioning it animated that correction and
  made a parent's FIRST expand visibly re-space its children (the size cache is empty
  only that once). **All timing lives in styles.css `:root`, never in JS**:
  `--collapse-anim-dur`/`-ease` is the shared clock, with four deliberate exceptions —
  `--reorder-anim-dur` (⌥↑/↓), `--wedge-anim-dur` (the progress pie), `--kind-anim-dur`
  (the glyph kind morph) and `--enter-fade-ease` (an entering row's opacity only).
  `animDurationMs()` reads the LIVE
  value for whichever is running so the teardown always tracks it; `COLLAPSE_ANIM_MS` is
  only a fallback (a hardcoded mirror desynced the moment the CSS was retuned and tore the
  ghost overlay out mid-fade). Each exception documents why it isn't the shared clock —
  don't "unify" them: the collapse var is routinely dialled past 500ms to eyeball a frame,
  which would drag every other animation into slow motion with it. **The webview's rAF is capped at 60Hz (WKWebView on
  macOS), but CSS `transform`/`opacity` animations are handed to Core Animation and
  composite at the display's native rate (120Hz on this ProMotion Mac) — so animate with
  CSS transitions, NEVER an rAF loop.** `perfMeter.ts` samples rAF deltas (auto-fires per
  toggle in dev, plus ⌘⌃⇧8 idle baseline) — because rAF is 60Hz-capped it measures
  MAIN-THREAD health (a steady ~16.7ms ⇒ no jank, the real cause of "choppy"), NOT the
  compositor's true fps; it can't read past 60.
- **Row enter / leave / reorder** (`runRowsAnim` in `collapseAnim.ts` + `lib/rowBands.ts`):
  creation, deletion, the hide-completed toggle, the just-completed grace expiry and
  ⌥↑/↓ all route through ONE entry point that adds **no new visual primitive** — it fires
  the bulk ⌘⇧E/⌘⇧D look from a FLATTEN DIFF instead of from a collapse gesture: entering
  rows get `.entering` (rowEnter), leaving rows are cloned into one `.collapse-ghosts`
  overlay, everyone else rides the `.rows-animating` reflow, which IS the row area
  opening/closing. So creation and deletion are the same two rules with the sign flipped.
  The diff runs over the FLATTEN, never the delta's ops: `add:<id>` placeholder rows are
  derived, so a first child mints TWO rows for ONE insert; a completion flip under
  hide-completed removes a whole subtree with no delete op at all; and the hide-completed
  toggle and grace expiry aren't deltas. A change that moves nothing (⌘⇧F, a completion
  flip while hide-completed is OFF) falls out as `firstChanged === -1`.
  **`drawerShowing` is always false here, deliberately**: a clip needs `visibility:hidden`
  on the real row, and in WebKit that element is not focusable — `el.focus()` silently
  no-ops and is never retried, so keystrokes into a freshly created node would be DROPPED,
  not merely delayed (every Enter lands the caret in a fresh entering row). The clip
  exists for the H≈1200px subtree case, which a creation never is.
  Two trigger kinds: DELTAS reach `mirror.ts`'s widened `setStructureCommit` seam, which
  now fires for EVERY structural delta and passes a classified `StructureChange` — so it
  must CLASSIFY before tearing anything down (an unconditional `endAnimNow()` would kill a
  live drawer on every ⌘⇧F). PER-WINDOW changes get a controller wrapper
  (`setHideCompleted`, `holdVisible`), same house rule as `toggleCollapse`: never call the
  `useWindowState` setter directly or it snaps. **The just-completed grace timer lives in
  the controller, not the store** — as a bare `set` it had no arming commit and the row
  vanished without animating. A delete's `nodes.delete`/`nodeVersions.delete` are DEFERRED
  into `publish()` while `removeFromParent` stays eager: the flatten taken at the seam is
  then exactly post-delta, while the leaving rows keep rendering through commit 1 (with
  the record already gone they would blank out mid-animation and re-trigger the
  ResizeObserver).
  A pure REORDER (⌥↑/↓ — nothing enters, nothing leaves) is the ONE case with its own
  clock: `.rows-reorder` retimes the same reflow transition to `--reorder-anim-dur` (170ms)
  / `--reorder-anim-ease` (linear). The shared ease-in-out exists to sell a distance being
  opened or closed; over a one-row swap it reads as hesitation at both ends, and linear
  keeps the two rows' speeds matched, which is what makes a swap read as a swap.
  `animDurationMs()` keys off the same flag so the teardown tracks it.
  `mountBand` anchors on a SURVIVING row here rather
  than skipping a parent's block — and WHICH survivor is load-bearing, because the band's
  reach is measured from the anchor's old y: an ENTER anchors just before the change
  (survivors move down), a LEAVE just past the removed block, so the removed height is
  already in the anchor's y and the reach scales with it. Anchor a leave above the block
  and every survivor more than ~2 viewports down snaps. A ghost overlay is never torn down
  mid-fade either (`detachGhosts`): it owns no live rows, so it is left to finish and
  self-remove — two leaves 100ms apart is an ordinary rhythm, and yanking the first would
  pop exactly where the overlay exists to prevent a pop.
- **DOM order is frozen while animating** (`rowRank` + the sort in `OutlineView`): every
  `.vrow` is absolutely positioned by its own transform, so DOM order carries no visual
  meaning — but it carries a fatal one for animation. When a change REORDERS rows (⌥↑/↓,
  an outdent past siblings, a drag), React's reconciler sees its keyed children in a new
  order and `insertBefore`s the ones that moved backwards; **a DOM move detaches and
  re-attaches the element, which CANCELS its running transition** (measured in WebKit: the
  moved element sat at its final y for all 22 frames while its partner interpolated).
  React moves only ONE of two swapped siblings, so ⌥↓ played as half a swap — the row you
  moved snapped while the row it passed glided (shipped bug, fixed). So while an animation
  is live the rows render in the order they had when it armed; rows created since sort
  last, and appending never moves a sibling. Surviving rows keeping their relative order
  is exactly the condition under which React performs no moves at all. At teardown the
  order reverts and React does reorder, but nothing is transitioning by then. Sorting only
  while animating also keeps DOM order equal to visual order at rest.
- **Tab glide** (the bottom of `collapseAnim.ts`; CSS `.node-row.gliding` / `.glide-arm`):
  Tab/⇧Tab slides the moved row into its new indent instead of snapping. Driven from the
  DELTA, not the gesture — `mirror.ts`'s `setStructureCommit` seam hands the animation
  layer any delta that changed a node's PARENT (a position-only change — ⌥↑/↓, a
  same-level drag — reaches the same seam but takes the reorder path, never the glide) — so ⌘Z and another window's edit glide with ONE implementation, and a
  no-op Tab emits no delta and arms nothing. THREE flushSync commits: flags → new depths
  + inverted offset (transition OFF) → release. **`paddingLeft` is never animated** (each
  intermediate value re-wraps text, changes row height, and makes the ResizeObserver
  reposition the list every frame); the row is laid out at its final indent and
  TRANSLATED back. The offset is a `--pf-glide-x` custom property on `.node-row` that
  inherits to `.row-inner` — never a transform on `.node-row` itself, whose
  `.indent-guide` children are a column shared with every other row and would visibly
  bend. **`.glide-arm` (transition: none for the invert commit) is load-bearing**: a
  transition takes its property/duration from the AFTER-change style, so applying the
  offset and its transition together starts a `none→offset` transition — the row never
  paints at the old position and the release cancels it at ~0ms, i.e. a snap (verified in
  WebKit). NOTE this means the rule this file USED to state for the collapse — "a
  transition only starts if the previously RESOLVED style already carried it" — is NOT the
  real CSS rule (that entry now states the correct one);
  what a transition needs is its FROM value resolved as a separate style change. The
  collapse's two-flushSync split is still required, but for that reason. The vertical
  half is free: `.rows-animating` is armed at commit 1 and `mountBand` (anchored on the
  moved node) keeps the rows it travels past mounted.
- **Progress wedge** (`Glyphs.tsx` `Wedge`; CSS `.glyph-wedge` / `.glyph-tint`): the
  parent pie fills radially, clockwise from 12 o'clock, as children complete. Drawn as a
  STROKED circle — path radius R/2, `stroke-width` R, so the band covers radii [0,R]
  exactly, pixel-identical to the filled sector it replaced — with `pathLength=1` so the
  fraction is ONE interpolable number, `stroke-dashoffset`. The old `sectorPath` couldn't
  animate: its segment list changed shape across the fraction and the large-arc flag
  flipped at ½ (and React writes `d` as an attribute, where a CSS transition never
  reaches it). Driven by the fraction VALUE, never a "just changed" flag, so it covers
  remote windows / ⌘Z / block toggles / auto-archive — and because a transition needs a
  resolved previous value it can never self-start on mount, so a wedge scrolling back
  into view paints at its true fraction. Keep `Wedge` a COMPONENT: in the checkbox branch
  it alternates with the check mark at the same child index, and React never reconciles a
  component element with a host one. Timing is `--wedge-anim-dur` (320ms ease-out),
  deliberately NOT `--collapse-anim-dur` — that one gets dialled past 500ms to debug the
  drawer. Unlike everything else here it is a main-thread repaint (WebKit composites only
  transform/opacity/filter), which at 14×14px is free.
- **Glyph kind morph** (`lib/kindMorph.ts` truth table + `useKindMorph`/`Glyph` in
  `Glyphs.tsx`; CSS `.glyph-layer` / `.glyph-prompt-ghost`): ⌘1/⌘2/⌘3 cross-animate TWO
  layers over the glyph slot — bullet↔checkbox collapse/grow to a point at their shared
  centre (`morph-scale`), to/from a prompt cross-fade in place (`morph-fade`, because a
  full-height bar can't scale into a dot). Anything involving a DIVIDER still snaps: no
  design yet, not an impossibility. KEYFRAMES, not transitions — an incoming glyph has no
  resolved from-value, and `animation-fill-mode: both` needs none. Driven off the kind
  VALUE via a per-row ref, like the wedge, so ⌘Z, the ⌘1/2/3 block form, the ⋯ menu and a
  remote window all animate with one implementation and a row scrolling into view never
  self-starts. Three things here are load-bearing:
  (1) **the resting glyph IS the entering layer**, permanently mounted under the key
  `"glyph"` and merely GAINING/losing the animation classes — a shape that returned a
  bare `<GlyphInk>` at rest and a wrapper while morphing swapped a component element for a
  host one, which React never reconciles (the `Wedge` rule), remounting the glyph subtree
  at BOTH edges: measured in WebKit as `drawCheck` stroking itself a second time when a ⌘2
  landed inside `.just-completed`'s 440ms window. The LEAVING layer is the opposite case —
  recreated per morph, so it keys on the epoch, and that key is what restarts its keyframe.
  (2) `.glyph-layer.glyph-leave` declares `opacity: 0` **as a resting style**: it is
  invisible only by fill-mode, and both clone containers force `animation: none !important`,
  so without it a row cloned mid-morph painted BOTH glyphs at full opacity.
  (3) the prompt's real bar is an overlay on the PANEL, so a morph out of a prompt has no
  bar to fade — the leaving layer draws `.glyph-prompt-ghost` in its place, at the real
  bar's LAST MEASURED height (a fixed height truncated a 4-line prompt's bar by ~55px on
  frame 0) and offset `+1px` for the panel's border, the vertical twin of the `−1` NodeRow
  already applies to `promptBarLeft`. NOT covered: converting to/from a prompt also changes
  the ROW HEIGHT (~18px at fontSize 16), and that still snaps — arming `.rows-animating`
  for it was measured to look worse, since the growing row's own height is a single-paint
  change; a real fix is a clip boundary for a growing row, i.e. a design project.
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
  has no editor), ⇧⌘C markdown copy, ⌥↑/⌥↓ (move node), ⌘↑/⌘↓ collapse/expand the focused
  parent — childless falls through to the native caret jump, wrap-selection, Escape);
  (2) `App.tsx` window handler (⌥⇧F, ⌘=/− → `adjustFont`, ⌘0 → `resetFont`,
  pinch/ctrl-wheel → `setFont`, ⌘[/],
  ⌘E/⌘D collapse/expand focused, ⌘⇧E/⌘⇧D collapse/expand ALL, ⌘Z/⇧⌘Z fallback,
  ⌘⌃⇧7 seed, ⌘⌃⇧8 idle perf baseline); (3) `handleSelectionKey` capture-phase (block ops
  while a node selection is
  live; an open ⋯ menu is a modal NSMenu, so Escape closes IT and never reaches the
  webview — one layer per press, with no in-app guard). Plus native menu accelerators (⌘N/⌘Z/⇧⌘Z + clipboard roles —
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
  blurring the editor the click just focused.
- **Chrome scales with ⌘+/⌘− via em units off an inline font-size** — rows set
  `fontSize` on `.node-row` (cluster/menu/prompt internals are em), the TopBar sets
  `16·clamp(scale,1,1.8)` (CAPPED: icons must never outgrow the fixed 44px strip or
  they'd break traffic-light alignment), SettingsPanel sets `13·clamp(scale,.9,2.2)`.
  New chrome CSS should be em, not px. The ⋯ menu is a NATIVE macOS NSMenu built in Rust
  (`popup_row_menu`) and popped at the button's bottom-left; the chosen item comes back to
  the OPENING window as a `row-menu-action` event and is replayed through the existing
  gestures by `performRowMenuAction` (controller.ts). AppKit owns dismissal, so it needs
  no CSS, no backdrop div and no in-app capture mousedown/Escape closer — don't reinstate
  any of them. (`.menu-backdrop` survives for the SETTINGS popover, which is still
  in-app.) The
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
  collapse; trailing ⋯ = Zoom In / Copy / Delete, built per kind in Rust — no Zoom In on
  a divider, and a prompt's copy item is Copy Markdown + Copy Raw (+ Copy Subtree when it
  has children) while a divider gets none (delete confirms at ≥10 descendants);
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
- **The mutation surface is the Rust commands** (37 registered in `lib.rs`; typed
  wrappers in `src/lib/api.ts`). Never mutate the mirror locally — apply state only from
  deltas. New mutations follow the pattern: store method → command → `emit_delta` →
  `MutationOut` hints for the caller.
- After UI-affecting changes, verify in the running app (scripts above + screenshots),
  and re-run `npm test` + `cargo test`; both suites are fast.

## Git

Default branch `main`, remote `git@github.com:RyanDivigalpitiya/PromptFlow-Tauri.git`;
per-phase commits, pushed to origin. End commit messages with the `Co-Authored-By`
trailer.
