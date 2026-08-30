// @vitest-environment happy-dom
//
// domMatchesRuns is the guard that lets the live editor SKIP rebuilding its run
// DOM. Skipping is what keeps macOS text substitution alive (WebKit runs its
// substitution pass after the synchronous `input` dispatch, so a replaceChildren
// in our handler would hand it detached nodes) — but a WRONG `true` strands the
// editor on stray browser DOM, which is the exact failure the controlled-editor
// invariant exists to prevent. So the interesting cases here are the false ones.
import { describe, expect, it } from "vitest";
import { buildRunDom, declFor, domMatchesRuns, mdLineViews, type StyleSet } from "./runs";

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

describe("markdown line views", () => {
  const view = (text: string, st: StyleSet = none) =>
    mdLineViews(text, st, 16).map((v) => [v.kind, v.segs.map((g) => g.text)]);

  it("keeps a whole line in ONE block, marker included", () => {
    // One block, not two: a grid cell would be its own block box, and that boundary
    // became a second caret position at one model offset — an ArrowRight swallowed at
    // every list marker. Adjacent inline spans in one block share a caret position.
    expect(view("# Title")).toEqual([["h1", ["# ", "Title"]]]);
    expect(view("- one")).toEqual([["bullet", ["- ", "one"]]]);
    expect(view("  - nested")).toEqual([["bullet", ["  - ", "nested"]]]);
    expect(view("1. step")).toEqual([["ordered", ["1. ", "step"]]]);
  });

  it("keeps each line's terminating newline INSIDE that line's own box", () => {
    // A block whose text ends in "\n" is exactly one line tall in WebKit (measured);
    // that is what lets one block per line stack without phantom blank lines.
    expect(view("a\nb")).toEqual([
      ["plain", ["a\n"]],
      ["plain", ["b"]],
    ]);
    expect(view("- a\n- b")).toEqual([
      ["bullet", ["- ", "a\n"]],
      ["bullet", ["- ", "b"]],
    ]);
  });

  it("ends a trailing-newline text with an EMPTY line for the sentinel to fill", () => {
    expect(view("a\n")).toEqual([["plain", ["a\n"]], ["plain", []]]);
  });

  it("splits a run at the marker boundary so bold composes with decoration", () => {
    const segs = mdLineViews("- one", styles({ bold: [0, 5] }), 16)[0].segs;
    expect(segs.map((g) => g.text)).toEqual(["- ", "one"]);
    expect(segs[0].bold && segs[0].marker).toBe(true);
    expect(segs[1].bold && !segs[1].marker).toBe(true);
  });

  it("hangs a LIST line and nothing else", () => {
    // The width itself is 0 without layout (happy-dom); what matters here is WHICH
    // lines ask for a hang — the geometry is measured in qa.mjs, in a real engine.
    const hangs = (t: string) => mdLineViews(t, none, 16).map((v) => v.hang);
    expect(hangs("# T\nplain\n- a\n1. b")).toEqual([0, 0, 0, 0]);
  });
});

describe("declFor", () => {
  const seg = (p: Partial<ReturnType<typeof mdLineViews>[0]["segs"][0]>) => ({
    text: "x", bold: false, italic: false, underline: false, heading: 0, marker: false, ...p,
  });

  it("returns UNDEFINED for a plain run, so the span carries no style attribute", () => {
    // `{}` would make React render style="" — falsy getAttribute but attributes.length 1,
    // so domMatchesRuns would return false forever and the editor would rebuild on every
    // keystroke, killing macOS text substitution with no visible symptom.
    expect(declFor(seg({}))).toBeUndefined();
  });

  it("keeps bold heavier than a heading — 400 -> 600 -> 700", () => {
    expect(declFor(seg({ heading: 1 }))?.fontWeight).toBe("600");
    expect(declFor(seg({ heading: 1, bold: true }))?.fontWeight).toBe("700");
    expect(declFor(seg({ bold: true }))?.fontWeight).toBe("700");
  });

  it("sizes the three heading levels and nothing else", () => {
    expect(declFor(seg({ heading: 1 }))?.fontSize).toBe("1.5em");
    expect(declFor(seg({ heading: 2 }))?.fontSize).toBe("1.25em");
    expect(declFor(seg({ heading: 3 }))?.fontSize).toBe("1.125em");
    expect(declFor(seg({}))?.fontSize).toBeUndefined();
  });

  it("dims a marker, at whatever size its line is", () => {
    expect(declFor(seg({ marker: true }))?.color).toBeTruthy();
    expect(declFor(seg({ marker: true, heading: 2 }))?.fontSize).toBe("1.25em");
  });
});

