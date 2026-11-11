import { describe, expect, it } from "vitest";
import { COALESCE_MS, TextHistory, type TextSnap } from "./textHistory";

const at = (text: string, start = text.length, end = start): TextSnap => ({
  text,
  start,
  end,
});

describe("TextHistory", () => {
  it("undoes and redoes one edit", () => {
    const h = new TextHistory();
    h.record(at("a"), "edit", 0);
    expect(h.undo(at("ab"))).toEqual(at("a"));
    expect(h.redo(at("a"))).toEqual(at("ab"));
    expect(h.canRedo).toBe(false);
  });

  it("folds a typing burst into one step", () => {
    const h = new TextHistory();
    h.record(at(""), "type", 0);
    h.record(at("a"), "type", 100);
    h.record(at("ab"), "type", 200);
    expect(h.undo(at("abc"))).toEqual(at(""));
    expect(h.canUndo).toBe(false);
  });

  it("starts a new step after a pause", () => {
    const h = new TextHistory();
    h.record(at(""), "type", 0);
    h.record(at("a"), "type", COALESCE_MS + 1);
    expect(h.undo(at("ab"))).toEqual(at("a"));
    expect(h.undo(at("a"))).toEqual(at(""));
  });

  it("never folds a structural edit into typing, either side of it", () => {
    const h = new TextHistory();
    h.record(at(""), "type", 0);
    h.record(at("a"), "edit", 10); // e.g. a paste
    h.record(at("a pasted"), "type", 20);
    expect(h.undo(at("a pastedx"))).toEqual(at("a pasted"));
    expect(h.undo(at("a pasted"))).toEqual(at("a"));
    expect(h.undo(at("a"))).toEqual(at(""));
  });

  it("a new edit clears redo", () => {
    const h = new TextHistory();
    h.record(at("a"), "edit", 0);
    h.undo(at("ab"));
    h.record(at("a"), "edit", 10);
    expect(h.canRedo).toBe(false);
  });

  it("typing after an undo is its own step", () => {
    const h = new TextHistory();
    h.record(at(""), "type", 0);
    h.undo(at("a"));
    h.record(at(""), "type", 10);
    h.record(at("x"), "type", 20);
    expect(h.undo(at("xy"))).toEqual(at(""));
  });

  it("restores the selection that was left", () => {
    const h = new TextHistory();
    h.record(at("hello", 1, 4), "edit", 0);
    expect(h.undo(at("ho", 1))).toEqual(at("hello", 1, 4));
  });

  it("has nothing to undo or redo when empty", () => {
    const h = new TextHistory();
    expect(h.undo(at("x"))).toBeNull();
    expect(h.redo(at("x"))).toBeNull();
  });
});
