/**
 * Expand/collapse animation — orchestration + tiny signal, kept OFF React's per-frame
 * path so it stays smooth at 120Hz. The whole motion is GPU-composited (transform +
 * opacity only); nothing here re-renders per frame.
 *
 * THE DRAWER (single-node toggles). Revealing a subtree slides it out from behind the
 * parent while everything below slides down by the subtree height H. The trick that
 * makes this work in a virtualized flat list is that the reveal EDGE is a CLIP boundary,
 * not a content boundary — so how far the edge travels (correctness) and how far the
 * content travels (aesthetics) are independent:
 *
 *   f(t) = shared easing output, shared duration, shared start.
 *   .drawer-sweep   : translateY(-H)      -> translateY(0)     // the clip edge
 *   .drawer-content : translateY(H - CAP) -> translateY(0)     // the rows inside
 *   => a clone at block-local y paints at  B + y - CAP*(1-f)
 *   => the visible band is exactly [B, B + H*f]   (clip ∩ clip)
 *
 * Rows below the parent transition from B to B+H, so their top edge sits at B + H*f —
 * the drawer's edge and the content below TILE EXACTLY at every instant, for any easing
 * and any CAP. H is correctness; CAP is taste.
 *
 * Why CAP is capped: with CAP = H (a literal rigid drawer) the visible band shows block-
 * local offsets [H(1-f), H] — i.e. the BOTTOM of the subtree arrives FIRST, which reads
 * backwards in an outline, and those rows aren't even rendered (the virtualizer renders
 * by final position). At H≈1200px over 190ms the content also moves ~100px/frame, which
 * strobes rather than glides. CAP = min(H, DRAWER_PULL) keeps the literal drawer for
 * small subtrees (H <= DRAWER_PULL => CAP = H) and degrades continuously into a
 * head-first curtain with a one-row parallax lead-in for large ones. One code path.
 *
 * Bulk ops (⌘⇧E/⌘⇧D) have no single B/H, so they keep the older look: entering rows fade
 * in (`.node-row.entering`) and leaving rows dissolve (`.collapse-ghosts`).
 *
 * `runCollapseAnim(...)` is the ONE choke point every collapse mutation routes through
 * (see controller's toggleCollapse/setCollapsed/setCollapsedAll).
 */

import { flushSync } from "react-dom";
import type { RenderRow } from "../lib/flatten";
import { mirror } from "./mirror";
import { measureFrames } from "./perfMeter";

/** Fallback duration, used only if the CSS variable can't be read. The REAL duration
 * is `--collapse-anim-dur` in styles.css — the single source of truth, read live by
 * `animDurationMs()` below, so retuning the animation means editing ONE value. */
export const COLLAPSE_ANIM_MS = 190;
/** Extra grace before tearing down the transition class / overlays, so the CSS
 * transition has fully settled (a premature teardown snaps the last frame). */
const TEARDOWN_BUFFER_MS = 40;

/** How far the drawer's CONTENT travels, in px (the CAP above). Pure aesthetics — it
 * never affects the tiling. 0 = a pure curtain wipe (content dead still, edge sweeps
 * down); >= H = a literal rigid drawer. Tune by eye. */
const DRAWER_PULL_PX = 48;

/** The live CSS animation duration in ms. Read per toggle (cheap) rather than mirrored
 * as a constant: a hardcoded mirror silently desyncs the moment `--collapse-anim-dur`
 * is retuned, and the teardown timer then yanks the overlay out mid-flight (shipped
 * bug, fixed). */
function cssDurationMs(name: string, fallback: number): number {
  try {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim();
    // Order matters: "2500ms" also ends with "s".
    if (raw.endsWith("ms")) return parseFloat(raw) || fallback;
    if (raw.endsWith("s")) return parseFloat(raw) * 1000 || fallback;
  } catch {
    // unreadable (no document / detached) — fall through to the fallback
  }
  return fallback;
}

/** The window the whole animation needs. Movement and fade share one duration and one
 * curve (see styles.css — decoupling the fade's timing reads as jarring). */
function animDurationMs(): number {
  return cssDurationMs("--collapse-anim-dur", COLLAPSE_ANIM_MS);
}

export type AnimMode = "expand" | "collapse";

// ---- signal (useSyncExternalStore-shaped) ----
let animating = false;
let mode: AnimMode = "expand";
let prevIds: ReadonlySet<string> = new Set();
let drawerShowing = false;
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
/** True while a drawer overlay is presenting the revealed/removed block — the real
 * entering rows must stay invisible (but still laid out) so they don't double-draw. */
