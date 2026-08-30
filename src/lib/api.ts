import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
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

  toggleBoldBlock: (ids: string[]) =>
    invoke<MutationOut>("toggle_bold_block", { ids }),

  /** ⌘3 over a non-prompt block: fold it into its first member as a "- " list. The
   * returned `newNode` is that member (the node to focus), or null when the block had
   * fewer than two mergeable nodes and nothing happened. */
  mergeIntoPrompt: (ids: string[]) =>
    invoke<MutationOut>("merge_into_prompt", { ids }),

  deleteBlock: (ids: string[]) => invoke<MutationOut>("delete_block", { ids }),

  undo: () => invoke<void>("undo"),
  redo: () => invoke<void>("redo"),

  newWindow: () => invoke<string>("new_window"),

  seedDemo: (roots: number, children: number, grandchildren: number) =>
    invoke<number>("seed_demo", { roots, children, grandchildren }),

  /** Pop up the native row (⋯) context menu at (x, y) in window coordinates. */
  popupRowMenu: (node: string, x: number, y: number) =>
    invoke<void>("popup_row_menu", { node, x, y }),

  /** Fill a prompt from a compiled-in template. `template` is the BARE id — the row
   * menu's action is `tpl-<id>` and the controller strips that prefix. Replaces the
   * node's text as ONE undo step (the store's `apply_template`, deliberately not
   * `set_text`, which would coalesce into a typing burst). */
  applyPromptTemplate: (node: string, template: string) =>
    invoke<MutationOut>("apply_prompt_template", { node, template }),

  /** The Settings ▸ Prompt Templates rows: id, the file-name-derived default, and the
   * name the ⋯ menu currently shows. */
  promptTemplates: () => invoke<PromptTemplateInfo[]>("prompt_templates"),

  /** Rename a template for this device; an empty name clears the override. Stored in the
   * BACKEND settings table, not localStorage, because the menu is built in Rust. */
  setPromptTemplateName: (template: string, name: string) =>
    invoke<void>("set_prompt_template_name", { template, name }),
};

export interface PromptTemplateInfo {
  id: string;
  defaultName: string;
  name: string;
}

export function onDelta(cb: (delta: Delta) => void): Promise<UnlistenFn> {
  return listen<Delta>("store://delta", (e) => cb(e.payload));
}

/** Selection from the native row (⋯) menu, routed back to THIS window from Rust. */
export function onRowMenuAction(
  cb: (action: string, node: string) => void,
): Promise<UnlistenFn> {
  return listen<{ action: string; node: string }>("row-menu-action", (e) =>
    cb(e.payload.action, e.payload.node),
  );
}

/** Focus-pane order restored by an outline import, broadcast to EVERY window: a peer
 * window's own reconcile of the import delta rebuilds order by (updatedAt, id) and
 * persists it — clobbering `pf.focusOrder` right after the importing window wrote the
 * file's order there. Adoption is idempotent, so whichever of the delta and this event
 * lands second leaves the file's order standing. `rev` is the import delta's rev — the
 * receiving window's grace boundary for adopted ids its mirror hasn't caught up to
 * (see focusPane's reconcile). */
export function emitFocusOrderAdopt(
  order: string[],
  rev: number,
): Promise<void> {
  return emit("focus-order-adopt", { order, rev });
}

export function onFocusOrderAdopt(
  cb: (order: string[], rev: number) => void,
): Promise<UnlistenFn> {
  return listen<{ order: string[]; rev: number }>("focus-order-adopt", (e) =>
    cb(e.payload.order, e.payload.rev),
  );
}
