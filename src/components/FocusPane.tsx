import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { currentTaskChain } from "../lib/currentTask";
import type { NodeRec } from "../lib/types";
import { revealNode } from "../state/controller";
import { useFocusPane } from "../state/focusPane";
import {
  mirror,
  nodeVersion,
  subscribeNode,
  subscribeStructure,
} from "../state/mirror";
import { useSettings } from "../state/settings";
import {
  clampSidebarWidth,
  FOCUS_TOP_MAX_FRACTION,
  FOCUS_TOP_MIN,
  useWindowState,
} from "../state/windowState";

/** The collapsible strip mirroring the highlighted (⌘⇧F) nodes — read-only rows:
 * ⠿ handle · numbered accent disc · bold accent title + the node's CURRENT TASK.
 * Clicking a row REVEALS its current task in the outline (the pinned node itself when
 * it has none); the handle drag reorders the device-local priority order and shows a
 * drop marker while dragging. */

/** Re-render whenever `id`'s node record changes (text/style/kind), so a focus row's
 * title tracks live edits from THIS or any other window — the pane's own structure
 * subscription only fires on tree-shape changes, not text edits. */
function useNodeRec(id: string) {
  const subscribe = useMemo(() => subscribeNode(id), [id]);
  useSyncExternalStore(subscribe, () => nodeVersion(id));
  return mirror.get(id);
}

/** The pinned node's live Current Task — the first open leaf under it (`currentTask.ts`),
 * or null when nothing is left to do there.
 *
 * The walk's result depends on exactly two things: the CHILD LISTS it scanned, and the
 * `kind`/`isCompleted` of the children in them. A child list change and a completion flip
 * are both STRUCTURAL, so the pane's own structure subscription re-runs this walk for
 * those — but a `kind` flip is deliberately NOT structural (the flatten is unchanged), and
 * neither is the task's own TEXT. So subscribe to every record the walk could have read:
 * the children of the focused node and of each node it descended into. That set is a
 * superset of what it examined and contains the task itself, which is what keeps the line
 * tracking a live edit from this window or any other — the same two-grain rule the row
 * title already follows, and the same one whose absence left mirrored titles stale. */
