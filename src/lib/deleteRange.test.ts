import { describe, expect, it } from "vitest";
import { deleteKind, deleteRange, type DeleteKind } from "./deleteRange";

const ev = (key: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

/** `text` with the removed span marked, so a whole table reads at a glance. */
const cut = (kind: DeleteKind, text: string, start: number, end = start) => {
  const { from, to } = deleteRange(kind, text, start, end);
  return text.slice(0, from) + "[" + text.slice(from, to) + "]" + text.slice(to);
};

describe("deleteKind", () => {
  it("maps the plain keys", () => {
    expect(deleteKind(ev("Backspace"))).toBe("charBack");
    expect(deleteKind(ev("Delete"))).toBe("charForward");
  });

  it("maps macOS's ctrl ALIASES, which issue the identical editor commands", () => {
    // ^H is deleteBackward: and ^D is deleteForward: in macOS's standard key bindings,
    // so they reach the same paragraph merge and must take the same path.
    expect(deleteKind(ev("h", { ctrlKey: true }))).toBe("charBack");
    expect(deleteKind(ev("H", { ctrlKey: true }))).toBe("charBack");
    expect(deleteKind(ev("d", { ctrlKey: true }))).toBe("charForward");
  });

  it("maps the granularity modifiers", () => {
    expect(deleteKind(ev("Backspace", { altKey: true }))).toBe("wordBack");
    expect(deleteKind(ev("Delete", { altKey: true }))).toBe("wordForward");
    expect(deleteKind(ev("Backspace", { metaKey: true }))).toBe("lineBack");
    expect(deleteKind(ev("Delete", { metaKey: true }))).toBe("lineForward");
  });

  it("claims nothing else", () => {
    expect(deleteKind(ev("a"))).toBeNull();
    expect(deleteKind(ev("Enter"))).toBeNull();
    expect(deleteKind(ev("k", { ctrlKey: true }))).toBeNull();
    // ⌃⌫ is not one of the standard bindings; leave it to the engine.
    expect(deleteKind(ev("Backspace", { ctrlKey: true }))).toBeNull();
  });
});

describe("deleteRange", () => {
  it("removes the SELECTION and nothing more, whatever the key", () => {
    for (const k of ["charBack", "wordBack", "lineBack", "lineForward"] as DeleteKind[]) {
      expect(cut(k, "alpha bravo", 2, 7)).toBe("al[pha b]ravo");
    }
  });

  it("takes one character, and stops at the ends", () => {
    expect(cut("charBack", "ab", 1)).toBe("[a]b");
    expect(cut("charBack", "ab", 0)).toBe("[]ab");
    expect(cut("charForward", "ab", 1)).toBe("a[b]");
    expect(cut("charForward", "ab", 2)).toBe("ab[]");
  });

  it("takes the newline when the caret sits just past one", () => {
    // The crossing case — the whole reason this file exists.
    expect(cut("charBack", "a\nb", 2)).toBe("a[\n]b");
    expect(cut("charForward", "a\nb", 1)).toBe("a[\n]b");
  });

  describe("word granularity", () => {
    it("takes the word, not the space before the next one", () => {
      expect(cut("wordBack", "alpha bravo", 11)).toBe("alpha [bravo]");
      expect(cut("wordBack", "alpha bravo", 6)).toBe("[alpha ]bravo");
      expect(cut("wordForward", "alpha bravo", 0)).toBe("[alpha] bravo");
    });

    it("steps over PUNCTUATION on the way, like macOS does", () => {
      // Measured against a non-markdown row: with the caret just after a bullet's dash,
      // native ⌥⌫ removes the dash, the newline above it AND the word above that. A rule
      // that stopped at the dash would leave the markdown path diverging from every
      // other row in the app.
      expect(cut("wordBack", "## a\n- b", 6)).toBe("## [a\n-] b");
      expect(cut("wordBack", "alpha, bravo", 7)).toBe("[alpha, ]bravo");
    });

    it("CROSSES a line break to reach a word — macOS's own behaviour", () => {
      // Caret at the start of "two" in "one\n\ntwo": ⌥⌫ swallows both blank newlines
      // and the word above. Measured against a non-markdown prompt, which is the
      // ground truth this has to match.
      expect(cut("wordBack", "one\n\ntwo", 5)).toBe("[one\n\n]two");
      expect(cut("wordForward", "one\n\ntwo", 3)).toBe("one[\n\ntwo]");
    });

    it("is a no-op at the far ends", () => {
      expect(cut("wordBack", "alpha", 0)).toBe("[]alpha");
      expect(cut("wordForward", "alpha", 5)).toBe("alpha[]");
    });
  });

  describe("line granularity", () => {
    it("takes back to the start of the line", () => {
      expect(cut("lineBack", "one\ntwo", 7)).toBe("one\n[two]");
      expect(cut("lineBack", "one\ntwo", 5)).toBe("one\n[t]wo");
    });

    it("degenerates to one character when already AT the line start", () => {
      // Otherwise ⌘⌫ at a line start would be a dead key. WebKit degenerates the same
      // way, which is why this matches rather than doing nothing.
      expect(cut("lineBack", "one\ntwo", 4)).toBe("one[\n]two");
      expect(cut("lineBack", "one", 0)).toBe("[]one");
    });

    it("takes forward to the end of the line, then the newline", () => {
      expect(cut("lineForward", "one\ntwo", 0)).toBe("[one]\ntwo");
      expect(cut("lineForward", "one\ntwo", 3)).toBe("one[\n]two");
      expect(cut("lineForward", "one", 3)).toBe("one[]");
    });
  });
});
