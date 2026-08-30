/** Styled-run utilities over a node's text: bold/italic/underline are three
 * independent flat [location, length, …] range arrays (the BoldRuns format,
 * generalized). The plain string stays the source of truth; these are decoration.
 * Shared by the static row renderer, the live contenteditable editor (both build
 * the SAME span structure so their metrics are identical), and the markdown copy.
 *
 * A promptDraft's text additionally gets LINE-level markdown decoration (see
 * `mdLines.ts`) — headings bigger, list items hanging under their own text. That is a
 * second, independent dimension over the same string: it never rewrites the model, and
 * with `md = false` every function here behaves exactly as it did before it existed. */

import { Theme } from "./layout";
import { isList, mdLines, type MdKind } from "./mdLines";

export interface StyleSet {
  bold: number[];
  italic: number[];
  underline: number[];
}

export interface RunSegment {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  /** Heading level 1–3 this run sits on, or 0. */
  heading: number;
  /** A markdown MARKER run — "# ", "- ", "1. " and any leading indent. */
  marker: boolean;
}

/** Every inline property the two renderers may write, resolved ONCE so the imperative
 * builder, the React renderer and the DOM comparison cannot drift apart by re-deriving
 * it three times.
 *
 * Every unset property is `undefined`, NEVER `""`. React renders `style={{}}` as
 * `style=""`, whose `getAttribute` is falsy while `attributes.length` is 1 — so
 * `domMatchesRuns` would return false forever, the editor would rebuild on every
 * keystroke, and macOS text substitution would die with no visible symptom. */
export interface Decl {
  fontSize?: string;
  fontWeight?: string;
  fontStyle?: string;
  textDecoration?: string;
  color?: string;
}

/** Heading sizes, indexed by level. `em`, so they ride ⌘+/⌘− with everything else, and
 * `--row-line-height` is a UNITLESS number so each one gets a proportionally taller line
 * box for free (measured in WebKit: a 1.5em span's line box is 32.4px against 21.6px). */
const HEADING_SIZE = ["", "1.5em", "1.25em", "1.125em"];
/** 600, not 700. Plain 400 → heading 600 → bold 700 stays a strictly increasing ladder,
 * so ⌘B inside a heading is still visibly heavier, and a highlighted row's own 600
 * wrapper weight is not outranked. */
const HEADING_WEIGHT = "600";

export function declFor(seg: RunSegment): Decl | undefined {
  const d: Decl = {};
  let any = false;
  if (seg.heading > 0) {
    d.fontSize = HEADING_SIZE[seg.heading];
    any = true;
  }
  // 700, not 600: a highlighted row sets 600 on the WRAPPER, and bold must stay visibly
  // heavier inside one — which is also why a heading is 600 and not 700.
  const weight = seg.bold ? "700" : seg.heading > 0 ? HEADING_WEIGHT : undefined;
  if (weight) {
    d.fontWeight = weight;
    any = true;
  }
  if (seg.italic) {
    d.fontStyle = "italic";
    any = true;
  }
  if (seg.underline) {
    d.textDecoration = "underline";
    any = true;
  }
  if (seg.marker) {
    d.color = Theme.mdMarkerColor;
    any = true;
  }
  return any ? d : undefined;
}

/** The engine's own serialization of a CSS value, so `domMatchesRuns` compares what the
 * DOM will actually read back rather than what we asked for. Colors are the reason:
 * setting "#06FF9A" reads back as "rgb(6, 255, 154)". Memoized — the set is tiny. */
const canonCache = new Map<string, string>();
function canon(prop: keyof Decl, value: string): string {
  const key = `${prop}:${value}`;
  let hit = canonCache.get(key);
  if (hit === undefined) {
    const probe = document.createElement("span");
    probe.style[prop] = value;
    hit = probe.style[prop] as string;
    canonCache.set(key, hit);
  }
  return hit;
}

const DECL_PROPS: (keyof Decl)[] = [
  "fontSize",
  "fontWeight",
  "fontStyle",
  "textDecoration",
  "color",
];

