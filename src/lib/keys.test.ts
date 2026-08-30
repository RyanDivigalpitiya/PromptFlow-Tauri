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

  it("carries a prompt's BULLET onto the next line, and an empty one ends the list", () => {
    expect(resolveKey("enter", ctx({ isPrompt: true, bulletLine: true }))).toBe(
      "newlineBullet",
    );
    expect(
      resolveKey("enter", ctx({ isPrompt: true, bulletLine: true, bulletBodyEmpty: true })),
    ).toBe("endBullet");
    // ⌥Enter and ⌘Enter are resolved before any of this and keep their meaning.
    expect(
      resolveKey("enter", ctx({ isPrompt: true, bulletLine: true, opt: true })),
    ).toBe("newNode");
    expect(
      resolveKey("enter", ctx({ isPrompt: true, bulletLine: true, cmd: true })),
    ).toBe("toggleComplete");
    // A bullet line only exists inside a prompt, so the flag alone changes nothing.
    expect(resolveKey("enter", ctx({ bulletLine: true }))).toBe("newNode");
  });

  it("Cmd+Enter completes for every kind", () => {
    expect(resolveKey("enter", ctx({ cmd: true }))).toBe("toggleComplete");
    expect(resolveKey("enter", ctx({ isPrompt: true, cmd: true }))).toBe("toggleComplete");
  });

  it("Tab / Shift+Tab indent and outdent", () => {
    expect(resolveKey("tab", ctx())).toBe("indent");
    expect(resolveKey("backtab", ctx())).toBe("outdent");
    // Still the NODE inside a prompt whose caret is not on a list line — a heading, a
    // paragraph, an empty draft. That is where indenting the node is the only reading.
    expect(resolveKey("tab", ctx({ isPrompt: true }))).toBe("indent");
    expect(resolveKey("backtab", ctx({ isPrompt: true }))).toBe("outdent");
    // ...and a list line ONLY exists in a prompt, so the flag alone never flips a bullet
    // or checkbox row.
    expect(resolveKey("tab", ctx({ listLine: true }))).toBe("indent");
  });

  it("nests the BULLET, not the node, on a prompt's list line", () => {
    // A prompt is a document you are writing and its list lives in the text, so Tab
    // there means what it means in every editor: one more level of list.
    expect(resolveKey("tab", ctx({ isPrompt: true, listLine: true }))).toBe("indentText");
    expect(resolveKey("backtab", ctx({ isPrompt: true, listLine: true }))).toBe(
      "outdentText",
    );
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
