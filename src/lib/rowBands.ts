import type { RenderRow } from "./flatten";

/**
 * What changed between two flattens, by ROW id.
 *
 * Diffing the FLATTEN rather than the delta's op list is the whole trick: the `add:<id>`
 * placeholder rows are DERIVED, not stored (see flatten.ts), so creating a first child
 * mints TWO rows for ONE insert op and deleting the last child removes two. A completion
 * flip under hide-completed removes a whole SUBTREE with no delete op at all, and the
 * hide-completed toggle and the keepVisible grace expiry are not deltas in the first
 * place. One diff catches every one of those, and a change that moves nothing (a ⌘⇧F
 * highlight flip, a completion flip while hide-completed is OFF) falls out for free as
 * `firstChanged === -1`.
 */
export interface RowsDiff {
  /** Row ids present in `next` only. */
  entering: Set<string>;
  /** Row ids present in `prev` only. */
  leaving: Set<string>;
  /** First index at which the two flattens disagree; -1 when they are identical. */
  firstChanged: number;
}

export function diffRows(prev: RenderRow[], next: RenderRow[]): RowsDiff {
  const prevIds = new Set(prev.map((r) => r.id));
  const nextIds = new Set(next.map((r) => r.id));
  const entering = new Set<string>();
  const leaving = new Set<string>();
  for (const id of nextIds) if (!prevIds.has(id)) entering.add(id);
  for (const id of prevIds) if (!nextIds.has(id)) leaving.add(id);
  let firstChanged = -1;
  const n = Math.max(prev.length, next.length);
  for (let i = 0; i < n; i++) {
    if (prev[i]?.id !== next[i]?.id) {
      firstChanged = i;
      break;
    }
  }
  return { entering, leaving, firstChanged };
}

/**
 * The row the mount band hangs off — a row present in BOTH flattens, so it re-derives
 * itself in whichever index space `mountBand` is called in.
 *
 * `pastChange` picks WHICH survivor, and it is load-bearing rather than cosmetic, because
 * the band's reach is measured from the anchor's OLD y:
 *  - false (enter / reorder): the last row BEFORE the divergence. Survivors move DOWN, so
 *    everything that must glide is at or below that row and within a viewport of it.
 *  - true (leave): the first survivor AT OR AFTER the divergence, i.e. the row just past
 *    the removed block. Survivors move UP by the removed height Δ, so a row can travel
 *    into view from as far as Δ below the fold. Anchoring past the block puts Δ into the
 *    anchor's own y and the viewport-relative limit scales with it for free — the same
 *    self-scaling the drawer path gets from skipping the parent's child block. Anchor
 *    above the block instead and every survivor further than ~2 viewports down is never
 *    mounted at commit 1, so it has no FROM value and snaps.
 *
 * Either way, walk FORWARD to the first survivor (the change may start at index 0, or the
 * rows at the divergence may all be leaving). Null ⇒ no band, nothing survives below.
 */
export function anchorRowId(
  prev: RenderRow[],
  d: RowsDiff,
  surviving: ReadonlySet<string>,
  pastChange: boolean,
): string | null {
  let i = pastChange ? d.firstChanged : Math.max(0, d.firstChanged - 1);
  while (i < prev.length && !surviving.has(prev[i].id)) i++;
  return prev[i]?.id ?? null;
}
