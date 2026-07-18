import { create } from "zustand";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { OutlineLayout } from "../lib/layout";

/** Per-WINDOW view state — collapse, drill navigation, focus, font size, hide-completed.
 * The outline DATA is shared through the Rust store; everything here deliberately
 * diverges per window (the SwiftUI app's CollapseState / NavigationModel / OutlineFocus /
 * @SceneStorage split). Persisted per window label, with a device-level "last window
 * state" snapshot that seeds FRESH windows (⌘N inherits how the last one was left). */

export type CaretIntent =
  | { type: "start" }
  | { type: "end" }
  | { type: "at"; offset: number }
  | { type: "lastLineStart" };

export type FocusField = "main" | "note";

interface WindowState {
  collapsed: Set<string>;
  hideCompleted: boolean;
  fontSize: number;
  drill: string | null;
  back: (string | null)[];
  forward: (string | null)[];
  focusId: string | null;
  focusField: FocusField;
  caretIntent: CaretIntent;
  /** Bumped on every programmatic focus so re-focusing the same node re-applies the caret. */
  focusEpoch: number;
  /** Node exempt from the next defocus-prune (an intentional Enter-at-start split). */
  exemptPruneOnce: string | null;
  /** Just-completed nodes briefly held on screen under hide-completed. */
  keepVisible: Set<string>;

  toggleCollapse(id: string): void;
  setCollapsed(id: string, value: boolean): void;
  expandMany(ids: string[]): void;
  collapseAll(parentIds: string[]): void;
  expandAll(): void;
  setHideCompleted(on: boolean): void;
  adjustFont(step: number): void;
  resetFont(): void;
  drillIn(id: string | null): void;
  goBack(): void;
  goForward(): void;
  goHome(): void;
  /** Restore a drill level WITHOUT recording history (launch/restore). */
  restoreDrill(id: string | null): void;
  focusNode(id: string | null, field?: FocusField, caret?: CaretIntent): void;
  clearFocus(): void;
  setExemptPruneOnce(id: string | null): void;
  holdVisible(id: string, ms?: number): void;
  /** Drop references to deleted nodes (fired from the mirror's delete hook). */
  purgeDeleted(ids: Set<string>): void;
}

const label = getCurrentWebviewWindow().label;
const WIN_KEY = `pf.win.${label}`;
const DEVICE_KEY = "pf.lastWindowState";

interface PersistedShape {
  collapsed: string[];
  hideCompleted: boolean;
  fontSize: number;
  drill: string | null;
}

function loadInitial(): PersistedShape {
  try {
    const own = localStorage.getItem(WIN_KEY);
    if (own) return JSON.parse(own);
    // Fresh window: inherit the device's most recent window state.
    const device = localStorage.getItem(DEVICE_KEY);
    if (device) return JSON.parse(device);
  } catch {
    // fall through to defaults
  }
  return {
    collapsed: [],
    hideCompleted: false,
    fontSize: OutlineLayout.baseFontSize,
    drill: null,
  };
}

const initial = loadInitial();

