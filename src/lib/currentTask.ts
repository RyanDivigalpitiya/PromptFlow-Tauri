import type { NodeKind } from "./types";

/**
 * A pinned node's **Current Task**: the first thing still to do underneath it.
 *
 * Walk the child lists downward, at each level taking the first child that is neither
 * COMPLETED nor a DIVIDER, and stop at the node that has no such child. That node is the
 * task. So for
 *
 *     Example > Parent 1 > [Child 1, Parent 2 > Child 2], Parent 3 > …
 *
 * the task is `Child 1` — NOT `Parent 1`. A parent is a container for work, not the work
 * itself, so the walk keeps descending as long as there is an open child to descend into.
 *
 * A completed node is skipped WHOLESALE, never descended into: ticking a node means its
 * subtree is done, so ticking `Child 1` advances the task to `Child 2` (the first open
 * thing under the next open sibling). The one case that stops on a non-leaf is a node
 * whose children are ALL completed while it is not — nothing is left under it, so IT is
 * what remains.
 *
 * Returns nothing when the focused node has no open descendant at all (no children, only
 * completed ones, only dividers). The pane then shows just the pinned node's own title —
 * repeating it as its own task would say nothing.
 *
 * Dividers are skipped for the same reason every caret path in the app steps over one:
 * a `line` renders no text and is never a task.
 *
 * Pure and pinned by `currentTask.test.ts` — change the semantics there first, then
 * `FocusPane`. It is parameterized over `TaskTree` rather than importing the mirror so a
 * test can hand-roll three nodes; `mirror` satisfies the interface structurally.
 */
export interface TaskTree {
  childrenOf(parent: string | null): readonly string[];
  get(id: string): { isCompleted: boolean; kind: NodeKind } | undefined;
}

/** The first child of `id` that is open work: not completed, not a divider. */
function firstOpenChild(tree: TaskTree, id: string): string | null {
  for (const child of tree.childrenOf(id)) {
    const rec = tree.get(child);
    if (!rec) continue; // a delta the mirror hasn't caught up to
    if (rec.kind === "line") continue;
    if (rec.isCompleted) continue;
    return child;
  }
  return null;
}

/**
 * The descent from `focusedId` (EXCLUSIVE) down to its Current Task (INCLUSIVE), or `[]`
 * when there is none. The intermediate ids matter to the caller as well as the last one:
 * they are the nodes whose records the walk READ, so they are exactly the records a view
 * must subscribe to for the result to stay live.
 */
export function currentTaskChain(
  tree: TaskTree,
  focusedId: string,
): string[] {
  const chain: string[] = [];
  const seen = new Set<string>([focusedId]); // cycle guard, as in mirror.subtree/ancestors
  let cur = focusedId;
  for (;;) {
    const next = firstOpenChild(tree, cur);
    if (next === null || seen.has(next)) return chain;
    seen.add(next);
    chain.push(next);
    cur = next;
  }
}

/** The Current Task's node id, or null when the focused node has no open descendant. */
export function currentTaskId(
  tree: TaskTree,
  focusedId: string,
): string | null {
  const chain = currentTaskChain(tree, focusedId);
  return chain.length === 0 ? null : chain[chain.length - 1];
}
