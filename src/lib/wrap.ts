/** Wrap-selection (the SwiftUI app's `EditorWrap`, shared by both editors there):
 * typing a delimiter while a non-empty selection exists WRAPS it (`word` → `(word)`)
 * instead of replacing; re-pressing the SAME delimiter over an already-wrapped
 * selection UNWRAPS one layer instead of nesting. No auto-pairing on an empty caret. */

const PAIRS: Record<string, string> = {
  '"': '"',
  "'": "'",
  "`": "`",
  "(": ")",
  "[": "]",
  "{": "}",
};

export type WrapAction =
  | { type: "wrap" }
  /** The pair sits just OUTSIDE the selection — remove it, keep the inner selected. */
  | { type: "unwrapSurrounding" }
  /** The selection SPANS the pair — strip the first/last characters. */
  | { type: "unwrapInclusive" };

export function wrapAction(
  ch: string,
  text: string,
  selStart: number,
  selEnd: number,
): WrapAction | null {
  if (!(ch in PAIRS) || selStart >= selEnd) return null;
  const close = PAIRS[ch];
  const sel = text.slice(selStart, selEnd);
  if (sel.length >= 2 && sel.startsWith(ch) && sel.endsWith(close)) {
    return { type: "unwrapInclusive" };
  }
  if (
    selStart > 0 &&
    selEnd < text.length &&
    text[selStart - 1] === ch &&
    text[selEnd] === close
  ) {
    return { type: "unwrapSurrounding" };
  }
  return { type: "wrap" };
}

export interface WrapResult {
  text: string;
  selStart: number;
  selEnd: number;
  /** The text after ONLY the later-position edit — every wrap/unwrap is TWO
   * single-character splices, and style-run adjustment (adjustRangesForEdit)
   * models exactly one splice per step; adjust old→mid, then mid→text. */
  mid: string;
}

/** Apply the action; the inner text stays selected in every case. */
export function applyWrap(
  action: WrapAction,
  ch: string,
  text: string,
  selStart: number,
  selEnd: number,
): WrapResult {
  const close = PAIRS[ch];
  const sel = text.slice(selStart, selEnd);
  switch (action.type) {
    case "wrap": {
      const mid = text.slice(0, selEnd) + close + text.slice(selEnd);
      return {
        text: text.slice(0, selStart) + ch + sel + close + text.slice(selEnd),
        selStart: selStart + 1,
        selEnd: selEnd + 1,
        mid,
      };
    }
    case "unwrapSurrounding": {
      const mid = text.slice(0, selEnd) + text.slice(selEnd + 1);
      return {
        text: text.slice(0, selStart - 1) + sel + text.slice(selEnd + 1),
        selStart: selStart - 1,
        selEnd: selEnd - 1,
        mid,
      };
    }
    case "unwrapInclusive": {
      const mid = text.slice(0, selEnd - 1) + text.slice(selEnd);
      return {
        text: text.slice(0, selStart) + sel.slice(1, -1) + text.slice(selEnd),
        selStart,
        selEnd: selEnd - 2,
        mid,
      };
    }
  }
}
