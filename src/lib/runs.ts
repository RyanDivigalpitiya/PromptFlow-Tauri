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

/** Build the run spans into `parent` (imperative — the live editor's DOM). The
 * structure matches the React StaticText exactly: one <span> per segment. A text
 * ending in "\n" gets a sentinel <br> (zero-width in the serialization — see
 * caret.ts) so the trailing line renders a line box the caret can sit on. */
export function buildRunDom(parent: HTMLElement, text: string, styles: StyleSet) {
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