export function isDrawerShowing(): boolean {
  return drawerShowing;
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

// ---- environment published by OutlineView ----
export interface AnimEnv {
  inner: HTMLElement | null;
  scrollEl: HTMLElement | null;
  /** Content-space extent of flattened row `i` (the virtualizer's measurement cache). */
  measureAt: (i: number) => { start: number; end: number } | undefined;
  totalSize: () => number;
  rows: () => RenderRow[];
}
const EMPTY_ENV: AnimEnv = {
  inner: null,
  scrollEl: null,
  measureAt: () => undefined,
  totalSize: () => 0,
  rows: () => [],
};
let env: AnimEnv = EMPTY_ENV;

export function publishAnimEnv(e: AnimEnv | null): void {
  env = e ?? EMPTY_ENV;
}

// ---- overlays ----
let ghostOverlay: HTMLElement | null = null;
let drawerEl: HTMLElement | null = null;
/** Applies the `to` transforms; split from the build so BOTH the drawer's transition and
 * the survivor rows' transition start in the same post-apply moment (a one-frame offset
 * would show as a seam the width of a frame's travel). */
let startDrawer: (() => void) | null = null;
let endTimer: ReturnType<typeof setTimeout> | null = null;

function removeOverlays() {
  if (ghostOverlay) {
    ghostOverlay.remove();
    ghostOverlay = null;
  }
  if (drawerEl) {
    drawerEl.remove();
    drawerEl = null;
  }
  startDrawer = null;
}

/** Clone the currently-rendered rows of the collapsing subtree into a fade-out overlay,
 * pinned at their pre-collapse positions. The BULK fallback (⌘⇧E) — single-node
 * collapses use the drawer instead. */
function captureGhosts(prevRows: RenderRow[], collapseRoots: string[]) {
  const inner = env.inner;
  if (!inner || collapseRoots.length === 0) return;
  const roots = new Set(collapseRoots);
  const leaving = new Set<string>();
  for (const r of collapseRoots) for (const d of mirror.descendants(r)) leaving.add(d);

  const overlay = document.createElement("div");
  overlay.className = "collapse-ghosts";
  inner.querySelectorAll<HTMLElement>(".vrow").forEach((v) => {
    const row = prevRows[Number(v.getAttribute("data-index"))];
    if (!row) return;
    // Keep the collapsing parent's own node row; drop its "+" add-row, its descendants
    // and their add-rows (all carry a nodeId inside the subtree).
    if (row.kind === "node" && roots.has(row.nodeId)) return;
    if (!leaving.has(row.nodeId)) return;
    overlay.appendChild(v.cloneNode(true));
  });
  if (overlay.childNodes.length > 0) {
    inner.appendChild(overlay);
    ghostOverlay = overlay;
  }
}

/** Build the three-layer drawer over `rootId`'s child block. `rows` must be the flatten
 * in which that block is PRESENT (post-apply for expand, pre-apply for collapse).
 * Returns false when a drawer isn't possible, so the caller can fall back. */
function buildDrawer(m: AnimMode, rootId: string, rows: RenderRow[]): boolean {
  const inner = env.inner;
  if (!inner) return false;
  const p = rows.findIndex((r) => r.kind === "node" && r.nodeId === rootId);
  if (p < 0) return false;
  // The block is the contiguous run of deeper rows right after the parent (its "+"
  // add-row included) — no diffing needed.
  const depth = rows[p].depth;
  let e = p + 1;
  while (e < rows.length && rows[e].depth > depth) e++;
  if (e === p + 1) return false; // nothing revealed / removed

  const first = env.measureAt(p + 1);
  if (!first) return false;
  const B = first.start; // the parent's bottom edge, in content space
  const after = e < rows.length ? env.measureAt(e) : undefined;
  const hVirt = (after ? after.start : env.totalSize()) - B;
  if (hVirt <= 0) return false;

  const clip = document.createElement("div");
  clip.className = "drawer-clip";
  const sweep = document.createElement("div");
  sweep.className = "drawer-sweep";
  const content = document.createElement("div");
  content.className = "drawer-content";
  sweep.appendChild(content);
  clip.appendChild(sweep);

  // Clone only the RENDERED rows of the block, repositioned block-local.
  let hMeasured = 0;
  inner.querySelectorAll<HTMLElement>(".vrow").forEach((v) => {
    const i = Number(v.getAttribute("data-index"));
    if (!(i > p && i < e)) return;
    const mm = env.measureAt(i);
    if (!mm) return;
    hMeasured = Math.max(hMeasured, mm.end - B);
    const c = v.cloneNode(true) as HTMLElement;
    c.style.transform = `translateY(${mm.start - B}px)`;
    // A clone is an inert snapshot: never editable, never focusable, and never wearing
    // the marker classes the live rows use (entering-row would hide it, see styles).
    c.classList.remove("entering-row");
    c.removeAttribute("contenteditable");
    c.querySelectorAll("[contenteditable]").forEach((n) =>
      n.removeAttribute("contenteditable"),
    );
    c.setAttribute("aria-hidden", "true");
    content.appendChild(c);
  });
  if (content.childNodes.length === 0) return false;

  // Bias H UP: under-shooting is the only direction that pops (the edge would stop short
  // of the content below), while over-shooting just sweeps into empty space.
  const H = Math.max(hMeasured, hVirt) + 1;
  const CAP = Math.min(H, DRAWER_PULL_PX);

  // Clamp the overlay's height so an absolutely-positioned child can't prop open
  // .outline-scroll's scrollable area (it would add overflow below the real content).
  const sc = env.scrollEl;
  const visibleBelow = sc ? sc.scrollTop + sc.clientHeight - B + 400 : H;
  clip.style.top = `${B}px`;
  clip.style.height = `${Math.max(0, Math.min(H, visibleBelow))}px`;
  sweep.style.height = `${H}px`;

  const fromSweep = m === "expand" ? -H : 0;
  const toSweep = m === "expand" ? 0 : -H;
  const fromContent = m === "expand" ? H - CAP : 0;
  const toContent = m === "expand" ? 0 : H - CAP;
  // The block also fades as it travels — in on the way out, out on the way in.
  const fromOpacity = m === "expand" ? "0" : "1";
  const toOpacity = m === "expand" ? "1" : "0";
  sweep.style.transform = `translateY(${fromSweep}px)`;
  content.style.transform = `translateY(${fromContent}px)`;
  content.style.opacity = fromOpacity;

  inner.appendChild(clip);
  drawerEl = clip;
  startDrawer = () => {
    void clip.offsetHeight; // flush the `from` styles so the transition has a start value
    clip.classList.add("drawer-anim");
    sweep.style.transform = `translateY(${toSweep}px)`;
    content.style.transform = `translateY(${toContent}px)`;
    content.style.opacity = toOpacity;
  };
  return true;
}

/** End the animation immediately: drop the transition class + overlays and snap to final
 * positions. Reveal the real rows BEFORE removing the drawer — late is free, early is the
 * only ordering that flashes. */
export function endAnimNow(): void {
  if (endTimer) {
    clearTimeout(endTimer);
    endTimer = null;
  }
  if (animating || drawerShowing) {
    animating = false;
    drawerShowing = false;
    prevIds = new Set();
    bump(); // real rows become visible again in this commit
  }
  removeOverlays();
}

/**
 * Run one expand/collapse with animation.
 *
 * Ordering is load-bearing. The anim signal flips ON *before* `apply()` so that when the
 * store mutation triggers OutlineView's re-render, `.rows-animating` and the entering /
 * drawer flags are already in place — the new row positions transition from the old ones
 * in a single commit instead of snapping first and animating a frame late. The drawer's
 * own transition is started only AFTER apply(), in the same task, so it shares a frame
 * with the survivor rows' transition.
 */
export function runCollapseAnim(
  m: AnimMode,
  roots: string[],
  prevRows: RenderRow[],
  apply: () => void,
): void {
  // A new toggle mid-animation: tear the previous one down cleanly first.
  endAnimNow();

  prevIds = new Set(prevRows.map((r) => r.id));
  mode = m;
  // A drawer needs one parent to hang off; bulk ops have no single B/H.
  const rootId = roots.length === 1 ? roots[0] : null;

  if (m === "collapse") {
    // The leaving rows are still in the DOM right now — clone before applying.
    const ok = rootId ? buildDrawer("collapse", rootId, prevRows) : false;
    if (!ok) captureGhosts(prevRows, roots);
    drawerShowing = ok;
  } else {
    // Hide the entering rows from their very first commit, so the drawer (built below,
    // once they exist) is the only thing drawing them.
    drawerShowing = rootId !== null;
  }
  animating = true;

  // COMMIT 1 — flags only, rows UNCHANGED. Then force a style resolution. This is what
  // makes the rows below actually glide: a CSS transition only starts if the element's
  // previously RESOLVED style already carried the transition. Letting React batch the
  // class in with the new positions leaves the survivors with no before-change style to
  // animate from, and they snap to their new spot (shipped bug, fixed). Don't collapse
  // these two flushes back into one.
  flushSync(bump);
  void env.inner?.offsetHeight;

  // COMMIT 2 — the actual row change. Survivors transition old -> new from here.
  flushSync(apply);

  if (m === "expand" && rootId) {
    // The entering rows exist and are measured now — clone them into the drawer.
    if (!buildDrawer("expand", rootId, env.rows())) {
      drawerShowing = false; // fall back to the plain entrance fade
      bump();
    }
  }

  // Started only now, in the same task as commit 2, so the drawer's transition shares a
  // frame with the survivors' — a one-frame offset would show as a seam.
  startDrawer?.();

  // Teardown tracks the LIVE css duration, so every part runs to completion no matter
  // how the animation is retuned.
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
