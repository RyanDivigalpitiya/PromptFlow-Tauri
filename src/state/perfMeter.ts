/**
 * Frame-pacing meter — samples requestAnimationFrame deltas across a short window and
 * reports the distribution to the dev terminal (via `dbg`). This is the objective
 * smoothness gauge for the expand/collapse animation: it catches MAIN-THREAD jank
 * (per-frame React re-renders, a stalling flatten, layout thrash) — exactly the failure
 * class that makes an animation feel choppy. A fully GPU-composited animation leaves the
 * main thread idle, so clean rAF pacing here corresponds to a smooth composite.
 *
 * Budgets: a 120Hz display refreshes every ~8.33ms; 60Hz every ~16.67ms. We count how
 * many sampled frames blew each budget — zero over-8.3ms frames is the 120Hz bar.
 */

import { dbg } from "./controller";

const FRAME_120 = 1000 / 120; // 8.33ms
const FRAME_60 = 1000 / 60; //  16.67ms

let active = false;

/** Sample rAF pacing for `ms` and log a one-line report tagged `label`. Re-entrant
 * calls are ignored so overlapping toggles don't interleave two samplers. */
export function measureFrames(label: string, ms: number): void {
  if (active) return;
  active = true;
  const deltas: number[] = [];
  const start = performance.now();
  let last = start;
  const tick = (now: number) => {
    deltas.push(now - last);
    last = now;
    if (now - start < ms) {
      requestAnimationFrame(tick);
    } else {
      active = false;
      report(label, deltas);
    }
  };
  requestAnimationFrame(tick);
}

function report(label: string, raw: number[]): void {
  // Drop the first delta: it spans from the pre-animation idle frame and is noise.
  const f = raw.slice(1);
  if (f.length === 0) {
    dbg(`⏱ ${label}: no frames sampled`);
    return;
  }
  const n = f.length;
  const total = f.reduce((a, b) => a + b, 0);
  const avg = total / n;
  const sorted = [...f].sort((a, b) => a - b);
  const p95 = sorted[Math.min(n - 1, Math.floor(n * 0.95))];
  const max = sorted[n - 1];
  const over120 = f.filter((d) => d > FRAME_120 + 0.5).length;
  const over60 = f.filter((d) => d > FRAME_60 + 0.5).length;
  const fps = 1000 / avg;
  dbg(
    `⏱ ${label}: ${n}f/${total.toFixed(0)}ms · avg ${avg.toFixed(1)}ms ` +
      `(${fps.toFixed(0)}fps) · p95 ${p95.toFixed(1)}ms · max ${max.toFixed(1)}ms ` +
      `· >8.3ms:${over120} >16.7ms:${over60}`,
  );
}

// Module-level state must never be split across HMR generations — decline hot updates.
if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
