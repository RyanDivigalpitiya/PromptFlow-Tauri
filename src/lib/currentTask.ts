import type { NodeKind } from "./types";

/**
 * A pinned node's **Current Task**: the first thing still to do underneath it.
 *
 * Walk the child lists downward, at each level taking the first child that is open work,
 * and stop at the node that has nothing open under it. That node is the task. So for
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
 * Two kinds can never BE the task, for different reasons and with different consequences:
 * a DIVIDER is skipped outright, exactly as every caret path in the app steps over one —
 * it renders no text and parents nothing. A PROMPT is stepped over but still DESCENDED
 * INTO: a draft is something you write, not something you do, but real work parented under
 * one must not become invisible to the pane. That is what makes this a backtracking walk
 * rather than a single descent — a prompt with nothing open under it cannot stand as the
 * answer, so the walk falls back out of it and tries the next sibling.
 *
 * Returns nothing when the focused node has no open descendant that can be a task. The
 * pane then shows just the pinned node's own title — repeating it as its own task would
 * say nothing.
 *
 * Pure and pinned by `currentTask.test.ts` — change the semantics there first, then
 * `FocusPane`. It is parameterized over `TaskTree` rather than importing the mirror so a
 * test can hand-roll three nodes; `mirror` satisfies the interface structurally.
 */
export interface TaskTree {
  childrenOf(parent: string | null): readonly string[];
  get(id: string): { isCompleted: boolean; kind: NodeKind } | undefined;
}

export interface TaskWalk {
  /** The descent from the focused node (EXCLUSIVE) to the task (INCLUSIVE), or `[]`. */
  chain: string[];
  /**
   * Every record the walk READ — which is exactly what a view must subscribe to for the
   * result to stay live. It is NOT the chain: the walk also reads the children it rejects
   * (their `kind` and `isCompleted` are what rejected them) and everything under a prompt
   * it backtracked out of. Siblings PAST the answer are deliberately absent — nothing they
   * could do changes the outcome while the winner still stands, and if it stops standing,
   * that is a change to a record already in here.
   */
  visited: string[];
}

export function walkCurrentTask(tree: TaskTree, focusedId: string): TaskWalk {
  const visited: string[] = [];
  const seen = new Set<string>([focusedId]); // cycle guard, as in mirror.subtree/ancestors

  /** The chain from `id` down to the first node that can be the task, or null. */
  function descend(id: string): string[] | null {
    for (const child of tree.childrenOf(id)) {
      if (seen.has(child)) continue;
      const rec = tree.get(child);
      if (!rec) continue; // a delta the mirror hasn't caught up to
      seen.add(child);
      visited.push(child); // its kind and completion were READ, so they must be watched
      if (rec.kind === "line" || rec.isCompleted) continue;
      const deeper = descend(child);
      if (deeper !== null) return [child, ...deeper];
      // Nothing open below. Anything but a prompt IS the task; a prompt cannot be, so the
      // walk gives up on it and carries on with the next sibling.
      if (rec.kind !== "promptDraft") return [child];
    }
    return null;
  }

  return { chain: descend(focusedId) ?? [], visited };
}

/** The Current Task's node id, or null when the focused node has no open descendant. */
export function currentTaskId(
  tree: TaskTree,
  focusedId: string,
): string | null {
  const { chain } = walkCurrentTask(tree, focusedId);
  return chain.length === 0 ? null : chain[chain.length - 1];
}
