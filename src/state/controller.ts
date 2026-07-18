import { api } from "../lib/api";
import type { RenderRow } from "../lib/flatten";
import type { KeyDecision } from "../lib/keys";
import { inheritableKind, type NodeKind } from "../lib/types";
import { mirror } from "./mirror";
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
      const out = await api.indent(nodeId, ws().hideCompleted);
      ws().expandMany(out.expand);
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
  await api.toggleCompleted(nodeId);
  if (!completing) return;
  const s = ws();
  // Under hide-completed, hold the just-completed node on screen briefly before it
  // slips away (the grace set the flatten's keepVisible reads).
  if (s.hideCompleted) s.holdVisible(nodeId);
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

/** The row's trailing "+" — first child for a parent (expanding it), sibling for a
 * leaf; the DRILL ROOT forces the child branch (its siblings aren't rendered). */
export async function addRelative(nodeId: string) {
  const s = ws();
  const out = await api.insertNewNodeRelative(
    nodeId,
    s.drill === nodeId,
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

/** ⌘⇧D expand-all / ⌘⇧E collapse-all — per window. */
export function setCollapsedAll(collapsed: boolean) {
  const s = ws();
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
}

/** Copy a node's whole subtree to the clipboard as an indented "- " bullet list. */
export async function copySubtree(nodeId: string) {
  const lines: string[] = [];
  const walk = (id: string, depth: number) => {
    const n = mirror.get(id);
    if (!n) return;
    if (n.kind !== "line") {
      lines.push("  ".repeat(depth) + "- " + n.text);
      if (n.note !== "") lines.push("  ".repeat(depth + 1) + n.note);
    }
    for (const k of mirror.childrenOf(id)) walk(k, depth + 1);
  };
  walk(nodeId, 0);
  await navigator.clipboard.writeText(lines.join("\n"));
}