function markRange(marks: Uint8Array, ranges: number[], bit: number) {
  const len = marks.length;
  for (let i = 0; i + 1 < ranges.length; i += 2) {
    const lo = Math.max(0, Math.min(ranges[i], len));
    const hi = Math.max(lo, Math.min(ranges[i] + ranges[i + 1], len));
    for (let j = lo; j < hi; j++) marks[j] |= bit;
  }
}

function styleMarks(text: string, styles: StyleSet): Uint8Array {
  const marks = new Uint8Array(text.length);
  markRange(marks, styles.bold, 1);
  markRange(marks, styles.italic, 2);
  markRange(marks, styles.underline, 4);
  return marks;
}

/** Maximal uniform-style segments of `text[lo, hi)`, all carrying the same markdown
 * decoration. Returns [] for an empty range. */
function segsIn(
  text: string,
  marks: Uint8Array,
  lo: number,
  hi: number,
  heading: number,
  marker: boolean,
): RunSegment[] {
  const out: RunSegment[] = [];
  if (hi <= lo) return out;
  let start = lo;
  for (let i = lo + 1; i <= hi; i++) {
    if (i === hi || marks[i] !== marks[start]) {
      const m = marks[start];
      out.push({
        text: text.slice(start, i),
        bold: (m & 1) !== 0,
        italic: (m & 2) !== 0,
        underline: (m & 4) !== 0,
        heading,
        marker,
      });
      start = i;
    }
  }
  return out;
}

/** Split `text` into maximal segments of uniform style. */
export function segments(text: string, styles: StyleSet): RunSegment[] {
  if (text.length === 0) return [];
  return segsIn(text, styleMarks(text, styles), 0, text.length, 0, false);
}

/** One rendered line of a markdown prompt: its runs in document order, marker included,
 * in ONE block.
 *
 * Deliberately one block and not two. A list item's hanging indent was first built as a
 * two-column grid (marker | body), which is exact and needs no measurement — but a grid
 * item is its own block box, so the marker/body boundary became a SECOND caret position
 * at a single model offset, and one ArrowRight was silently swallowed at every marker
 * (measured against a non-markdown prompt: 4 of 12 offsets diverged). Two adjacent INLINE
 * spans in one block share one caret position, so the hang is done with `padding-left` +
 * a negative `text-indent` of the marker's measured width instead. */
export interface MdLineView {
  kind: MdKind;
  segs: RunSegment[];
  /** The marker's rendered width in px — the hang — or 0 for a non-list line. */
  hang: number;
}

/** Width of a marker as the row renders it, cached per (font size, marker). Measured in
 * a hidden `.node-row` so it inherits the same family, weight and letter-spacing the
 * real row does; only the leading indent and the marker itself are ever measured, both
 * short and few, so the cache is tiny. Returns 0 where there is no layout (happy-dom),
 * which keeps the two renderers agreeing there rather than disagreeing. */
const hangCache = new Map<string, number>();
let hangHost: HTMLElement | null = null;
export function markerHang(fontSize: number, marker: string): number {
  if (marker === "") return 0;
  const key = `${fontSize}|${marker}`;
  const hit = hangCache.get(key);
  if (hit !== undefined) return hit;
  if (!hangHost) {
    hangHost = document.createElement("div");
    // Deliberately NOT `class="node-row"`, however convenient the cascade would be: this
    // box lives on <body>, and anything doing `querySelectorAll(".node-row")` — qa.mjs
    // does, to read the outline — would find a phantom row. The family, weight and
    // letter-spacing it needs are inherited from the document anyway; only the size
    // varies per row, and that is set below.
    hangHost.style.cssText =
      "position:absolute;visibility:hidden;top:-9999px;left:0;white-space:pre";
    hangHost.appendChild(document.createElement("span"));
    document.body.appendChild(hangHost);
  }
  hangHost.style.fontSize = `${fontSize}px`;
  const span = hangHost.firstElementChild as HTMLElement;
  span.textContent = marker;
  const w = Math.round(span.getBoundingClientRect().width * 100) / 100;
  hangCache.set(key, w);
  return w;
}

