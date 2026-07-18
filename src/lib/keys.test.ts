import { describe, expect, it } from "vitest";
import { resolveKey, type KeyContext } from "./keys";

/** The key-routing truth table (ports the SwiftUI app's keyTruthTable scenario). */

function ctx(over: Partial<KeyContext> = {}): KeyContext {
  return {
    isPrompt: false,
    shift: false,
    cmd: false,
    opt: false,
    caretAtStartEmpty: false,
    atFirstLine: true,
    atLastLine: true,
    ...over,
  };
}

describe("resolveKey", () => {
  it("bullet/checkbox: Enter = new node, Shift+Enter = newline", () => {
    expect(resolveKey("enter", ctx())).toBe("newNode");
    expect(resolveKey("enter", ctx({ shift: true }))).toBe("newline");
  });

  it("prompt: Enter and Shift+Enter insert a newline; Option+Enter makes a node", () => {
    expect(resolveKey("enter", ctx({ isPrompt: true }))).toBe("newline");
    expect(resolveKey("enter", ctx({ isPrompt: true, shift: true }))).toBe("newline");
    expect(resolveKey("enter", ctx({ isPrompt: true, opt: true }))).toBe("newNode");
  });

  it("Cmd+Enter completes for every kind", () => {
    expect(resolveKey("enter", ctx({ cmd: true }))).toBe("toggleComplete");
    expect(resolveKey("enter", ctx({ isPrompt: true, cmd: true }))).toBe("toggleComplete");
  });

  it("Tab / Shift+Tab indent and outdent", () => {
    expect(resolveKey("tab", ctx())).toBe("indent");
    expect(resolveKey("backtab", ctx())).toBe("outdent");
  });

  it("Backspace deletes only an empty node at caret start", () => {
    expect(resolveKey("deleteBackward", ctx({ caretAtStartEmpty: true }))).toBe("deleteEmpty");
    expect(resolveKey("deleteBackward", ctx())).toBe("passthrough");
  });

  it("arrows cross nodes only at boundary lines", () => {
    expect(resolveKey("moveUp", ctx({ atFirstLine: true }))).toBe("arrowUp");
    expect(resolveKey("moveUp", ctx({ atFirstLine: false }))).toBe("passthrough");
    expect(resolveKey("moveDown", ctx({ atLastLine: true }))).toBe("arrowDown");
    expect(resolveKey("moveDown", ctx({ atLastLine: false }))).toBe("passthrough");
  });

  it("Option+arrows never route as caret moves (move-node handled upstream)", () => {
    expect(resolveKey("moveUp", ctx({ opt: true }))).toBe("passthrough");
    expect(resolveKey("moveDown", ctx({ opt: true }))).toBe("passthrough");
  });

  it("Command+arrows never route as caret moves (collapse/expand handled upstream)", () => {
    expect(resolveKey("moveUp", ctx({ cmd: true, atFirstLine: true }))).toBe("passthrough");
    expect(resolveKey("moveDown", ctx({ cmd: true, atLastLine: true }))).toBe("passthrough");
  });

  it("Shift+arrows grow a node selection only from boundary lines", () => {
    expect(resolveKey("shiftMoveUp", ctx({ atFirstLine: true }))).toBe("extendSelectUp");
    expect(resolveKey("shiftMoveUp", ctx({ atFirstLine: false }))).toBe("passthrough");
    expect(resolveKey("shiftMoveDown", ctx({ atLastLine: true }))).toBe("extendSelectDown");
    expect(resolveKey("shiftMoveDown", ctx({ cmd: true }))).toBe("passthrough");
    expect(resolveKey("shiftMoveUp", ctx({ opt: true }))).toBe("passthrough");
  });
});
