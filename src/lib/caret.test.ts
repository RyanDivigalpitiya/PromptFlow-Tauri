// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { selectionOffsets, serializeEditor, setSelectionOffsets } from "./caret";

/** An editor element holding a literal DOM shape. Every shape below was MEASURED in
 * WebKit (Playwright, the WKWebView engine) — either as what buildRunDom renders or as
 * what WebKit itself leaves behind mid-edit — so these are recordings, not guesses. */
function editor(html: string): HTMLElement {
  const el = document.createElement("div");
  el.contentEditable = "true";
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

const SENTINEL = '<br data-pf-sentinel="1">';

describe("serializeEditor", () => {
  it("reads a plain run", () => {
    expect(serializeEditor(editor("<span>alpha</span>"))).toBe("alpha");
  });

  it("reads newlines as the literal characters they are", () => {
    expect(serializeEditor(editor("<span>alpha\nbravo</span>"))).toBe("alpha\nbravo");
  });

  it("skips our own trailing sentinel", () => {
    expect(serializeEditor(editor(`<span>alpha\n</span>${SENTINEL}`))).toBe("alpha\n");
  });

  // The shipped bug. Emptying the last line makes WebKit insert its OWN line-box
  // placeholder <br> INSIDE the run span, before our input handler ever runs; counting
  // it as a newline committed a phantom empty line to the store on every "delete the
  // last line". Measured shapes, from backspace / select-and-delete / forward-delete.
  it("skips WebKit's placeholder <br> for an emptied last line", () => {
    expect(serializeEditor(editor("<span>alpha\n<br></span>"))).toBe("alpha\n");
    expect(serializeEditor(editor("<span>one\ntwo\n<br></span>"))).toBe("one\ntwo\n");
    expect(serializeEditor(editor("<span>charlie\n<br></span>"))).toBe("charlie\n");
  });

  it("skips it over several trailing newlines too", () => {
    expect(serializeEditor(editor("<span>a\n\n\n<br></span>"))).toBe("a\n\n\n");
  });

  it("skips it when the placeholder follows a styled run", () => {
    expect(
      serializeEditor(
        editor('<span style="font-weight: 700;">styled</span><span>\n<br></span>'),
      ),
    ).toBe("styled\n");
  });

  // buildRunDom emits one span per style run, so in a styled node the trailing "\n" and
  // WebKit's placeholder land in different elements — the rule's "text before it" has to
  // join ACROSS parts, not just read the <br>'s own parent or previous sibling.
  it("skips it when the newline lives in a DIFFERENT element", () => {
    expect(
      serializeEditor(
        editor('<span style="font-weight: 700;">bold</span><span>\n</span><br>'),
      ),
    ).toBe("bold\n");
  });

  it("skips it past a trailing EMPTY text node", () => {
    const el = editor("<span>a\n<br></span>");
    el.appendChild(document.createTextNode(""));
    expect(serializeEditor(el)).toBe("a\n");
  });

  // A just-emptied node must read as empty, or it stops counting as empty and Backspace
  // stops deleting it (an older shipped bug this rule now subsumes).
  it("reads WebKit's placeholder for a fully emptied editor as empty", () => {
    expect(serializeEditor(editor("<br>"))).toBe("");
    expect(serializeEditor(editor("<span></span><br>"))).toBe("");
  });

  // The other half of the rule: a <br> that carries a newline of its OWN still counts.
  // Text DROPPED into the editor is the one insertion path we don't intercept, so this
  // is the shape that must not be swallowed. Widening the rule to "any trailing <br> is
  // zero-width" breaks exactly these two.
  it("counts a <br> that is not redundant with a newline already in the text", () => {
    expect(serializeEditor(editor("<span>hello</span><br>"))).toBe("hello\n");
    expect(serializeEditor(editor("<span>hello</span><br><br>"))).toBe("hello\n");
  });

  it("counts a <br> in the middle", () => {
    expect(serializeEditor(editor("<span>a</span><br><span>b</span>"))).toBe("a\nb");
  });

  it("keeps an emptied MIDDLE line's newlines", () => {
    expect(serializeEditor(editor("<span>mid\n\nend</span>"))).toBe("mid\n\nend");
  });
});

describe("selection offsets", () => {
  it("reads a point on EITHER side of a zero-width <br> as the text end", () => {
    // WebKit's own selection after backspacing the last character of "alpha\nbravo" is
    // an ELEMENT position in the run span — child index 1 (before the placeholder) or 2
    // (after it) — and `onInput` reads it off that raw DOM in the same handler that
    // serializes it. The after-side used to read 7: one past the end of the 6-character
    // text being committed, i.e. the caret restored onto the phantom line.
    const el = editor("<span>alpha\n<br></span>");
    const span = el.firstChild as HTMLElement;
    const sel = window.getSelection()!;
    for (const childOffset of [1, 2]) {
      const range = document.createRange();
      range.setStart(span, childOffset);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      expect(selectionOffsets(el), `child offset ${childOffset}`).toEqual({
        start: 6,
        end: 6,
      });
    }
  });

  it("round-trips an offset on the trailing empty line", () => {
    const el = editor(`<span>alpha\n</span>${SENTINEL}`);
    setSelectionOffsets(el, 6);
    expect(selectionOffsets(el)).toEqual({ start: 6, end: 6 });
  });

  it("counts a real <br> as one offset", () => {
    const el = editor("<span>a</span><br><span>b</span>");
    setSelectionOffsets(el, 2); // after the newline, before "b"
    expect(selectionOffsets(el)).toEqual({ start: 2, end: 2 });
  });

  it("round-trips a range that spans a newline", () => {
    const el = editor("<span>alpha\nbravo</span>");
    setSelectionOffsets(el, 3, 8);
    expect(selectionOffsets(el)).toEqual({ start: 3, end: 8 });
  });
});