export const useWindowState = create<WindowState>((set, get) => ({
  collapsed: new Set(initial.collapsed),
  hideCompleted: initial.hideCompleted,
  fontSize: OutlineLayout.clampFontSize(initial.fontSize),
  drill: initial.drill,
  back: [],
  forward: [],
  focusId: null,
  focusField: "main",
  caretIntent: { type: "end" },
  focusEpoch: 0,
  exemptPruneOnce: null,
  keepVisible: new Set(),

  toggleCollapse(id) {
    const next = new Set(get().collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    set({ collapsed: next });
  },
  setCollapsed(id, value) {
    const cur = get().collapsed;
    if (cur.has(id) === value) return;
    const next = new Set(cur);
    if (value) next.add(id);
    else next.delete(id);
    set({ collapsed: next });
  },
  expandMany(ids) {
    if (ids.length === 0) return;
    const cur = get().collapsed;
    if (!ids.some((id) => cur.has(id))) return;
    const next = new Set(cur);
    for (const id of ids) next.delete(id);
    set({ collapsed: next });
  },
  collapseAll(parentIds) {
    const next = new Set(get().collapsed);
    for (const id of parentIds) next.add(id);
    set({ collapsed: next });
  },
  expandAll() {
    set({ collapsed: new Set() });
  },
  setHideCompleted(on) {
    set({ hideCompleted: on });
  },
  adjustFont(step) {
    set({ fontSize: OutlineLayout.clampFontSize(get().fontSize + step) });
  },
  resetFont() {
    set({ fontSize: OutlineLayout.baseFontSize });
  },

  drillIn(id) {
    const { drill, back } = get();
    if (id === drill) return;
    set({ drill: id, back: [...back, drill], forward: [] });
  },
  goBack() {
    const { back, forward, drill } = get();
    if (back.length === 0) return;
    const prev = back[back.length - 1];
    set({
      drill: prev,
      back: back.slice(0, -1),
      forward: [...forward, drill],
    });
  },
  goForward() {
    const { back, forward, drill } = get();
    if (forward.length === 0) return;
    const next = forward[forward.length - 1];
    set({
      drill: next,
      forward: forward.slice(0, -1),
      back: [...back, drill],
    });
  },
  goHome() {
    get().drillIn(null);
  },
  restoreDrill(id) {
    set({ drill: id, back: [], forward: [] });
  },

  focusNode(id, field = "main", caret = { type: "end" }) {
    set({
      focusId: id,
      focusField: field,
      caretIntent: caret,
      focusEpoch: get().focusEpoch + 1,
    });
  },
  clearFocus() {
    set({ focusId: null, focusField: "main" });
  },
  setExemptPruneOnce(id) {
    set({ exemptPruneOnce: id });
  },

  holdVisible(id, ms = 1400) {
    const next = new Set(get().keepVisible);
    next.add(id);
    set({ keepVisible: next });
    setTimeout(() => {
      const cur = get().keepVisible;
      if (!cur.has(id)) return;
      const after = new Set(cur);
      after.delete(id);
      set({ keepVisible: after });
    }, ms);
  },

  purgeDeleted(ids) {
    const s = get();
    const patch: Partial<WindowState> = {};
    if (s.focusId && ids.has(s.focusId)) {
      patch.focusId = null;
      patch.focusField = "main";
    }
    if (s.drill && ids.has(s.drill)) {
      patch.drill = null;
      patch.back = [];
      patch.forward = [];
    } else {
      // Prune deleted ids out of the history stacks so Back never lands on a ghost.
      const clean = (stack: (string | null)[]) =>
        stack.filter((x) => x === null || !ids.has(x));
      const back = clean(s.back);
      const forward = clean(s.forward);
      if (back.length !== s.back.length) patch.back = back;
      if (forward.length !== s.forward.length) patch.forward = forward;
    }
    if (Object.keys(patch).length > 0) set(patch);
  },
}));

// Persist (debounced) — per-window restore + the device seed for fresh windows.
let persistTimer: ReturnType<typeof setTimeout> | null = null;
useWindowState.subscribe((s) => {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const payload: PersistedShape = {
      collapsed: [...s.collapsed],
      hideCompleted: s.hideCompleted,
      fontSize: s.fontSize,
      drill: s.drill,
    };
    try {
      const json = JSON.stringify(payload);
      localStorage.setItem(WIN_KEY, json);
      localStorage.setItem(DEVICE_KEY, json);
    } catch {
      // storage full/unavailable — view state is best-effort
    }
  }, 250);
});

export const windowLabel = label;

// Module-level state must never be split across HMR generations — a hot update that
// swapped this module would strand components on a fresh empty instance. Decline hot
// updates so edits here trigger a FULL reload instead.
if (import.meta.hot) {
  import.meta.hot.decline();
}
