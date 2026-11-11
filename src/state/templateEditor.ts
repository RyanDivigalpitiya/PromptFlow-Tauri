import { create } from "zustand";
import { api } from "../lib/api";

/** The template editor sheet — per WINDOW, like Settings. What it edits is the backend's
 * `prompt_templates` table, which every window shares; nothing here is persisted.
 *
 * Opened from the TopBar Templates menu (a native NSMenu, so its selection arrives as a
 * `templates-menu-action` event — see `handleTemplatesMenuAction`). */

export interface TemplateDraft {
  /** null while a NEW template has never been saved. */
  id: string | null;
  name: string;
  body: string;
  /** Bumped on every open, so a second open — even of the same template — remounts the
   * sheet and starts from what is stored, not from the last sheet's unsaved state. */
  epoch: number;
}

interface TemplateEditorState {
  draft: TemplateDraft | null;
  openNew(): void;
  openEdit(id: string): Promise<void>;
  close(): void;
}

let epoch = 0;

export const useTemplateEditor = create<TemplateEditorState>((set) => ({
  draft: null,
  openNew() {
    set({ draft: { id: null, name: "", body: "", epoch: ++epoch } });
  },
  /** Reads the template FRESH rather than from whatever list the menu was built from:
   * another window may have saved it since. Gone (deleted elsewhere) ⇒ nothing opens. */
  async openEdit(id) {
    const list = await api.promptTemplates();
    const t = Array.isArray(list) ? list.find((x) => x.id === id) : undefined;
    if (!t) return;
    set({ draft: { id: t.id, name: t.name, body: t.body, epoch: ++epoch } });
  },
  close() {
    set({ draft: null });
  },
}));

/** Whether the sheet is up. App.tsx's window shortcuts check it: the outline behind a
 * modal must not take ⌘E, ⌘[, ⌘Z… */
export function templateEditorOpen(): boolean {
  return useTemplateEditor.getState().draft !== null;
}

/** A TopBar Templates menu selection: `new`, or `edit-<template id>`. Ignored while the
 * sheet is already open — the menu can't be reached then anyway (the sheet's backdrop
 * covers the TopBar), so this only guards a stray late event from replacing unsaved work. */
export function handleTemplatesMenuAction(action: string): Promise<void> {
  const s = useTemplateEditor.getState();
  if (s.draft) return Promise.resolve();
  if (action === "new") {
    s.openNew();
    return Promise.resolve();
  }
  if (action.startsWith("edit-")) return s.openEdit(action.slice("edit-".length));
  return Promise.resolve();
}

if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
