/**
 * Completion animation state — a tiny module-level store (same shape as the mirror)
 * that flags a node as JUST-completed so its row plays the one-shot check-draw + glyph
 * pop (see NodeRow's `just-completed` class and styles.css). Scoped to a real user
 * completion so already-completed nodes don't animate on load. The set self-clears a
 * beat after the CSS animation ends.
 */

export const COMPLETE_ANIM_MS = 440;

const completing = new Set<string>();
let version = 0;
const listeners = new Set<() => void>();

export function subscribeCompleting(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
export function completingVersion(): number {
  return version;
}
export function isCompleting(id: string): boolean {
  return completing.has(id);
}
function bump() {
  version += 1;
  listeners.forEach((cb) => cb());
}

/** Flag a node as just-completed so its row plays the check/pop animation once. */
export function markCompleting(id: string) {
  completing.add(id);
  bump();
  setTimeout(() => {
    completing.delete(id);
    bump();
  }, COMPLETE_ANIM_MS);
}

// Module-level state must never be split across HMR generations — a hot update that
// swapped this module would strand components on a fresh empty instance. Decline hot
// updates so edits here trigger a FULL reload instead.
if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
