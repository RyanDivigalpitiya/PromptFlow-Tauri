import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** Sync status, mirrored from the Rust sync thread.
 *
 * Read-only state: the thread is the source of truth and pushes every change as a
 * `sync://status` event to EVERY window, exactly as the store's deltas do. Nothing here
 * ever decides anything — a window that computed its own idea of "synced" would disagree
 * with its peers the moment one of them was in the middle of a cycle. */

export interface SyncStatus {
  configured: boolean;
  syncing: boolean;
  lastSyncedAt: number | null;
  error: string | null;
  /** Consecutive failures. One is a dropped request; several is a problem. */
  failures: number;
  /** Nodes queued for the hub. */
  pending: number;
  /** Deletes held back by the hub's mass-delete tripwire, awaiting an explicit
   * confirmation. Never resolved automatically — that is the whole point of it. */
  blockedDeletes: number | null;
}

export interface SyncConfig {
  url: string;
  accessClientId: string;
  enabled: boolean;
  /** Whether each secret is present in the login Keychain. The VALUES never cross into
   * the webview — a renderer has no business holding them, and the panel only needs to
   * know whether to say "set". */
  hasBearer: boolean;
  hasAccessSecret: boolean;
  deviceId: string;
}

interface SyncState {
  status: SyncStatus;
  config: SyncConfig | null;
  loadConfig(): Promise<void>;
  save(patch: {
    url: string;
    accessClientId: string;
    bearer?: string;
    accessClientSecret?: string;
    enabled: boolean;
  }): Promise<void>;
  syncNow(): void;
  confirmMassDelete(): void;
}

const idle: SyncStatus = {
  configured: false,
  syncing: false,
  lastSyncedAt: null,
  error: null,
  failures: 0,
  pending: 0,
  blockedDeletes: null,
};

export const useSync = create<SyncState>((set) => ({
  status: idle,
  config: null,

  async loadConfig() {
    const [config, status] = await Promise.all([
      invoke<SyncConfig>("sync_get_config"),
      invoke<SyncStatus>("sync_status"),
    ]);
    set({ config, status });
  },

  async save(patch) {
    await invoke("sync_set_config", {
      url: patch.url,
      accessClientId: patch.accessClientId,
      // An omitted secret means "leave the Keychain alone", so the panel can show a
      // blank field without wiping a working credential every time it is saved.
      bearer: patch.bearer || null,
      accessClientSecret: patch.accessClientSecret || null,
      enabled: patch.enabled,
    });
    const config = await invoke<SyncConfig>("sync_get_config");
    set({ config });
  },

  syncNow() {
    void invoke("sync_now");
  },

  confirmMassDelete() {
    void invoke("sync_confirm_mass_delete");
  },
}));

void listen<SyncStatus>("sync://status", (e) => {
  useSync.setState({ status: e.payload });
});

/** "3 minutes ago" — deliberately coarse. The exact second is never the question; "is it
 * keeping up" is, and a relative phrase answers that at a glance. */
export function agoLabel(ms: number | null): string {
  if (ms == null) return "never";
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
