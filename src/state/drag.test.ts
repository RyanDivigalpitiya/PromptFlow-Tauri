import { describe, expect, it } from "vitest";
import { projectDrop, type DropCandidate } from "./drag";

/** Drop projection (ports the SwiftUI app's dragProjection scenario shapes).
 * Layout: A(0) > A1(1), A2(1); B(0) — rows 24px tall from y=0. */

function cand(
  nodeId: string,
  parent: string | null,
  depth: number,
  index: number,
  kind: DropCandidate["kind"] = "bulletPoint",
): DropCandidate {
  const minY = index * 24;
  return { nodeId, parent, kind, depth, minY, midY: minY + 12, maxY: minY + 24 };
}

const PARENTS: Record<string, string | null> = {
  A: null,
  A1: "A",
  A2: "A",
  B: null,
};

const candidates = [
  cand("A", null, 0, 0),
  cand("A1", "A", 1, 1),
  cand("A2", "A", 1, 2),
  cand("B", null, 0, 3),
];

const parentOf = (id: string) => PARENTS[id] ?? null;

describe("projectDrop", () => {
  it("drops between siblings at the same depth", () => {
    // Pointer in the gap between A1 and A2, no horizontal delta.
    const p = projectDrop(candidates, 40, 0, 1, 22, false, parentOf)!;
    expect(p.parentId).toBe("A");
    expect(p.afterId).toBe("A1");
    expect(p.depth).toBe(1);
  });

  it("a rightward drag below a parent makes a FIRST CHILD", () => {
    // Gap below A (pointer between A and A1), dragged one indent right.
    const p = projectDrop(candidates, 20, 22, 0, 22, false, parentOf)!;
    expect(p.parentId).toBe("A");
    expect(p.afterId).toBeNull();
  });

  it("a leftward drag at the end outdents to root level", () => {
    // Below everything, dragged left of A2's depth.
    const p = projectDrop(candidates, 200, -44, 1, 22, false, parentOf)!;
    expect(p.parentId).toBeNull();
    expect(p.afterId).toBe("B");
    expect(p.depth).toBe(0);
  });

  it("walking up from a deep prev picks the ancestor's sibling slot", () => {
    // Gap after A2 (pointer between A2 and B), at depth 0 → next sibling of A.
    const p = projectDrop(candidates, 64, -22, 1, 22, false, parentOf)!;
    expect(p.parentId).toBeNull();
    expect(p.afterId).toBe("A");
  });

  it("a divider can never become a parent", () => {
    const withRule = [cand("R", null, 0, 0, "line"), cand("B", null, 0, 1)];
    // Gap below the rule, dragged right (would be a child of R if allowed).
    const p = projectDrop(withRule, 20, 44, 0, 22, false, parentOf)!;
    expect(p.parentId).toBeNull(); // clamped to R's own depth → sibling, not child
    expect(p.afterId).toBe("R");
  });

  it("drilled-in view forbids the gap above the drill root and floors depth at 1", () => {
    const p = projectDrop(candidates, 0, -99, 1, 22, true, parentOf)!;
    expect(p.depth).toBeGreaterThanOrEqual(1);
    // The gap above the root is forbidden — the topmost legal slot is the root's
    // own FIRST CHILD, never a sibling above it.
    expect(p.parentId).toBe("A");
    expect(p.afterId).toBeNull();
  });

  it("top of a true-root list lands as the first root", () => {
    const p = projectDrop(candidates, 0, 0, 0, 22, false, parentOf)!;
    expect(p.parentId).toBeNull();
    expect(p.afterId).toBeNull();
  });
});
