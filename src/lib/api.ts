import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Delta, MutationOut, NodeKind, Snapshot } from "./types";

/** Typed wrappers over the Rust store commands. Every mutation's delta arrives back
 * through `onDelta` (broadcast to every window); the return value carries only the
 * per-gesture hints for the calling window (node to focus, parents to expand). */

export const api = {
  snapshot: () => invoke<Snapshot>("snapshot"),

  commitNewNode: (
    node: string,
    before: string,
    after: string,
    expandedInWindow: boolean,
    hideCompleted: boolean,
  ) =>
    invoke<MutationOut>("commit_new_node", {
      node,
      before,
      after,
      expandedInWindow,
      hideCompleted,
    }),

  appendRoot: (kind?: NodeKind) => invoke<MutationOut>("append_root", { kind }),

  appendChild: (parent: string, kind?: NodeKind) =>
    invoke<MutationOut>("append_child", { parent, kind }),

  insertSiblingAfter: (node: string, kind: NodeKind) =>
    invoke<MutationOut>("insert_sibling_after", { node, kind }),

  insertNewNodeRelative: (
    node: string,
    forceChild: boolean,
    hideCompleted: boolean,
  ) =>
    invoke<MutationOut>("insert_new_node_relative", {
      node,
      forceChild,
      hideCompleted,
    }),

  indent: (node: string, hideCompleted: boolean) =>
    invoke<MutationOut>("indent_node", { node, hideCompleted }),

  outdent: (node: string) => invoke<MutationOut>("outdent_node", { node }),

  moveBy: (node: string, offset: number, hideCompleted: boolean) =>
    invoke<MutationOut>("move_node_by", { node, offset, hideCompleted }),

  moveTo: (node: string, newParent: string | null, after: string | null) =>
    invoke<MutationOut>("move_node_to", { node, newParent, after }),

  deleteNode: (node: string) => invoke<MutationOut>("delete_node", { node }),

  toggleCompleted: (node: string) =>
    invoke<MutationOut>("toggle_completed", { node }),

  setText: (
    node: string,
    text: string,
    boldRanges?: number[],
    italicRanges?: number[],
    underlineRanges?: number[],
  ) =>
    invoke<MutationOut>("set_text", {
      node,
      text,
      boldRanges,
      italicRanges,
      underlineRanges,
    }),

  setNote: (node: string, note: string) =>
    invoke<MutationOut>("set_note", { node, note }),

  setKind: (node: string, kind: NodeKind) =>
    invoke<MutationOut>("set_kind", { node, kind }),

  setHighlighted: (node: string, on: boolean) =>
    invoke<MutationOut>("set_highlighted", { node, on }),

  indentBlock: (ids: string[], hideCompleted: boolean) =>
    invoke<MutationOut>("indent_block", { ids, hideCompleted }),

  outdentBlock: (ids: string[]) => invoke<MutationOut>("outdent_block", { ids }),

  moveBlockBy: (ids: string[], offset: number, hideCompleted: boolean) =>
    invoke<MutationOut>("move_block_by", { ids, offset, hideCompleted }),

  moveBlockTo: (ids: string[], newParent: string | null, after: string | null) =>
    invoke<MutationOut>("move_block_to", { ids, newParent, after }),

  toggleCompletedBlock: (ids: string[]) =>
    invoke<MutationOut>("toggle_completed_block", { ids }),

  setKindBlock: (ids: string[], kind: NodeKind) =>
    invoke<MutationOut>("set_kind_block", { ids, kind }),

  deleteBlock: (ids: string[]) => invoke<MutationOut>("delete_block", { ids }),

  undo: () => invoke<void>("undo"),
  redo: () => invoke<void>("redo"),

  newWindow: () => invoke<string>("new_window"),

  seedDemo: (roots: number, children: number, grandchildren: number) =>
    invoke<number>("seed_demo", { roots, children, grandchildren }),
};

export function onDelta(cb: (delta: Delta) => void): Promise<UnlistenFn> {
  return listen<Delta>("store://delta", (e) => cb(e.payload));
}
