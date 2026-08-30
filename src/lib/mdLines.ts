/** Line-level markdown classification for a prompt draft's text — pure, DOM-free.
 *
 * This is DISPLAY only. The plain string stays the source of truth: the `#` and `- `
 * characters are real text that stays on screen, keeps its offsets, and copies out
 * verbatim. Nothing here ever rewrites the model.
 *
 * The negative cases matter as much as the positive ones. ⌘3 folding a selection writes
 * an indented "- " list into a prompt (`Store::merge_into_prompt`), and a node's own
 * multi-line text becomes CONTINUATION lines carrying two spaces and NO marker — those
 * must classify plain, or the fold's carefully measured geometry moves. */

export type MdKind = "plain" | "h1" | "h2" | "h3" | "bullet" | "ordered";

export interface MdLine {
  /** Offset of the line's first character in the whole text. */
  start: number;
  /** Offset just past its last character, EXCLUDING the terminating "\n". */
  end: number;
  /** Whether a "\n" follows at `end` (every line but the last one has one). */
  hasNewline: boolean;
  kind: MdKind;
  /** Offset where the marker ends — leading indent included. Equals `start` when there
   * is no marker, so `[start, markerEnd)` is always the marker and `[markerEnd, end)`
   * always the body. */
  markerEnd: number;
}

/** A heading is anchored at COLUMN 0 with no leading whitespace: an indented "#" is a
 * line of a folded list, not a title. The space is required (`#Title` is not a heading in
 * any markdown dialect), and so is a non-space after it, so a bare "# " being typed is
 * still plain until it has something to title. */
const HEADING = /^(#{1,3}) +(?=\S)/;
/** A bullet may be indented — two spaces per level is what the fold writes. An empty body
 * is allowed (`- ` at the end of a line) so a list item reads as one the moment it opens. */
const BULLET = /^([ \t]*)([-*+])( +)(?=\S|$)/;
/** Capped at three digits so prose that opens with a year ("2024. That was the year")
 * stays prose. Both "1." and "1)" are markdown. */
const ORDERED = /^([ \t]*)(\d{1,3})([.)])( +)(?=\S|$)/;

/** Classify one line's text. Returns the kind and the marker's LENGTH in that line. */
export function classifyLine(line: string): { kind: MdKind; markerLen: number } {
  const h = HEADING.exec(line);
  if (h) return { kind: (`h${h[1].length}` as MdKind), markerLen: h[0].length };
  const b = BULLET.exec(line);
  if (b) return { kind: "bullet", markerLen: b[0].length };
  const o = ORDERED.exec(line);
  if (o) return { kind: "ordered", markerLen: o[0].length };
  return { kind: "plain", markerLen: 0 };
}

/** Split `text` into classified lines. Always returns at least one line, and a text
 * ending in "\n" yields a final EMPTY line — the one the trailing-line sentinel exists
 * to give a line box to. */
export function mdLines(text: string): MdLine[] {
  const out: MdLine[] = [];
  let start = 0;
  for (;;) {
    const nl = text.indexOf("\n", start);
    const end = nl === -1 ? text.length : nl;
    const { kind, markerLen } = classifyLine(text.slice(start, end));
    out.push({ start, end, hasNewline: nl !== -1, kind, markerEnd: start + markerLen });
    if (nl === -1) break;
    start = nl + 1;
  }
  return out;
}

/** A list line hangs its wrapped continuation under its text; a heading does not. */
export function isList(kind: MdKind): boolean {
  return kind === "bullet" || kind === "ordered";
}

/** 1–3 for a heading, 0 otherwise. */
export function headingLevel(kind: MdKind): number {
  return kind === "h1" ? 1 : kind === "h2" ? 2 : kind === "h3" ? 3 : 0;
}

/** One level of list nesting, in the units the text itself carries — what one Tab adds
 * and one ⇧Tab takes away.
 *
 * NOTE this is deliberately WIDER than the two spaces `Store::merge_into_prompt` writes
 * per depth when ⌘3 folds a block into a prompt, so a folded list nests in smaller steps
 * than a hand-tabbed one. Nothing computes a level from the width — the renderer just
 * paints the leading whitespace the text carries — so the two mix without breaking, they
 * simply step by different amounts. Change the Rust `INDENT` too if they should match;
 * that is a stored-text change pinned by `merge_into_prompt_nests_descendants_by_depth`
 * and by qa.mjs's `FOLDED`, so both suites move in the same commit. */
