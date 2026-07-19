import { invoke } from "@tauri-apps/api/core";
import { api } from "../lib/api";
import { flattenDrillRoot, flattenRoots, type RenderRow } from "../lib/flatten";

/** Dev diagnostics to the terminal (see commands::log_msg). */
export function dbg(msg: string) {
  void invoke("log_msg", { msg }).catch(() => {});
}
import type { KeyDecision } from "../lib/keys";
import { toMarkdown } from "../lib/runs";
import { inheritableKind, type NodeKind } from "../lib/types";
import { runCollapseAnim, runRowsAnim } from "./collapseAnim";
import { mirror } from "./mirror";
import { markCompleting } from "./rowAnim";
import { useSelection } from "./selection";
import { useWindowState, type CaretIntent } from "./windowState";

/** The outline's gesture semantics — the port of OutlineView's glue between key
 * decisions and store mutations. Module-level functions with stable identities (rows
 * are published by OutlineView each render), so row components never re-render from
 * callback churn. */

let currentRows: RenderRow[] = [];

export function publishRows(rows: RenderRow[]) {
  currentRows = rows;
}

export function visibleRows(): RenderRow[] {
  return currentRows;
}

function ws() {
  return useWindowState.getState();
}

function rowIndex(id: string): number {
  return currentRows.findIndex((r) => r.kind === "node" && r.nodeId === id);
}

/** The nearest NODE row before/after `id` in visible order. */
function neighborNode(id: string, dir: -1 | 1): RenderRow | null {
  const idx = rowIndex(id);
  if (idx < 0) return null;
  for (let i = idx + dir; i >= 0 && i < currentRows.length; i += dir) {
    if (currentRows[i].kind === "node") return currentRows[i];
  }
  return null;
}

async function applyOut(
  out: { newNode: string | null; expand: string[] },
  caret: CaretIntent = { type: "start" },
) {
  if (out.expand.length > 0) ws().expandMany(out.expand);
  if (out.newNode) ws().focusNode(out.newNode, "main", caret);
}

/** Client-side mirror of Store::indent's target rule (store.rs): the nearest previous
 * sibling, skipping completed ones under hide-completed; null when there is none or it
 * is a divider. Advisory only — the store stays authoritative; this exists so the
 * destination can be EXPANDED before the invoke. `expandMany(out.expand)` runs after
 * the awaited delta, and in between the moved row is absent from the flatten: React
 * unmounts it and remounts it as a brand-new row a commit later, which costs a
 * one-frame flash, the caret, and any glide. Same total work, one commit earlier. */
export function indentTargetParent(
  nodeId: string,
  hideCompleted: boolean,
): string | null {
  const rec = mirror.get(nodeId);
  if (!rec) return null;
  const sibs = mirror.childrenOf(rec.parent);
  let i = sibs.indexOf(nodeId) - 1;
  while (i >= 0 && hideCompleted && mirror.get(sibs[i])?.isCompleted) i--;
  if (i < 0) return null;
  return mirror.get(sibs[i])?.kind === "line" ? null : sibs[i];
}

// MARK: Key decisions

