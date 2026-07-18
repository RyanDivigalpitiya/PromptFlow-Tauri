import { mirror } from "../state/mirror";

/** One rendered outline row — a port of the SwiftUI app's `RenderRow`. The expanded
 * tree flattens to a single array rendered by one virtualized list. */
export interface RenderRow {
  /** node id (+ "add:" prefix for placeholder rows) — the virtualizer key. */
  id: string;
  nodeId: string;
  depth: number;
  hasChildren: boolean;
  kind: "node" | "addChild";
  /** Collapsed IN THIS WINDOW (from the window's collapse set, not the model). */
  isCollapsed: boolean;
}

interface FlattenCtx {
  collapsed: ReadonlySet<string>;
  hideCompleted: boolean;
  keepVisible: ReadonlySet<string>;
  visited: Set<string>;
  rows: RenderRow[];
}

/** Depth-first flatten that emits a row for `id`, then recurses into ordered children
 * ONLY when expanded. Completed nodes (and subtrees) are skipped under hideCompleted
 * unless kept visible (the just-completed grace set / reveal override). Cycle-guarded. */
function flattenInto(id: string, depth: number, ctx: FlattenCtx) {
  const node = mirror.get(id);
  if (!node) return;
  if (ctx.hideCompleted && node.isCompleted && !ctx.keepVisible.has(id)) return;
  if (ctx.visited.has(id)) return;
  ctx.visited.add(id);
  const kids = mirror.childrenOf(id);
  const nodeCollapsed = ctx.collapsed.has(id);
  ctx.rows.push({
    id,
    nodeId: id,
    depth,
    hasChildren: kids.length > 0,
    kind: "node",
    isCollapsed: nodeCollapsed,
  });
  if (nodeCollapsed) return;
  for (const child of kids) flattenInto(child, depth + 1, ctx);
  // A "+" at the bottom of this node's child list (every expanded level gets one).
  if (kids.length > 0) {
    ctx.rows.push({
      id: "add:" + id,
      nodeId: id,
      depth: depth + 1,
      hasChildren: false,
      kind: "addChild",
      isCollapsed: false,
    });
  }
}

export function flattenRoots(
  collapsed: ReadonlySet<string>,
  hideCompleted: boolean,
  keepVisible: ReadonlySet<string>,
): RenderRow[] {
  const ctx: FlattenCtx = {
    collapsed,
    hideCompleted,
    keepVisible,
    visited: new Set(),
    rows: [],
  };
  for (const root of mirror.roots()) flattenInto(root, 0, ctx);
  return ctx.rows;
}

/** Flatten a drill-in root: the node itself at depth 0, then its descendants. The
 * root's own collapse is ignored for recursion (drilling in always reveals children);
 * the root is always shown even if completed (you navigated into it). */
export function flattenDrillRoot(
  rootId: string,
  collapsed: ReadonlySet<string>,
  hideCompleted: boolean,
  keepVisible: ReadonlySet<string>,
): RenderRow[] {
  const node = mirror.get(rootId);
  if (!node) return [];
  const ctx: FlattenCtx = {
    collapsed,
    hideCompleted,
    keepVisible,
    visited: new Set([rootId]),
    rows: [
      {
        id: rootId,
        nodeId: rootId,
        depth: 0,
        hasChildren: mirror.hasChildren(rootId),
        kind: "node",
        isCollapsed: collapsed.has(rootId),
      },
    ],
  };
  for (const child of mirror.childrenOf(rootId)) flattenInto(child, 1, ctx);
  return ctx.rows;
}

/** How many of `children` are completed-and-hidden WHEN the list renders completely
 * empty because of it — null when there's anything to show or nothing hidden. Drives
 * the "(All Completed — Hidden)" hint. MIRRORS flattenInto's visibility rule. */
export function hiddenCompletedCount(
  childIds: readonly string[],
  hideCompleted: boolean,
  keepVisible: ReadonlySet<string>,
): number | null {
  if (!hideCompleted) return null;
  for (const id of childIds) {
    const n = mirror.get(id);
    if (n && (!n.isCompleted || keepVisible.has(id))) return null;
  }
  return childIds.length > 0 ? childIds.length : null;
}
