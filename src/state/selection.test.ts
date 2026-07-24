import { describe, expect, it } from "vitest";
import { projectSelectionHead, type SelRow } from "./selection";

/** Selection-head projection (ports the SwiftUI app's selectionRange scenario shapes).
 * Layout, 24px rows from y=0:  A(0) > A1(1) > A1a(2), A2(1), [add:A]; B(0); C(0) */

const PARENTS: Record<string, string | null> = {
  A: null,
  A1: "A",
  A1a: "A1",
  A2: "A",
  B: null,
  C: null,
};
const parentOf = (id: string) => PARENTS[id] ?? null;

const ORDER = ["A", "A1", "A1a", "A2", "add:A", "B", "C"];

const rows: SelRow[] = ORDER.map((id) => ({
  id,
  nodeId: id.startsWith("add:") ? id.slice(4) : id,
  kind: id.startsWith("add:") ? "addChild" : "node",
}));

const frames = new Map(
  ORDER.map((id, i) => [id, { minY: i * 24, maxY: i * 24 + 24 }] as const),
);

/** Mid-row y for a row id. */
const midY = (id: string) => ORDER.indexOf(id) * 24 + 12;

const head = (anchor: string, y: number) =>
  projectSelectionHead(anchor, y, rows, frames, parentOf);

describe("projectSelectionHead", () => {
  it("returns the row under the pointer when it's a sibling of the anchor", () => {
    expect(head("A", midY("B"))).toBe("B");
    expect(head("C", midY("A"))).toBe("A");
    expect(head("A1", midY("A2"))).toBe("A2");
  });

  it("returns the anchor itself while the pointer is still on it", () => {
    expect(head("A1", midY("A1"))).toBe("A1");
  });

  it("maps a deeper hit row up to the anchor-level sibling containing it", () => {
    // A1a is a child of A1, which is a child of A — at A's level that's A itself.
    expect(head("B", midY("A1a"))).toBe("A");
    // Anchored one level down, the same row resolves to A1.
    expect(head("A2", midY("A1a"))).toBe("A1");
  });

  it("clamps to the end of the sibling list the pointer is past", () => {
    // Anchored on a child of A, pointing at a root BELOW it → last sibling (A2).
    expect(head("A1", midY("C"))).toBe("A2");
    // …and at a root ABOVE the anchor's row → first sibling (A1).
    expect(head("A2", -50)).toBe("A1");
  });

  it("resolves above the first row and below the last to the ends", () => {
    expect(head("B", -1000)).toBe("A");
    expect(head("B", 100000)).toBe("C");
  });

  it("ignores the '+' placeholder rows", () => {
    // add:A sits between A2 and B; a pointer over it is NOT a hit on node A.
    expect(head("A", midY("add:A"))).toBe("B");
  });

  it("returns null when the anchor isn't a visible row", () => {
    expect(head("gone", midY("A"))).toBeNull();
  });

  it("survives a parent cycle", () => {
    const cyclic = (id: string) => (id === "X" ? "Y" : id === "Y" ? "X" : null);
    const cRows: SelRow[] = [
      { id: "R", nodeId: "R", kind: "node" },
      { id: "X", nodeId: "X", kind: "node" },
    ];
    const cFrames = new Map([
      ["R", { minY: 0, maxY: 24 }],
      ["X", { minY: 24, maxY: 48 }],
    ]);
    // X's chain never reaches a root-level node — the hit clamps instead of hanging.
    expect(projectSelectionHead("R", 36, cRows, cFrames, cyclic)).toBe("R");
  });
});
