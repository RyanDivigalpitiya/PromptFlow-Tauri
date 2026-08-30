import { describe, expect, it } from "vitest";
import {
  bulletAtCaret,
  classifyLine,
  hasMarkdown,
  indentLines,
  mdLines,
} from "./mdLines";

/** `kind@markerLen` — compact enough to read a whole truth table at once. */
const c = (line: string) => {
  const { kind, markerLen } = classifyLine(line);
  return `${kind}@${markerLen}`;
};

describe("classifyLine, headings", () => {
  it("takes one to three hashes followed by a space and something", () => {
    expect(c("# Title")).toBe("h1@2");
    expect(c("## Section")).toBe("h2@3");
    expect(c("### Sub")).toBe("h3@4");
    // Extra spaces after the hashes belong to the marker, so the title's ink starts
    // at the same column whatever the author typed.
    expect(c("#   Title")).toBe("h1@4");
  });

  it("stops at three — #### is prose, as in every markdown dialect we care about", () => {
    expect(c("#### Deep")).toBe("plain@0");
  });

  it("needs the space, and needs something after it", () => {
    expect(c("#Title")).toBe("plain@0");
    // A bare "# " is a heading being TYPED. Classifying it early would resize the row
    // under the caret before there is anything to title.
    expect(c("# ")).toBe("plain@0");
    expect(c("#")).toBe("plain@0");
  });

  it("is anchored at column 0 — an INDENTED hash is folded content, not a title", () => {
    // ⌘3 folds a block whose node text happens to start with "#"; two spaces in, that
    // is a list line's continuation, and sizing it as a title would be absurd.
    expect(c(" # Indented")).toBe("plain@0");
    expect(c("  # Indented")).toBe("plain@0");
  });
});

describe("classifyLine, lists", () => {
  it("takes -, * and + as bullets", () => {
    expect(c("- one")).toBe("bullet@2");
    expect(c("* one")).toBe("bullet@2");
    expect(c("+ one")).toBe("bullet@2");
  });

  it("takes the indent into the MARKER, so nesting shifts the whole item", () => {
    // Two spaces per level is exactly what `merge_into_prompt` writes.
    expect(c("  - nested")).toBe("bullet@4");
    expect(c("    - deeper")).toBe("bullet@6");
    expect(c("\t- tabbed")).toBe("bullet@3");
  });

  it("takes 1. and 1) as ordered, up to three digits", () => {
    expect(c("1. first")).toBe("ordered@3");
    expect(c("1) first")).toBe("ordered@3");
    expect(c("10. tenth")).toBe("ordered@4");
    expect(c("999. many")).toBe("ordered@5");
    expect(c("  2. nested")).toBe("ordered@5");
  });

  it("leaves a year-opening sentence as prose", () => {
    // The whole reason the digit run is capped: "2024. That was the year" is a sentence,
    // and rendering it as list item #2024 would be a lie about the text.
    expect(c("2024. That was the year")).toBe("plain@0");
  });

  it("allows an EMPTY body, so an item reads as one the moment it opens", () => {
    expect(c("- ")).toBe("bullet@2");
    expect(c("1. ")).toBe("ordered@3");
  });

  it("needs the space after the marker", () => {
    expect(c("-one")).toBe("plain@0");
    expect(c("1.first")).toBe("plain@0");
    // A lone dash is a dash.
    expect(c("-")).toBe("plain@0");
  });

  it("leaves a fold's CONTINUATION line plain — the case that must not regress", () => {
    // `merge_into_prompt` hangs a node's own extra lines under the bullet's TEXT with
    // two spaces and NO marker. Treating that as a nested bullet would re-indent the
    // fold's output and move geometry that both suites measure.
    expect(c("  continuation of bravo")).toBe("plain@0");
    expect(c("    deeper continuation")).toBe("plain@0");
    expect(c("")).toBe("plain@0");
  });
});

describe("mdLines", () => {
  it("splits on newlines and records where each line's marker ends", () => {
    expect(mdLines("# T\n- a\nplain")).toEqual([
      { start: 0, end: 3, hasNewline: true, kind: "h1", markerEnd: 2 },
      { start: 4, end: 7, hasNewline: true, kind: "bullet", markerEnd: 6 },
      { start: 8, end: 13, hasNewline: false, kind: "plain", markerEnd: 8 },
    ]);
  });

  it("gives a text ending in a newline a final EMPTY line", () => {
    // That line is what the trailing-line sentinel renders a line box for; without it
    // the row would be a line shorter unfocused than focused.
    const ls = mdLines("a\n");
    expect(ls.length).toBe(2);
    expect(ls[1]).toEqual({ start: 2, end: 2, hasNewline: false, kind: "plain", markerEnd: 2 });
  });

  it("always returns at least one line, even for empty text", () => {
    expect(mdLines("")).toEqual([
      { start: 0, end: 0, hasNewline: false, kind: "plain", markerEnd: 0 },
    ]);
  });

  it("keeps a blank middle line as its own line", () => {
    expect(mdLines("a\n\nb").map((l) => `${l.start}-${l.end}`)).toEqual(["0-1", "2-2", "3-4"]);
  });
});

