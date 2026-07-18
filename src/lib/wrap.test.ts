import { describe, expect, it } from "vitest";
import { applyWrap, wrapAction } from "./wrap";

describe("wrap-selection", () => {
  it("wraps a plain selection and keeps the inner text selected", () => {
    const a = wrapAction("(", "say word now", 4, 8)!;
    expect(a.type).toBe("wrap");
    const r = applyWrap(a, "(", "say word now", 4, 8);
    expect(r.text).toBe("say (word) now");
    expect(r.text.slice(r.selStart, r.selEnd)).toBe("word");
  });

  it("unwraps one layer when the pair sits just outside the selection", () => {
    const text = "say (word) now";
    const a = wrapAction("(", text, 5, 9)!;
    expect(a.type).toBe("unwrapSurrounding");
    const r = applyWrap(a, "(", text, 5, 9);
    expect(r.text).toBe("say word now");
    expect(r.text.slice(r.selStart, r.selEnd)).toBe("word");
  });

  it("strips an inclusive pair when the selection spans it", () => {
    const text = 'a "quoted" b';
    const a = wrapAction('"', text, 2, 10)!;
    expect(a.type).toBe("unwrapInclusive");
    const r = applyWrap(a, '"', text, 2, 10);
    expect(r.text).toBe("a quoted b");
    expect(r.text.slice(r.selStart, r.selEnd)).toBe("quoted");
  });

  it("does nothing on an empty caret or a non-delimiter", () => {
    expect(wrapAction("(", "word", 2, 2)).toBeNull();
    expect(wrapAction("x", "word", 0, 4)).toBeNull();
  });
});
