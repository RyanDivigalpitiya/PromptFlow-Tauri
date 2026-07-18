/** Raw kind strings match the SwiftUI app's `NodeKind` (and the export JSON). */
export type NodeKind = "bulletPoint" | "checkbox" | "promptDraft" | "line";

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
  /** Import/export seed only — live collapse state is per-window. */
  isCollapsed: boolean;
  /** Flat [location, length, …] pairs over `text`. */
  boldRanges: number[];
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
