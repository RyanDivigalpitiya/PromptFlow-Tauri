import { describe, expect, it } from "vitest";
import { adjustRangesForEdit, toggleBold } from "./bold";

describe("bold runs", () => {
  it("toggles bold on, merges adjacent runs, and toggles back off", () => {
    const text = "hello world";
    let r = toggleBold([], text.length, 0, 5);
    expect(r).toEqual([0, 5]);
    r = toggleBold(r, text.length, 5, 11);
    expect(r).toEqual([0, 11]);
    r = toggleBold(r, text.length, 0, 11);
    expect(r).toEqual([]);
  });

  it("unbolds only when the whole selection is bold", () => {
    // Half-bold selection → bolds the rest.
    const r = toggleBold([0, 3], 6, 0, 6);
    expect(r).toEqual([0, 6]);
  });

  it("shifts ranges across an insertion before the run", () => {
    // "abcdef" with bold "cd" → insert "XY" at 0.
    const r = adjustRangesForEdit([2, 2], "abcdef", "XYabcdef");
    expect(r).toEqual([4, 2]);
  });

  it("extends a run when typing inside it", () => {
    // bold "bcd" in "abcde", type X between c and d.
    const r = adjustRangesForEdit([1, 3], "abcde", "abcXde");
    expect(r).toEqual([1, 4]);
  });

  it("clips a run when its text is deleted", () => {
    // bold "cd" in "abcdef", delete "cd".
    const r = adjustRangesForEdit([2, 2], "abcdef", "abef");
    expect(r).toEqual([]);
  });
});
