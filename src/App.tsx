import { useEffect, useState } from "react";
import { OutlineView } from "./components/OutlineView";
import { TopBar } from "./components/TopBar";
import { api } from "./lib/api";
import { copyBlock, setCollapsedAll } from "./state/controller";
import { mirror, startMirror, subscribeStructure } from "./state/mirror";
import { selectionIds, useSelection } from "./state/selection";
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
      if (!e.shiftKey && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        s.adjustFont(1);
      } else if (!e.shiftKey && e.key === "-") {
        e.preventDefault();
        s.adjustFont(-1);
      } else if (!e.shiftKey && e.key === "0") {
        e.preventDefault();
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

  if (!ready) return <div className="app-shell" />;
  return (
    <div className="app-shell">
      <TopBar />
      <OutlineView />
    </div>
  );
}