export const LIST_INDENT = "    ";

/** One level of leading whitespace to REMOVE: a tab, or up to a full level of spaces, so
 * a line indented by hand — or by the fold's narrower step — still un-indents cleanly. */
const OUTDENT_RE = new RegExp(`^(\\t| {1,${LIST_INDENT.length}})`);

/** Tab / ⇧Tab over the LINES `[start, end]` touches: add or remove one level of leading
 * indent on each. Returns the new text and the adjusted selection, or null when nothing
 * would change (⇧Tab where no touched line has any indent left to give).
 *
 * An EMPTY line is skipped rather than indented — indenting nothing leaves trailing
 * whitespace on a blank line, the same reason `merge_into_prompt` gives a blank
 * continuation line no prefix. Outdent takes a tab, or up to `LIST_INDENT.length`
 * spaces, so a line indented by hand with a single space still un-indents cleanly. */
export function indentLines(
  text: string,
  start: number,
  end: number,
  indent: boolean,
): { text: string; start: number; end: number } | null {
  const touched = mdLines(text).filter((l) => l.start <= end && l.end >= start);
  if (touched.length === 0) return null;

  let out = "";
  let cursor = 0;
  let dStart = 0;
  let dEnd = 0;
  for (const line of touched) {
    const body = text.slice(line.start, line.end);
    if (indent) {
      // An EMPTY line is skipped: indenting nothing leaves trailing whitespace on a
      // blank line, the same reason `merge_into_prompt` gives a blank continuation line
      // no prefix.
      if (body === "") continue;
      out += text.slice(cursor, line.start) + LIST_INDENT;
      cursor = line.start;
      if (start >= line.start) dStart += LIST_INDENT.length;
      if (end >= line.start) dEnd += LIST_INDENT.length;
    } else {
      const lead = OUTDENT_RE.exec(body);
      if (!lead) continue;
      const n = lead[0].length;
      out += text.slice(cursor, line.start);
      cursor = line.start + n;
      // A caret INSIDE the whitespace being removed collapses to the line's new start
      // rather than running off the front of it.
      if (start >= line.start) dStart -= Math.min(start - line.start, n);
      if (end >= line.start) dEnd -= Math.min(end - line.start, n);
    }
  }
  if (cursor === 0 && out === "") return null;
  out += text.slice(cursor);
  if (out === text) return null;
  return { text: out, start: start + dStart, end: end + dEnd };
}

/** The bullet Enter should carry onto the next line, or null when it should just break.
 *
 * BULLETS ONLY — an ordered line is deliberately left alone: continuing "1." would mean
 * deciding what the next number is and renumbering everything below it when a line is
 * inserted or removed, and a list that renumbers itself is a different feature from a
 * list that indents.
 *
 * Null unless the caret is COLLAPSED and sits at or past the marker. A caret inside the
 * marker ("-|" before its space) is being edited, not extended, and splitting there
 * would interleave two half-markers. */
export interface BulletAtCaret {
  /** The leading indent and marker to repeat verbatim, e.g. `"  - "`. */
  marker: string;
  lineStart: number;
  markerEnd: number;
  /** The line carries a marker and nothing after it — Enter ENDS the list here. */
  bodyEmpty: boolean;
}

export function bulletAtCaret(
  text: string,
  start: number,
  end: number,
): BulletAtCaret | null {
  if (start !== end) return null;
  const line = mdLines(text).find(
    (l) => start >= l.start && start <= l.end,
  );
  if (!line || line.kind !== "bullet" || start < line.markerEnd) return null;
  return {
    marker: text.slice(line.start, line.markerEnd),
    lineStart: line.start,
    markerEnd: line.markerEnd,
    bodyEmpty: line.markerEnd === line.end,
  };
}

/** Whether `text` has any markdown at all. When it doesn't, the renderers stay on the
 * FLAT one-span-per-run path they have always used — so an ordinary prose prompt keeps
 * exactly today's DOM, and the macOS text-substitution fast path is provably untouched
 * for it. */
export function hasMarkdown(text: string): boolean {
  return mdLines(text).some((l) => l.kind !== "plain");
}
