import { describe, expect, it } from "vitest";
import { kindMorphStyle } from "./kindMorph";

describe("kindMorphStyle", () => {
  it("morphs bullet <-> checkbox by scale (concentric glyphs)", () => {
    expect(kindMorphStyle("bulletPoint", "checkbox")).toBe("scale");
    expect(kindMorphStyle("checkbox", "bulletPoint")).toBe("scale");
  });

  it("leaves the prompt and the divider snapping — no designed transition yet", () => {
    expect(kindMorphStyle("bulletPoint", "promptDraft")).toBeNull();
    expect(kindMorphStyle("checkbox", "promptDraft")).toBeNull();
    expect(kindMorphStyle("promptDraft", "bulletPoint")).toBeNull();
    expect(kindMorphStyle("promptDraft", "checkbox")).toBeNull();
    expect(kindMorphStyle("bulletPoint", "line")).toBeNull();
    expect(kindMorphStyle("line", "bulletPoint")).toBeNull();
    expect(kindMorphStyle("promptDraft", "line")).toBeNull();
    expect(kindMorphStyle("line", "checkbox")).toBeNull();
  });

  it("never animates a no-op change", () => {
    expect(kindMorphStyle("bulletPoint", "bulletPoint")).toBeNull();
    expect(kindMorphStyle("line", "line")).toBeNull();
  });
});
