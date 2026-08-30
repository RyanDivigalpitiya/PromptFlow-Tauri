import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { emitFocusOrderAdopt } from "../lib/api";
import { OutlineLayout, Theme } from "../lib/layout";
import { setHideCompleted } from "../state/controller";
import { persistedFocusOrder, useFocusPane } from "../state/focusPane";
import { mirror } from "../state/mirror";
import { useSettings } from "../state/settings";
import { agoLabel, useSync } from "../state/sync";
import { useWindowState } from "../state/windowState";

function todayStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Sync configuration and state.
 *
 * The two SECRETS are write-only from here: the backend reports only whether each one is
 * present in the login Keychain, and an empty field on save means "leave it alone" — so
 * opening the panel and pressing Save never wipes a working credential.
 *
 * The error line is deliberately verbose. Everything this feature can do wrong looks
 * identical from the outline ("my iPad doesn't have it"), so the one place that knows the
 * difference between a wrong token, a sleeping office and a paused mass delete has to
 * say which. */
function SyncSection() {
  const { status, config, save, syncNow, confirmMassDelete } = useSync();
  const [url, setUrl] = useState<string | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const [bearer, setBearer] = useState("");
  const [secret, setSecret] = useState("");
  const [saved, setSaved] = useState(false);

  if (!config) return <div className="settings-footnote">Loading…</div>;

  // The inputs are uncontrolled until first touched, so a status event arriving
  // mid-typing cannot yank the field out from under the cursor.
  const urlValue = url ?? config.url;
  const idValue = clientId ?? config.accessClientId;

  const commit = async (enabled: boolean) => {
    await save({
      url: urlValue,
      accessClientId: idValue,
      bearer,
      accessClientSecret: secret,
      enabled,
    });
    setBearer("");
    setSecret("");
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <>
      <label className="settings-row">
        <span>Sync with the hub</span>
        <input
          type="checkbox"
          checked={config.enabled}
          onChange={(e) => void commit(e.target.checked)}
        />
      </label>
      <label className="settings-row settings-row-stack">
        <span>Server URL</span>
        <input
          type="text"
          placeholder="https://pf-sync.example.com"
          value={urlValue}
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>
      <label className="settings-row settings-row-stack">
        <span>Access client ID</span>
        <input
          type="text"
          placeholder="leave empty for a local server"
          value={idValue}
          onChange={(e) => setClientId(e.target.value)}
        />
      </label>
      <label className="settings-row settings-row-stack">
        <span>Bearer token {config.hasBearer && <em>· set</em>}</span>
        <input
          type="password"
          placeholder={config.hasBearer ? "unchanged" : "required"}
          value={bearer}
          onChange={(e) => setBearer(e.target.value)}
        />
      </label>
      <label className="settings-row settings-row-stack">
        <span>Access client secret {config.hasAccessSecret && <em>· set</em>}</span>
        <input
          type="password"
          placeholder={config.hasAccessSecret ? "unchanged" : "leave empty for a local server"}
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
        />
      </label>
      <div className="settings-actions">
        <button className="mini-btn" onClick={() => void commit(config.enabled)}>
          {saved ? "Saved" : "Save Sync Settings"}
        </button>
        <button className="mini-btn" disabled={!config.enabled} onClick={syncNow}>
          Sync Now
        </button>
      </div>

      <div className={`sync-state${status.error ? " sync-state-error" : ""}`}>
        {!config.enabled ? (
          "Sync is off. This Mac keeps working exactly as before."
        ) : (
          <>
            <div>
              {status.syncing
                ? "Syncing…"
                : `Last synced ${agoLabel(status.lastSyncedAt)}`}
              {status.pending > 0 && ` · ${status.pending} waiting to send`}
            </div>
            {status.error && <div className="sync-error">{status.error}</div>}
          </>
        )}
      </div>

      {status.blockedDeletes != null && status.blockedDeletes > 0 && (
        <div className="sync-confirm">
          <div>
            {status.blockedDeletes} deletion
            {status.blockedDeletes === 1 ? "" : "s"} are waiting. The server holds back an
            unusually large delete until you say so, in case another device is about to
            lose work it still wants.
          </div>
          <button className="mini-btn" onClick={confirmMassDelete}>
            Send the deletions
          </button>
        </div>
      )}
      <div className="settings-footnote">
        this device: {config.deviceId.slice(0, 8)}
      </div>
    </>
  );
}

/** Settings — appearance (highlight color, indent guides, background tint), Data
 * (export/import, Clear Completed, archive) and Sync. A modal sheet, per window. */
