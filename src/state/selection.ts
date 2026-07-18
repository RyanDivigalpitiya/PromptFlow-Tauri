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
  import.meta.hot.decline();
}
