import { create } from "zustand";
import type { NodeKind } from "../lib/types";

/** Drag-to-reorder state + the pure drop projection (the OutlineDragController port).
 * All geometry is in the OUTLINE CONTENT space (y includes scrollTop; the virtualizer's
 * row offsets live in the same space), so the math is scroll-invariant. */

export interface DropCandidate {
  nodeId: string;
  parent: string | null;
  kind: NodeKind;
  depth: number;
  minY: number;
  midY: number;
  maxY: number;
}

export interface DropProjection {
  parentId: string | null;
  afterId: string | null;
  depth: number;
  markerY: number;
}

/** Pure projection: vertical pointer position picks the gap between two rows;
 * horizontal drag distance picks the depth within that gap's allowed band.
 * `resolveParent(nodeId)` reads the mirror; `drilledIn` protects the drill root. */
export function projectDrop(
  candidates: DropCandidate[],
  pointerY: number,
  dx: number,
  grabbedDepth: number,
  step: number,
  drilledIn: boolean,
  parentOf: (id: string) => string | null,
): DropProjection | null {
  if (candidates.length === 0) return null;

  const floor = drilledIn ? 1 : 0;
  let gapIndex = candidates.reduce(
    (acc, c) => (c.midY <= pointerY ? acc + 1 : acc),
    0,
  );
  if (drilledIn) gapIndex = Math.max(gapIndex, 1); // can't drop above the drill root

  const prev = gapIndex > 0 ? candidates[gapIndex - 1] : null;
  const next = gapIndex < candidates.length ? candidates[gapIndex] : null;

  // Depth band. A divider can't be a parent: when prev is a rule the band tops out
  // at ITS depth (drop lands as its next sibling, never its child).
  const maxDepth = prev ? (prev.kind === "line" ? prev.depth : prev.depth + 1) : floor;
  let minDepth = Math.max(floor, next?.depth ?? floor);
  minDepth = Math.min(minDepth, maxDepth);
  const rawDepth = grabbedDepth + Math.round(dx / step);
  const projected = Math.min(Math.max(rawDepth, minDepth), maxDepth);

  let markerY: number;
  if (prev && next) markerY = (prev.maxY + next.minY) / 2;
  else if (next) markerY = next.minY;
  else if (prev) markerY = prev.maxY;
  else markerY = 0;

  let parentId: string | null;
  let afterId: string | null;
  if (prev) {
    if (projected === prev.depth + 1) {
      parentId = prev.nodeId; // FIRST child of prev (covers a collapsed prev)
      afterId = null;
    } else {
      // Walk prev up to the ancestor at `projected`; the node becomes its next sibling.
      let r = prev.nodeId;
      let rDepth = prev.depth;
      while (rDepth > projected) {
        const p = parentOf(r);
        if (p === null) break;
        r = p;
        rDepth -= 1;
      }
      parentId = parentOf(r);
      afterId = r;
    }
  } else {
    parentId = null; // top of a true-root list → first root
    afterId = null;
  }

  return { parentId, afterId, depth: projected, markerY };
}

interface DragState {
  /** The node under the grabbed glyph (null = idle). */
  nodeId: string | null;
  /** Ordered roots of the dragged block (single drag = [nodeId]). */
  block: string[];
  /** Dragged roots + all descendants — dimmed and excluded as drop targets. */
  subtree: Set<string>;
  grabbedDepth: number;
  startX: number;
  startY: number;
  pointerX: number;
  pointerY: number;
  projection: DropProjection | null;
  /** Text shown in the floating ghost. */
  ghostText: string;

  begin(
    nodeId: string,
    depth: number,
    x: number,
    y: number,
    subtree: Set<string>,
    block: string[],
    ghostText: string,
  ): void;
  update(x: number, y: number, projection: DropProjection | null): void;
  reset(): void;
}

export const useDrag = create<DragState>((set) => ({
  nodeId: null,
  block: [],
  subtree: new Set(),
  grabbedDepth: 0,
  startX: 0,
  startY: 0,
  pointerX: 0,
  pointerY: 0,
  projection: null,
  ghostText: "",

  begin(nodeId, depth, x, y, subtree, block, ghostText) {
    set({
      nodeId,
      block,
      subtree,
      grabbedDepth: depth,
      startX: x,
      startY: y,
      pointerX: x,
      pointerY: y,
      projection: null,
      ghostText,
    });
  },
  update(x, y, projection) {
    set({ pointerX: x, pointerY: y, projection });
  },
  reset() {
    set({
      nodeId: null,
      block: [],
      subtree: new Set(),
      grabbedDepth: 0,
      projection: null,
      ghostText: "",
    });
  },
}));

// Module-level state must never be split across HMR generations — a hot update that
// swapped this module would strand components on a fresh empty instance. Decline hot
// updates so edits here trigger a FULL reload instead.
if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