export async function performDecision(
  nodeId: string,
  decision: KeyDecision,
  selStart: number,
  selEnd: number,
  currentText: string,
) {
  switch (decision) {
    case "newNode": {
      const before = currentText.slice(0, selStart);
      const after = currentText.slice(selEnd);
      // Enter at line start leaves the source empty and moves on — an intentional
      // split, not abandonment; exempt it from the next defocus-prune.
      if (before === "") ws().setExemptPruneOnce(nodeId);
      const out = await api.commitNewNode(
        nodeId,
        before,
        after,
        !ws().collapsed.has(nodeId),
        ws().hideCompleted,
      );
      await applyOut(out);
      break;
    }
    case "toggleComplete":
      await toggleCompleted(nodeId, { spawnNext: true });
      break;
    case "indent": {
      const hide = ws().hideCompleted;
      const target = indentTargetParent(nodeId, hide);
      if (target) ws().expandMany([target]);
      const out = await api.indent(nodeId, hide);
      ws().expandMany(out.expand); // idempotent; usually a no-op after the above
      break;
    }
    case "outdent":
      await api.outdent(nodeId);
      break;
    case "deleteEmpty":
      await deleteAndFocusPrev(nodeId);
      break;
    case "arrowUp": {
      const prev = neighborNode(nodeId, -1);
      if (prev) ws().focusNode(prev.nodeId, "main", { type: "lastLineStart" });
      break;
    }
    case "arrowDown": {
      const next = neighborNode(nodeId, 1);
      if (next) ws().focusNode(next.nodeId, "main", { type: "start" });
      break;
    }
    case "extendSelectUp":
    case "extendSelectDown": {
      // ⇧↑/⇧↓ at a boundary line grows a NODE selection from the caret's node to its
      // nearest visible sibling; no visible sibling → stay native (no-op here).
      const node = mirror.get(nodeId);
      if (!node) break;
      const dir = decision === "extendSelectUp" ? -1 : 1;
      const sibs = mirror.childrenOf(node.parent);
      let i = sibs.indexOf(nodeId) + dir;
      while (
        i >= 0 &&
        i < sibs.length &&
        ws().hideCompleted &&
        mirror.get(sibs[i])?.isCompleted
      ) {
        i += dir;
      }
      if (i < 0 || i >= sibs.length) break;
      ws().clearFocus();
      (document.activeElement as HTMLElement | null)?.blur();
      useSelection.getState().start(nodeId, sibs[i]);
      break;
    }
    default:
      break;
  }
}

// MARK: Completion (the focused-node ⌘Enter path, with the spawn-a-sibling rule)

export async function toggleCompleted(
  nodeId: string,
  opts: { spawnNext: boolean } = { spawnNext: false },
) {
  const node = mirror.get(nodeId);
  if (!node || node.kind === "line") return;
  const completing = !node.isCompleted;
  // Play the check/pop the moment the user acts (before the store round-trip), so the
  // row is already flagged when its completed delta re-renders it.
  if (completing) markCompleting(nodeId);
  // Armed BEFORE the invoke. store://delta is emitted synchronously inside the Rust
  // command and can land before the invoke promise resolves, leaving a window where the
  // node is completed and NOT yet in keepVisible — the flatten drops it, so the row
  // unmounts and remounts a tick later. It is also load-bearing for the animation: with
  // the grace already armed, the completion delta produces an IDENTICAL flatten,
  // runRowsAnim declines, and the leave is owned solely by the grace timer. Pre-arming is
  // inert if the toggle fails, since keepVisible is only consulted for completed nodes.
  if (completing && ws().hideCompleted) holdVisible(nodeId);
  await api.toggleCompleted(nodeId);
  if (!completing) return;
  const s = ws();
  if (!opts.spawnNext) return;
  // Never spawn for the drill root — the sibling would render outside the drilled view.
  if (s.drill === nodeId) return;
  const sibs = mirror.childrenOf(node.parent);
  const isLast = sibs.length > 0 && sibs[sibs.length - 1] === nodeId;
  if (isLast) {
    const out = await api.insertSiblingAfter(nodeId, inheritableKind(node.kind));
    await applyOut(out);
  } else {
    const next = neighborNode(nodeId, 1);
    if (next) s.focusNode(next.nodeId, "main", { type: "end" });
  }
}

// MARK: Deletion

export async function deleteAndFocusPrev(nodeId: string) {
  const prev = neighborNode(nodeId, -1);
  await api.deleteNode(nodeId);
  const s = ws();
  if (prev) s.focusNode(prev.nodeId, "main", { type: "end" });
  else s.clearFocus();
}

/** Delete a node's whole subtree, confirming when it's big (the
 * bulletDeleteWarningThreshold port). */
