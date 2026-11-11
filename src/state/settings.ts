import { create } from "zustand";
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
  set(patch: Partial<Persisted>): void;
  setAutoArchive(on: boolean): void;
  openSettings(open: boolean): void;
  loadBackend(): Promise<void>;
}

export const useSettings = create<SettingsState>((set, get) => ({
  ...load(),
  autoArchive: true,
  settingsOpen: false,

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
  openSettings(open) {
    set({ settingsOpen: open });
  },
  async loadBackend() {
    const v = await invoke<string | null>("get_setting", { key: "autoArchive" });
    set({ autoArchive: v !== "0" });
  },
}));

export function fontScale(fontSize: number): number {
  return OutlineLayout.scale(fontSize);
}

if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
