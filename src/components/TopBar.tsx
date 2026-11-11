import { useMemo, useSyncExternalStore } from "react";
import { api } from "../lib/api";
import { OutlineLayout } from "../lib/layout";
import { setHideCompleted } from "../state/controller";
import { mirror, nodeVersion, subscribeNode } from "../state/mirror";
import { useSettings } from "../state/settings";
import { useSync } from "../state/sync";
import {
  FOCUS_DOCK_SWITCHER,
  type FocusPaneLayout,
  useWindowState,
} from "../state/windowState";

/** Toolbar icons ride ⌘+/⌘− but CAPPED so the buttons never outgrow the fixed
 * 44px strip — the traffic lights can't move at runtime, so the row's midline
 * (and therefore the strip height) must stay put for them to stay aligned. */
export function topbarScale(fontSize: number): number {
  return Math.min(Math.max(OutlineLayout.scale(fontSize), 1), 1.8);
}

function DrillTitle({ id }: { id: string }) {
  const subscribe = useMemo(() => subscribeNode(id), [id]);
  useSyncExternalStore(subscribe, () => nodeVersion(id));
  const rec = mirror.get(id);
  return <span className="topbar-title">{rec?.text || "Untitled"}</span>;
}

/** A cloud with a slash, shown ONLY while sync has failed repeatedly or is holding back
 * a large delete.
 *
 * Deliberately absent the rest of the time — including during an ordinary cycle. A
 * spinner that blinks on every keystroke's debounce would train the eye to ignore this
 * corner, which is exactly the wrong reflex for the one state that matters: the outline
 * silently no longer reaching the other device. A single failure is a dropped request on
 * a train; two in a row is a problem worth a glance. */
function SyncIndicator({ scale }: { scale: number }) {
  const status = useSync((s) => s.status);
  const blocked = (status.blockedDeletes ?? 0) > 0;
  if (!status.configured || (status.failures < 2 && !blocked)) return null;
  return (
    <button
      className="bar-btn sync-indicator"
      onClick={() => useSettings.getState().openSettings(true)}
      title={status.error ?? "Sync needs attention"}
      aria-label="Sync needs attention"
    >
      <svg
        width={14 * scale}
        height={14 * scale}
        viewBox="0 0 14 14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
      >
        <path d="M4 10.4 A2.4 2.4 0 0 1 4.2 5.7 A3.1 3.1 0 0 1 10.1 5.2 A2.6 2.6 0 0 1 10.2 10.4 Z" />
        <line x1="2.4" y1="12.2" x2="11.6" y2="2.4" strokeWidth="1.3" />
      </svg>
    </button>
  );
}

/** A window-panel glyph whose filled region is where the focus pane docks — the left
 * column (sidebar) or the top strip (top). The sidebar form is the focus button's icon;
 * the switcher, when offered, shows the CURRENT dock with it. */
function DockGlyph({ dock, size }: { dock: FocusPaneLayout; size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.1"
    >
      <rect x="1.6" y="1.6" width="10.8" height="10.8" rx="2.2" />
      {dock === "sidebar" ? (
        <>
          <rect
            x="1.6"
            y="1.6"
            width="4.1"
            height="10.8"
            rx="2.2"
            fill="currentColor"
            fillOpacity="0.4"
            stroke="none"
          />
          <line x1="5.7" y1="1.6" x2="5.7" y2="12.4" />
        </>
      ) : (
        <>
          <rect
            x="1.6"
            y="1.6"
            width="10.8"
            height="4.1"
            rx="2.2"
            fill="currentColor"
            fillOpacity="0.4"
            stroke="none"
          />
          <line x1="1.6" y1="5.7" x2="12.4" y2="5.7" />
        </>
      )}
    </svg>
  );
}

/** A page with a folded corner and a markdown-ish body: a short heading line over two
 * text lines. Same 14-unit grid and 1.1 stroke as the other TopBar icons. */
function TemplatesGlyph({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.1"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3.1 1.8 H8.3 L10.9 4.4 V12.2 H3.1 Z" />
      <path d="M8.3 1.8 V4.4 H10.9" />
      <path d="M5 6.7 H7.2" strokeWidth="1.4" />
      <path d="M5 8.7 H9" />
      <path d="M5 10.4 H8.2" />
    </svg>
  );
}

/** The window chrome strip: nav back/forward/home, the drill title, hide-completed.
 * Chrome-less: no background or divider — it reads as part of the content area,
 * with the traffic lights vertically centered on the same line (trafficLightPosition).
 * "deep" drag region: anywhere in the strip drags the window except the buttons. */