export async function confirmDelete(nodeId: string) {
  if (!mirror.get(nodeId)) return; // a blur-prune may have beaten this
  const count = mirror.descendantsCount(nodeId) - 1;
  if (count >= 10) {
    const ok = window.confirm(
      `Delete this node and its ${count} nested items? (⌘Z undoes)`,
    );
    if (!ok) return;
  }
  await deleteAndFocusPrev(nodeId);
}

/** Run a native row-(⋯)-menu selection through the existing gesture handlers — the
 * same actions the old in-app dropdown fired, so behavior stays identical. */
export async function performRowMenuAction(action: string, nodeId: string) {
  const rec = mirror.get(nodeId);
  if (!rec) return;
  switch (action) {
    case "zoom":
      drillInto(nodeId);
      break;
    case "copy":
    case "copy-subtree":
      await copySubtree(nodeId);
      break;
    case "copy-md":
      await navigator.clipboard.writeText(
        toMarkdown(rec.text, {
          bold: rec.boldRanges,
          italic: rec.italicRanges,
          underline: rec.underlineRanges,
        }),
      );
      break;
    case "copy-raw":
      await navigator.clipboard.writeText(rec.text);
      break;
    case "delete":
      await confirmDelete(nodeId);
      break;
  }
}

/** Prune an abandoned empty node when focus leaves it (the OutlineFocus.onDefocus
 * port). Split sources are exempt once; the drill root is never pruned. */
export async function pruneIfEmptyOnDefocus(nodeId: string) {
  const s = ws();
  if (s.exemptPruneOnce === nodeId) {
    s.setExemptPruneOnce(null);
    return;
  }
  if (s.focusId === nodeId) return; // focus came back (e.g. re-click)
  if (s.drill === nodeId) return;
  const node = mirror.get(nodeId);
  if (!node) return;
  if (node.text !== "" || node.note !== "" || mirror.hasChildren(nodeId)) return;
  if (node.kind === "line") return; // a divider is legitimately empty
  await api.deleteNode(nodeId);
}

// MARK: Row affordances

/** The row's trailing "+" — first child for an EXPANDED parent, sibling below for a
 * leaf or a COLLAPSED parent (adding into a closed list you can't see would be
 * disorienting); the DRILL ROOT forces the child branch (its siblings aren't
 * rendered). */
export async function addRelative(nodeId: string) {
  const s = ws();
  const node = mirror.get(nodeId);
  // The click that revealed this + may have BLUR-pruned the node it belongs to.
  if (!node) return;
  const isDrillRoot = s.drill === nodeId;
  if (
    node &&
    !isDrillRoot &&
    mirror.hasChildren(nodeId) &&
    s.collapsed.has(nodeId)
  ) {
    const out = await api.insertSiblingAfter(nodeId, inheritableKind(node.kind));
    await applyOut(out);
    return;
  }
  const out = await api.insertNewNodeRelative(
    nodeId,
    isDrillRoot,
    s.hideCompleted,
  );
  await applyOut(out);
}

/** The per-level "+" placeholder at the bottom of an expanded child list. */
export async function appendChildAt(parentId: string) {
  const out = await api.appendChild(parentId);
  await applyOut(out);
}

/** The bottom-of-list "+" placeholder: append a root (or a child of the drill root). */
export async function addAtBottom() {
  const s = ws();
  const out = s.drill
    ? await api.appendChild(s.drill)
    : await api.appendRoot();
  await applyOut(out);
}

export async function setKindGuarded(nodeId: string, kind: NodeKind) {
  const node = mirror.get(nodeId);
  if (!node || node.kind === "line") return; // ⌘1/2/3 never converts a divider
  if (node.kind === kind) return;
  await api.setKind(nodeId, kind);
}

export async function toggleHighlight(nodeId: string) {
  const node = mirror.get(nodeId);
  if (!node || node.kind === "line") return;
  await api.setHighlighted(nodeId, !node.isHighlighted);
}

export async function moveFocused(nodeId: string, offset: -1 | 1) {
  await api.moveBy(nodeId, offset, ws().hideCompleted);
}

