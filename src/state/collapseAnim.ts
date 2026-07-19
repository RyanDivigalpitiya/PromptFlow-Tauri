/**
 * Expand/collapse animation — orchestration + tiny signal, kept OFF React's per-frame
 * path so it stays smooth at 120Hz. The whole motion is GPU-composited (transform +
 * opacity only); nothing here re-renders per frame.
 *
 * Three moving parts (see styles.css `.rows-animating`, `.node-row.entering`,
 * `.collapse-ghosts`):
 *   1. Below-content reflow — the virtualizer reassigns each surviving row a new
 *      translateY; a transient `.rows-animating` class turns on `transition: transform`
 *      on `.vrow` so they slide old→new on the compositor. The class is GATED to the
 *      toggle window: an always-on transition would make plain scrolling lag (the
 *      virtualizer repositions rows on every scroll tick).
 *   2. Entering rows (expand) — fade+slide in via a CSS keyframe; identified by diffing
 *      the post-toggle rows against `prevIds` captured before the state change.
 *   3. Leaving rows (collapse) — cloned out of the live DOM into one absolutely-
 *      positioned overlay that fades out. React never sees them; it's a single
 *      composited opacity layer, so a collapse of a big subtree costs nothing extra.
 *
 * A `runCollapseAnim(...)` wrapper is the ONE choke point every collapse mutation routes
 * through (see controller's toggleCollapse/setCollapsed/setCollapsedAll).
 */

import type { RenderRow } from "../lib/flatten";
import { mirror } from "./mirror";
import { measureFrames } from "./perfMeter";

/** Fallback duration, used only if the CSS variable can't be read. The REAL duration
 * is `--collapse-anim-dur` in styles.css — the single source of truth, read live by
 * `animDurationMs()` below, so retuning the animation means editing ONE value. */
export const COLLAPSE_ANIM_MS = 190;
/** Extra grace before tearing down the transition class / ghost overlay, so the CSS
 * transition has fully settled (a premature teardown snaps the last frame). */
const TEARDOWN_BUFFER_MS = 40;

/** The live CSS animation duration in ms. Read per toggle (cheap) rather than mirrored
 * as a constant: a hardcoded mirror silently desyncs the moment `--collapse-anim-dur`
 * is retuned, and the teardown timer then yanks the ghost overlay out mid-fade — the
 * ghosts snap out of existence partway through (shipped bug, fixed). */
function animDurationMs(): number {
  try {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue("--collapse-anim-dur")
      .trim();
    // Order matters: "2500ms" also ends with "s".
    if (raw.endsWith("ms")) return parseFloat(raw) || COLLAPSE_ANIM_MS;
    if (raw.endsWith("s")) return parseFloat(raw) * 1000 || COLLAPSE_ANIM_MS;
  } catch {
    // unreadable (no document / detached) — fall through to the constant
  }
  return COLLAPSE_ANIM_MS;
}

export type AnimMode = "expand" | "collapse";

// ---- signal (useSyncExternalStore-shaped) ----
let animating = false;
let mode: AnimMode = "expand";
let prevIds: ReadonlySet<string> = new Set();
let version = 0;
const listeners = new Set<() => void>();

export function subscribeAnim(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
export function animVersion(): number {
  return version;
}
export function isAnimating(): boolean {
  return animating;
}
/** True while an expand animation is live AND this row was NOT present before the
 * toggle — i.e. it should play the entrance. Always false during a collapse. */
export function isEntering(id: string): boolean {
  return animating && mode === "expand" && !prevIds.has(id);
}
function bump() {
  version += 1;
  listeners.forEach((cb) => cb());
}

// ---- ghost overlay (leaving rows on collapse) ----
let innerEl: HTMLElement | null = null;
let ghostOverlay: HTMLElement | null = null;
let endTimer: ReturnType<typeof setTimeout> | null = null;

/** OutlineView publishes its `.outline-inner` element — the coordinate space the
 * virtualizer's rows (and thus the ghost overlay) live in. */
export function publishAnimContainer(el: HTMLElement | null): void {
  innerEl = el;
}

function removeGhosts() {
  if (ghostOverlay) {
    ghostOverlay.remove();
    ghostOverlay = null;
  }
}

/** Clone the currently-rendered rows of the collapsing subtree into a fade-out overlay,
 * pinned at their pre-collapse positions. Only the VISIBLE (rendered) rows are cloned —
 * a 500-child subtree with 8 rows on screen makes 8 ghosts, not 500. */
function captureGhosts(prevRows: RenderRow[], collapseRoots: string[]) {
  if (!innerEl || collapseRoots.length === 0) return;
  const roots = new Set(collapseRoots);
  // Every id inside any collapsing subtree (roots + descendants). The root NODE rows
  // themselves stay on screen, so they're excluded below.
  const leaving = new Set<string>();
  for (const r of collapseRoots) for (const d of mirror.descendants(r)) leaving.add(d);

  const overlay = document.createElement("div");
  overlay.className = "collapse-ghosts";
  const vrows = innerEl.querySelectorAll<HTMLElement>(".vrow");
  vrows.forEach((v) => {
    const idx = Number(v.getAttribute("data-index"));
    const row = prevRows[idx];
    if (!row) return;
    // Keep the collapsing parent's own node row; drop its "+" add-row, its descendants
    // and their add-rows (all carry a nodeId inside the subtree).
    if (row.kind === "node" && roots.has(row.nodeId)) return;
    if (!leaving.has(row.nodeId)) return;
    overlay.appendChild(v.cloneNode(true));
  });
  if (overlay.childNodes.length > 0) {
    innerEl.appendChild(overlay);
    ghostOverlay = overlay;
  }
}

/** End the animation immediately: drop the transition class + ghost overlay and snap to
 * final positions. Called on teardown timeout and defensively on scroll (a scroll mid-
 * animation would otherwise make the gated transition lag every repositioned row). */
export function endAnimNow(): void {
  if (endTimer) {
    clearTimeout(endTimer);
    endTimer = null;
  }
  removeGhosts();
  if (animating) {
    animating = false;
    prevIds = new Set();
    bump();
  }
}

/**
 * Run one expand/collapse with animation. Order matters for a single clean paint:
 *   1. capture pre-change state (prevIds for the entering diff; ghost clones for
 *      collapse — the DOM must still hold the leaving rows).
 *   2. flip the anim signal ON *before* applying, so when `apply()`'s store mutation
 *      triggers OutlineView's re-render, `.rows-animating` and the entering flags are
 *      already in place — the new row positions transition from the old ones in a single
 *      commit rather than snapping first and animating a frame late.
 *   3. apply the actual collapse-set mutation.
 */
export function runCollapseAnim(
  m: AnimMode,
  collapseRoots: string[],
  prevRows: RenderRow[],
  apply: () => void,
): void {
  // A new toggle mid-animation: tear the previous one down cleanly first.
  endAnimNow();

  prevIds = new Set(prevRows.map((r) => r.id));
  mode = m;
  if (m === "collapse") captureGhosts(prevRows, collapseRoots);

  animating = true;
  bump(); // render 1: class + entering flags on, rows unchanged yet
  apply(); // render 2: new rows; positions transition, entering rows mount with fade

  // Teardown tracks the LIVE css duration, so the ghost fade / row slide always run to
  // completion no matter how the animation is retuned.
  const dur = animDurationMs();
  if (import.meta.env.DEV) {
    measureFrames(`collapse:${m}`, dur + 120);
  }

  endTimer = setTimeout(endAnimNow, dur + TEARDOWN_BUFFER_MS);
}

// Module-level state must never be split across HMR generations — decline hot updates.
if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