export function SettingsPanel() {
  const s = useSettings();
  const [notice, setNotice] = useState<string | null>(null);
  const fontSize = useWindowState((st) => st.fontSize);
  // The panel rides ⌘+/⌘− (all internals are em); clamped so it neither
  // shrinks unreadably nor outgrows the window.
  const ss = Math.min(Math.max(OutlineLayout.scale(fontSize), 0.9), 2.2);

  useEffect(() => {
    if (s.settingsOpen) {
      void s.loadBackend();
      void useSync.getState().loadConfig();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.settingsOpen]);

  if (!s.settingsOpen) return null;

  const doExport = async () => {
    const path = await saveDialog({
      defaultPath: `PromptFlow Outline ${todayStamp()}.json`,
      filters: [{ name: "PromptFlow Outline", extensions: ["json"] }],
    });
    if (!path) return;
    const collapsed = [...useWindowState.getState().collapsed];
    // The pane's order is device-local (pf.focusOrder) and import mints fresh ids, so
    // the file is the only carrier that survives a backup/restore round trip. Read the
    // PERSISTED key, not this window's memory — a drag in another window persists but
    // doesn't broadcast, and a stale copy here would silently back up a pre-drag order.
    const focusOrder = persistedFocusOrder();
    const n = await invoke<number>("export_to_file", { path, collapsed, focusOrder });
    setNotice(`Exported ${n} nodes.`);
  };

  const doImport = async () => {
    const path = await openDialog({
      multiple: false,
      filters: [{ name: "PromptFlow Outline", extensions: ["json"] }],
    });
    if (typeof path !== "string") return;
    const ok = window.confirm(
      "Importing replaces the ENTIRE outline in every window. This cannot be undone. Continue?",
    );
    if (!ok) return;
    const out = await invoke<{
      imported: number;
      collapsed: string[];
      focusOrder: string[];
      rev: number;
    }>("import_from_file", { path });
    const ws = useWindowState.getState();
    ws.restoreDrill(null);
    ws.clearFocus();
    // The file's collapse flags seed THIS window's collapse state.
    ws.expandAll();
    ws.collapseAll(out.collapsed);
    // The file's focus-pane order (mapped to the fresh ids) becomes the device's,
    // broadcast so a peer window's reconcile of the import delta can't persist its
    // rebuilt-by-updatedAt order over it.
    useFocusPane.getState().adopt(out.focusOrder, out.rev);
    void emitFocusOrderAdopt(out.focusOrder, out.rev);
    setNotice(`Imported ${out.imported} nodes.`);
  };

  const doClearCompleted = async () => {
    const info = await invoke<{ units: number; nodes: number }>(
      "completed_units_info",
    );
    if (info.nodes === 0) {
      setNotice("Nothing completed to clear.");
      return;
    }
    const ok = window.confirm(
      `Archive and remove ${info.nodes} completed node${info.nodes === 1 ? "" : "s"} ` +
        `(${info.units} top-level item${info.units === 1 ? "" : "s"})? ` +
        "They are saved to an archive file first. This cannot be undone in-app.",
    );
    if (!ok) return;
    const out = await invoke<{ archived: number; path: string }>(
      "clear_completed",
    );
    setHideCompleted(false);
    setNotice(`Archived ${out.archived} nodes to ${out.path.split("/").pop()}.`);
  };

  const doReveal = async () => {
    const dir = await invoke<string>("archive_dir_path");
    await revealItemInDir(dir);
  };

  return (
    <>
      <div className="menu-backdrop" onClick={() => s.openSettings(false)} />
      <div
        className="settings-panel"
        style={{ fontSize: 13 * ss, width: 340 * ss }}
      >
        <div className="settings-head">
          <span>Settings</span>
          <button className="bar-btn" onClick={() => s.openSettings(false)}>
            ✕
          </button>
        </div>

        <div className="settings-section">UI Style</div>
        <label className="settings-row">
          <span>Highlight color</span>
          <span className="settings-controls">
            <input
              type="color"
              value={s.highlightColor}
              onChange={(e) => s.set({ highlightColor: e.target.value })}
            />
            <button
              className="mini-btn"
              onClick={() => s.set({ highlightColor: Theme.defaultHighlightHex })}
            >
              Reset
            </button>
          </span>
        </label>
        <label className="settings-row">
          <span>Indent guides</span>
          <span className="settings-controls">
            <input
              type="checkbox"
              checked={s.showIndentGuides}
              onChange={(e) => s.set({ showIndentGuides: e.target.checked })}
            />
            <input
              type="color"
              value={s.indentGuideColor}
              disabled={!s.showIndentGuides}
              onChange={(e) => s.set({ indentGuideColor: e.target.value })}
            />
          </span>
        </label>
        <label className="settings-row">
          <span>Background dim</span>
          <input
            type="range"
            min={0}
            max={Theme.maxBgTint}
            step={0.05}
            value={s.bgTint}
            onChange={(e) => s.set({ bgTint: Number(e.target.value) })}
          />
        </label>

        <div className="settings-section">Data</div>
        <label className="settings-row">
          <span>Auto-archive completed after 3 days</span>
          <input
            type="checkbox"
            checked={s.autoArchive}
            onChange={(e) => s.setAutoArchive(e.target.checked)}
          />
        </label>
        <div className="settings-actions">
          <button className="mini-btn" onClick={() => void doExport()}>
            Export Outline…
          </button>
          <button className="mini-btn" onClick={() => void doImport()}>
            Import Outline…
          </button>
          <button className="mini-btn" onClick={() => void doClearCompleted()}>
            Clear Completed…
          </button>
          <button className="mini-btn" onClick={() => void doReveal()}>
            Reveal Archive in Finder
          </button>
        </div>
        <div className="settings-section">Prompt Templates</div>
        {s.templates.length === 0 ? (
          <div className="settings-footnote">
            None found. Add a file to <code>prompt-templates/</code> in the repo and
            rebuild.
          </div>
        ) : (
          s.templates.map((t) => (
            <label key={t.id} className="settings-row settings-row-stack">
              <span>{t.id}</span>
              <span className="settings-tpl">
                <input
                  type="text"
                  value={t.name}
                  placeholder={t.defaultName}
                  onChange={(e) => s.setTemplateName(t.id, e.target.value)}
                />
                <button
                  className="mini-btn"
                  disabled={t.name.trim() === "" || t.name === t.defaultName}
                  onClick={() => s.setTemplateName(t.id, "", true)}
                >
                  Reset
                </button>
              </span>
            </label>
          ))
        )}
        <div className="settings-footnote">
          What a prompt's ⋯ menu calls each template. Names are stored on this Mac; the
          templates themselves ship with the app.
        </div>

        <div className="settings-section">Sync</div>
        <SyncSection />

        {notice && <div className="settings-notice">{notice}</div>}
        <div className="settings-footnote">
          {mirror.nodeCount()} nodes in the outline
        </div>
      </div>
    </>
  );
}
