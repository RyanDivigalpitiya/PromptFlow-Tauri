import { describe, expect, it } from "vitest";
import { currentTaskId, walkCurrentTask, type TaskTree } from "./currentTask";
import type { NodeKind } from "./types";

/** The screenshot's tree, which is the whole point of the descent rule:
 *
 *   Example > Parent 1 > [Child 1, Parent 2 > Child 2]
 *           > Parent 3 > Parent 4 > Child 3
 *
 * `Example`'s Current Task is `Child 1` — its first CHILD is `Parent 1`. */
interface Spec {
  parent: string | null;
  kind?: NodeKind;
  done?: boolean;
}

function tree(spec: Record<string, Spec>): TaskTree {
  const ids = Object.keys(spec); // insertion order IS sibling order
  return {
    childrenOf: (parent) => ids.filter((id) => spec[id].parent === parent),
    get: (id) =>
      spec[id] && {
        isCompleted: spec[id].done ?? false,
        kind: spec[id].kind ?? "bulletPoint",
      },
  };
}

const SCREENSHOT: Record<string, Spec> = {
  Example: { parent: null },
  "Parent 1": { parent: "Example" },
  "Child 1": { parent: "Parent 1" },
  "Parent 2": { parent: "Parent 1" },
  "Child 2": { parent: "Parent 2" },
  "Parent 3": { parent: "Example" },
  "Parent 4": { parent: "Parent 3" },
  "Child 3": { parent: "Parent 4" },
};

const taskIn = (spec: Record<string, Spec>, id = "Example") =>
  currentTaskId(tree(spec), id);

describe("currentTaskId", () => {
  it("descends to the first leaf, not the first child", () => {
    expect(taskIn(SCREENSHOT)).toBe("Child 1");
  });

  it("advances past a completed leaf to the next open branch", () => {
    expect(taskIn({ ...SCREENSHOT, "Child 1": { parent: "Parent 1", done: true } })).toBe(
      "Child 2",
    );
  });

  it("skips a completed subtree WHOLESALE — never descends into one", () => {
    // Parent 1 is ticked while Child 1 under it is not: ticking a parent means its
    // subtree is done, so the task is the next open sibling's first leaf.
    expect(taskIn({ ...SCREENSHOT, "Parent 1": { parent: "Example", done: true } })).toBe(
      "Child 3",
    );
  });

  it("stops on a node whose children are all done — IT is what remains", () => {
    expect(
      taskIn({
        ...SCREENSHOT,
        "Child 1": { parent: "Parent 1", done: true },
        "Parent 2": { parent: "Parent 1", done: true },
      }),
    ).toBe("Parent 1");
  });

  it("has no task when the focused node has no children", () => {
    expect(taskIn(SCREENSHOT, "Child 3")).toBeNull();
    expect(taskIn({ Lone: { parent: null } }, "Lone")).toBeNull();
  });

  it("has no task when every child is completed", () => {
    expect(
      taskIn({
        ...SCREENSHOT,
        "Parent 1": { parent: "Example", done: true },
        "Parent 3": { parent: "Example", done: true },
      }),
    ).toBeNull();
  });

  it("steps over dividers, like every caret path in the app", () => {
    expect(
      taskIn({
        Example: { parent: null },
        Rule: { parent: "Example", kind: "line" },
        Real: { parent: "Example" },
      }),
    ).toBe("Real");
    // A divider is never a task even when it is the only child.
    expect(
      taskIn({ Example: { parent: null }, Rule: { parent: "Example", kind: "line" } }),
    ).toBeNull();
  });

  it("takes a checkbox as a task like any other node", () => {
    expect(
      taskIn({
        Example: { parent: null },
        Box: { parent: "Example", kind: "checkbox" },
      }),
    ).toBe("Box");
  });
});

