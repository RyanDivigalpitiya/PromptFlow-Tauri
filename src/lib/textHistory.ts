/** Undo/redo for ONE text field that is not a node — the template editor's body.
 *
 * The outline's ⌘Z belongs to the store (one global history, see CLAUDE.md), and the
 * editor is a CONTROLLED contenteditable whose DOM is rebuilt from the model, so WebKit's
 * own undo stack would replay mutations onto nodes that no longer exist. Hence a model-
 * level history: each entry is the text and selection to go back to.
 *
 * A typing burst is ONE step (consecutive "type" edits less than `COALESCE_MS` apart),
 * the same grain the store gives a node's text; anything structural — a paste, a cut, an
 * indent, a bullet carried by Enter — is always a step of its own. */

export interface TextSnap {
  text: string;
  start: number;
  end: number;
}

export type EditKind = "type" | "edit";

export const COALESCE_MS = 1000;
const CAP = 500;

export class TextHistory {
  private past: TextSnap[] = [];
  private future: TextSnap[] = [];
  private lastKind: EditKind | null = null;
  private lastAt = 0;

  /** Call BEFORE adopting an edit, with the state being left. */
  record(before: TextSnap, kind: EditKind, now = Date.now()): void {
    const coalesce =
      kind === "type" && this.lastKind === "type" && now - this.lastAt < COALESCE_MS;
    if (!coalesce) {
      this.past.push(before);
      if (this.past.length > CAP) this.past.shift();
    }
    this.future = [];
    this.lastKind = kind;
    this.lastAt = now;
  }

  /** The state to restore, or null when there is nothing to undo. `current` is kept for
   * redo. Ends any typing burst, so the next keystroke starts a new step. */
  undo(current: TextSnap): TextSnap | null {
    const prev = this.past.pop();
    if (!prev) return null;
    this.future.push(current);
    this.lastKind = null;
    return prev;
  }

  redo(current: TextSnap): TextSnap | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(current);
    this.lastKind = null;
    return next;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }
}