export function TopBar() {
  const drill = useWindowState((s) => s.drill);
  const canBack = useWindowState((s) => s.back.length > 0);
  const canForward = useWindowState((s) => s.forward.length > 0);
  const hideCompleted = useWindowState((s) => s.hideCompleted);
  const focusPane = useWindowState((s) => s.focusPaneExpanded);
  const focusLayout = useWindowState((s) => s.focusPaneLayout);
  const fontSize = useWindowState((s) => s.fontSize);
  const ts = topbarScale(fontSize);
  const s = useWindowState.getState;

  return (
    <div
      className="topbar"
      data-tauri-drag-region="deep"
      style={{ fontSize: 16 * ts }}
    >
      <div className="topbar-left">
        <button
          className="bar-btn"
          disabled={!canBack}
          onClick={() => s().goBack()}
          title="Back"
        >
          ‹
        </button>
        <button
          className="bar-btn"
          disabled={!canForward}
          onClick={() => s().goForward()}
          title="Forward"
        >
          ›
        </button>
        {drill && (
          <button
            className="bar-btn home"
            onClick={() => s().goHome()}
            title="Home"
            aria-label="Home"
          >
            <svg
              width={13 * ts}
              height={13 * ts}
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {/* Outline house: roof, walls, and a door notch. */}
              <path d="M1.9 6.7 L7 2.1 L12.1 6.7" />
              <path d="M3.15 5.9 V11.9 H10.85 V5.9" />
              <path d="M5.7 11.9 V8.4 H8.3 V11.9" />
            </svg>
          </button>
        )}
      </div>
      <div className="topbar-center">
        {drill && <DrillTitle id={drill} />}
      </div>
      <div className="topbar-right">
        {FOCUS_DOCK_SWITCHER ? (
          <>
            {/* The two-button form — show/hide, plus the dock switcher. Hidden in this app
                (see FOCUS_DOCK_SWITCHER) but kept as the reference for the iPadOS port. */}
            <button
              className={"bar-btn" + (focusPane ? " active" : "")}
              onClick={() => s().toggleFocusPane()}
              title="Focus pane (⌥⇧F)"
            >
              ★
            </button>
            <button
              className="bar-btn"
              onClick={() => s().toggleFocusPaneLayout()}
              title={
                focusLayout === "sidebar"
                  ? "Dock focus pane to top"
                  : "Dock focus pane to left"
              }
              aria-label="Switch focus pane layout"
            >
              <DockGlyph dock={focusLayout} size={14 * ts} />
            </button>
          </>
        ) : (
          <button
            className={"bar-btn" + (focusPane ? " active" : "")}
            onClick={() => s().toggleFocusPane()}
            title={focusPane ? "Hide focus sidebar (⌥⇧F)" : "Show focus sidebar (⌥⇧F)"}
            aria-label="Focus sidebar"
            aria-pressed={focusPane}
          >
            <DockGlyph dock="sidebar" size={14 * ts} />
          </button>
        )}
        <button
          className={"bar-btn" + (hideCompleted ? " active" : "")}
          onClick={() => setHideCompleted(!hideCompleted)}
          title={hideCompleted ? "Show completed" : "Hide completed"}
        >
          <svg width={14 * ts} height={14 * ts} viewBox="0 0 14 14">
            <path
              d="M1 7 C3 3.5 5 2.5 7 2.5 C9 2.5 11 3.5 13 7 C11 10.5 9 11.5 7 11.5 C5 11.5 3 10.5 1 7 Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.1"
            />
            <circle cx="7" cy="7" r="2.1" fill="currentColor" />
            {hideCompleted && (
              <line x1="2" y1="12" x2="12" y2="2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            )}
          </svg>
        </button>
        <button
          className="bar-btn"
          // Kept off the focus chain, like the ⋯ button: dismissing the menu should leave
          // the caret where it was. Choosing a template opens the editor, which takes
          // focus itself.
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            // A native NSMenu (Rust builds it from the templates table), popped under the
            // button's leading edge exactly as the ⋯ menu is. The choice comes back as a
            // `templates-menu-action` event (App.tsx).
            const r = e.currentTarget.getBoundingClientRect();
            void api.popupTemplatesMenu(r.left, r.bottom);
          }}
          title="Templates"
          aria-label="Templates"
        >
          <TemplatesGlyph size={14 * ts} />
        </button>
        <SyncIndicator scale={ts} />
        <button
          className="bar-btn"
          onClick={() => useSettings.getState().openSettings(true)}
          title="Settings"
        >
          ⚙
        </button>
      </div>
    </div>
  );
}
