import { useEffect, useState } from "react";
import { FocusPane } from "./components/FocusPane";
import { OutlineView } from "./components/OutlineView";
import { SettingsPanel } from "./components/SettingsPanel";
import { TopBar } from "./components/TopBar";
import { api, onRowMenuAction } from "./lib/api";
import { endAnimNow } from "./state/collapseAnim";
import {
  copyBlock,
  indentTargetParent,
  performRowMenuAction,
  setCollapsed,
  setCollapsedAll,
} from "./state/controller";
import { mirror, startMirror, subscribeStructure } from "./state/mirror";
import { selectionIds, useSelection } from "./state/selection";
import { useSettings } from "./state/settings";
import { useWindowState } from "./state/windowState";

/** Keys while a NODE selection is live (nothing is first responder then) — the
 * OutlineSelectionKeyMonitor port. Runs in capture phase; every combo it doesn't
 * claim passes through. */
function handleSelectionKey(e: KeyboardEvent): boolean {
  const sel = useSelection.getState();
  if (!sel.isActive()) return false;
  const ids = selectionIds();
  const s = useWindowState.getState();
  const done = () => {
    e.preventDefault();
    e.stopPropagation();
    sel.refresh();
  };
  if (e.key === "Escape") {
    // No ⋯-menu guard needed: that menu is a native NSMenu running AppKit's own modal
    // loop, so while it's open Escape closes IT and never reaches the webview at all.
    // One layer per press, for free.
    e.preventDefault();
    sel.clear();
    return true;
  }
  if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    const dir = e.key === "ArrowUp" ? -1 : 1;
    if (e.shiftKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      sel.step(dir, s.hideCompleted);
      return true;
    }
    if (e.altKey && !e.metaKey) {
      void api.moveBlockBy(ids, dir, s.hideCompleted).then(() => sel.refresh());
      done();
      return true;
    }
  }
  if (e.key === "Tab" && !e.metaKey) {
    if (e.shiftKey) {
      void api.outdentBlock(ids).then(() => sel.refresh());
    } else {
      // Expand the destination BEFORE the invoke — same reason as the single-node Tab
      // (see indentTargetParent). `ids[0]` is the block's first node in sibling order,
      // matching Rust's normalized_block, because a selection is a contiguous
      // one-level sibling range.
      const target = indentTargetParent(ids[0], s.hideCompleted);
      if (target) s.expandMany([target]);
      void api.indentBlock(ids, s.hideCompleted).then((out) => {
        s.expandMany(out.expand);
        sel.refresh();
      });
    }
    done();
    return true;
  }
  if (e.metaKey && e.key === "Enter") {
    void api.toggleCompletedBlock(ids).then(() => sel.refresh());
    done();
    return true;
  }
  if (e.metaKey && (e.key === "1" || e.key === "2" || e.key === "3")) {
    const kind =
      e.key === "1" ? "bulletPoint" : e.key === "2" ? "checkbox" : "promptDraft";
    void api.setKindBlock(ids, kind).then(() => sel.refresh());
    done();
    return true;
  }
  if (e.metaKey && (e.key === "c" || e.key === "C") && !e.shiftKey) {
    void copyBlock(ids);
    e.preventDefault();
    e.stopPropagation();
    return true;
  }
  if ((e.key === "Backspace" || e.key === "Delete") && !e.metaKey) {
    void api.deleteBlock(ids);
    e.preventDefault();
    e.stopPropagation();
    sel.clear();
    return true;
  }
  return false;
}

