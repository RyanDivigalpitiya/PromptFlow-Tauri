import { useSyncExternalStore } from "react";
import { mirror, nodeVersion, subscribeNode } from "../state/mirror";
import { useSettings } from "../state/settings";
import { useWindowState } from "../state/windowState";

function DrillTitle({ id }: { id: string }) {
  useSyncExternalStore(subscribeNode(id), () => nodeVersion(id));
  const rec = mirror.get(id);
  return <span className="topbar-title">{rec?.text || "Untitled"}</span>;
}

/** The window chrome strip: nav back/forward/home, the drill title, hide-completed.
 * The whole bar is a drag region (overlay title bar), with the buttons on top. */
export function TopBar() {
  const drill = useWindowState((s) => s.drill);
  const canBack = useWindowState((s) => s.back.length > 0);
  const canForward = useWindowState((s) => s.forward.length > 0);
  const hideCompleted = useWindowState((s) => s.hideCompleted);
  const focusPane = useWindowState((s) => s.focusPaneExpanded);
  const s = useWindowState.getState;

  return (
    <div className="topbar" data-tauri-drag-region>
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
          <button className="bar-btn" onClick={() => s().goHome()} title="Home">
            ⌂
          </button>
        )}
      </div>
      <div className="topbar-center" data-tauri-drag-region>
        {drill ? <DrillTitle id={drill} /> : <span className="topbar-title app">PromptFlow</span>}
      </div>
      <div className="topbar-right">
        <button
          className={"bar-btn" + (focusPane ? " active" : "")}
          onClick={() => s().toggleFocusPane()}
          title="Focus pane (⌘⌥F)"
        >
          ★
        </button>
        <button
          className={"bar-btn" + (hideCompleted ? " active" : "")}
          onClick={() => s().setHideCompleted(!hideCompleted)}
          title={hideCompleted ? "Show completed" : "Hide completed"}
        >
          <svg width="14" height="14" viewBox="0 0 14 14">
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
          onClick={() => useSettings.getState().openSettings(true)}
          title="Settings"
        >
          ⚙
        </button>
      </div>
    </div>
  );
}
