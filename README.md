# PromptFlow (Tauri)

A macOS port of [PromptFlow](../PromptFlow) — the SwiftUI + SwiftData outliner
(Workflowy-style infinite nesting + prompt drafting) — rebuilt on **Tauri v2** with a
**React** frontend and a **Rust** data core. Built for scale: virtualized rendering
that stays smooth past 10,000 nodes, and any number of windows (4+ verified) editing
one outline with live sync.

Deliberately **not** ported: iCloud/CloudKit sync, the Apple-Intelligence "Improve
prompt" action, and the iPadOS target.

## Architecture

```
┌─ window "main" ─────────┐  ┌─ window "w1" ─┐  … (⌘N spawns peers)
│ React + zustand mirror  │  │ mirror        │
│ TanStack Virtual rows   │  │ …             │
└──────────┬──────────────┘  └──────┬────────┘
     invoke │  ▲ store://delta events │
┌───────────▼──┴───────────────────────────────┐
│ Rust store (single source of truth)          │
│  • tree in memory: HashMap + sorted sibling  │
│    lists, gapped positions (midpoint insert) │
│  • every mutation → SQLite (WAL) txn         │
│  • global undo/redo (state-image entries,    │
│    per-gesture grouping, typing coalescing)  │
│  • rev-stamped delta broadcast to EVERY      │
│    window; a gap triggers snapshot resync    │
└──────────────────────────────────────────────┘
```

- **The Rust store owns the data.** All mutations from `OutlineStore.swift` are ported:
  caret splits with Workflowy placement, kind inheritance (dividers never propagate),
  hide-completed-aware indent/move, multi-select block operations, cascade delete,
  gap compaction. Undo is one shared history across windows, like the original's
  single `NSUndoManager`.
- **Each window mirrors the store** and applies deltas at two grains: per-node
  subscriptions (a text keystroke re-renders exactly one row, in each window) and a
  structure version (the flatten recomputes only when the tree shape changes).
- **Per-window view state** (the `CollapseState` / `NavigationModel` / `OutlineFocus`
  split): collapse, drill history, focus, font size, hide-completed, focus-pane
  visibility. Persisted per window label; a fresh ⌘N window seeds from the device's
  last window state.
- **One live editor.** Unfocused rows are cheap static spans (bold runs, strikethrough,
  highlight); the focused row swaps in an auto-growing textarea — the same economy the
  original gets from AppKit first responder, and what keeps 10k+ rows cheap.
- **Virtualized outline** (TanStack Virtual) over the flattened row list, with the
  drop projection and drag marker running in the same content coordinate space.

## Development

```sh
npm install
scripts/dev.sh            # tauri dev against an isolated throwaway store
scripts/build.sh          # release bundle -> src-tauri/target/release/bundle/macos
scripts/verify.sh         # launch smoke test of the release build
npm test                  # frontend unit tests (key routing, wrap, bold, projection)
cd src-tauri && cargo test  # store tests (mutations, undo, archive round-trip)
```

- `PROMPTFLOW_STORE=<path>` isolates the SQLite store (default:
  `~/Library/Application Support/com.ryandiv.promptflow-tauri/promptflow.sqlite`).
- `PROMPTFLOW_NO_SEED=1` skips the welcome outline on an empty store.
- `⌘⌃⇧7` (dev) seeds a ~11k-node synthetic tree for performance testing.
- `scripts/shot.sh out.png` screenshots the app window; `clickwin.swift` /
  `dragwin.swift` / `scroll.swift` drive it for UI verification.

## Keyboard

| Keys | Action |
| --- | --- |
| Enter / ⇧Enter | New node / newline (inverted inside a prompt panel) |
| ⌥Enter | New node below (any kind) |
| ⌘Enter | Toggle complete (spawns a fresh sibling when completing the last item) |
| Tab / ⇧Tab | Indent / outdent (node or selected block) |
| ⌥↑ / ⌥↓ | Move node (or block) past the nearest visible sibling |
| ⌘1 / ⌘2 / ⌘3 | Bullet / checkbox / prompt panel |
| ⌘B | Bold the selected text (stored as bold runs) |
| ⌘⇧F | Highlight (accent + focus-pane membership) |
| ⌘⇧N | Edit the node's note |
| ⌥⇧F | Toggle the focus pane |
| ⇧↑ / ⇧↓ at a boundary line | Grow a node selection; shift-click extends it |
| ⌘⇧D / ⌘⇧E | Expand all / collapse all (per window) |
| ⌘= / ⌘− / ⌘0 | Text size (per window) |
| ⌘[ / ⌘] | Drill back / forward |
| ⌘N | New window (live-synced peer) |
| ⌘Z / ⇧⌘Z | Undo / redo (one shared history) |
| Escape | Delete an empty node, else defocus; cancels a drag |

Clicking a bullet drills in; clicking a checkbox toggles it; dragging any glyph
reorders (with depth choice on horizontal travel); the trailing ⋯ menu has Zoom
In / Copy / Delete.

## Data

- **Export / Import** (Settings → Data) speaks the SwiftUI app's exact
  `promptflow.outline` JSON — outlines migrate losslessly in both directions
  (import replaces the outline and is not undoable).
- **Clear Completed / auto-archive**: fully-completed subtrees are archived to
  timestamped JSON in `<store dir>/Archive` and then removed; the auto sweep runs at
  launch for units completed more than 3 days ago (toggle in Settings).
