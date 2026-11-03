/** Raw kind strings match the SwiftUI app's `NodeKind` (and the export JSON). */
export type NodeKind = "bulletPoint" | "checkbox" | "promptDraft" | "line";

/** The focus pane's stage selector (`Stage` in promptflow-core). Every node carries one;
 * only a pinned (⌘⇧F) node shows it. A new node always starts at "planning". */
export type Stage = "planning" | "building" | "executing" | "testing" | "deploying";

export interface StageOption {
  id: Stage;
  label: string;
  /** What the selector falls back to when the pane is too narrow for the full words (the
   * sidebar dock at its narrowest). */
  short: string;
}

/** The selector's four SLOTS in display order. A slot can hold more than one stage: its
 * FIRST option is what the segment reads and what a click lands on, and clicking the
 * segment again while it is lit steps to the next option (wrapping). Only the second slot
 * uses this today — Building, or Executing — and the two are distinct stored values, so
 * the choice belongs to the node, synced and undoable like the stage itself. A slot is one
 * equal grid column whatever its label says, so the fill never changes width. */
export const STAGE_SLOTS: readonly (readonly StageOption[])[] = [
  [{ id: "planning", label: "Planning", short: "Plan" }],
  [
    { id: "building", label: "Building", short: "Build" },
    { id: "executing", label: "Executing", short: "Exec" },
  ],
  [{ id: "testing", label: "Testing", short: "Test" }],
  [{ id: "deploying", label: "Deploying", short: "Deploy" }],
];

/** Which slot `stage` sits in — 0 for anything unknown, matching the store's lenient
 * decode of an unknown raw string as "planning". */
export function stageSlot(stage: Stage): number {
  const i = STAGE_SLOTS.findIndex((slot) => slot.some((o) => o.id === stage));
  return Math.max(0, i);
}

/** One outline node — the flat record mirrored from the Rust store. */
export interface NodeRec {
  id: string;
  parent: string | null;
  position: number;
  text: string;
  note: string;
  kind: NodeKind;
  isCompleted: boolean;
  isHighlighted: boolean;
  stage: Stage;
  /** Import/export seed only — live collapse state is per-window. */
  isCollapsed: boolean;
  /** Flat [location, length, …] pairs over `text`. */
  boldRanges: number[];
  italicRanges: number[];
  underlineRanges: number[];
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export type DeltaOp =
  | { type: "upsert"; node: NodeRec }
  | { type: "delete"; id: string };

export interface Delta {
  rev: number;
  origin: string;
  ops: DeltaOp[];
  canUndo: boolean;
  canRedo: boolean;
}

export interface Snapshot {
  rev: number;
  nodes: NodeRec[];
  canUndo: boolean;
  canRedo: boolean;
}

/** Per-gesture hints returned to the CALLING window only. */
export interface MutationOut {
  newNode: string | null;
  expand: string[];
  moved: boolean;
}

/** The kind a new node spawned from this one inherits (a divider never propagates). */
export function inheritableKind(kind: NodeKind): NodeKind {
  return kind === "line" ? "bulletPoint" : kind;
}
