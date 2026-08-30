/** What a delete keystroke removes, computed over the MODEL string.
 *
 * A markdown prompt renders every line as its own block box, which WebKit treats as a
 * PARAGRAPH — so any delete that reaches across a line boundary runs its paragraph-merge
 * logic instead of removing characters, and that logic does not agree with a flat string
 * plus literal newlines. Measured divergences against an identical non-markdown prompt:
 * ^H at a blank-line start lost a newline, ⌥⌫ ate a whole extra line, ⌘⌫ lost one, ^D
 * committed a phantom trailing newline.
 *
 * So a delete that CROSSES a newline is computed here and spliced into the model instead.
 * One that does not cross stays native, which is where grapheme clusters (a single
 * Backspace removes a whole emoji), the revert-a-substitution behaviour, and macOS text
 * substitution itself all live — none of which this file tries to reproduce. */

export type DeleteKind =
  | "charBack"
  | "charForward"
  | "wordBack"
  | "wordForward"
  | "lineBack"
  | "lineForward";

export interface DeleteKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** The delete this keystroke performs, or null if it is not a delete.
 *
 * The ctrl aliases are macOS's own standard key bindings — ^H issues the SAME
 * `deleteBackward:` command Backspace does and ^D the same `deleteForward:` as Delete —
 * so they reach exactly the same paragraph merge and must take the same path. */
export function deleteKind(e: DeleteKeyEvent): DeleteKind | null {
  const back = e.key === "Backspace";
  const fwd = e.key === "Delete";
  if (e.ctrlKey && !e.metaKey && !e.altKey) {
    if (e.key === "h" || e.key === "H") return "charBack";
    if (e.key === "d" || e.key === "D") return "charForward";
    return null;
  }
  if (e.ctrlKey || (!back && !fwd)) return null;
  if (e.metaKey) return back ? "lineBack" : "lineForward";
  if (e.altKey) return back ? "wordBack" : "wordForward";
  return back ? "charBack" : "charForward";
}

/** A WORD character for delete-by-word. macOS's `deleteWordBackward:` steps back over
 * any run of non-word characters — whitespace, newlines AND punctuation — before taking
 * the word itself, which is why "- " at a line start is skipped rather than treated as a
 * word of its own. Measured: with the caret just after a bullet's dash, native ⌥⌫ removes
 * the dash, the newline above it and the word above that. */
const isWord = (c: string) => /[\p{L}\p{N}_]/u.test(c);

/** The [from, to) the keystroke removes. A non-collapsed selection is always just
 * itself — every delete key removes the selection and nothing more. */
export function deleteRange(
  kind: DeleteKind,
  text: string,
  start: number,
  end: number,
): { from: number; to: number } {
  if (start !== end) return { from: start, to: end };
  switch (kind) {
    case "charBack":
      return { from: Math.max(0, start - 1), to: start };
    case "charForward":
      return { from: start, to: Math.min(text.length, start + 1) };
    case "wordBack": {
      let i = start;
      while (i > 0 && !isWord(text[i - 1])) i--;
      while (i > 0 && isWord(text[i - 1])) i--;
      return { from: i, to: start };
    }
    case "wordForward": {
      let i = start;
      const n = text.length;
      while (i < n && !isWord(text[i])) i++;
      while (i < n && isWord(text[i])) i++;
      return { from: start, to: i };
    }
    case "lineBack": {
      // To the start of this line — and when the caret is ALREADY there, one character
      // back, which is the newline. That degenerate step is what WebKit does too, and
      // without it ⌘⌫ at a line start would be a dead key.
      const nl = text.lastIndexOf("\n", start - 1);
      const from = nl === -1 ? 0 : nl + 1;
      return from === start
        ? { from: Math.max(0, start - 1), to: start }
        : { from, to: start };
    }
    case "lineForward": {
      const nl = text.indexOf("\n", start);
      const to = nl === -1 ? text.length : nl;
      return to === start
        ? { from: start, to: Math.min(text.length, start + 1) }
        : { from: start, to };
    }
  }
}