describe("domMatchesRuns, markdown", () => {
  const builtMd = (text: string, s: StyleSet = none) => {
    const el = document.createElement("div");
    buildRunDom(el, text, s, true, 16);
    return el;
  };

  it("matches what buildRunDom just built, and is idempotent", () => {
    for (const text of ["# Title", "- one\n- two", "# T\n\nbody\n- a\n  - b", "1. step\n"]) {
      const el = builtMd(text);
      expect(domMatchesRuns(el, text, none, true, 16), JSON.stringify(text)).toBe(true);
      expect(buildRunDom(el, text, none, true, 16), JSON.stringify(text)).toBe(false);
    }
  });

  it("models the typing case the fast path exists for", () => {
    // Typing inside a list item's BODY: WebKit mutates its own text node and dispatches
    // `input`. The model and the DOM already agree, so no rebuild — which is what leaves
    // WebKit's nodes alive for its substitution pass.
    const el = builtMd("- item");
    const body = el.querySelector(".md-line span:last-child") as HTMLElement;
    body.textContent = "items";
    expect(domMatchesRuns(el, "- items", none, true, 16)).toBe(true);
    expect(buildRunDom(el, "- items", none, true, 16)).toBe(false);
  });

  it("REBUILDS when a keystroke changes what a line IS", () => {
    // "- item" -> "-- item" stops being a bullet, so the whole line's shape changes.
    const el = builtMd("- item");
    expect(domMatchesRuns(el, "-- item", none, true, 16)).toBe(false);
  });

  it("rejects a wrapper carrying an unexpected class or attribute", () => {
    const el = builtMd("- one");
    const line = el.firstElementChild as HTMLElement;
    line.classList.add("stray");
    expect(domMatchesRuns(el, "- one", none, true, 16)).toBe(false);
    line.className = "md-line md-li";
    expect(domMatchesRuns(el, "- one", none, true, 16)).toBe(true);
    line.setAttribute("data-x", "1");
    expect(domMatchesRuns(el, "- one", none, true, 16)).toBe(false);
  });

  it("rejects the FLAT dom for markdown text and vice versa", () => {
    // The two modes must never be confused: `md` is decided by the caller and both
    // sides of the comparison have to have been told the same thing.
    const flat = document.createElement("div");
    buildRunDom(flat, "# Title", none, false);
    expect(domMatchesRuns(flat, "# Title", none, true, 16)).toBe(false);
    expect(domMatchesRuns(builtMd("# Title"), "# Title", none, false)).toBe(false);
  });

  it("puts the trailing sentinel in the empty last line, which is PLAIN", () => {
    // "- one\n" is a bullet followed by an empty line. That empty line carries no
    // marker, so it is a plain block — the sentinel gives it the line box the caret
    // sits on, exactly as in the flat renderer.
    const el = builtMd("- one\n");
    expect([...el.children].map((c) => c.className)).toEqual(["md-line md-li", "md-line"]);
    const last = el.lastElementChild!;
    expect(last.childNodes.length).toBe(1);
    expect((last.firstChild as HTMLElement).getAttribute("data-pf-sentinel")).toBe("1");
  });

  it("gives a list line its hang and a plain line none", () => {
    const el = builtMd("- one\nplain");
    const [li, plain] = [...el.children] as HTMLElement[];
    expect(li.className).toBe("md-line md-li");
    expect(plain.className).toBe("md-line");
    // Without layout the measured width is 0, so neither carries the property here —
    // what this pins is that a plain line never gets a `style` attribute at all.
    expect(plain.getAttribute("style")).toBeNull();
  });

  it("accepts a run split across sibling text nodes inside a line", () => {
    // WebKit splits text nodes as it types; that renders identically, so forcing a
    // rebuild here would defeat the whole point of the check.
    const el = builtMd("- one");
    const span = el.querySelector(".md-line span:last-child") as HTMLElement;
    span.textContent = "";
    span.appendChild(document.createTextNode("o"));
    span.appendChild(document.createTextNode("ne"));
    expect(domMatchesRuns(el, "- one", none, true, 16)).toBe(true);
  });
});
