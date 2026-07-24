import { create } from "zustand";
import { mirror } from "./mirror";

/** Node multi-select (the OutlineSelectionController port): a CONTIGUOUS sibling
 * range at one level (anchor → head), with every member's subtree tinted. Per-window
 * state; block mutations run through the store's block commands (one undo step). */

/** Resolve `head` to the sibling LEVEL of `anchor`: head itself or its ancestor whose
 * parent matches anchor's; failing that, resolve anchor down… (symmetric fallback:
 * anchor's ancestor at head's level). Returns [anchorResolved, headResolved] or null. */
function resolveLevels(
  anchor: string,
  head: string,
): [string, string] | null {
  const aRec = mirror.get(anchor);
  const hRec = mirror.get(head);
  if (!aRec || !hRec) return null;
  const aParent = aRec.parent;
  if (hRec.parent === aParent) return [anchor, head];
  // head's ancestor at anchor's level
  for (const anc of [head, ...mirror.ancestors(head)].reverse()) {
    if (mirror.get(anc)?.parent === aParent) return [anchor, anc];
  }
  // anchor's ancestor at head's level
  const hParent = hRec.parent;
  for (const anc of [anchor, ...mirror.ancestors(anchor)].reverse()) {
    if (mirror.get(anc)?.parent === hParent) return [anc, head];
  }
  return null;
}

export interface SelectionResolved {
  parent: string | null;
  /** Ordered contiguous members of the range. */
  ids: string[];
  /** Members + all their descendants (row tinting). */
  tint: Set<string>;
}

function resolve(anchor: string, head: string): SelectionResolved | null {
  const pair = resolveLevels(anchor, head);
  if (!pair) return null;
  const [a, h] = pair;
  const parent = mirror.get(a)?.parent ?? null;
  const sibs = mirror.childrenOf(parent);
  const ai = sibs.indexOf(a);
  const hi = sibs.indexOf(h);
  if (ai < 0 || hi < 0) return null;
  const [lo, hi2] = ai <= hi ? [ai, hi] : [hi, ai];
  const ids = sibs.slice(lo, hi2 + 1);
  const tint = new Set<string>();
  for (const id of ids) for (const d of mirror.descendants(id)) tint.add(d);
  return { parent, ids: [...ids], tint };
}

/** The row fields the drag projection needs — a `RenderRow` subset, so the function
 * stays pure (no mirror, no flatten) and testable on plain literals. */
export interface SelRow {
  id: string;
  nodeId: string;
  kind: "node" | "addChild";
}

/** Pure port of the Swift `projectSelectionRange`: map a pointer position to the
 * selection's HEAD — the anchor-LEVEL sibling the pointer is over. (The Swift returns
 * the id range; here the head goes back through `start`/`extendTo`, which resolves the
 * same range, so both entry points share one definition of a selection.)
 *
 * Hit row = the first MEASURED row whose bottom edge is below the pointer, so above the
 * first row and below the last both resolve deterministically to the ends. A hit deeper
 * than the anchor's level walks up its parent chain to the sibling containing it; a hit
 * outside the anchor's parent entirely clamps to whichever end of the sibling list the
 * pointer is past — the range can never collapse to nothing mid-drag. */
export function projectSelectionHead(
  anchorId: string,
  pointerY: number,
  rows: readonly SelRow[],
  frames: ReadonlyMap<string, { minY: number; maxY: number }>,
  parentOf: (id: string) => string | null,
): string | null {
  const nodeRows = rows.filter((r) => r.kind === "node");
  const anchorIdx = nodeRows.findIndex((r) => r.nodeId === anchorId);
  if (anchorIdx < 0) return null;
  const anchorParent = parentOf(anchorId);
  // The anchor's visible sibling rows, in visible order (visible order IS sibling
  // order, and a hidden completed sibling is simply absent).
  const sibRows = nodeRows.filter((r) => parentOf(r.nodeId) === anchorParent);
  const anchorSibIdx = sibRows.findIndex((r) => r.nodeId === anchorId);
  if (anchorSibIdx < 0) return null;
  const framed = nodeRows.filter((r) => frames.has(r.id));
  if (framed.length === 0) return anchorId;
  const hit =
    framed.find((r) => frames.get(r.id)!.maxY > pointerY) ??
    framed[framed.length - 1];

  // Walk the hit row up to the anchor-level sibling that contains it (visited-set
  // guard — a corrupt tree could form a parent cycle).
  let target: string | null = null;
  let cur: string | null = hit.nodeId;
  const seen = new Set<string>();
  while (cur !== null) {
    if (seen.has(cur)) break;
    seen.add(cur);
    if (parentOf(cur) === anchorParent) {
      target = cur;
      break;
    }
    cur = parentOf(cur);
  }
  if (target !== null && sibRows.some((r) => r.nodeId === target)) return target;

  // Outside the anchor's parent subtree: clamp by which side of the anchor it's on.
  const hitIdx = nodeRows.findIndex((r) => r.id === hit.id);
  return hitIdx < anchorIdx
    ? sibRows[0].nodeId
    : sibRows[sibRows.length - 1].nodeId;
}

interface SelectionState {
  anchor: string | null;
  head: string | null;
  resolved: SelectionResolved | null;

  start(anchor: string, head: string): void;
  extendTo(head: string): void;
  /** Move the head one visible sibling up/down (⇧↑/⇧↓ while a selection is live). */
  step(dir: -1 | 1, hideCompleted: boolean): void;
  /** Re-resolve after a structural change (members may have moved/vanished). */
  refresh(): void;
  clear(): void;
  isActive(): boolean;
}

export const useSelection = create<SelectionState>((set, get) => ({
  anchor: null,
  head: null,
  resolved: null,

  start(anchor, head) {
    set({ anchor, head, resolved: resolve(anchor, head) });
  },
  extendTo(head) {
    const anchor = get().anchor ?? head;
    set({ anchor, head, resolved: resolve(anchor, head) });
  },
  step(dir, hideCompleted) {
    const { anchor, head } = get();
    if (!anchor || !head) return;
    const pair = resolveLevels(anchor, head);
    if (!pair) return;
    const [, h] = pair;
    const parent = mirror.get(h)?.parent ?? null;
    const sibs = mirror.childrenOf(parent);
    let i = sibs.indexOf(h) + dir;
    while (i >= 0 && i < sibs.length && hideCompleted && mirror.get(sibs[i])?.isCompleted) {
      i += dir;
    }
    if (i < 0 || i >= sibs.length) return;
    set({ anchor, head: sibs[i], resolved: resolve(anchor, sibs[i]) });
  },
  refresh() {
    const { anchor, head } = get();
    if (!anchor || !head) return;
    const resolved = resolve(anchor, head);
    if (!resolved || resolved.ids.length === 0) {
      set({ anchor: null, head: null, resolved: null });
    } else {
      set({ resolved });
    }
  },
  clear() {
    if (get().anchor === null) return;
    set({ anchor: null, head: null, resolved: null });
  },
  isActive() {
    return (get().resolved?.ids.length ?? 0) > 0;
  },
}));

/** Ordered member ids of the live selection ([] when none). */
export function selectionIds(): string[] {
  return useSelection.getState().resolved?.ids ?? [];
}

// Module-level state must never be split across HMR generations — a hot update that
// swapped this module would strand components on a fresh empty instance. Decline hot
// updates so edits here trigger a FULL reload instead.
if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
