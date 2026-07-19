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
 * Bulk ops (⌘⇧E/⌘⇧D) have no single B/H, so they keep the older look: the gated reflow
 * slide, plus a `.node-row.entering` fade on expand. They pass NO roots, so they never
 * raise ghosts — `.collapse-ghosts` is only the single-node collapse fallback.
 *
 * `runCollapseAnim(...)` is the ONE choke point every collapse mutation routes through
 * (see controller's toggleCollapse/setCollapsed/setCollapsedAll).
 *
 * THE TAB GLIDE (indent/outdent) also lives here, at the bottom of the file — it shares
 * this module's `.rows-animating` class, its teardown timer and its `glideBand`, and
 * having two owners for any of those would be a bug. Unlike the collapse it is driven
 * from the DELTA rather than the gesture, so ⌘Z and another window's edit glide too.
 */

import { flushSync } from "react-dom";
import type { RenderRow } from "../lib/flatten";
import { mirror, setStructureCommit } from "./mirror";
import { measureFrames } from "./perfMeter";
import { useWindowState } from "./windowState";

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

export type AnimMode = "expand" | "collapse" | "glide";

// ---- signal (useSyncExternalStore-shaped) ----
let animating = false;
let mode: AnimMode = "expand";
let prevIds: ReadonlySet<string> = new Set();
let drawerShowing = false;
/** The single node being toggled (null for the bulk ⌘⇧E/⌘⇧D path) — the anchor
 * `glideBand` hangs off. */
let animRootId: string | null = null;
let version = 0;
const listeners = new Set<() => void>();

// ---- tab-glide signal (see the driver at the bottom of the file) ----
/** More reparented ROOTS than a gesture can plausibly produce ⇒ a bulk reshuffle
 * (import, a whole-document move). Snap instead. */
const GLIDE_MAX_ROOTS = 64;
/** Moved-root id → how many LEVELS its subtree moved (+1 = indented one level). */
let glideRoots: Map<string, number> | null = null;
/** "idle": flags only — no offset yet, so the rows still paint where they were.
 * "invert": rows are laid out at their NEW indent but painted at the old one, with the
 *   transition SUPPRESSED (`.glide-arm`) — see the CSS note on why that suppression is
 *   the whole ballgame.
 * "play": the offset is released to 0 and the transition is allowed — the commit the
 *   motion actually runs from. */
let glidePhase: "idle" | "invert" | "play" = "idle";
/** A drag already tells the whole story (drop marker, ghost under the cursor, the row
 * dimmed in place) and its projection frames are un-animated, so a glide on top would
 * disagree with them. Expiring rather than a bare flag, so a cancelled drop can't
 * poison the next Tab — and the CALLER must arm it only for a drop that genuinely
 * reparents, since only a reparent delta reaches the seam that drains it. */
let suppressUntil = 0;
export function suppressGlideOnce(): void {
  suppressUntil = performance.now() + 2000;
}

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
/** Absent from the flatten this animation started from, whatever its kind. Such a row
 * has no old position to slide from, and the virtualizer places it at an ESTIMATED
 * height until its ResizeObserver reports the real one, so it must be excluded from the
 * survivor reflow transition (`.rows-animating .vrow:not(.entering-row)`). On the
 * expand/collapse paths this is exactly `isEntering`; it exists separately so a GLIDE —
 * which can also create rows, e.g. the destination parent's "+" placeholder — gets that
 * exclusion WITHOUT also firing the rowEnter keyframe, whose animation declaration
 * would outrank the glide's own transform. */
export function isNewRow(id: string): boolean {
  return animating && !prevIds.has(id);
}
/** Resolve a row's glide delta by walking UP the (already-mutated) mirror to a moved
 * root — cheaper and steadier than enumerating descendants, which for a collapsed
 * 5000-node subtree would allocate 5000 entries to move ~0 rendered rows. */
function glideDelta(nodeId: string): number | null {
  const roots = glideRoots;
  if (!roots) return null;
  let cur: string | null = nodeId;
  const seen = new Set<string>();
  while (cur) {
    const d = roots.get(cur);
    if (d !== undefined) return d;
    if (seen.has(cur)) break; // cycle guard, as elsewhere in the mirror
    seen.add(cur);
    cur = mirror.get(cur)?.parent ?? null;
  }
  return null;
}
/** How many LEVELS this row must be shifted back by right now: the negative of its
 * depth change while inverted, 0 once released, null when it isn't gliding at all (no
 * class, no transform). OutlineView converts levels → px, so NodeRow never has to know
 * this module exists. */
export function glideLevels(nodeId: string): number | null {
  if (!glideRoots || glidePhase === "idle") return null;
  const d = glideDelta(nodeId);
  if (d === null) return null;
  return glidePhase === "invert" ? -d : 0;
}
/** True during the INVERT commit, when the offset must be applied with the transition
 * switched off. Without this the offset and its transition declaration would arrive in
 * the same style change, and a transition takes its property/duration from the
 * AFTER-change style — so the row would transition none→offset (i.e. never actually
 * paint at the old position) and the release would then cancel it at ~0ms elapsed. The
 * result was a horizontal SNAP, verified in WebKit; this flag is the fix. */
export function isGlideArming(): boolean {
  return glideRoots !== null && glidePhase === "invert";
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

/**
 * The extra index band OutlineView must keep MOUNTED for the duration of a single-node
 * toggle, on top of the virtualizer's natural window. Null when no such animation is live.
 *
 * WHY: a CSS transition only starts when the element already carried a RESOLVED style
 * carrying it — the same rule that forces the two flushSyncs below. A row the virtualizer
 * had NOT rendered before the toggle is created for the FIRST time in commit 2, with its
 * final translateY as its only computed style, so it cannot transition: it paints at the
 * destination while its neighbours glide. The natural window reaches only `overscan` rows
 * past the viewport, so ANY subtree taller than that pushes the rows that must glide
 * outside it — which is why small subtrees animated correctly and large ones snapped from
 * a seam downward (shipped bug, fixed). On EXPAND the same rows are instead unmounted in
 * commit 2 (their new position is below the window), leaving a blank strip under the
 * sweeping edge — one cause, two symptoms.
 *
 * The rows that must glide are always the ones immediately AFTER the toggled parent's
 * block, and never more than one viewport's worth — nothing that is off-screen when the
 * animation ends can be seen to snap. So this is ~a screenful no matter how tall the
 * subtree is; the cost does not grow with H.
 *
 * `rows` must be the CURRENT flatten. The block scan re-derives itself in whichever index
 * space it is called in, so ONE rule covers all four states: pre-collapse / post-expand
 * the block is present and the band lands past it (the rows to add / to keep);
 * post-collapse / pre-expand the block is absent, the band degenerates onto rows the
 * natural window already holds, and it costs nothing.
 */
export function glideBand(
  rows: RenderRow[],
  count: number,
  rowEstimate: number,
): { lo: number; hi: number } | null {
  if (!animating || !animRootId) return null;
  const viewport = env.scrollEl?.clientHeight ?? 0;
  if (viewport <= 0) return null;
  const n = Math.min(rows.length, count);
  const p = rows.findIndex((r) => r.kind === "node" && r.nodeId === animRootId);
  if (p < 0) return null;
  const depth = rows[p].depth;
  let e = p + 1;
  while (e < n && rows[e].depth > depth) e++;
  if (e >= n) return null; // the block runs to the end — nothing below it to glide
  const first = env.measureAt(e);
  if (!first) return null;
  // Walk real (or estimated) extents rather than dividing by rowEstimate, so a viewport
  // full of short rows (dividers) is still covered end to end. Bounded by the viewport.
  const limit = first.start + viewport + rowEstimate;
  let hi = e;
  while (hi + 1 < n) {
    const m = env.measureAt(hi + 1);
    if (!m || m.start >= limit) break;
    hi++;
  }
  return { lo: e, hi };
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
 * pinned at their pre-collapse positions. Reached ONLY when a single-node collapse can't
 * build a drawer — bulk ⌘⇧E passes no roots and returns here immediately. */
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
    animRootId = null;
    // Teardown is a PROP change, not a class the row remembers: the next render emits
    // every row with no `.gliding` and no offset. That's why onWheel's guard, the
    // unmount cleanup and runCollapseAnim's preempt all cancel a glide for free.
    glideRoots = null;
    glidePhase = "idle";
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
  // Set BEFORE commit 1: the band's rows must mount in the same commit that adds
  // `.rows-animating`, so the forced reflow below arms them with a before-change style.
  animRootId = rootId;
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

// ---- the tab glide (indent / outdent) ----

/** `id`'s depth as the flatten would compute it, in the CURRENT (post-mutation) mirror.
 * Drill-aware: flattenDrillRoot rebases the drill root to 0. Null when the node has
 * left the drilled subtree entirely — ⇧Tab on a direct child of the drill root removes
 * it from the view, and there is nothing left on screen to glide. */
function modelDepth(id: string, drill: string | null): number | null {
  if (id === drill) return 0;
  let d = 0;
  let p = mirror.get(id)?.parent ?? null;
  const seen = new Set([id]);
  while (p) {
    if (seen.has(p)) return null;
    seen.add(p);
    d++;
    if (p === drill) return d;
    p = mirror.get(p)?.parent ?? null;
  }
  return drill === null ? d : null;
}

/** Decide whether this reparent can glide, and by how many levels per moved root. Null
 * ⇒ publish normally (snap). Each bail is its own reason:
 *   - too many roots         : a bulk reshuffle, not a gesture
 *   - not in the old flatten : it wasn't on screen. Import mints FRESH ids, so every
 *                              row misses here and that whole path self-excludes
 *   - lands under a collapse : it will be absent from the new flatten, so React
 *                              unmounts it and there is nothing to transform
 *   - modelDepth null        : it left the drilled subtree
 *   - delta 0                : a same-level move — vertical only, already handled */
function planGlide(reparented: readonly string[]): Map<string, number> | null {
  if (reparented.length === 0 || reparented.length > GLIDE_MAX_ROOTS) return null;
  const st = useWindowState.getState();
  const want = new Set(reparented);
  const wasDepth = new Map<string, number>();
  for (const r of env.rows()) {
    if (r.kind === "node" && want.has(r.nodeId)) wasDepth.set(r.nodeId, r.depth);
  }
  const out = new Map<string, number>();
  for (const id of reparented) {
    const was = wasDepth.get(id);
    if (was === undefined) continue;
    const now = modelDepth(id, st.drill);
    if (now === null || now === was) continue;
    let p = mirror.get(id)?.parent ?? null;
    let hidden = false;
    const seen = new Set<string>();
    // Stops at the drill root, like modelDepth: flattenDrillRoot ignores the root's own
    // collapse and never looks above it, so a collapsed ancestor at or above the root
    // hides nothing — testing it would wrongly suppress the glide for every child of a
    // drill root that happens to be collapsed at home level (⌘⇧E then drill in).
    while (p && p !== st.drill && !hidden && !seen.has(p)) {
      seen.add(p);
      if (st.collapsed.has(p)) hidden = true;
      p = mirror.get(p)?.parent ?? null;
    }
    if (hidden) continue;
    out.set(id, now - was);
  }
  return out.size > 0 ? out : null;
}

/**
 * TAB GLIDE — a reparented row slides into its new indent instead of snapping there.
 *
 * Driven from the DELTA rather than the gesture, so ONE implementation covers every
 * path that can reparent: Tab/⇧Tab, block Tab on a selection, ⌘Z/⇧⌘Z (which has no
 * frontend call site at all — the native pf-undo item goes straight to the store), and
 * an edit made in another window. It also means a no-op mutation (Tab on a first
 * sibling, ⇧Tab at the root) emits no delta and so arms nothing at all.
 *
 * THREE commits, because a transition needs its FROM value to have been resolved as a
 * separate style change before the TO value is written:
 *
 *   1  flags only, rows UNCHANGED   ─ forced reflow ─▶ arms `.rows-animating` (vertical)
 *   2  new depths AND the inversion ─ forced reflow ─▶ resolves the FROM x (horizontal)
 *   3  release the inversion                        ─▶ both axes run to final
 *
 * Commits 1→2 are runCollapseAnim's pair verbatim: the survivors' OLD translateY has to
 * be a resolved style before commit 2 writes the new one. Commits 2→3 are the classic
 * FLIP invert-then-play, and the inversion in commit 2 MUST be un-transitioned — hence
 * `.glide-arm`. Note the rule is NOT "a transition only starts if the previous style
 * already declared it": a transition takes its property and duration from the
 * AFTER-change style, which is exactly why `startDrawer` can add `.drawer-anim` and the
 * new transform together. Getting that backwards makes commit 2 start a
 * none→offset transition that commit 3 then cancels at ~0ms, and the row snaps.
 *
 * All three run in one task with no paint between, so X and Y start on the same frame —
 * the same reason startDrawer() is deferred until after apply().
 *
 * paddingLeft is NEVER animated: every intermediate value re-wraps the text, changes
 * the row's height, and drives the virtualizer's ResizeObserver to reposition the whole
 * list on the main thread each frame. The row is laid out at its final indent from
 * commit 2 and TRANSLATED back, so the motion stays pure compositor work.
 */
setStructureCommit((reparented, publish) => {
  const suppressed = performance.now() < suppressUntil;
  suppressUntil = 0;
  const inner = env.inner;
  const roots = suppressed || !inner ? null : planGlide(reparented);
  if (!roots || !inner) {
    publish();
    return;
  }

  endAnimNow(); // one owner for `.rows-animating` and the teardown timer

  // env.rows() is the LAST RENDERED flatten — still pre-mutation here, since React
  // hasn't re-rendered yet. The same source runCollapseAnim's expand path reads.
  prevIds = new Set(env.rows().map((r) => r.id));
  mode = "glide";
  drawerShowing = false;
  // Reuse the drawer's band anchor. At commit 1 (old flatten) glideBand mounts ~one
  // screenful below the moved node's OLD block — exactly the rows an outdent travels
  // past. Without it, overscan(14) leaves them unrendered and they snap from a seam
  // while the moved row glides (the drawer's "one cause, two symptoms" bug).
  animRootId = roots.keys().next().value ?? null;
  glideRoots = roots;
  animating = true;

  // COMMIT 1 — flags only. structureVersion is untouched, so OutlineView's `rows` memo
  // returns the SAME array: every row re-renders at its old depth and old translateY,
  // and glideLevels() is null ("idle"), so no row gains `.gliding` yet.
  glidePhase = "idle";
  flushSync(bump);
  void inner.offsetHeight;

  // COMMIT 2 — the real structural change AND the inversion, together.
  glidePhase = "invert";
  flushSync(() => {
    bump();
    publish();
  });
  void inner.offsetHeight;

  // COMMIT 3 — release. Still before paint, so the horizontal transition starts on the
  // same frame as the vertical one armed in commit 2.
  glidePhase = "play";
  flushSync(bump);

  const dur = animDurationMs();
  if (import.meta.env.DEV) measureFrames("glide", dur + 120);
  endTimer = setTimeout(endAnimNow, dur + TEARDOWN_BUFFER_MS);
});

// Module-level state must never be split across HMR generations — decline hot updates.
if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
