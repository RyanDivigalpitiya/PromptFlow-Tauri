import type { Delta, NodeRec, Snapshot } from "../lib/types";
import { api, onDelta } from "../lib/api";

/**
 * The window's mirror of the Rust store, built for MANY nodes and cheap updates:
 *
 * - Data lives in module-level mutable maps (no per-delta cloning of thousands of
 *   records — a text keystroke touches exactly one entry).
 * - React subscribes at two grains via `useSyncExternalStore`:
 *     • per-node listeners — a row re-renders only when ITS node record changes;
 *     • a structure listener — the flattened row list recomputes only when the tree
 *       shape (parent/position/insert/delete/isCompleted/hasChildren) changes.
 * - Every delta carries `rev`; a gap (missed event) triggers a full snapshot reload,
 *   so a window can never silently drift from the store.
 */

export type ParentKey = string | null;

const nodes = new Map<string, NodeRec>();
/** Sibling id lists sorted by (position, id) — id tiebreak matches the backend. */
const children = new Map<ParentKey, string[]>();
let rev = 0;
let loaded = false;

let structureVersion = 0;
const structureListeners = new Set<() => void>();
const nodeListeners = new Map<string, Set<() => void>>();
const nodeVersions = new Map<string, number>();
let deletedHooks: ((ids: Set<string>) => void)[] = [];

let undoState = { canUndo: false, canRedo: false };
let undoVersion = 0;
const undoListeners = new Set<() => void>();

