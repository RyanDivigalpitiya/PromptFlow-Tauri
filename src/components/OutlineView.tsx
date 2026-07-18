import { useVirtualizer } from "@tanstack/react-virtual";
import {
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import {
  flattenDrillRoot,
  flattenRoots,
  hiddenCompletedCount,
  type RenderRow,
} from "../lib/flatten";
import { OutlineLayout, Theme } from "../lib/layout";
import { addAtBottom, appendChildAt, publishRows } from "../state/controller";
import { mirror, subscribeStructure } from "../state/mirror";
import { useWindowState } from "../state/windowState";
import { AddChildRow, NodeRow } from "./NodeRow";

/** Ids of every node with a highlighted (⌘⇧F) descendant at any depth — ONE full
 * forest walk per structural change (the OutlineView.highlightAncestorIDs port). */
function computeHighlightAncestors(): Set<string> {
  const out = new Set<string>();
  const walk = (id: string): boolean => {
    let below = false;
    for (const k of mirror.childrenOf(id)) {
      if (walk(k)) below = true;
    }
    const rec = mirror.get(id);
    if (below) out.add(id);
    return below || (rec?.isHighlighted ?? false);
  };
  for (const r of mirror.roots()) walk(r);
  return out;
}

export function OutlineView() {
  const structureV = useSyncExternalStore(subscribeStructure, () =>
    mirror.structureVersion(),
  );
  const collapsed = useWindowState((s) => s.collapsed);
  const hideCompleted = useWindowState((s) => s.hideCompleted);
  const keepVisible = useWindowState((s) => s.keepVisible);
  const drill = useWindowState((s) => s.drill);
  const fontSize = useWindowState((s) => s.fontSize);
  const focusId = useWindowState((s) => s.focusId);
  const focusField = useWindowState((s) => s.focusField);
  const focusEpoch = useWindowState((s) => s.focusEpoch);

  const rows: RenderRow[] = useMemo(() => {
    void structureV;
    return drill
      ? flattenDrillRoot(drill, collapsed, hideCompleted, keepVisible)
      : flattenRoots(collapsed, hideCompleted, keepVisible);
  }, [structureV, collapsed, hideCompleted, keepVisible, drill]);
  publishRows(rows);

  const highlightAncestors = useMemo(() => {
    void structureV;
    return computeHighlightAncestors();
  }, [structureV]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rowEstimate =
    OutlineLayout.lineHeight(fontSize) + OutlineLayout.rowVerticalPadding * 2;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowEstimate,
    getItemKey: (i) => rows[i].id,
    overscan: 14,
  });

  // Keep the focused row on screen (presence-gated, like the Swift attemptScroll).
  useEffect(() => {
    if (!focusId) return;
    const idx = rows.findIndex((r) => r.kind === "node" && r.nodeId === focusId);
    if (idx >= 0) virtualizer.scrollToIndex(idx, { align: "auto" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, focusEpoch, rows]);

  const items = virtualizer.getVirtualItems();

  return (
    <div
      className="outline-scroll"
      ref={scrollRef}
      onMouseDown={(e) => {
        // Blank-background click → defocus (the viewport-filling clear-tap port).
        if (e.target === e.currentTarget) {
          useWindowState.getState().clearFocus();
          (document.activeElement as HTMLElement | null)?.blur();
        }
      }}
    >
      <div
        className="outline-inner"
        style={{
          height: virtualizer.getTotalSize(),
          paddingTop: OutlineLayout.documentVInset,
        }}
      >
        {items.map((vi) => {
          const row = rows[vi.index];
          return (
            <div
              key={vi.key}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              className="vrow"
              style={{ transform: `translateY(${vi.start}px)` }}
            >
              {row.kind === "node" ? (
                <NodeRow
                  nodeId={row.nodeId}
                  depth={row.depth}
                  hasChildren={row.hasChildren}
                  isCollapsed={row.isCollapsed}
                  isFocused={focusId === row.nodeId && focusField === "main"}
                  isNoteFocused={focusId === row.nodeId && focusField === "note"}
                  isDrillRoot={drill === row.nodeId}
                  hasHighlightedDescendant={highlightAncestors.has(row.nodeId)}
                  fontSize={fontSize}
                  showGuides={true}
                  guideColor={Theme.defaultIndentGuideHex}
                  highlightColor={Theme.defaultHighlightHex}
                />
              ) : (
                <AddChildRow
                  parentId={row.nodeId}
                  depth={row.depth}
                  fontSize={fontSize}
                  hiddenCount={
                    hideCompleted
                      ? hiddenCompletedCount(
                          mirror.childrenOf(row.nodeId),
                          hideCompleted,
                          keepVisible,
                        )
                      : null
                  }
                  onAdd={(id) => void appendChildAt(id)}
                />
              )}
            </div>
          );
        })}
      </div>
      <div className="bottom-add">
        <button className="add-child-btn" onClick={() => void addAtBottom()}>
          +
        </button>
        {(() => {
          if (!hideCompleted) return null;
          const kids = drill ? mirror.childrenOf(drill) : mirror.roots();
          const n = hiddenCompletedCount(kids, hideCompleted, keepVisible);
          return n != null ? (
            <span className="hidden-completed-hint">(All Completed — Hidden)</span>
          ) : null;
        })()}
      </div>
    </div>
  );
}
