import { api } from "../lib/api";
import { OutlineLayout } from "../lib/layout";
import type { NodeKind } from "../lib/types";
import { endAnimNow, isAnimating, suppressGlideOnce } from "./collapseAnim";
import { drillInto, toggleCompleted, visibleRows } from "./controller";
import { projectDrop, useDrag, type DropCandidate } from "./drag";
import { mirror } from "./mirror";
import { selectionIds, useSelection } from "./selection";
import { useWindowState } from "./windowState";

/** The glyph's mousedown state machine: a still press-and-release is a CLICK (bullet →
 * drill, checkbox → toggle complete); moving past a threshold becomes a DRAG driving
 * the drop projection. Dragging a member of the live multi-selection drags the BLOCK. */

const DRAG_THRESHOLD = 4;
const EDGE_BAND = 44;
const EDGE_SPEED = 14;

/** Published by OutlineView each render — the geometry the projection needs. */
export interface DragEnv {
  scrollEl: HTMLElement | null;
  /** minY/maxY (content space) for every flattened row id, node rows only. */
  getFrames: () => Map<string, { minY: number; maxY: number }>;
}

let env: DragEnv = { scrollEl: null, getFrames: () => new Map() };

export function publishDragEnv(e: DragEnv) {
  env = e;
}

/** The outline geometry both pointer gestures project against (reorder drag and
 * multi-select drag) — always the LIVE publication, never a captured copy. */
export function dragEnv(): DragEnv {
  return env;
}

export function contentY(clientY: number): number {
  const el = env.scrollEl;
  if (!el) return clientY;
  const rect = el.getBoundingClientRect();
  return clientY - rect.top + el.scrollTop;
}

/** Edge auto-scroll for a live pointer gesture: while the pointer sits in the outline's
 * top/bottom band, scroll it and re-run the caller's projection (the pointer hasn't
 * moved, but the content under it has). Returns the stopper. */
export function startEdgeAutoScroll(
  getClientY: () => number,
  onScroll: () => void,
): () => void {
  const id = window.setInterval(() => {
    const el = env.scrollEl;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const y = getClientY();
    let delta = 0;
    if (y < rect.top + EDGE_BAND) delta = -EDGE_SPEED;
    else if (y > rect.bottom - EDGE_BAND) delta = EDGE_SPEED;
    if (delta !== 0) {
      el.scrollTop += delta;
      onScroll();
    }
  }, 16);
  return () => window.clearInterval(id);
}

function buildCandidates(subtree: Set<string>): DropCandidate[] {
  const frames = env.getFrames();
  const out: DropCandidate[] = [];
  for (const row of visibleRows()) {
    if (row.kind !== "node") continue;
    if (subtree.has(row.nodeId)) continue;
    const f = frames.get(row.id);
    const rec = mirror.get(row.nodeId);
    if (!f || !rec) continue;
    out.push({
      nodeId: row.nodeId,
      parent: rec.parent,
      kind: rec.kind,
      depth: row.depth,
      minY: f.minY,
      midY: (f.minY + f.maxY) / 2,
      maxY: f.maxY,
    });
  }
  return out;
}

export function glyphMouseDown(
  e: React.MouseEvent,
  nodeId: string,
  depth: number,
  kind: NodeKind,
) {
  if (e.button !== 0) return;
  e.preventDefault();
  // The drop projection reads the virtualizer's (un-animated) frames, so never let a
  // gesture start against rows that are still mid-glide.
  if (isAnimating()) endAnimNow();
  const startClientX = e.clientX;
  const startClientY = e.clientY;
  let dragging = false;
  let lastClientX = startClientX;
  let lastClientY = startClientY;
  let stopAutoScroll: (() => void) | null = null;

  const s = () => useWindowState.getState();

  const beginDrag = () => {
    dragging = true;
    const sel = selectionIds();
    const block = sel.includes(nodeId) ? sel : [nodeId];
    const subtree = new Set<string>();
    for (const b of block) for (const d of mirror.descendants(b)) subtree.add(d);
    const rec = mirror.get(nodeId);
    const ghost =
      block.length > 1
        ? `${block.length} items`
        : (rec?.text || "•").slice(0, 60);
    useDrag
      .getState()
      .begin(
        nodeId,
        depth,
        startClientX,
        contentY(startClientY),
        subtree,
        block,
        ghost,
      );
    stopAutoScroll = startEdgeAutoScroll(() => lastClientY, reproject);
  };

  const reproject = () => {
    const d = useDrag.getState();
    const fontSize = s().fontSize;
    const step = OutlineLayout.indentPerLevel * OutlineLayout.scale(fontSize);
    const projection = projectDrop(
      buildCandidates(d.subtree),
      contentY(lastClientY),
      lastClientX - startClientX,
      d.grabbedDepth,
      step,
      s().drill !== null,
      (id) => mirror.get(id)?.parent ?? null,
    );
    d.update(lastClientX, lastClientY, projection);
  };

  const onMove = (ev: MouseEvent) => {
    lastClientX = ev.clientX;
    lastClientY = ev.clientY;
    if (!dragging) {
      const dist = Math.hypot(
        ev.clientX - startClientX,
        ev.clientY - startClientY,
      );
      if (dist > DRAG_THRESHOLD) beginDrag();
    }
    if (dragging) reproject();
  };

  const cleanup = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    window.removeEventListener("keydown", onKey, true);
    stopAutoScroll?.();
  };

  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape" && dragging) {
      ev.preventDefault();
      ev.stopPropagation();
      cleanup();
      useDrag.getState().reset();
    }
  };

  const onUp = () => {
    cleanup();
    if (!dragging) {
      // A still click: bullet/prompt → drill in; checkbox → toggle complete.
      if (kind === "checkbox") void toggleCompleted(nodeId);
      else if (kind !== "line") drillInto(nodeId);
      return;
    }
    const d = useDrag.getState();
    const proj = d.projection;
    const block = d.block;
    d.reset();
    if (!proj) return;
    // A drop already tells the whole story — marker, ghost, dimmed row — so the row
    // should simply BE at the projected spot when the drag ends, not fly there after.
    // Armed unconditionally: the seam now sees EVERY structural delta, so a same-parent
    // drop reaches it as a reorder and drains the suppression — it can no longer leak
    // into the next Tab. And it must be armed either way, or the settle would animate
    // and disagree with the drop marker, whose projection frames are un-animated.
    suppressGlideOnce();
    void (async () => {
      const out =
        block.length > 1
          ? await api.moveBlockTo(block, proj.parentId, proj.afterId)
          : await api.moveTo(nodeId, proj.parentId, proj.afterId);
      if (out.expand.length > 0) useWindowState.getState().expandMany(out.expand);
      useSelection.getState().refresh();
    })();
  };

  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  window.addEventListener("keydown", onKey, true);
}

// Module-level state must never be split across HMR generations — a hot update that
// swapped this module would strand components on a fresh empty instance. Decline hot
// updates so edits here trigger a FULL reload instead.
if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