function useCurrentTask(focusedId: string): NodeRec | null {
  const chain = currentTaskChain(mirror, focusedId);
  const watched = [focusedId, ...chain].flatMap((p) => mirror.childrenOf(p));
  // Re-subscribe only when the watched SET changes; the closures below are recreated with
  // it, so a stale `watched` can never outlive the key that describes it.
  const key = watched.join("\u0000");
  const subscribe = useMemo(
    () => (cb: () => void) => {
      const offs = watched.map((id) => subscribeNode(id)(cb));
      return () => {
        for (const off of offs) off();
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` describes `watched`
    [key],
  );
  const version = useCallback(
    () => watched.map(nodeVersion).join(","),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` describes `watched`
    [key],
  );
  useSyncExternalStore(subscribe, version);
  const taskId = chain.length === 0 ? null : chain[chain.length - 1];
  return taskId === null ? null : (mirror.get(taskId) ?? null);
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
  const task = useCurrentTask(id);
  if (!rec) return null;
  // The whole row navigates to the CURRENT TASK — that is the node the row is pointing
  // at. With nothing left to do under it, it falls back to the pinned node itself.
  const target = task?.id ?? id;
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
        onClick={() => revealNode(target)}
      >
        {index + 1}
      </span>
      <span className="focus-content" onClick={() => revealNode(target)}>
        <span className="focus-title" style={{ color: accent }}>
          {rec.text || "Untitled"}
        </span>
        {task && (
          <span className="focus-task">{task.text || "Untitled"}</span>
        )}
      </span>
    </div>
  );
}

export function FocusPane() {
  const structureV = useSyncExternalStore(subscribeStructure, () =>
    mirror.structureVersion(),
  );
  const expanded = useWindowState((s) => s.focusPaneExpanded);
  const layout = useWindowState((s) => s.focusPaneLayout);
  const fontSize = useWindowState((s) => s.fontSize);
  const sidebarWidth = useWindowState((s) => s.focusSidebarWidth);
  const topHeight = useWindowState((s) => s.focusTopHeight);
  const order = useFocusPane((s) => s.order);
  const accent = useSettings((s) => s.highlightColor);

  // Marker offset (content-space px) while a handle drag is live; null when idle.
  const [markerTop, setMarkerTop] = useState<number | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const prevLayoutRef = useRef(layout);

  // A dock switch changes the shell's width/height DISCONTINUOUSLY (top strip auto-height
  // ⇄ sidebar fixed-width), and either edge would otherwise animate through the drawer
  // transition and read as a morph. Pin `.no-anim` for one frame — applied in a LAYOUT
  // effect (before paint), so the new dock's geometry commits with transitions off and
  // no intermediate frame paints — then re-enable next frame for the real open/close.
  useLayoutEffect(() => {
    if (prevLayoutRef.current === layout) return;
    prevLayoutRef.current = layout;
    const shell = shellRef.current;
    if (!shell) return;
    shell.classList.add("no-anim");
    void shell.offsetWidth; // force the reshape to settle with transitions suppressed
    const id = requestAnimationFrame(() => shell.classList.remove("no-anim"));
    return () => cancelAnimationFrame(id);
  }, [layout]);

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

  // The grip resizes whichever edge the current dock exposes.
  const onResizeDown =
    layout === "sidebar" ? onSidebarResize : onTopResize;

  /** Sidebar resize: drive the width var directly on the shell (bypassing React so it
   * tracks the pointer 1:1) with the drawer transition suppressed via `.resizing`, then
   * commit the final width to per-window state on release, where it persists. */
  function onSidebarResize(e: React.MouseEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    const shell = shellRef.current;
    if (!shell) return;
    const startX = e.clientX;
    const startW = useWindowState.getState().focusSidebarWidth;
    const widthAt = (ev: MouseEvent) => clampSidebarWidth(startW + (ev.clientX - startX));
    shell.classList.add("resizing");
    const onMove = (ev: MouseEvent) => {
      shell.style.setProperty("--focus-sidebar-width", `${widthAt(ev)}px`);
    };
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      shell.classList.remove("resizing");
      useWindowState.getState().setFocusSidebarWidth(widthAt(ev));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  /** Top-strip resize: drag the bottom edge to a fixed height, driven directly on the
   * shell (which is put into `.fixed-top` rendering for the drag). Dragging the edge
   * within SNAP_PX of the last row's bottom snaps to "auto" — content-fit that keeps the
   * bottom edge on the last pinned row as pins are added. Commits per-window on release. */
  function onTopResize(e: React.MouseEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    const shell = shellRef.current;
    if (!shell) return;
    const pane = shell.querySelector<HTMLElement>(".focus-pane");
    const body = shell.closest<HTMLElement>(".app-body");
    const startY = e.clientY;
    const startH = shell.getBoundingClientRect().height;
    const maxH = Math.round(
      (body?.getBoundingClientRect().height ?? window.innerHeight) *
        FOCUS_TOP_MAX_FRACTION,
    );
    const SNAP_PX = 12;
    const PANE_PAD_BOTTOM = 6; // .focus-pane bottom padding
    // Natural content height (independent of the pane's current height, which fill:100%
    // would otherwise inflate scrollHeight to): last row's bottom + the pane's bottom pad.
    const contentHeight = (): number => {
      if (!pane) return startH;
      const rows = pane.querySelectorAll(".focus-row, .focus-empty");
      if (rows.length === 0) return FOCUS_TOP_MIN;
      const last = rows[rows.length - 1] as HTMLElement;
      const paneTop = pane.getBoundingClientRect().top;
      return (
        last.getBoundingClientRect().bottom - paneTop + pane.scrollTop + PANE_PAD_BOTTOM
      );
    };
    let snapped = false;
    const heightAt = (ev: MouseEvent): number => {
      let h = Math.max(FOCUS_TOP_MIN, Math.min(maxH, startH + (ev.clientY - startY)));
      const c = contentHeight();
      snapped = Math.abs(h - c) <= SNAP_PX;
      if (snapped) h = c;
      return h;
    };
    // Enter fixed rendering at the current height so nothing jumps as the drag begins.
    shell.classList.add("fixed-top", "resizing");
    shell.style.setProperty("--focus-top-height", `${startH}px`);
    const onMove = (ev: MouseEvent) => {
      shell.style.setProperty("--focus-top-height", `${heightAt(ev)}px`);
      shell.classList.toggle("snapping", snapped);
    };
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      const h = heightAt(ev);
      shell.classList.remove("resizing", "snapping");
      if (snapped) {
        shell.classList.remove("fixed-top");
        shell.style.removeProperty("--focus-top-height");
        useWindowState.getState().setFocusTopHeight("auto");
      } else {
        useWindowState.getState().setFocusTopHeight(h);
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // "fixed-top" switches the top strip from content-fit (grid drawer) to a fixed dragged
  // height (a plain height drawer); "auto" keeps the content-fit grid trick.
  const fixedTop = layout === "top" && typeof topHeight === "number";
  const shellStyle: React.CSSProperties = {
    ["--focus-sidebar-width" as string]: `${sidebarWidth}px`,
    ...(fixedTop
      ? { ["--focus-top-height" as string]: `${topHeight as number}px` }
      : {}),
  };

  return (
    <div
      ref={shellRef}
      className={
        "focus-pane-shell" +
        (expanded ? " open" : "") +
        (fixedTop ? " fixed-top" : "")
      }
      style={shellStyle}
    >
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
      {/* Right-edge resize grip — only interactive in the sidebar layout (CSS hides it in
          the top strip and while collapsed). */}
      <div className="focus-resize-handle" onMouseDown={onResizeDown} />
    </div>
  );
}
