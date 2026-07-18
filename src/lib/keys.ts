/** Pure keyboard routing — a direct port of the SwiftUI app's `KeyRouting.resolveKey`
 * (the unit-verified heart of the per-node-type keyboard semantics):
 *   • bullet/checkbox: Enter = new node, Shift+Enter = newline
 *   • prompt draft:    Enter = newline (Shift+Enter too); Option+Enter = new node (inverted)
 *   • all types:       ⌘Enter = toggle completed; Option+Enter = new node below
 *   • Tab/Shift+Tab = indent/outdent; Backspace at start of empty = delete; arrows cross nodes.
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
  | "toggleComplete"
  | "indent"
  | "outdent"
  | "deleteEmpty"
  | "arrowUp"
  | "arrowDown"
  | "extendSelectUp"
  | "extendSelectDown"
  | "passthrough";

export interface KeyContext {
  isPrompt: boolean;
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
        return "newline"; // prompt: plain Enter / Shift+Enter insert a newline
      }
      return ctx.shift ? "newline" : "newNode";
    case "tab":
      return "indent";
    case "backtab":
      return "outdent";
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