export function drillInto(nodeId: string) {
  const node = mirror.get(nodeId);
  if (!node || node.kind === "line") return; // a divider is not drillable
  ws().clearFocus();
  ws().drillIn(nodeId);
}

/** Animated collapse toggle — the chevron click and any programmatic single-node
 * toggle route here so the reveal/hide slides instead of snapping. */
export function toggleCollapse(id: string) {
  const s = ws();
  const willCollapse = !s.collapsed.has(id);
  // The root is passed for BOTH directions — the drawer hangs off it either way.
  runCollapseAnim(
    willCollapse ? "collapse" : "expand",
    [id],
    visibleRows(),
    () => s.toggleCollapse(id),
  );
}

/** Animated set-collapsed — ⌘E/⌘D and ⌘↑/⌘↓ on a focused parent. No-op if unchanged. */
export function setCollapsed(id: string, value: boolean) {
  const s = ws();
  // The drill root is always shown expanded and can't be collapsed (the chevron locks
  // it; the keyboard paths must honor the same rule, or flattenDrillRoot ignores the
  // collapse and we paint phantom ghosts over unchanged rows + poison the collapsed set).
  if (value && s.drill === id) return;
  if (s.collapsed.has(id) === value) return;
  runCollapseAnim(
    value ? "collapse" : "expand",
    [id],
    visibleRows(),
    () => s.setCollapsed(id, value),
  );
}

/** ⌘⇧D expand-all / ⌘⇧E collapse-all — per window. */
export function setCollapsedAll(collapsed: boolean) {
  const s = ws();
  const apply = () => {
    if (!collapsed) {
      s.expandAll();
      return;
    }
    // Collapse-all fills the window's set with every parent's id.
    const parents: string[] = [];
    const stack = [...mirror.roots()];
    while (stack.length > 0) {
      const id = stack.pop()!;
      const kids = mirror.childrenOf(id);
      if (kids.length > 0) {
        parents.push(id);
        for (const k of kids) stack.push(k);
      }
    }
    s.collapseAll(parents);
  };
  // Bulk op: animate the below-row slide (and, on expand, the entrance fade) but skip
  // per-row ghosts — a whole-tree fade would be visual noise. Empty roots ⇒ no ghosts.
  runCollapseAnim(collapsed ? "collapse" : "expand", [], visibleRows(), apply);
}

/** The rows a PER-WINDOW change is about to produce, computed WITHOUT applying it. The
 * flatten is pure over (mirror, collapsed, hideCompleted, keepVisible, drill), so the
 * animation can diff the exact next rows up front. One extra flatten per gesture (<8ms
 * even at 11k rows — see OutlineView's dbg threshold): a one-shot cost, not per-frame. */
function previewRows(over: {
  hideCompleted?: boolean;
  keepVisible?: ReadonlySet<string>;
}): RenderRow[] {
  const s = ws();
  const hide = over.hideCompleted ?? s.hideCompleted;
  const keep = over.keepVisible ?? s.keepVisible;
  return s.drill
    ? flattenDrillRoot(s.drill, s.collapsed, hide, keep)
    : flattenRoots(s.collapsed, hide, keep);
}

function animatedApply(nextRows: RenderRow[], apply: () => void, label: string) {
  if (!runRowsAnim(visibleRows(), nextRows, apply, label)) apply();
}

/** Animated hide-completed toggle. Same house rule as toggleCollapse: NEVER call
 * `useWindowState.setHideCompleted` directly, or the change snaps. (Subscribing to
 * zustand inside collapseAnim instead is not an option — a store listener fires AFTER
 * the state object is swapped, so a flushSync from it would render `.rows-animating`
 * and the new `rows` in ONE commit, which is the snap this whole dance exists to
 * avoid.) Call sites: TopBar, SettingsPanel. */
export function setHideCompleted(on: boolean) {
  const s = ws();
  if (s.hideCompleted === on) return;
  animatedApply(
    previewRows({ hideCompleted: on }),
    () => s.setHideCompleted(on),
    `hideCompleted:${on}`,
  );
}

