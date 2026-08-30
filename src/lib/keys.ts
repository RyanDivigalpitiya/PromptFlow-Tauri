/** Pure keyboard routing — a direct port of the SwiftUI app's `KeyRouting.resolveKey`
 * (the unit-verified heart of the per-node-type keyboard semantics):
 *   • bullet/checkbox: Enter = new node, Shift+Enter = newline
 *   • prompt draft:    Enter = newline (Shift+Enter too); Option+Enter = new node (inverted)
 *   • all types:       ⌘Enter = toggle completed; Option+Enter = new node below
 *   • Tab/Shift+Tab = indent/outdent the NODE — except on a prompt's list line, where
 *     they nest the BULLET in the text; Backspace at start of empty = delete; arrows cross nodes.
 */

export type EditorKey =
  | "enter"
  | "tab"
  | "backtab"
  | "deleteBackward"
  | "moveUp"
  | "moveDown"
  | "shiftMoveUp"
  | "shiftMoveDown"
  | "other";

export type KeyDecision =
  | "newNode"
  | "newline"
  | "newlineBullet"
  | "endBullet"
  | "toggleComplete"
  | "indent"
  | "outdent"
  | "indentText"
  | "outdentText"
  | "deleteEmpty"
  | "arrowUp"
  | "arrowDown"
  | "extendSelectUp"
  | "extendSelectDown"
  | "passthrough";

export interface KeyContext {
  isPrompt: boolean;
  /** The caret (or selection) touches a markdown LIST line of this prompt's text. */
  listLine?: boolean;
  /** The caret sits on a BULLET line of this prompt's text, at or past its marker. */
  bulletLine?: boolean;
  /** ...and that line carries its marker and nothing else. */
  bulletBodyEmpty?: boolean;
  shift: boolean;
  cmd: boolean;
  opt: boolean;
  caretAtStartEmpty: boolean;
  atFirstLine: boolean;
  atLastLine: boolean;
}

export function resolveKey(key: EditorKey, ctx: KeyContext): KeyDecision {
  switch (key) {
    case "enter":
      if (ctx.cmd) return "toggleComplete"; // ⌘Enter completes (any node type)
      if (ctx.opt) return "newNode"; // ⌥Enter makes a new node below (any node type)
      if (ctx.isPrompt) {
        // A bullet CARRIES ONTO the next line, the way it does in any editor — and an
        // empty one ENDS the list instead of minting another, which is the only way out
        // of a list that does not involve deleting the marker by hand. Ordered lists are
        // deliberately excluded: continuing one means renumbering.
        if (ctx.bulletLine) return ctx.bulletBodyEmpty ? "endBullet" : "newlineBullet";
        return "newline"; // prompt: plain Enter / Shift+Enter insert a newline
      }
      return ctx.shift ? "newline" : "newNode";
    case "tab":
      // In a prompt, Tab on a LIST line nests the bullet rather than the node: a prompt
      // is a document you are writing, and its list is written in the text. Everywhere
      // else — a heading, a paragraph, an empty prompt, any other kind — Tab still
      // indents the NODE, so the outline gesture is not lost where it is the only
      // sensible reading.
      return ctx.isPrompt && ctx.listLine ? "indentText" : "indent";
    case "backtab":
      return ctx.isPrompt && ctx.listLine ? "outdentText" : "outdent";
    case "deleteBackward":
      return ctx.caretAtStartEmpty ? "deleteEmpty" : "passthrough";
    case "moveUp":
      // ⌥Up is move-node, ⌘Up is collapse — both resolved in keyDown before this
      // (the Swift KeyRouting cmd/opt passthrough).
      if (ctx.opt || ctx.cmd) return "passthrough";
      return ctx.atFirstLine ? "arrowUp" : "passthrough";
    case "moveDown":
      if (ctx.opt || ctx.cmd) return "passthrough";
      return ctx.atLastLine ? "arrowDown" : "passthrough";
    case "shiftMoveUp":
      // Shift+Up grows the NODE selection only from the caret's boundary line.
      if (ctx.cmd || ctx.opt) return "passthrough";
      return ctx.atFirstLine ? "extendSelectUp" : "passthrough";
    case "shiftMoveDown":
      if (ctx.cmd || ctx.opt) return "passthrough";
      return ctx.atLastLine ? "extendSelectDown" : "passthrough";
    case "other":
      return "passthrough";
  }
}