export default function App() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void startMirror().then(() => setReady(true));
  }, []);

  // Deleted nodes must never linger as focus/drill/history targets.
  useEffect(() => {
    return mirror.onDeleted((ids) => useWindowState.getState().purgeDeleted(ids));
  }, []);

  // A structural change can move/remove selection members — re-resolve.
  useEffect(() => {
    return subscribeStructure(() => useSelection.getState().refresh());
  }, []);

  // Native row (⋯) menu selections arrive as events from Rust — run them here.
  useEffect(() => {
    const un = onRowMenuAction((action, node) => {
      void performRowMenuAction(action, node);
    });
    return () => void un.then((f) => f());
  }, []);

  // Trackpad pinch → font size (the MagnifyGesture port): WebKit delivers pinch as
  // proprietary gesture events with a cumulative scale; size = anchor × scale,
  // rounded and clamped, exactly like the SwiftUI app. Some configurations send
  // ctrl+wheel instead — same mapping through an accumulated float.
  useEffect(() => {
    let anchor = 0;
    const start = (e: Event) => {
      e.preventDefault();
      anchor = useWindowState.getState().fontSize;
    };
    const change = (e: Event) => {
      e.preventDefault();
      const scale = (e as { scale?: number }).scale;
      if (anchor > 0 && typeof scale === "number") {
        // A scale change invalidates every px offset an animation is mid-way through
        // (indents, drawer height), and a pinch is not a wheel event, so
        // OutlineView's onWheel guard never sees it. Cheap when nothing is running.
        endAnimNow();
        useWindowState.getState().setFont(anchor * scale);
      }
    };
    const end = (e: Event) => {
      e.preventDefault();
      anchor = 0;
    };
    let wheelFloat: number | null = null;
    let wheelReset: ReturnType<typeof setTimeout> | null = null;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return; // plain wheel = scroll
      e.preventDefault();
      const s = useWindowState.getState();
      if (wheelFloat === null) wheelFloat = s.fontSize;
      wheelFloat = Math.min(40, Math.max(9, wheelFloat * Math.exp(-e.deltaY * 0.01)));
      s.setFont(wheelFloat);
      if (wheelReset) clearTimeout(wheelReset);
      wheelReset = setTimeout(() => {
        wheelFloat = null;
      }, 300);
    };
    window.addEventListener("gesturestart", start, { passive: false });
    window.addEventListener("gesturechange", change, { passive: false });
    window.addEventListener("gestureend", end, { passive: false });
    window.addEventListener("wheel", wheel, { passive: false });
    return () => {
      window.removeEventListener("gesturestart", start);
      window.removeEventListener("gesturechange", change);
      window.removeEventListener("gestureend", end);
      window.removeEventListener("wheel", wheel);
    };
  }, []);

  // Window-level shortcuts (the OutlineView keyboardShortcuts / commands port).
  useEffect(() => {
    const onSelKey = (e: KeyboardEvent) => {
      handleSelectionKey(e);
    };
    window.addEventListener("keydown", onSelKey, true);
    const onKey = (e: KeyboardEvent) => {
      const s = useWindowState.getState();
      const meta = e.metaKey;
      if (!meta) return;
      if (e.altKey && (e.key === "f" || e.key === "F" || e.code === "KeyF")) {
        e.preventDefault();
        s.toggleFocusPane(); // ⌘⌥F — the one ⌘⌥ shortcut, like the SwiftUI app
      } else if (e.ctrlKey && e.shiftKey && e.code === "Digit7") {
        // Dev: ⌘⌃⇧7 seeds a large synthetic tree for performance testing.
        e.preventDefault();
        void api.seedDemo(40, 25, 10).then((n) => console.log(`seeded ${n}`));
      } else if (e.ctrlKey && e.shiftKey && e.code === "Digit8") {
        // Dev: ⌘⌃⇧8 measures the idle rAF ceiling (no animation) — tells 60Hz-capped
        // webview apart from animation jank.
        e.preventDefault();
        void import("./state/perfMeter").then((m) =>
          m.measureFrames("idle-baseline", 600),
        );
      } else if (!e.shiftKey && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        endAnimNow(); // a scale change invalidates in-flight px offsets — see the pinch
        s.adjustFont(1);
      } else if (!e.shiftKey && e.key === "-") {
        e.preventDefault();
        endAnimNow();
        s.adjustFont(-1);
      } else if (!e.shiftKey && e.key === "0") {
        e.preventDefault();
        endAnimNow();
        s.resetFont();
      } else if (e.key === "[") {
        e.preventDefault();
        s.goBack();
      } else if (e.key === "]") {
        e.preventDefault();
        s.goForward();
      } else if (e.shiftKey && (e.key === "d" || e.key === "D")) {
        e.preventDefault();
        setCollapsedAll(false); // ⌘⇧D expand all (per window)
      } else if (e.shiftKey && (e.key === "e" || e.key === "E")) {
        e.preventDefault();
        setCollapsedAll(true); // ⌘⇧E collapse all (per window)
      } else if (!e.shiftKey && !e.altKey && (e.key === "e" || e.key === "E")) {
        // ⌘E collapse / ⌘D expand the focused node (the setCollapsedFocused
        // port) — no-ops without a focused parent node, like the original.
        e.preventDefault();
        if (s.focusId && mirror.hasChildren(s.focusId))
          setCollapsed(s.focusId, true);
      } else if (!e.shiftKey && !e.altKey && (e.key === "d" || e.key === "D")) {
        e.preventDefault();
        if (s.focusId && mirror.hasChildren(s.focusId))
          setCollapsed(s.focusId, false);
      } else if (!e.shiftKey && (e.key === "z" || e.key === "Z")) {
        // Normally consumed by the native Edit menu; fallback if it wasn't.
        e.preventDefault();
        void api.undo();
      } else if (e.shiftKey && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        void api.redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keydown", onSelKey, true);
    };
  }, []);

  const bgTint = useSettings((s) => s.bgTint);
  const shellStyle = {
    background: `rgba(10, 10, 14, ${bgTint})`,
  } as React.CSSProperties;

  if (!ready) return <div className="app-shell" style={shellStyle} />;
  return (
    <div className="app-shell" style={shellStyle}>
      <TopBar />
      <FocusPane />
      <OutlineView />
      <SettingsPanel />
    </div>
  );
}