/** Hold just-completed nodes on screen, then animate them away. The timer lives HERE and
 * not in windowState: the store's old inline setTimeout was a bare `set` with no arming
 * commit — the exact analogue of calling setCollapsed directly — so the row vanished
 * without animating. A BLOCK is released in ONE apply, so N rows leave together instead
 * of N animations tearing each other down. Also serves revealNode's 60s reveal holds. */
export function holdVisible(ids: string | readonly string[], ms = 1400) {
  const list = typeof ids === "string" ? [ids] : [...ids];
  if (list.length === 0) return;
  for (const id of list) ws().holdVisible(id);
  setTimeout(() => {
    const s = ws();
    const live = list.filter((id) => s.keepVisible.has(id));
    if (live.length === 0) return; // un-completed or deleted meanwhile
    const keep = new Set(s.keepVisible);
    for (const id of live) keep.delete(id);
    // If the nodes were un-completed or hide-completed was switched off meanwhile the
    // flatten is unchanged, runRowsAnim declines, and the release still happens.
    animatedApply(
      previewRows({ keepVisible: keep }),
      () => s.releaseVisible(live),
      "graceExpiry",
    );
  }, ms);
}

/** Reveal a node from the focus pane: go Home if it's outside the current drill,
 * expand its collapsed ancestors, un-hide completed ancestors transiently (the
 * revealKeep semantics), then focus it — the presence-gated scroll effect lands it
 * on screen after the structural changes settle. */
export function revealNode(nodeId: string) {
  const s = ws();
  const node = mirror.get(nodeId);
  if (!node) return;
  const ancestors = mirror.ancestors(nodeId);
  if (s.drill && s.drill !== nodeId && !ancestors.includes(s.drill)) {
    s.goHome();
  }
  s.expandMany(ancestors);
  if (s.hideCompleted) {
    // ONE hold, so the whole revealed chain leaves together in a single animation when
    // the (long) reveal grace expires.
    const held = ancestors.filter((a) => mirror.get(a)?.isCompleted);
    if (node.isCompleted) held.push(nodeId);
    holdVisible(held, 60_000);
  }
  s.focusNode(nodeId, "main", { type: "end" });
}

function subtreeLines(nodeId: string, lines: string[], depth = 0) {
  const n = mirror.get(nodeId);
  if (!n) return;
  if (n.kind !== "line") {
    lines.push("  ".repeat(depth) + "- " + n.text);
    if (n.note !== "") lines.push("  ".repeat(depth + 1) + n.note);
  }
  for (const k of mirror.childrenOf(nodeId)) subtreeLines(k, lines, depth + 1);
}

/** Copy a node's whole subtree to the clipboard as an indented "- " bullet list. */
export async function copySubtree(nodeId: string) {
  const lines: string[] = [];
  subtreeLines(nodeId, lines);
  await navigator.clipboard.writeText(lines.join("\n"));
}

/** ⌘C on a multi-selection: every member's full subtree, collapsed included. */
export async function copyBlock(ids: string[]) {
  const lines: string[] = [];
  for (const id of ids) subtreeLines(id, lines);
  await navigator.clipboard.writeText(lines.join("\n"));
}

// Prune abandoned empty nodes on ANY focus change. The editor's onBlur alone can't
// do it: focusing another row unmounts the editor without a blur event (browsers
// fire no blur when a focused element is removed), so the prune must key off the
// focus STATE, not the DOM event.
let lastFocusId: string | null = useWindowState.getState().focusId;
useWindowState.subscribe((s) => {
  const prev = lastFocusId;
  if (s.focusId !== prev) {
    lastFocusId = s.focusId;
    if (prev) setTimeout(() => void pruneIfEmptyOnDefocus(prev), 0);
  }
});

// Module-level state must never be split across HMR generations — a hot update that
// swapped this module would strand components on a fresh empty instance. Decline hot
// updates so edits here trigger a FULL reload instead.
if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
