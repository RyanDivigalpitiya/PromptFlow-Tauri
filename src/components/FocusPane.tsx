import { useSyncExternalStore } from "react";
import { revealNode } from "../state/controller";
import { useFocusPane } from "../state/focusPane";
import { mirror, subscribeStructure } from "../state/mirror";
import { useSettings } from "../state/settings";
import { useWindowState } from "../state/windowState";

/** The collapsible strip mirroring the highlighted (⌘⇧F) nodes — read-only rows:
 * ⠿ handle · numbered accent circle · bold accent title + ancestor breadcrumb.
 * Clicking a row REVEALS the node in the outline; the handle drag reorders the
 * device-local priority order. */

function Breadcrumb({ id, accent }: { id: string; accent: string }) {
  const chain = mirror.ancestors(id);
  if (chain.length === 0) return null;
  return (
    <span className="focus-breadcrumb">
      {chain.map((a, i) => {
        const rec = mirror.get(a);
        const isTop = i === 0;
        const isParent = i === chain.length - 1;
        return (
          <span key={a}>
            {i > 0 && <span className="crumb-sep"> ▸ </span>}
            <span
              className={
                "crumb" + (isTop ? " top" : isParent ? " parent" : " mid")
              }
              style={isParent ? { color: accent } : undefined}
            >
              {rec?.text || "Untitled"}
            </span>
          </span>
        );
      })}
    </span>
  );
}

function paneRowDrag(e: React.MouseEvent, index: number) {
  if (e.button !== 0) return;
  e.preventDefault();
  const container = (e.currentTarget as HTMLElement).closest(".focus-pane");
  if (!container) return;
  const onUp = (ev: MouseEvent) => {
    window.removeEventListener("mouseup", onUp);
    const rows = [...container.querySelectorAll(".focus-row")];
    let to = rows.length - 1;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (ev.clientY < r.top + r.height / 2) {
        to = i - (i > index ? 1 : 0);
        break;
      }
    }
    if (to !== index) useFocusPane.getState().move(index, to);
  };
  window.addEventListener("mouseup", onUp);
}

export function FocusPane() {
  useSyncExternalStore(subscribeStructure, () => mirror.structureVersion());
  const expanded = useWindowState((s) => s.focusPaneExpanded);
  const fontSize = useWindowState((s) => s.fontSize);
  const order = useFocusPane((s) => s.order);
  const accent = useSettings((s) => s.highlightColor);

  // Membership is derived from the store; order from the device-local list.
  useFocusPane.getState().reconcile();

  if (!expanded) return null;
  const members = useFocusPane
    .getState()
    .order.filter((id) => mirror.get(id)?.isHighlighted);
  void order;

  return (
    <div className="focus-pane" style={{ fontSize }}>
      {members.length === 0 ? (
        <div className="focus-empty">
          Highlight nodes with ⌘⇧F to pin them here.
        </div>
      ) : (
        members.map((id, i) => {
          const rec = mirror.get(id);
          if (!rec) return null;
          return (
            <div className="focus-row" key={id}>
              <span
                className="focus-handle"
                onMouseDown={(e) => paneRowDrag(e, i)}
              >
                ⠿
              </span>
              <span
                className="focus-index"
                style={{ borderColor: accent, color: accent }}
                onClick={() => revealNode(id)}
              >
                {i + 1}
              </span>
              <span className="focus-content" onClick={() => revealNode(id)}>
                <span className="focus-title" style={{ color: accent }}>
                  {rec.text || "Untitled"}
                </span>
                <Breadcrumb id={id} accent={accent} />
              </span>
            </div>
          );
        })
      )}
    </div>
  );
}
