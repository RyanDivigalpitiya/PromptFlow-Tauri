/** Styled-run utilities over a node's text: bold/italic/underline are three
 * independent flat [location, length, …] range arrays (the BoldRuns format,
 * generalized). The plain string stays the source of truth; these are decoration.
 * Shared by the static row renderer, the live contenteditable editor (both build
 * the SAME span structure so their metrics are identical), and the markdown copy. */

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
}

function markRange(marks: Uint8Array, ranges: number[], bit: number) {
  const len = marks.length;
  for (let i = 0; i + 1 < ranges.length; i += 2) {
    const lo = Math.max(0, Math.min(ranges[i], len));
    const hi = Math.max(lo, Math.min(ranges[i] + ranges[i + 1], len));
    for (let j = lo; j < hi; j++) marks[j] |= bit;
  }
}

/** Split `text` into maximal segments of uniform style. */
export function segments(text: string, styles: StyleSet): RunSegment[] {
  if (text.length === 0) return [];
  const marks = new Uint8Array(text.length);
  markRange(marks, styles.bold, 1);
  markRange(marks, styles.italic, 2);
  markRange(marks, styles.underline, 4);
  const out: RunSegment[] = [];
  let start = 0;
  for (let i = 1; i <= text.length; i++) {
    if (i === text.length || marks[i] !== marks[start]) {
      const m = marks[start];
      out.push({
        text: text.slice(start, i),
        bold: (m & 1) !== 0,
        italic: (m & 2) !== 0,
        underline: (m & 4) !== 0,
      });
      start = i;
    }
  }
  return out;
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
 * Each span must hold text nodes ONLY: `textContent` alone would equate a
 * browser-injected <b> wrapper with a plain run. */
export function domMatchesRuns(
  parent: HTMLElement,
  text: string,
  styles: StyleSet,
): boolean {
  const segs = segments(text, styles);
  const wantSentinel = text.endsWith("\n");
  const kids = parent.childNodes;
  if (kids.length !== segs.length + (wantSentinel ? 1 : 0)) return false;

  for (let i = 0; i < segs.length; i++) {
    const node = kids[i];
    if (!(node instanceof HTMLElement) || node.tagName !== "SPAN") return false;
    for (const child of node.childNodes) {
      if (child.nodeType !== Node.TEXT_NODE) return false;
    }
    const seg = segs[i];
    if (node.textContent !== seg.text) return false;
    if (node.style.fontWeight !== (seg.bold ? "700" : "")) return false;
    if (node.style.fontStyle !== (seg.italic ? "italic" : "")) return false;
    if (node.style.textDecoration !== (seg.underline ? "underline" : "")) return false;
    if (node.attributes.length !== (node.getAttribute("style") ? 1 : 0)) return false;
  }

  if (wantSentinel) {
    const last = kids[kids.length - 1];
    if (!(last instanceof HTMLElement) || last.tagName !== "BR") return false;
    if (last.dataset.pfSentinel !== "1") return false;
  }
  return true;
}

/** Build the run spans into `parent` (imperative — the live editor's DOM). The
 * structure matches the React StaticText exactly: one <span> per segment. A text
 * ending in "\n" gets a sentinel <br> (zero-width in the serialization — see
 * caret.ts) so the trailing line renders a line box the caret can sit on.
 *
 * Returns whether it actually rebuilt: an already-matching DOM is left ALONE so
 * WebKit's pending text-substitution pass still sees live nodes (see
 * `domMatchesRuns`). The caller uses this to skip a redundant caret restore. */
export function buildRunDom(
  parent: HTMLElement,
  text: string,
  styles: StyleSet,
): boolean {
  if (domMatchesRuns(parent, text, styles)) return false;
  const frag = document.createDocumentFragment();
  for (const seg of segments(text, styles)) {
    const span = document.createElement("span");
    if (seg.bold) span.style.fontWeight = "700";
    if (seg.italic) span.style.fontStyle = "italic";
    if (seg.underline) span.style.textDecoration = "underline";
    span.textContent = seg.text;
    frag.appendChild(span);
  }
  if (text.endsWith("\n")) {
    const br = document.createElement("br");
    br.dataset.pfSentinel = "1";
    frag.appendChild(br);
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