describe("hasMarkdown", () => {
  it("is false for prose, so an ordinary prompt keeps today's flat DOM exactly", () => {
    expect(hasMarkdown("You are a helpful coding agent.")).toBe(false);
    expect(hasMarkdown("line one\nline two\n")).toBe(false);
    expect(hasMarkdown("")).toBe(false);
  });

  it("is true as soon as any line carries a marker", () => {
    expect(hasMarkdown("intro\n- a bullet")).toBe(true);
    expect(hasMarkdown("# Title")).toBe(true);
    expect(hasMarkdown("1. step")).toBe(true);
  });

  /** The exact string `merge_into_prompt_nests_descendants_by_depth` (store.rs) and
   * qa.mjs's fold section both pin. The two suites meet on it, and so does this one. */
  const FOLDED = "- Alpha\n  - Child one\n    - Grandchild\n  - Child two\n- Beta\n  - Beta's child";

  it("renders a ⌘3 fold as a nested list, every line a bullet", () => {
    expect(hasMarkdown(FOLDED)).toBe(true);
    expect(mdLines(FOLDED).map((l) => `${l.kind}@${l.markerEnd - l.start}`)).toEqual([
      "bullet@2",
      "bullet@4",
      "bullet@6",
      "bullet@4",
      "bullet@2",
      "bullet@4",
    ]);
  });
});

describe("indentLines", () => {
  /** One Tab. Spelled out here rather than imported so a change to the constant has to
   * be a deliberate edit to these expectations too. */
  const PAD = "    ";
  /** `text` with the selection marked, so a case reads as what the user sees. */
  const sel = (r: { text: string; start: number; end: number } | null) =>
    r === null ? null : r.text.slice(0, r.start) + "|" + r.text.slice(r.start, r.end) + (r.start === r.end ? "" : "|") + r.text.slice(r.end);
  const tab = (text: string, s: number, e = s) => sel(indentLines(text, s, e, true));
  const untab = (text: string, s: number, e = s) => sel(indentLines(text, s, e, false));

  it("indents the caret's line by one level and carries the caret with it", () => {
    // Two spaces — the same unit ⌘3's fold writes per depth, so a hand-tabbed list and
    // a folded one nest identically.
    expect(tab("- one", 2)).toBe(`${PAD}- |one`);
    expect(tab("- one", 0)).toBe(`${PAD}|- one`);
  });

  it("outdents it again", () => {
    expect(untab(`${PAD}- one`, 6)).toBe("- |one");
    expect(untab("- one", 2)).toBeNull();
  });

  it("collapses a caret sitting INSIDE the whitespace it removes", () => {
    // Rather than letting it run off the front of the line.
    expect(untab(`${PAD}- one`, 2)).toBe("|- one");
    expect(untab(`${PAD}- one`, 0)).toBe("|- one");
  });

  it("takes a single space, so a hand-indented line still un-indents", () => {
    expect(untab(" - one", 3)).toBe("- |one");
    expect(untab("\t- one", 3)).toBe("- |one");
  });

  it("moves every line a SELECTION touches, and the selection with them", () => {
    // [1,5) is " a\n-" — after indenting both lines it is still exactly that content,
    // now at [3,9).
    expect(tab("- a\n- b\n- c", 1, 5)).toBe(`${PAD}-| a\n${PAD}-| b\n- c`);
    // The fold's narrower two-space step un-indents in one press too — a level to
    // REMOVE is "up to one level", not "exactly one".
    expect(untab("  - a\n  - b", 3, 9)).toBe("-| a\n-| b");
  });

  it("skips a blank line rather than leaving trailing whitespace on it", () => {
    // The same rule `merge_into_prompt` follows for a blank continuation line: the
    // middle line stays empty while the two around it move.
    expect(tab("- a\n\n- b", 1, 7)).toBe(`${PAD}-| a\n\n${PAD}- |b`);
  });

  it("is null when nothing would move, so the caller can fall through", () => {
    expect(untab("- a\n- b", 1, 5)).toBeNull();
    expect(tab("", 0)).toBeNull();
  });
});

describe("bulletAtCaret", () => {
  const at = (text: string, start: number, end = start) => {
    const b = bulletAtCaret(text, start, end);
    return b === null ? null : `${JSON.stringify(b.marker)}${b.bodyEmpty ? " (empty)" : ""}`;
  };

  it("carries the line's own marker, indent included", () => {
    expect(at("- one", 5)).toBe('"- "');
    expect(at("    - one", 9)).toBe('"    - "');
    expect(at("* one", 5)).toBe('"* "');
    expect(at("+ one", 5)).toBe('"+ "');
  });

  it("works mid-line — Enter splits the item in two", () => {
    expect(at("- alpha", 4)).toBe('"- "');
  });

  it("reports an EMPTY bullet, where Enter ends the list instead", () => {
    expect(at("- ", 2)).toBe('"- " (empty)');
    expect(at("  - ", 4)).toBe('"  - " (empty)');
  });

  it("leaves ORDERED lists alone — renumbering is a different feature", () => {
    expect(at("1. one", 6)).toBeNull();
    expect(at("1) one", 6)).toBeNull();
  });

  it("is null on anything that is not a bullet line", () => {
    expect(at("# Title", 7)).toBeNull();
    expect(at("plain prose", 5)).toBeNull();
    expect(at("", 0)).toBeNull();
    // A fold's continuation line: two spaces and no marker.
    expect(at("  continuation", 5)).toBeNull();
  });

  it("is null with the caret INSIDE the marker, which is being edited not extended", () => {
    expect(at("- one", 0)).toBeNull();
    expect(at("- one", 1)).toBeNull();
    expect(at("- one", 2)).toBe('"- "');
  });

  it("is null for a selection — Enter there replaces, and which line is ambiguous", () => {
    expect(at("- one", 1, 4)).toBeNull();
  });

  it("picks the line the caret is on, not the first bullet it finds", () => {
    expect(at("- one\n    - two\nplain", 15)).toBe('"    - "');
    expect(at("- one\n    - two\nplain", 20)).toBeNull();
  });
});
