import { describe, expect, it } from "vitest";
import type { RenderRow } from "./flatten";
import { anchorRowId, diffRows } from "./rowBands";

/** A node row. The flatten's other fields don't affect the diff, which keys on `id`. */
function n(id: string, depth = 0): RenderRow {
  return { id, nodeId: id, depth, hasChildren: false, kind: "node", isCollapsed: false };
}
/** The derived "+" placeholder a parent gets — the reason the diff must run over the
 * FLATTEN and not over the delta's op list. */
function add(parent: string, depth = 1): RenderRow {
  return {
    id: "add:" + parent,
    nodeId: parent,
    depth,
    hasChildren: false,
    kind: "addChild",
    isCollapsed: false,
  };
}
const ids = (s: Set<string>) => [...s].sort();

describe("diffRows", () => {
  it("reports an identical flatten as unchanged", () => {
    const rows = [n("a"), n("b"), n("c")];
    const d = diffRows(rows, [n("a"), n("b"), n("c")]);
    expect(d.firstChanged).toBe(-1);
    expect(d.entering.size).toBe(0);
    expect(d.leaving.size).toBe(0);
  });

  it("finds a single insertion", () => {
    const d = diffRows([n("a"), n("c")], [n("a"), n("b"), n("c")]);
    expect(ids(d.entering)).toEqual(["b"]);
    expect(d.leaving.size).toBe(0);
    expect(d.firstChanged).toBe(1);
  });

  it("finds a single deletion", () => {
    const d = diffRows([n("a"), n("b"), n("c")], [n("a"), n("c")]);
    expect(ids(d.leaving)).toEqual(["b"]);
    expect(d.entering.size).toBe(0);
    expect(d.firstChanged).toBe(1);
  });

  it("counts the derived '+' row when a first child is created", () => {
    // One insert op, but the flatten gains TWO rows.
    const d = diffRows([n("p")], [n("p"), n("k", 1), add("p")]);
    expect(ids(d.entering)).toEqual(["add:p", "k"]);
    expect(d.firstChanged).toBe(1);
  });

  it("drops the derived '+' row when the last child is deleted", () => {
    const d = diffRows([n("p"), n("k", 1), add("p")], [n("p")]);
    expect(ids(d.leaving)).toEqual(["add:p", "k"]);
    expect(d.firstChanged).toBe(1);
  });

  it("treats a pure reorder as neither entering nor leaving", () => {
    // ⌥↑/⌥↓: the rows all survive, only their order changes.
    const d = diffRows([n("a"), n("b"), n("c")], [n("a"), n("c"), n("b")]);
    expect(d.entering.size).toBe(0);
    expect(d.leaving.size).toBe(0);
    expect(d.firstChanged).toBe(1);
  });

  it("collects a scattered leave set (hide-completed turning ON)", () => {
    const prev = [n("a"), n("b"), n("c"), n("d"), n("e")];
    const d = diffRows(prev, [n("a"), n("c"), n("e")]);
    expect(ids(d.leaving)).toEqual(["b", "d"]);
    expect(d.firstChanged).toBe(1);
  });

  it("reports every id as both entering and leaving when ids are re-minted", () => {
    // Import/replace_all mints FRESH ids — the mixed-direction bail is what keeps that
    // whole path off the animation.
    const d = diffRows([n("a"), n("b")], [n("x"), n("y")]);
    expect(d.entering.size).toBe(2);
    expect(d.leaving.size).toBe(2);
    expect(d.firstChanged).toBe(0);
  });
});

describe("anchorRowId", () => {
  it("anchors an ENTER on the last row before the change", () => {
    const prev = [n("a"), n("b"), n("c")];
    const d = diffRows(prev, [n("a"), n("b"), n("x"), n("c")]);
    const surviving = new Set(["a", "b", "x", "c"]);
    expect(anchorRowId(prev, d, surviving, false)).toBe("b");
  });

  it("anchors a LEAVE past the removed block, so the band's reach covers it", () => {
    // "b" and "c" leave; the anchor must be "d" (whose OLD y already includes the
    // removed height), never "a" — see the note on anchorRowId.
    const prev = [n("a"), n("b"), n("c"), n("d"), n("e")];
    const d = diffRows(prev, [n("a"), n("d"), n("e")]);
    const surviving = new Set(["a", "d", "e"]);
    expect(anchorRowId(prev, d, surviving, true)).toBe("d");
  });

  it("walks forward to the first survivor when the change starts at index 0", () => {
    const prev = [n("a"), n("b"), n("c")];
    const d = diffRows(prev, [n("b"), n("c")]); // "a" leaves
    expect(anchorRowId(prev, d, new Set(["b", "c"]), false)).toBe("b");
    expect(anchorRowId(prev, d, new Set(["b", "c"]), true)).toBe("b");
  });

  it("returns null when nothing survives", () => {
    const prev = [n("a"), n("b")];
    const d = diffRows(prev, [n("x")]);
    expect(anchorRowId(prev, d, new Set(["x"]), false)).toBeNull();
    expect(anchorRowId(prev, d, new Set(["x"]), true)).toBeNull();
  });
});
