import { create } from "zustand";
import { api, type PromptTemplateInfo } from "../lib/api";
import { invoke } from "@tauri-apps/api/core";
import { OutlineLayout, Theme } from "../lib/layout";

/** Appearance settings — device-local (localStorage, the UserDefaults analogue), NOT
 * synced across windows' view state: every window reads the same device values. The
 * auto-archive toggle lives in the BACKEND settings table (the sweep runs at launch,
 * before any window exists). */

const KEY = "pf.appearance";

interface Persisted {
  highlightColor: string;
  showIndentGuides: boolean;
  indentGuideColor: string;
  bgTint: number;
}

function load(): Persisted {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...defaults, ...JSON.parse(raw) };
  } catch {
    // fall through
  }
  return { ...defaults };
}

const defaults: Persisted = {
  highlightColor: Theme.defaultHighlightHex,
  showIndentGuides: true,
  indentGuideColor: Theme.defaultIndentGuideHex,
  bgTint: Theme.defaultBgTint,
};

interface SettingsState extends Persisted {
  autoArchive: boolean;
  settingsOpen: boolean;
  /** The compiled-in prompt templates, with the display name each one currently shows. */
  templates: PromptTemplateInfo[];
  set(patch: Partial<Persisted>): void;
  setAutoArchive(on: boolean): void;
  setTemplateName(id: string, name: string, reset?: boolean): void;
  openSettings(open: boolean): void;
  loadBackend(): Promise<void>;
}

export const useSettings = create<SettingsState>((set, get) => ({
  ...load(),
  autoArchive: true,
  settingsOpen: false,
  templates: [],

  set(patch) {
    set(patch);
    const s = get();
    const persisted: Persisted = {
      highlightColor: s.highlightColor,
      showIndentGuides: s.showIndentGuides,
      indentGuideColor: s.indentGuideColor,
      bgTint: Math.min(Theme.maxBgTint, Math.max(0, s.bgTint)),
    };
    try {
      localStorage.setItem(KEY, JSON.stringify(persisted));
    } catch {
      // best-effort
    }
  },
  setAutoArchive(on) {
    set({ autoArchive: on });
    void invoke("set_setting", { key: "autoArchive", value: on ? "1" : "0" });
  },
  /** Rename a template, or reset it by passing "". The override lives in the BACKEND
   * settings table rather than localStorage because the ⋯ menu is built in Rust — which
   * is also why no delta is needed: every window's next menu reads the new name. The
   * local copy is updated optimistically so the field stays under the cursor. */
  /** `reset` distinguishes "the user pressed Reset" from "the user typed the field
   * empty". Both clear the override in the backend, but only Reset puts the derived name
   * back in the FIELD — folding an empty typed value to the default made a controlled
   * input rewrite itself mid-edit, so the field could never be cleared (hold-Backspace
   * deleted down to one character and then refilled) and the placeholder was
   * unreachable. */
  setTemplateName(id, name, reset = false) {
    set({
      templates: get().templates.map((t) =>
        t.id === id ? { ...t, name: reset ? t.defaultName : name } : t,
      ),
    });
    void api.setPromptTemplateName(id, reset ? "" : name);
  },
  openSettings(open) {
    set({ settingsOpen: open });
  },
  async loadBackend() {
    const v = await invoke<string | null>("get_setting", { key: "autoArchive" });
    set({ autoArchive: v !== "0" });
    try {
      // Shape-guarded, not just error-guarded: anything but an array here would throw
      // inside the panel's `.map` during render and blank the WHOLE settings sheet,
      // taking sync config and Clear Completed down with a feature nobody was using.
      const list = await api.promptTemplates();
      set({ templates: Array.isArray(list) ? list : [] });
    } catch {
      // An older backend, or none at all — the section just renders empty.
    }
  },
}));

export function fontScale(fontSize: number): number {
  return OutlineLayout.scale(fontSize);
}

if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
