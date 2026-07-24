import { endAnimNow, isAnimating } from "./collapseAnim";
import { visibleRows } from "./controller";
import { contentY, dragEnv, startEdgeAutoScroll } from "./dragGesture";
import { mirror } from "./mirror";
import { projectSelectionHead, useSelection } from "./selection";
import { useWindowState } from "./windowState";

/** Mouse multi-select: sweep the pointer across rows to grow a NODE selection (the
 * `MultiSelectMouseSession` port). Same entry rule as the original — a press starts as
 * ordinary TEXT selection inside the pressed row, and only becomes a node selection
 * once the pointer leaves that row's top/bottom edge — so click-to-edit, caret
 * placement and dragging out a text range inside one node are all untouched.
 *
 * AppKit needed a synthetic mouseUp to abort NSTextView's modal tracking loop before it
 * could take the pointer over; WebKit has no such loop, but it DOES keep extending the
 * native text selection under the pointer, so the takeover clears that selection and
 * makes the outline's text unselectable (`.selecting-nodes`) for the rest of the drag.
 *
 * Armed in the CAPTURE phase on the scroll host, and deliberately passive at mousedown
 * (no preventDefault, no stopPropagation): every row handler underneath still runs, so
 * a press that never turns into a drag behaves exactly as it did before. */

const DRAG_THRESHOLD = 4;

/** Controls that own their own press: the glyph runs the drill/reorder state machine
 * and the buttons act on their click. Anything else in the outline can start a sweep —
 * text, a row's blank trailing area, a divider, the background below the rows. */
const EXCLUDED = "button, .glyph-slot, .prompt-line-bullet";

const parentOf = (id: string) => mirror.get(id)?.parent ?? null;

/** The node row whose band contains `y` (content space), by the SAME rule the
 * projection uses — so the anchor a background press adopts is the row the projection
 * would then pick for it. Null only when the outline has no measured node rows. */
function nodeRowAt(y: number): string | null {
  const frames = dragEnv().getFrames();
  const rows = visibleRows().filter((r) => r.kind === "node" && frames.has(r.id));
  if (rows.length === 0) return null;
  const hit = rows.find((r) => frames.get(r.id)!.maxY > y) ?? rows[rows.length - 1];
  return hit.nodeId;
}

/** Drop any native text selection the press left behind. The guard is what makes this
 * safe to hang off `selectionchange`: after the first call `rangeCount` is 0, so the
 * change it fires itself is a no-op and the loop terminates. */
function dropTextSelection() {
  const sel = document.getSelection();
  if (sel && sel.rangeCount > 0 && !sel.isCollapsed) sel.removeAllRanges();
}

export function selectionMouseDown(e: React.MouseEvent) {
  // ctrl-click is a secondary click on macOS; ⌘/⌥ presses carry no selection meaning.
  if (e.button !== 0 || e.metaKey || e.altKey || e.ctrlKey) return;
  const host = e.currentTarget as HTMLElement;
  // A press in the scrollbar gutter belongs to the scrollbar.
  if (e.clientX > host.getBoundingClientRect().left + host.clientWidth) return;
  const target = e.target as HTMLElement;
  if (target.closest(EXCLUDED)) return;

  // Any plain press in the outline drops a live selection — the row/background handlers
  // cover only some of these surfaces, and a stale tint under a fresh caret reads as a
  // stuck selection. Shift instead EXTENDS, so it must keep the anchor.
  const shift = e.shiftKey;
  if (!shift) useSelection.getState().clear();

  const startX = e.clientX;
  const startY = e.clientY;
  let lastY = startY;
  let active = false;
  let anchor: string | null = null;
  let head: string | null = null;
  let stopAutoScroll: (() => void) | null = null;

  // The pressed row, and its content-space band: the sweep takes over only once the
  // pointer leaves it. A press that isn't on a node row (the "+" placeholder, the
  // background under the list) has no band and converts on the threshold alone.
  const rows = visibleRows();
  const vrow = target.closest(".vrow") as HTMLElement | null;
  const idx = vrow ? Number(vrow.dataset.index) : -1;
  const startRow =
    idx >= 0 && rows[idx]?.kind === "node" ? rows[idx] : null;
  const band = startRow ? (dragEnv().getFrames().get(startRow.id) ?? null) : null;

  const extend = () => {
    if (anchor === null) return;
    const h = projectSelectionHead(
      anchor,
      contentY(lastY),
      visibleRows(),
      dragEnv().getFrames(),
      parentOf,
    );
    if (h === null || h === head) return;
    head = h;
    // `start`, not `extendTo`: the anchor is fixed for the whole sweep, so re-pinning
    // it each step keeps the range identical to the one shift-click would resolve.
    useSelection.getState().start(anchor, h);
  };

  const begin = () => {
    // The projection reads the virtualizer's (un-animated) frames — never sweep against
    // rows that are still mid-glide.
    if (isAnimating()) endAnimNow();
    const s = useWindowState.getState();
    anchor = shift
      ? (useSelection.getState().anchor ?? s.focusId ?? startRow?.nodeId ?? null)
      : (startRow?.nodeId ?? null);
    anchor ??= nodeRowAt(contentY(lastY));
    if (anchor === null) return; // nothing measured to select
    active = true;
    // Nothing may be first responder while a node selection is live (the capture-phase
    // key handler owns the keyboard then) — and the pressed editor's text selection has
    // to go with it, since this gesture is what replaces it.
    (document.activeElement as HTMLElement | null)?.blur();
    s.clearFocus();
    // Two halves, and BOTH are needed. The class stops a NEW native selection forming
    // as the pointer crosses the next row (`user-select: none`). The listener kills the
    // one already IN FLIGHT when the press landed in a live editor (or on the outline
    // background, where nothing calls preventDefault): WebKit extends that selection in
    // the mousemove's DEFAULT action, i.e. AFTER our handler has run, so clearing it
    // from `extend` always loses the race and leaves a stray character highlighted —
    // measured. `selectionchange` fires after the default action, so it wins.
    host.classList.add("selecting-nodes");
    document.addEventListener("selectionchange", dropTextSelection);
    dropTextSelection();
    extend();
    stopAutoScroll = startEdgeAutoScroll(() => lastY, extend);
  };

  const cleanup = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    window.removeEventListener("keydown", onKey, true);
    document.removeEventListener("selectionchange", dropTextSelection);
    stopAutoScroll?.();
    host.classList.remove("selecting-nodes");
  };

  const onMove = (ev: MouseEvent) => {
    lastY = ev.clientY;
    if (!active) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) <= DRAG_THRESHOLD) {
        return;
      }
      if (band) {
        const y = contentY(ev.clientY);
        if (y >= band.minY && y <= band.maxY) return; // still inside the pressed row
      }
      begin();
      if (!active) cleanup(); // nothing to anchor to — get out of the way
      return;
    }
    extend();
  };

  const onKey = (ev: KeyboardEvent) => {
    if (!active || ev.key !== "Escape") return;
    ev.preventDefault();
    ev.stopPropagation();
    cleanup();
    useSelection.getState().clear();
  };

  const onUp = () => cleanup();

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
