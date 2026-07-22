import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { revealNode } from "../state/controller";
import { useFocusPane } from "../state/focusPane";
import {
  mirror,
  nodeVersion,
  subscribeNode,
  subscribeStructure,
} from "../state/mirror";
import { useSettings } from "../state/settings";
import { useWindowState } from "../state/windowState";

/** The collapsible strip mirroring the highlighted (⌘⇧F) nodes — read-only rows:
 * ⠿ handle · numbered accent disc · bold accent title + ancestor breadcrumb.
 * Clicking a row REVEALS the node in the outline; the handle drag reorders the
 * device-local priority order and shows a drop marker while dragging. */

/** Re-render whenever `id`'s node record changes (text/style/kind), so a focus row's
 * title and each breadcrumb crumb track live edits from THIS or any other window — the
 * pane's own structure subscription only fires on tree-shape changes, not text edits. */
function useNodeRec(id: string) {
  const subscribe = useMemo(() => subscribeNode(id), [id]);
  useSyncExternalStore(subscribe, () => nodeVersion(id));
  return mirror.get(id);
}

function Crumb({ id, faint }: { id: string; faint: boolean }) {
  const rec = useNodeRec(id);
  return (
    <span className={"crumb" + (faint ? " mid" : " top")}>
      {rec?.text || "Untitled"}
    </span>
  );
}

/** Ancestor chain top→parent. Leftmost crumb is white, every deeper crumb grey; a lone
 * crumb stays white (never accent). Each crumb subscribes to its own node so a rename
 * anywhere in the chain updates live. */
function Breadcrumb({ id }: { id: string }) {
  const chain = mirror.ancestors(id);
  if (chain.length === 0) return null;
  return (
    <span className="focus-breadcrumb">
      {chain.map((a, i) => (
        <span key={a}>
          {i > 0 && <span className="crumb-sep"> ▸ </span>}
          <Crumb id={a} faint={i !== 0} />
        </span>
      ))}
    </span>
  );
}

function FocusRow({
  id,
  index,
  accent,
  onHandleDown,
}: {
  id: string;
  index: number;
  accent: string;
  onHandleDown: (e: React.MouseEvent, index: number) => void;
}) {
  const rec = useNodeRec(id);
  if (!rec) return null;
  return (
    <div className="focus-row">
      <span
        className="focus-handle"
        onMouseDown={(e) => onHandleDown(e, index)}
      >
        ⠿
      </span>
      <span
        className="focus-index"
        style={{ ["--focus-accent" as string]: accent } as React.CSSProperties}
        onClick={() => revealNode(id)}
      >
        {index + 1}
      </span>
      <span className="focus-content" onClick={() => revealNode(id)}>
        <span className="focus-title" style={{ color: accent }}>
          {rec.text || "Untitled"}
        </span>
        <Breadcrumb id={id} />
      </span>
    </div>
  );
}

export function FocusPane() {
  const structureV = useSyncExternalStore(subscribeStructure, () =>
    mirror.structureVersion(),
  );
  const expanded = useWindowState((s) => s.focusPaneExpanded);
  const fontSize = useWindowState((s) => s.fontSize);
  const order = useFocusPane((s) => s.order);
  const accent = useSettings((s) => s.highlightColor);

  // Marker offset (content-space px) while a handle drag is live; null when idle.
  const [markerTop, setMarkerTop] = useState<number | null>(null);

  // Membership is derived from the store; order from the device-local list. Reconciling
  // in an EFFECT (not during render) is what makes a ⌘⇧F highlight from ANOTHER window
  // land here: the highlight flip is structural, so it bumps our structure version and
  // re-runs this effect — whereas the old set()-during-render was dropped when the only
  // re-render was that idle structural delta, so a pinned node never appeared in the
  // pane's other windows.
  useEffect(() => {
    useFocusPane.getState().reconcile();
  }, [structureV]);

  // Stays MOUNTED across the collapse: `.open` drives the grid-track drawer, so the
  // close animation can play out instead of the strip vanishing the instant `expanded`
  // flips (an unmount would snap it shut). Rows keep rendering while collapsed — they are
  // clipped to height 0, and the close animation needs them on screen.
  const members = order.filter((id) => mirror.get(id)?.isHighlighted);

  /** Handle drag: track the pointer, paint a drop marker at the nearest row gap, and
   * commit the reorder on release. */
  function onHandleDown(e: React.MouseEvent, index: number) {
    if (e.button !== 0) return;
    e.preventDefault();
    const container = (e.currentTarget as HTMLElement).closest(
      ".focus-pane",
    ) as HTMLElement | null;
    if (!container) return;

    // Nearest gap in [0, rows.length]: the insertion slot BEFORE removing the drag row.
    const gapAt = (clientY: number): number => {
      const rows = [...container.querySelectorAll(".focus-row")];
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i].getBoundingClientRect();
        if (clientY < r.top + r.height / 2) return i;
      }
      return rows.length;
    };
    const markerFor = (gap: number): number => {
      const rows = [...container.querySelectorAll(".focus-row")];
      if (rows.length === 0) return 0;
      const cRect = container.getBoundingClientRect();
      const row =
        gap < rows.length ? rows[gap] : rows[rows.length - 1];
      const r = row.getBoundingClientRect();
      const edge = gap < rows.length ? r.top : r.bottom;
      return edge - cRect.top + container.scrollTop;
    };

    const onMove = (ev: MouseEvent) => {
      setMarkerTop(markerFor(gapAt(ev.clientY)));
    };
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setMarkerTop(null);
      const gap = gapAt(ev.clientY);
      const to = gap > index ? gap - 1 : gap;
      if (to !== index) useFocusPane.getState().move(index, to);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  return (
    <div className={"focus-pane-shell" + (expanded ? " open" : "")}>
      <div className="focus-pane-clip">
        <div className="focus-pane" style={{ fontSize }}>
          {members.length === 0 ? (
            <div className="focus-empty">
              Highlight nodes with ⌘⇧F to pin them here.
            </div>
          ) : (
            <>
              {members.map((id, i) => (
                <FocusRow
                  key={id}
                  id={id}
                  index={i}
                  accent={accent}
                  onHandleDown={onHandleDown}
                />
              ))}
              {markerTop !== null && (
                <div
                  className="focus-drop-marker"
                  style={
                    {
                      top: markerTop,
                      ["--focus-accent" as string]: accent,
                    } as React.CSSProperties
                  }
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