export function mdLineViews(
  text: string,
  styles: StyleSet,
  fontSize: number,
): MdLineView[] {
  const marks = styleMarks(text, styles);
  return mdLines(text).map((line) => {
    const level = line.kind === "h1" ? 1 : line.kind === "h2" ? 2 : line.kind === "h3" ? 3 : 0;
    const markerSegs = segsIn(text, marks, line.start, line.markerEnd, level, true);
    // The line's terminating "\n" rides along with its body. It renders nothing (WebKit
    // gives a trailing newline no line box of its own — measured), and keeping it inside
    // the line's own box is what lets each block be exactly one line tall.
    const bodyEnd = line.end + (line.hasNewline ? 1 : 0);
    const bodySegs = segsIn(text, marks, line.markerEnd, bodyEnd, level, false);
    return {
      kind: line.kind,
      segs: markerSegs.concat(bodySegs),
      hang: isList(line.kind)
        ? markerHang(fontSize, text.slice(line.start, line.markerEnd))
        : 0,
    };
  });
}

export function lineClass(kind: MdKind): string {
  return isList(kind) ? "md-line md-li" : "md-line";
}

// MARK: DOM comparison + imperative build

function matchRunSpan(node: ChildNode, seg: RunSegment): boolean {
  if (!(node instanceof HTMLElement) || node.tagName !== "SPAN") return false;
  // Each span must hold text nodes ONLY: `textContent` alone would equate a
  // browser-injected <b> wrapper with a plain run.
  for (const child of node.childNodes) {
    if (child.nodeType !== Node.TEXT_NODE) return false;
  }
  if (node.textContent !== seg.text) return false;
  const d = declFor(seg) ?? {};
  for (const prop of DECL_PROPS) {
    const want = d[prop];
    if (node.style[prop] !== (want === undefined ? "" : canon(prop, want))) return false;
  }
  return node.attributes.length === (node.getAttribute("style") ? 1 : 0);
}

function matchSegs(
  kids: NodeListOf<ChildNode>,
  segs: RunSegment[],
  sentinel: boolean,
): boolean {
  if (kids.length !== segs.length + (sentinel ? 1 : 0)) return false;
  for (let i = 0; i < segs.length; i++) {
    if (!matchRunSpan(kids[i], segs[i])) return false;
  }
  if (sentinel) {
    const last = kids[kids.length - 1];
    if (!(last instanceof HTMLElement) || last.tagName !== "BR") return false;
    if (last.dataset.pfSentinel !== "1") return false;
  }
  return true;
}

function matchLine(node: ChildNode, view: MdLineView): HTMLElement | null {
  if (!(node instanceof HTMLElement) || node.tagName !== "SPAN") return null;
  if (node.className !== lineClass(view.kind)) return null;
  // A line wrapper carries its class and, for a list item, nothing but `--md-hang`.
  const wantHang = view.hang > 0 ? `${view.hang}px` : "";
  if (node.style.getPropertyValue("--md-hang") !== wantHang) return null;
  if (node.attributes.length !== (wantHang ? 2 : 1)) return null;
  return node;
}

/** True when `parent`'s children ALREADY are exactly what `buildRunDom` would
 * build — so rebuilding would be a no-op replacement of identical DOM.
 *
 * This exists for macOS TEXT SUBSTITUTION (System Settings ▸ Keyboard ▸ Text
 * Replacements, smart quotes/dashes). On Cocoa, `TypingCommand` dispatches the
 * `input` event SYNCHRONOUSLY and runs `markMisspellingsAfterTyping` AFTER it, so
 * our input handler lands in between: a `replaceChildren` there destroys every
 * text node, and WebKit's substitution pass then resolves its stored Positions
 * against a detached subtree and silently does nothing. Typing "->" never became
 * "→" (shipped bug, fixed). For ordinary typing the browser's own insertion has
 * already produced the exact DOM the model implies, so skipping the rebuild keeps
 * WebKit's nodes, selection and markers alive across the dispatch.
 *
 * Deliberately STRICT — a false positive would strand the editor on stray browser
 * DOM, which is the very thing the controlled-editor invariant exists to prevent.
 * A RUN span may carry nothing but `style`; a markdown WRAPPER span may carry
 * nothing but its exact `class`. */
