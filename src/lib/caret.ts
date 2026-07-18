/** Caret geometry for textareas — which visual line the caret sits on. Uses a hidden
 * mirror div with identical typography (the standard textarea-caret-position
 * technique), so wrapped lines are measured, not guessed. */

let mirrorEl: HTMLDivElement | null = null;

function mirror(): HTMLDivElement {
  if (!mirrorEl) {
    mirrorEl = document.createElement("div");
    const s = mirrorEl.style;
    s.position = "absolute";
    s.visibility = "hidden";
    s.whiteSpace = "pre-wrap";
    s.overflowWrap = "break-word";
    s.top = "-9999px";
    s.left = "0";
    s.pointerEvents = "none";
    document.body.appendChild(mirrorEl);
  }
  return mirrorEl;
}

function syncTypography(ta: HTMLTextAreaElement, el: HTMLDivElement) {
  const cs = getComputedStyle(ta);
  el.style.font = cs.font;
  el.style.letterSpacing = cs.letterSpacing;
  el.style.tabSize = cs.tabSize;
  el.style.width = `${ta.clientWidth}px`;
}

/** Y offset (px) of the caret at `offset` inside `ta`'s text. */
function caretTop(ta: HTMLTextAreaElement, offset: number): number {
  const el = mirror();
  syncTypography(ta, el);
  el.textContent = ta.value.slice(0, offset);
  const marker = document.createElement("span");
  // A zero-width marker measures the NEXT character's line when the caret sits at a
  // soft-wrap boundary; a text node marker sticks to the previous line. Use "​".
  marker.textContent = "​";
  el.appendChild(marker);
  return marker.offsetTop;
}

export interface CaretLineInfo {
  atFirstLine: boolean;
  atLastLine: boolean;
}

export function caretLineInfo(
  ta: HTMLTextAreaElement,
  offset: number,
): CaretLineInfo {
  const value = ta.value;
  if (value.length === 0) return { atFirstLine: true, atLastLine: true };
  const lh = parseFloat(getComputedStyle(ta).lineHeight) || 18;
  const y = caretTop(ta, offset);
  const yEnd = caretTop(ta, value.length);
  return {
    atFirstLine: y < lh * 0.5,
    atLastLine: y > yEnd - lh * 0.5,
  };
}

/** Offset of the START of the last visual line (Arrow-Up entering a wrapped node from
 * below lands here — the mirror of Arrow-Down landing on the top line). */
export function lastVisualLineStart(ta: HTMLTextAreaElement): number {
  const len = ta.value.length;
  if (len === 0) return 0;
  const lastTop = caretTop(ta, len);
  // offsetTop is monotone in the caret offset — binary search the first offset on
  // the last visual line.
  let lo = 0;
  let hi = len;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (caretTop(ta, mid) >= lastTop) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
