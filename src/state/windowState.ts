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

/** Focus pane docking: the current top strip, or a left-anchored resizable sidebar. */
export type FocusPaneLayout = "top" | "sidebar";

export const FOCUS_SIDEBAR_MIN = 180;
export const FOCUS_SIDEBAR_MAX = 640;
export function clampSidebarWidth(w: number): number {
  return Math.min(FOCUS_SIDEBAR_MAX, Math.max(FOCUS_SIDEBAR_MIN, Math.round(w)));
}

/** Top-strip height: "auto" fits content (bottom edge tracks the last pinned row, grows
 * with new pins), or a dragged fixed px. The upper bound is a FRACTION of the body, kept
 * in CSS (`max-height`) so a window resize can't strand a persisted px too tall; only the
 * lower bound is enforced here. */
export type FocusTopHeight = number | "auto";
export const FOCUS_TOP_MIN = 60;
export const FOCUS_TOP_MAX_FRACTION = 0.6;
export function clampTopHeight(h: FocusTopHeight): FocusTopHeight {
  return h === "auto" ? "auto" : Math.max(FOCUS_TOP_MIN, Math.round(h));
}

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
  /** The focus pane strip (⌘⌥F / the ⭐ button) — per window. */
  focusPaneExpanded: boolean;
  /** Where the focus pane docks: top strip or left sidebar — per window. */
  focusPaneLayout: FocusPaneLayout;
  /** The left-sidebar width in px (resizable, persisted) — per window. */
  focusSidebarWidth: number;
  /** The top-strip height: "auto" (content-fit) or a dragged px — per window. */
  focusTopHeight: FocusTopHeight;

  toggleCollapse(id: string): void;
  setCollapsed(id: string, value: boolean): void;
  expandMany(ids: string[]): void;
  collapseAll(parentIds: string[]): void;
  expandAll(): void;
  setHideCompleted(on: boolean): void;
  adjustFont(step: number): void;
  /** Absolute size (clamped) — the pinch gesture's continuous path. */
  setFont(size: number): void;
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
  /** Add to the just-completed grace set. TIMER-FREE by design: the release has to run
   * through controller.holdVisible so it can animate, exactly as a collapse has to run
   * through controller.setCollapsed. A bare `set({keepVisible})` snaps. */
  holdVisible(id: string): void;
  releaseVisible(ids: readonly string[]): void;
  toggleFocusPane(): void;
  toggleFocusPaneLayout(): void;
  setFocusSidebarWidth(w: number): void;
  setFocusTopHeight(h: FocusTopHeight): void;
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
  focusPaneExpanded?: boolean;
  focusPaneLayout?: FocusPaneLayout;
  focusSidebarWidth?: number;
  focusTopHeight?: FocusTopHeight;
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
  focusPaneExpanded: initial.focusPaneExpanded ?? false,
  focusPaneLayout: initial.focusPaneLayout ?? "top",
  focusSidebarWidth: clampSidebarWidth(initial.focusSidebarWidth ?? 280),
  focusTopHeight: clampTopHeight(initial.focusTopHeight ?? "auto"),

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
  setFont(size) {
    const next = OutlineLayout.clampFontSize(Math.round(size));
    if (next !== get().fontSize) set({ fontSize: next });
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

  holdVisible(id) {
    const cur = get().keepVisible;
    if (cur.has(id)) return;
    const next = new Set(cur);
    next.add(id);
    set({ keepVisible: next });
  },
  releaseVisible(ids) {
    const cur = get().keepVisible;
    const next = new Set(cur);
    for (const id of ids) next.delete(id);
    if (next.size === cur.size) return;
    set({ keepVisible: next });
  },

  toggleFocusPane() {
    set({ focusPaneExpanded: !get().focusPaneExpanded });
  },
  toggleFocusPaneLayout() {
    set({
      focusPaneLayout: get().focusPaneLayout === "top" ? "sidebar" : "top",
    });
  },
  setFocusSidebarWidth(w) {
    set({ focusSidebarWidth: clampSidebarWidth(w) });
  },
  setFocusTopHeight(h) {
    set({ focusTopHeight: clampTopHeight(h) });
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
      focusPaneExpanded: s.focusPaneExpanded,
      focusPaneLayout: s.focusPaneLayout,
      focusSidebarWidth: s.focusSidebarWidth,
      focusTopHeight: s.focusTopHeight,
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
  import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
