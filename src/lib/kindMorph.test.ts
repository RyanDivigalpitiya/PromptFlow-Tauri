import { describe, expect, it } from "vitest";
import { kindMorphStyle } from "./kindMorph";

describe("kindMorphStyle", () => {
  it("morphs bullet <-> checkbox by scale (concentric glyphs)", () => {
    expect(kindMorphStyle("bulletPoint", "checkbox")).toBe("scale");
    expect(kindMorphStyle("checkbox", "bulletPoint")).toBe("scale");
  });

  it("cross-fades to and from a prompt (a bar can't scale into a dot)", () => {
    expect(kindMorphStyle("bulletPoint", "promptDraft")).toBe("fade");
    expect(kindMorphStyle("checkbox", "promptDraft")).toBe("fade");
    expect(kindMorphStyle("promptDraft", "bulletPoint")).toBe("fade");
    expect(kindMorphStyle("promptDraft", "checkbox")).toBe("fade");
  });

  it("leaves the divider snapping — no designed transition yet", () => {
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
