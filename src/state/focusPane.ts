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
}

export const useFocusPane = create<FocusPaneState>((set, get) => ({
  order: load(),

  reconcile() {
    const highlighted = mirror.highlightedIds();
    const hset = new Set(highlighted);
    const kept = get().order.filter((id) => hset.has(id));
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
}));

if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