export function domMatchesRuns(
  parent: HTMLElement,
  text: string,
  styles: StyleSet,
  md = false,
  fontSize = 16,
): boolean {
  const wantSentinel = text.endsWith("\n");
  if (!md) {
    return matchSegs(parent.childNodes, segments(text, styles), wantSentinel);
  }
  const views = mdLineViews(text, styles, fontSize);
  if (parent.childNodes.length !== views.length) return false;
  for (let i = 0; i < views.length; i++) {
    const view = views[i];
    const line = matchLine(parent.childNodes[i], view);
    if (!line) return false;
    // The sentinel lives in the LAST line, which a trailing "\n" makes empty.
    const sentinel = wantSentinel && i === views.length - 1;
    if (!matchSegs(line.childNodes, view.segs, sentinel)) return false;
  }
  return true;
}

function appendSegs(parent: Node, segs: RunSegment[]) {
  for (const seg of segs) {
    const span = document.createElement("span");
    const d = declFor(seg);
    if (d) {
      for (const prop of DECL_PROPS) {
        const v = d[prop];
        if (v !== undefined) span.style[prop] = v;
      }
    }
    span.textContent = seg.text;
    parent.appendChild(span);
  }
}

function sentinelBr(): HTMLBRElement {
  const br = document.createElement("br");
  br.dataset.pfSentinel = "1";
  return br;
}

/** Build the run spans into `parent` (imperative — the live editor's DOM). The
 * structure matches the React StaticText exactly: one <span> per segment, wrapped in
 * one `.md-line` block per line when `md`. A text ending in "\n" gets a sentinel <br>
 * (zero-width in the serialization — see caret.ts) so the trailing line renders a line
 * box the caret can sit on.
 *
 * Returns whether it actually rebuilt: an already-matching DOM is left ALONE so
 * WebKit's pending text-substitution pass still sees live nodes (see
 * `domMatchesRuns`). The caller uses this to skip a redundant caret restore. */
export function buildRunDom(
  parent: HTMLElement,
  text: string,
  styles: StyleSet,
  md = false,
  fontSize = 16,
): boolean {
  if (domMatchesRuns(parent, text, styles, md, fontSize)) return false;
  const frag = document.createDocumentFragment();
  if (!md) {
    appendSegs(frag, segments(text, styles));
    if (text.endsWith("\n")) frag.appendChild(sentinelBr());
  } else {
    const views = mdLineViews(text, styles, fontSize);
    views.forEach((view, i) => {
      const line = document.createElement("span");
      line.className = lineClass(view.kind);
      if (view.hang > 0) line.style.setProperty("--md-hang", `${view.hang}px`);
      appendSegs(line, view.segs);
      if (text.endsWith("\n") && i === views.length - 1) line.appendChild(sentinelBr());
      frag.appendChild(line);
    });
  }
  parent.replaceChildren(frag);
  return true;
}

/** Markdown for a styled text: **bold**, *italic*, <u>underline</u> (markdown has
 * no underline syntax; inline HTML is valid markdown). Emphasis can't span line
 * breaks, so styled segments wrap per line. */
export function toMarkdown(text: string, styles: StyleSet): string {
  let out = "";
  for (const seg of segments(text, styles)) {
    const lines = seg.text.split("\n");
    out += lines
      .map((line) => {
        if (line === "") return "";
        let s = line;
        if (seg.italic) s = `*${s}*`;
        if (seg.bold) s = `**${s}**`;
        if (seg.underline) s = `<u>${s}</u>`;
        return s;
      })
      .join("\n");
  }
  return out;
}