describe("currentTaskId, prompts", () => {
  it("never shows a prompt as the task — it steps over one", () => {
    expect(
      taskIn({
        Example: { parent: null },
        Draft: { parent: "Example", kind: "promptDraft" },
        Real: { parent: "Example" },
      }),
    ).toBe("Real");
  });

  it("…but DESCENDS into it, so work parented under a prompt is never hidden", () => {
    expect(
      taskIn({
        Example: { parent: null },
        Draft: { parent: "Example", kind: "promptDraft" },
        "Refine the wording": { parent: "Draft" },
        Later: { parent: "Example" },
      }),
    ).toBe("Refine the wording");
  });

  it("backtracks out of a prompt with nothing open under it", () => {
    // The whole reason this is a backtracking walk: `Draft` is reached first and descended
    // into, and only when it yields nothing does the walk fall back to its next sibling.
    expect(
      taskIn({
        Example: { parent: null },
        Draft: { parent: "Example", kind: "promptDraft" },
        "its done child": { parent: "Draft", done: true },
        "The real next action": { parent: "Example" },
      }),
    ).toBe("The real next action");
  });

  it("backtracks out of nested prompts too", () => {
    expect(
      taskIn({
        Example: { parent: null },
        Outer: { parent: "Example", kind: "promptDraft" },
        Inner: { parent: "Outer", kind: "promptDraft" },
        Real: { parent: "Example" },
      }),
    ).toBe("Real");
  });

  it("has no task when a prompt is all there is", () => {
    expect(
      taskIn({
        Example: { parent: null },
        Draft: { parent: "Example", kind: "promptDraft" },
      }),
    ).toBeNull();
  });

  it("still skips a COMPLETED prompt wholesale — never looks inside it", () => {
    expect(
      taskIn({
        Example: { parent: null },
        Draft: { parent: "Example", kind: "promptDraft", done: true },
        "buried under a done prompt": { parent: "Draft" },
        Real: { parent: "Example" },
      }),
    ).toBe("Real");
  });
});

describe("walkCurrentTask", () => {
  it("returns the descent — focused exclusive, task inclusive", () => {
    expect(walkCurrentTask(tree(SCREENSHOT), "Example").chain).toEqual([
      "Parent 1",
      "Child 1",
    ]);
  });

  it("is empty when there is no task, so a view subscribes to nothing extra", () => {
    expect(walkCurrentTask(tree(SCREENSHOT), "Child 1").chain).toEqual([]);
  });

  it("visits every record it READ, including the ones it rejected", () => {
    const spec: Record<string, Spec> = {
      Example: { parent: null },
      Rule: { parent: "Example", kind: "line" },
      Done: { parent: "Example", done: true },
      "buried under Done": { parent: "Done" },
      Draft: { parent: "Example", kind: "promptDraft" },
      "under the prompt": { parent: "Draft", done: true },
      Real: { parent: "Example" },
      Later: { parent: "Example" },
    };
    const { chain, visited } = walkCurrentTask(tree(spec), "Example");
    expect(chain).toEqual(["Real"]);
    // The divider, the completed node and the fruitless prompt all decided the outcome by
    // their kind/completion, so all three are watched — as is the prompt's own child, read
    // while descending. `buried under Done` was never read (a completed node is skipped
    // wholesale) and `Later` never reached, since `Real` already won.
    expect(visited).toEqual(["Rule", "Done", "Draft", "under the prompt", "Real"]);
  });

  it("watches the task's own children — they are why it is the task", () => {
    const { visited } = walkCurrentTask(
      tree({
        Example: { parent: null },
        "Parent 1": { parent: "Example" },
        "done kid": { parent: "Parent 1", done: true },
      }),
      "Example",
    );
    expect(visited).toEqual(["Parent 1", "done kid"]);
  });

  it("ignores a child the mirror hasn't caught up to", () => {
    const spec = { ...SCREENSHOT };
    const t = tree(spec);
    const holed: TaskTree = {
      childrenOf: (p) => (p === "Example" ? ["ghost", "Parent 1"] : t.childrenOf(p)),
      get: (id) => (id === "ghost" ? undefined : t.get(id)),
    };
    expect(currentTaskId(holed, "Example")).toBe("Child 1");
  });

  it("terminates on a cycle instead of walking forever", () => {
    const cyclic: TaskTree = {
      childrenOf: (p) => (p === "A" ? ["B"] : p === "B" ? ["A"] : []),
      get: () => ({ isCompleted: false, kind: "bulletPoint" }),
    };
    expect(currentTaskId(cyclic, "A")).toBe("B");
  });
});
