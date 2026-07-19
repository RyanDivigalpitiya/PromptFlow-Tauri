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
import { OutlineLayout } from "../lib/layout";
import {
  animVersion,
  endAnimNow,
  isAnimating,
  publishAnimContainer,
  subscribeAnim,
} from "../state/collapseAnim";
import { addAtBottom, appendChildAt, dbg, publishRows } from "../state/controller";
import { useDrag } from "../state/drag";
import { publishDragEnv } from "../state/dragGesture";
import { mirror, subscribeStructure } from "../state/mirror";
import { useSelection } from "../state/selection";
import { useSettings } from "../state/settings";
import { useWindowState } from "../state/windowState";
import { AddChildRow, NodeRow } from "./NodeRow";

/** Drop marker + floating ghost while a drag is live. Only this component re-renders
 * per pointer move — the rows themselves stay untouched. */
function DragOverlay({ fontSize }: { fontSize: number }) {
  const nodeId = useDrag((s) => s.nodeId);
  const projection = useDrag((s) => s.projection);
  const pointerX = useDrag((s) => s.pointerX);
  const pointerY = useDrag((s) => s.pointerY);
  const ghostText = useDrag((s) => s.ghostText);
  if (!nodeId) return null;
  const isChildDrop = projection && projection.afterId === null && projection.parentId !== null;
  const ballX = projection
    ? isChildDrop
      ? OutlineLayout.contentLeadingInset(projection.depth, fontSize)
      : OutlineLayout.bulletCenterInset(projection.depth, fontSize)
    : 0;
  return (
    <>
      {projection && (
        <div className="drop-marker" style={{ top: projection.markerY - 1 }}>
          <span className="drop-ball" style={{ left: ballX - 3 }} />
          <span
            className="drop-line"
            style={{ left: ballX + 5, right: OutlineLayout.documentHInset }}
          />
        </div>
      )}
      <div className="drag-ghost" style={{ left: pointerX + 14, top: pointerY + 12 }}>
        {ghostText}
      </div>
    </>
  );
}

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
  // Re-render when an expand/collapse animation starts or ends, so `.outline-inner`
  // gains/loses the gated `.rows-animating` transition class.
  useSyncExternalStore(subscribeAnim, animVersion);
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
    const t0 = performance.now();
    const out = drill
      ? flattenDrillRoot(drill, collapsed, hideCompleted, keepVisible)
      : flattenRoots(collapsed, hideCompleted, keepVisible);
    const dt = performance.now() - t0;
    if (dt > 8) {
      // A slow flatten would be the first thing to hurt at scale — surface it.
      dbg(`flatten: ${out.length} rows in ${dt.toFixed(1)}ms`);
    }
    return out;
  }, [structureV, collapsed, hideCompleted, keepVisible, drill]);
  publishRows(rows);

  const highlightAncestors = useMemo(() => {
    void structureV;
    return computeHighlightAncestors();
  }, [structureV]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  // Publish `.outline-inner` (the virtualizer's coordinate space) so the collapse
  // animation can pin its ghost overlay there.
  useEffect(() => {
    publishAnimContainer(innerRef.current);
    return () => {
      endAnimNow(); // drop any live overlay/timer before the container goes away
      publishAnimContainer(null);
    };
  }, []);
  const rowEstimate =
    OutlineLayout.lineHeight(fontSize) + OutlineLayout.rowVerticalPadding * 2;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowEstimate,
    getItemKey: (i) => rows[i].id,
    overscan: 14,
    // The document's top margin — must be the virtualizer's own padding (a CSS
    // padding on the container is invisible to its translateY positioning).
    paddingStart: OutlineLayout.documentVInset,
  });

  // Scroll a focused row into view ONLY when it's fully off-screen (presence-gated,
  // like the Swift attemptScroll). A row already at least partly visible — e.g. one
  // the user just clicked — is left exactly where it is, so clicking a node never
  // yanks the view to an "optimal" position for it.
  useEffect(() => {
    if (!focusId) return;
    const idx = rows.findIndex((r) => r.kind === "node" && r.nodeId === focusId);
    if (idx < 0) return;
    const scrollEl = scrollRef.current;
    const m = virtualizer.measurementsCache[idx];
    if (scrollEl && m) {
      const top = scrollEl.scrollTop;
      const bottom = top + scrollEl.clientHeight;
      // Any overlap with the viewport ⇒ already present; don't reposition.
      if (m.end > top && m.start < bottom) return;
    }
    virtualizer.scrollToIndex(idx, { align: "auto" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, focusEpoch, rows]);

  const items = virtualizer.getVirtualItems();

  // Geometry for the drag projection: every flattened row's content-space extent
  // (measured when rendered, estimated otherwise — same numbers the virtualizer uses).
  publishDragEnv({
    scrollEl: scrollRef.current,
    getFrames: () => {
      const frames = new Map<string, { minY: number; maxY: number }>();
      const cache = virtualizer.measurementsCache;
      const n = Math.min(cache.length, rows.length);
      for (let i = 0; i < n; i++) {
        const m = cache[i];
        frames.set(rows[i].id, { minY: m.start, maxY: m.end });
      }
      return frames;
    },
  });

  const selResolved = useSelection((s) => s.resolved);
  const dragSubtree = useDrag((s) => s.subtree);
  const showGuides = useSettings((s) => s.showIndentGuides);
  const guideColor = useSettings((s) => s.indentGuideColor);
  const highlightColor = useSettings((s) => s.highlightColor);

  return (
    <div
      className="outline-scroll"
      ref={scrollRef}
      onWheel={() => {
        // A user scroll mid-animation would make the gated transform transition lag
        // every repositioned row — snap to final positions instead. (Uses wheel, not
        // scroll, so a layout-induced scrollTop clamp on collapse can't self-cancel.)
        if (isAnimating()) endAnimNow();
      }}
      onMouseDown={(e) => {
        // Blank-background click → defocus + clear selection (the clear-tap port).
        if (e.target === e.currentTarget) {
          useWindowState.getState().clearFocus();
          useSelection.getState().clear();
          (document.activeElement as HTMLElement | null)?.blur();
        }
      }}
    >
      <div
        ref={innerRef}
        className={"outline-inner" + (isAnimating() ? " rows-animating" : "")}
        style={{ height: virtualizer.getTotalSize() }}
      >
        {items.map((vi) => {
          const row = rows[vi.index];
          const prevDepth = rows[vi.index - 1]?.depth ?? -1;
          const nextDepth = rows[vi.index + 1]?.depth ?? -1;
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
                  prevDepth={prevDepth}
                  nextDepth={nextDepth}
                  hasChildren={row.hasChildren}
                  isCollapsed={row.isCollapsed}
                  isFocused={focusId === row.nodeId && focusField === "main"}
                  isNoteFocused={focusId === row.nodeId && focusField === "note"}
                  isDrillRoot={drill === row.nodeId}
                  hasHighlightedDescendant={highlightAncestors.has(row.nodeId)}
                  fontSize={fontSize}
                  showGuides={showGuides}
                  guideColor={guideColor}
                  highlightColor={highlightColor}
                  isSelected={selResolved?.ids.includes(row.nodeId) ?? false}
                  isSelTinted={
                    (selResolved?.tint.has(row.nodeId) ?? false) &&
                    !(selResolved?.ids.includes(row.nodeId) ?? false)
                  }
                  isDragDimmed={dragSubtree.has(row.nodeId)}
                />
              ) : (
                <AddChildRow
                  parentId={row.nodeId}
                  depth={row.depth}
                  prevDepth={prevDepth}
                  nextDepth={nextDepth}
                  fontSize={fontSize}
                  showGuides={showGuides}
                  guideColor={guideColor}
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
        <DragOverlay fontSize={fontSize} />
      </div>
      <div className="bottom-add">
        <button
          className="add-child-btn"
          style={{ width: OutlineLayout.bulletHitSize(fontSize), fontSize }}
          onClick={() => void addAtBottom()}
        >
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
