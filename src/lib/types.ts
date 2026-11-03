/** Raw kind strings match the SwiftUI app's `NodeKind` (and the export JSON). */
export type NodeKind = "bulletPoint" | "checkbox" | "promptDraft" | "line";

/** The focus pane's stage selector (`Stage` in promptflow-core). Every node carries one;
 * only a pinned (⌘⇧F) node shows it. A new node always starts at "planning". */
export type Stage = "planning" | "executing" | "testing" | "deploying";

/** Display order and labels. `short` is what the selector falls back to when the pane is
 * too narrow for the full words (the sidebar dock at its default width). */
export const STAGES: readonly { id: Stage; label: string; short: string }[] = [
  { id: "planning", label: "Planning", short: "Plan" },
  { id: "executing", label: "Executing", short: "Exec" },
  { id: "testing", label: "Testing", short: "Test" },
  { id: "deploying", label: "Deploying", short: "Deploy" },
];

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
