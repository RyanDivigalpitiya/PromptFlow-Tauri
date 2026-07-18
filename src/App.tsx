import { useEffect, useState } from "react";
import { OutlineView } from "./components/OutlineView";
import { TopBar } from "./components/TopBar";
import { api } from "./lib/api";
import { setCollapsedAll } from "./state/controller";
import { mirror, startMirror } from "./state/mirror";
import { useWindowState } from "./state/windowState";

export default function App() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void startMirror().then(() => setReady(true));
  }, []);

  // Deleted nodes must never linger as focus/drill/history targets.
  useEffect(() => {
    return mirror.onDeleted((ids) => useWindowState.getState().purgeDeleted(ids));
  }, []);

  // Window-level shortcuts (the OutlineView keyboardShortcuts / commands port).
  useEffect(() => {
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
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!ready) return <div className="app-shell" />;
  return (
    <div className="app-shell">
      <TopBar />
      <OutlineView />
    </div>
  );
}
