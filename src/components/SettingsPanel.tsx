import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Theme } from "../lib/layout";
import { mirror } from "../state/mirror";
import { useSettings } from "../state/settings";
import { useWindowState } from "../state/windowState";

function todayStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Settings — appearance (highlight color, indent guides, background tint) and Data
 * (export/import, Clear Completed, archive). A modal sheet, per window. */
export function SettingsPanel() {
  const s = useSettings();
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (s.settingsOpen) void s.loadBackend();
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
    const n = await invoke<number>("export_to_file", { path, collapsed });
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
    const out = await invoke<{ imported: number; collapsed: string[] }>(
      "import_from_file",
      { path },
    );
    const ws = useWindowState.getState();
    ws.restoreDrill(null);
    ws.clearFocus();
    // The file's collapse flags seed THIS window's collapse state.
    ws.expandAll();
    ws.collapseAll(out.collapsed);
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
    useWindowState.getState().setHideCompleted(false);
    setNotice(`Archived ${out.archived} nodes to ${out.path.split("/").pop()}.`);
  };

  const doReveal = async () => {
    const dir = await invoke<string>("archive_dir_path");
    await revealItemInDir(dir);
  };

  return (
    <>
      <div className="menu-backdrop" onClick={() => s.openSettings(false)} />
      <div className="settings-panel">
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
        {notice && <div className="settings-notice">{notice}</div>}
        <div className="settings-footnote">
          {mirror.nodeCount()} nodes in the outline
        </div>
      </div>
    </>
  );
}