function sortSiblings(list: string[]) {
  list.sort((a, b) => {
    const na = nodes.get(a)!;
    const nb = nodes.get(b)!;
    if (na.position !== nb.position) return na.position - nb.position;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function insertSorted(parent: ParentKey, id: string) {
  let list = children.get(parent);
  if (!list) {
    list = [];
    children.set(parent, list);
  }
  list.push(id);
  sortSiblings(list);
}

function removeFromParent(parent: ParentKey, id: string) {
  const list = children.get(parent);
  if (list) {
    const i = list.indexOf(id);
    if (i >= 0) list.splice(i, 1);
  }
}

function bumpNode(id: string) {
  nodeVersions.set(id, (nodeVersions.get(id) ?? 0) + 1);
  nodeListeners.get(id)?.forEach((cb) => cb());
}

function rebuildAll(recs: NodeRec[]) {
  nodes.clear();
  children.clear();
  for (const r of recs) nodes.set(r.id, r);
  for (const r of recs) {
    let list = children.get(r.parent);
    if (!list) {
      list = [];
      children.set(r.parent, list);
    }
    list.push(r.id);
  }
  for (const list of children.values()) sortSiblings(list);
}

function notifyStructure() {
  structureVersion++;
  structureListeners.forEach((cb) => cb());
}

function setUndoState(canUndo: boolean, canRedo: boolean) {
  if (undoState.canUndo === canUndo && undoState.canRedo === canRedo) return;
  undoState = { canUndo, canRedo };
  undoVersion++;
  undoListeners.forEach((cb) => cb());
}

/** What a structural delta did to the row set, classified in ONE pass over the ops so
 * the animation layer can dispatch without re-deriving any of it. */
export interface StructureChange {
  /** The mutating window's label, or "undo"/"redo"/"auto-archive". */
  origin: string;
  /** Op count — the cheap bulk guard (import, seed_demo, Clear Completed). */
  opCount: number;
  /** Upserts with no previous record. */
  inserted: string[];
  /** Delete ops. `delete_subtree` lists every descendant, so this is the whole set. */
  deleted: ReadonlySet<string>;
  /** Parent changed ⇒ depth changed. The tab glide's input. */
  reparented: string[];
  /** Position changed but parent did NOT (⌥↑/↓, a same-level drag) — vertical only. */
  moved: string[];
  /** isCompleted flipped — a visibility change under hide-completed, a restyle otherwise. */
  completionFlips: string[];
}

/** Wrapper around a delta's structural notification, installed by the animation layer so
 * a row change can be split into the multi-commit sequence a CSS transition needs. (A
 * transition takes its property and duration from the AFTER-change style; what it needs
 * is its FROM value resolved as a SEPARATE style change, on an element that was already
 * mounted at its old position — see collapseAnim.ts.) The wrapper MUST call `publish`
 * exactly once, synchronously; the default just does.
 *
 * Called for EVERY structural delta — insert, delete, reparent, reorder, completion flip
 * — so the wrapper must CLASSIFY before it tears anything down: a ⌘⇧F highlight flip is
 * structural (the breadcrumb walk is global) but moves no row, and an unconditional
 * endAnimNow() at the top would rip a live drawer out on every highlight toggle.
 * `load()`/`reload()` deliberately bypass this seam: a full snapshot (first launch,
 * rev-gap resync) must NEVER animate. Exactly one owner — this OVERWRITES, there is no
 * registry, and a second installer would silently steal the animation. */
type StructureCommit = (c: StructureChange, publish: () => void) => void;
let structureCommit: StructureCommit = (_c, publish) => publish();
export function setStructureCommit(fn: StructureCommit) {
  structureCommit = fn;
}

function applyDelta(delta: Delta) {
  if (!loaded) return;
  if (delta.rev <= rev) return; // stale echo (e.g. snapshot already covered it)
  if (delta.rev !== rev + 1) {
    // Missed a delta — resync from a full snapshot.
    void reload();
    return;
  }
  rev = delta.rev;
  let structural = false;
  const touched: string[] = [];
  const deleted = new Set<string>();
  const reparented: string[] = [];
  const inserted: string[] = [];
  const moved: string[] = [];
  const completionFlips: string[] = [];
  /** Records whose map entries are dropped in publish(), not here — see the note there. */
  const pendingDeletes: string[] = [];
  for (const op of delta.ops) {
    if (op.type === "upsert") {
      const rec = op.node;
      const old = nodes.get(rec.id);
      nodes.set(rec.id, rec);
      if (!old) {
        insertSorted(rec.parent, rec.id);
        structural = true;
        inserted.push(rec.id);
        // The parent's row shows a chevron/ring the moment it gains a first child.
        if (rec.parent) touched.push(rec.parent);
      } else if (old.parent !== rec.parent || old.position !== rec.position) {
        removeFromParent(old.parent, rec.id);
        insertSorted(rec.parent, rec.id);
        structural = true;
        if (old.parent) touched.push(old.parent);
        if (rec.parent) touched.push(rec.parent);
        // A changed PARENT changes the row's depth, so it must glide into its new
        // indent rather than snap. A changed position alone (⌥↑/↓, a same-level drag)
        // moves it only vertically, which the reflow transition already covers.
        if (old.parent !== rec.parent) reparented.push(rec.id);
        else moved.push(rec.id);
      }
      if (old && old.isCompleted !== rec.isCompleted) {
        // Visibility under hide-completed + parent progress rings both change.
        structural = true;
        completionFlips.push(rec.id);
        if (rec.parent) touched.push(rec.parent);
      }
      if (old && old.isHighlighted !== rec.isHighlighted) {
        // The highlight-ancestor breadcrumb is computed over the whole forest.
        structural = true;
      }
      touched.push(rec.id);
    } else {
      const old = nodes.get(op.id);
      if (old) {
        // The sibling-list removal is EAGER, so a flatten taken at the seam is already
        // the exact post-delta one (a parent's derived "add:" row drops with its last
        // child, which an id filter over the old flatten could not reproduce). The
        // RECORD and its version survive until publish() — see the note there.
        removeFromParent(old.parent, op.id);
        pendingDeletes.push(op.id);
        if (old.parent) touched.push(old.parent);
      }
      deleted.add(op.id);
      structural = true;
    }
  }
  // EVERY structural delta is routed through the seam so the animation layer can wrap
  // the notification in its commit sequence; it classifies and declines cheaply.
  // `load()`/`reload()` deliberately bypass it: a full snapshot (first load, rev-gap
  // resync) must never animate.
  const publish = () => {
    // Drained HERE, not in the op loop: the animation layer's seam runs BEFORE publish,
    // and its first commit re-renders every mounted row. With the record already gone
    // NodeRow renders null, and nodeVersions.delete changes that row's
    // useSyncExternalStore snapshot, forcing the re-render past `memo` — so the leaving
    // rows would blank out, change height, and drive the virtualizer's ResizeObserver to
    // reposition the whole list WHILE `.rows-animating` is on. Deferring keeps them
    // rendering their (already-detached) records through commit 1, which is exactly what
    // a leave animation needs them to do.
    for (const id of pendingDeletes) {
      nodes.delete(id);
      nodeVersions.delete(id);
    }
    for (const id of touched) if (nodes.has(id)) bumpNode(id);
    if (deleted.size > 0) deletedHooks.forEach((h) => h(deleted));
    if (structural) notifyStructure();
  };
  if (structural) {
    structureCommit(
      {
        origin: delta.origin,
        opCount: delta.ops.length,
        inserted,
        deleted,
        reparented,
        moved,
        completionFlips,
      },
      publish,
    );
  } else publish();
  setUndoState(delta.canUndo, delta.canRedo);
}

async function load(snapshot: Snapshot) {
  rebuildAll(snapshot.nodes);
  rev = snapshot.rev;
  loaded = true;
  for (const id of nodes.keys()) bumpNode(id);
  notifyStructure();
  setUndoState(snapshot.canUndo, snapshot.canRedo);
}

let reloading = false;
async function reload() {
  if (reloading) return;
  reloading = true;
  try {
    await load(await api.snapshot());
  } finally {
    reloading = false;
  }
}

/** Start the mirror: initial snapshot + the delta subscription. Idempotent. */
let started: Promise<void> | null = null;
export function startMirror(): Promise<void> {
  if (!started) {
    started = (async () => {
      await onDelta(applyDelta);
      await reload();
    })();
  }
  return started;
}

// MARK: Reads (non-reactive)

export const mirror = {
  get(id: string): NodeRec | undefined {
    return nodes.get(id);
  },
  childrenOf(parent: ParentKey): readonly string[] {
    return children.get(parent) ?? [];
  },
  roots(): readonly string[] {
    return children.get(null) ?? [];
  },
  hasChildren(id: string): boolean {
    return (children.get(id)?.length ?? 0) > 0;
  },
  nodeCount(): number {
    return nodes.size;
  },
  isLoaded(): boolean {
    return loaded;
  },
  rev(): number {
    return rev;
  },
  structureVersion(): number {
    return structureVersion;
  },
  undoState(): { canUndo: boolean; canRedo: boolean } {
    return undoState;
  },
  /** Completed fraction of DIRECT children (drives parent progress glyphs). */
  completedChildFraction(id: string): number {
    const kids = children.get(id);
    if (!kids || kids.length === 0) return 0;
    let done = 0;
    for (const k of kids) if (nodes.get(k)?.isCompleted) done++;
    return done / kids.length;
  },
  /** Every highlighted (⌘⇧F) node id — the focus pane's membership scan. */
  highlightedIds(): string[] {
    const out: string[] = [];
    for (const [id, rec] of nodes) if (rec.isHighlighted) out.push(id);
    return out;
  },
  /** `id`'s whole subtree (self included), parents before children. Cycle-guarded. */
  descendants(id: string): string[] {
    const out: string[] = [];
    const stack = [id];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      out.push(cur);
      const kids = children.get(cur);
      if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
    return out;
  },
  /** Size of `id`'s subtree, self included. */
  descendantsCount(id: string): number {
    let n = 0;
    const stack = [id];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      n++;
      for (const k of children.get(cur) ?? []) stack.push(k);
    }
    return n;
  },
  /** Ancestor chain from topmost root down to `id`'s parent (excludes `id`). */
  ancestors(id: string): string[] {
    const chain: string[] = [];
    const seen = new Set([id]);
    let p = nodes.get(id)?.parent ?? null;
    while (p) {
      if (seen.has(p)) break;
      seen.add(p);
      chain.push(p);
      p = nodes.get(p)?.parent ?? null;
    }
    chain.reverse();
    return chain;
  },
  /** Register a hook fired with the set of ids removed by a delta (clear focus/nav). */
  onDeleted(hook: (ids: Set<string>) => void): () => void {
    deletedHooks.push(hook);
    return () => {
      deletedHooks = deletedHooks.filter((h) => h !== hook);
    };
  },
};

// MARK: React subscriptions (useSyncExternalStore-shaped)

export function subscribeStructure(cb: () => void): () => void {
  structureListeners.add(cb);
  return () => structureListeners.delete(cb);
}

export function subscribeNode(id: string): (cb: () => void) => () => void {
  return (cb: () => void) => {
    let set = nodeListeners.get(id);
    if (!set) {
      set = new Set();
      nodeListeners.set(id, set);
    }
    set.add(cb);
    return () => {
      set!.delete(cb);
      if (set!.size === 0) nodeListeners.delete(id);
    };
  };
}

export function nodeVersion(id: string): number {
  return nodeVersions.get(id) ?? 0;
}

export function subscribeUndo(cb: () => void): () => void {
  undoListeners.add(cb);
  return () => undoListeners.delete(cb);
}

export function undoVersionNow(): number {
  return undoVersion;
}

// Module-level state must never be split across HMR generations — a hot update that
// swapped this module would strand components on a fresh empty instance. Decline hot
// updates so edits here trigger a FULL reload instead.
if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
