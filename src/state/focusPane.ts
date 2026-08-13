import { create } from "zustand";
import { mirror } from "./mirror";

/** The focus pane's DEVICE-LOCAL priority order over the highlighted (⌘⇧F) nodes —
 * the FocusOrderStore port. The highlighted SET lives on the nodes (shared store);
 * only the pane's order is per-device. Reconcile appends newcomers to the BOTTOM in
 * (updatedAt, id) order and prunes anything no longer highlighted. */

const KEY = "pf.focusOrder";

function load(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // fall through
  }
  return [];
}

/** The DEVICE's persisted order, read fresh — for the outline export. Every mutation
 * (move/adopt/reconcile, in any window) persists synchronously, so the key is never
 * behind any window's memory; a peer window's memory, seeded once at module init, CAN
 * be behind the key (a drag in another window broadcasts nothing), and exporting that
 * stale copy would silently record a pre-drag order into a disaster-recovery file.
 * Falls back to this window's memory only when the key is empty/unreadable. */
export function persistedFocusOrder(): string[] {
  const stored = load();
  return stored.length ? stored : useFocusPane.getState().order;
}

/** The rev the last adopted order was minted at (the import delta's rev) — see
 * reconcile. Session-only: by the next launch the snapshot covers the import. */
let adoptRev = 0;

function persist(order: string[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(order));
  } catch {
    // best-effort
  }
}

interface FocusPaneState {
  order: string[];
  reconcile(): void;
  move(from: number, to: number): void;
  adopt(order: string[], rev: number): void;
}

export const useFocusPane = create<FocusPaneState>((set, get) => ({
  order: load(),

  reconcile() {
    const highlighted = mirror.highlightedIds();
    const hset = new Set(highlighted);
    // An id ABSENT from the mirror is pruned as dead only once the mirror has caught
    // up to the rev the adopted order was minted at. Before that, absence means "from
    // a delta this window hasn't processed yet" — an import's fresh ids arrive here
    // via the adopt broadcast, and a reconcile against a pre-import mirror (a stale
    // rev-gap snapshot resolving late, a window mid-spawn) must not prune and PERSIST
    // over the order the import just restored. Present-but-unhighlighted is pruned
    // regardless — that is a real un-⌘⇧F, not mirror lag.
    const keep = (id: string) =>
      hset.has(id) || (!mirror.get(id) && mirror.rev() < adoptRev);
    const kept = get().order.filter(keep);
    const keptSet = new Set(kept);
    const newcomers = highlighted
      .filter((id) => !keptSet.has(id))
      .sort((a, b) => {
        const ua = mirror.get(a)?.updatedAt ?? 0;
        const ub = mirror.get(b)?.updatedAt ?? 0;
        if (ua !== ub) return ua - ub;
        return a < b ? -1 : 1;
      });
    const order = [...kept, ...newcomers];
    if (
      order.length !== get().order.length ||
      order.some((id, i) => get().order[i] !== id)
    ) {
      set({ order });
      persist(order);
    }
  },

  move(from, to) {
    const order = [...get().order];
    if (from < 0 || from >= order.length) return;
    const [x] = order.splice(from, 1);
    order.splice(Math.max(0, Math.min(to, order.length)), 0, x);
    set({ order });
    persist(order);
  },

  /** Replace the order wholesale — an outline import carries the exporting device's
   * pane order mapped to the FRESH ids, and every window adopts it (see doImport).
   * `rev` is the import delta's rev: until this window's mirror reaches it, reconcile
   * treats the adopted ids as not-yet-known rather than dead (see the keep rule).
   * The immediate reconcile is what appends highlighted-but-UNRANKED nodes (an
   * archive written by Clear Completed carries flags but no ranks) — without it they
   * stay off the pane until the next structural change, since a bare adopt bumps no
   * structure version. */
  adopt(order, rev) {
    adoptRev = Math.max(adoptRev, rev);
    set({ order: [...order] });
    persist(order);
    get().reconcile();
  },
}));

if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
