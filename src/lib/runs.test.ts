// @vitest-environment happy-dom
//
// domMatchesRuns is the guard that lets the live editor SKIP rebuilding its run
// DOM. Skipping is what keeps macOS text substitution alive (WebKit runs its
// substitution pass after the synchronous `input` dispatch, so a replaceChildren
// in our handler would hand it detached nodes) — but a WRONG `true` strands the
// editor on stray browser DOM, which is the exact failure the controlled-editor
// invariant exists to prevent. So the interesting cases here are the false ones.
import { describe, expect, it } from "vitest";
import { buildRunDom, domMatchesRuns, type StyleSet } from "./runs";

const none: StyleSet = { bold: [], italic: [], underline: [] };
const styles = (s: Partial<StyleSet>): StyleSet => ({ ...none, ...s });

/** A container holding exactly what buildRunDom produces for (text, styles). */
function built(text: string, s: StyleSet = none): HTMLElement {
  const el = document.createElement("div");
  buildRunDom(el, text, s);
  return el;
}

describe("domMatchesRuns", () => {
  it("matches the DOM buildRunDom just built", () => {
    for (const [text, s] of [
      ["hello", none],
      ["", none],
      ["a\nb", none],
      ["trailing\n", none],
      ["bold me", styles({ bold: [0, 4] })],
      ["mixed", styles({ bold: [0, 2], italic: [2, 3] })],
      ["all three", styles({ bold: [0, 3], italic: [0, 3], underline: [0, 3] })],
    ] as const) {
      const el = built(text, s as StyleSet);
      expect(domMatchesRuns(el, text, s as StyleSet), JSON.stringify(text)).toBe(true);
    }
  });

  it("is idempotent: buildRunDom reports no rebuild the second time", () => {
    const el = document.createElement("div");
    expect(buildRunDom(el, "hello", none)).toBe(true);
    expect(buildRunDom(el, "hello", none)).toBe(false);
    // ...and a real change still rebuilds.
    expect(buildRunDom(el, "hello!", none)).toBe(true);
  });

  it("rejects a text difference", () => {
    const el = built("hello");
    expect(domMatchesRuns(el, "hell", none)).toBe(false);
    expect(domMatchesRuns(el, "hello!", none)).toBe(false);
    expect(domMatchesRuns(el, "", none)).toBe(false);
  });

  it("rejects a style difference", () => {
    const el = built("hello", styles({ bold: [0, 5] }));
    expect(domMatchesRuns(el, "hello", none)).toBe(false);
    expect(domMatchesRuns(el, "hello", styles({ italic: [0, 5] }))).toBe(false);
    // Same text, but split into two runs instead of one.
    expect(domMatchesRuns(el, "hello", styles({ bold: [0, 2] }))).toBe(false);
  });

  it("rejects a sentinel <br> mismatch in both directions", () => {
    // Built WITH a trailing newline, asked about text without one.
    expect(domMatchesRuns(built("line\n"), "line", none)).toBe(false);
    // Built WITHOUT, asked about text with one.
    expect(domMatchesRuns(built("line"), "line\n", none)).toBe(false);
    // Right shape, wrong marker: a browser-inserted <br> is not our sentinel.
    const el = built("line\n");
    (el.lastChild as HTMLElement).removeAttribute("data-pf-sentinel");
    expect(domMatchesRuns(el, "line\n", none)).toBe(false);
  });

  it("rejects browser-injected markup that textContent alone would accept", () => {
    // WebKit's own rich-text engine wrapping a run in <b> renders differently but
    // serializes identically — comparing textContent only would call this a match.
    const el = built("hello");
    const span = el.firstChild as HTMLElement;
    span.innerHTML = "<b>hello</b>";
    expect(span.textContent).toBe("hello");
    expect(domMatchesRuns(el, "hello", none)).toBe(false);
  });

  it("rejects a bare text node not wrapped in a span", () => {
    const el = document.createElement("div");
    el.appendChild(document.createTextNode("hello"));
    expect(domMatchesRuns(el, "hello", none)).toBe(false);
  });

  it("rejects extra trailing nodes", () => {
    const el = built("hello");
    el.appendChild(document.createElement("span"));
    expect(domMatchesRuns(el, "hello", none)).toBe(false);
  });

  it("rejects a span carrying extra attributes", () => {
    // A class/id the model never asked for means someone else owns this DOM.
    const el = built("hello");
    (el.firstChild as HTMLElement).className = "browser-artifact";
    expect(domMatchesRuns(el, "hello", none)).toBe(false);
  });

  it("accepts a run split across sibling text nodes", () => {
    // WebKit splits text nodes as it types; that renders identically, so forcing a
    // rebuild here would defeat the whole point of the check.
    const el = built("hello");
    const span = el.firstChild as HTMLElement;
    span.textContent = "";
    span.appendChild(document.createTextNode("hel"));
    span.appendChild(document.createTextNode("lo"));
    expect(domMatchesRuns(el, "hello", none)).toBe(true);
  });

  it("models the typing case the fix exists for", () => {
    // Editor shows "-", the user types ">": WebKit mutates its own text node and
    // dispatches `input`. The model now says "->" and the DOM already agrees, so
    // no rebuild — leaving WebKit's nodes live for its substitution pass.
    const el = built("-");
    (el.firstChild as HTMLElement).textContent = "->";
    expect(domMatchesRuns(el, "->", none)).toBe(true);
    expect(buildRunDom(el, "->", none)).toBe(false);
  });

  it("still rebuilds when typing lands inside a styled run", () => {
    // Bold [0,4] over "bold" — typing "x" at the end makes the model "boldx" with
    // only the first 4 chars bold, so the DOM (one all-bold span) must be rebuilt.
    const el = built("bold", styles({ bold: [0, 4] }));
    (el.firstChild as HTMLElement).textContent = "boldx";
    expect(domMatchesRuns(el, "boldx", styles({ bold: [0, 4] }))).toBe(false);
  });
});
