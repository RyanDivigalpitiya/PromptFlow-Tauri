/** Caret geometry + selection offsets for the row editor (a contenteditable div;
 * previously a textarea — the mirror-measurement technique is element-agnostic).
 * Offsets are indices into the SERIALIZED text (text nodes in order, <br> = "\n"). */

let mirrorEl: HTMLDivElement | null = null;

function mirror(): HTMLDivElement {
  if (!mirrorEl) {
    mirrorEl = document.createElement("div");
    const s = mirrorEl.style;
    s.position = "absolute";
    s.visibility = "hidden";
    s.whiteSpace = "pre-wrap";
    s.overflowWrap = "anywhere";
    s.top = "-9999px";
    s.left = "0";
    s.pointerEvents = "none";
    document.body.appendChild(mirrorEl);
  }
  return mirrorEl;
}

function syncTypography(el: HTMLElement, m: HTMLDivElement) {
  const cs = getComputedStyle(el);
  m.style.font = cs.font;
  m.style.letterSpacing = cs.letterSpacing;
  m.style.tabSize = cs.tabSize;
  // Fractional width: the hugging editor shrink-wraps to a fractional advance;
  // clientWidth's integer truncation mis-detects wrap boundaries.
  m.style.width = `${el.getBoundingClientRect().width}px`;
}

/** Y offset (px) of the caret at `offset` inside `value` laid out like `el`.
 * NOTE: measures PLAIN text — styled runs (bold is wider) shift wrap points
 * slightly, so boundary detection is approximate on wrapped styled lines. */
function caretTop(el: HTMLElement, value: string, offset: number): number {
  const m = mirror();
  syncTypography(el, m);
  m.textContent = value.slice(0, offset);
  const marker = document.createElement("span");
  // A zero-width marker measures the NEXT character's line when the caret sits at a
  // soft-wrap boundary; a text node marker sticks to the previous line. Use "​".
  marker.textContent = "​";
  m.appendChild(marker);
  return marker.offsetTop;
}

export interface CaretLineInfo {
  atFirstLine: boolean;
  atLastLine: boolean;
}

export function caretLineInfo(
  el: HTMLElement,
  value: string,
  offset: number,
): CaretLineInfo {
  if (value.length === 0) return { atFirstLine: true, atLastLine: true };
  const lh = parseFloat(getComputedStyle(el).lineHeight) || 18;
  const y = caretTop(el, value, offset);
  const yEnd = caretTop(el, value, value.length);
  return {
    atFirstLine: y < lh * 0.5,
    atLastLine: y > yEnd - lh * 0.5,
  };
}

/** Offset of the START of the last visual line (Arrow-Up entering a wrapped node from
 * below lands here — the mirror of Arrow-Down landing on the top line). */
export function lastVisualLineStart(el: HTMLElement, value: string): number {
  const len = value.length;
  if (len === 0) return 0;
  const lastTop = caretTop(el, value, len);
  // offsetTop is monotone in the caret offset — binary search the first offset on
  // the last visual line.
  let lo = 0;
  let hi = len;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (caretTop(el, value, mid) >= lastTop) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

// MARK: Serialized-text <-> DOM position mapping for the contenteditable editor

/** The trailing-line sentinel <br> buildRunDom appends is ZERO-width everywhere:
 * serialization, offset counting, and offset placement all skip it. */
function isSentinel(n: Node): boolean {
  return n.nodeName === "BR" && (n as HTMLElement).dataset?.pfSentinel === "1";
}

/** The editor's text: text nodes in document order; <br> counts as "\n". */
export function serializeEditor(el: HTMLElement): string {
  let out = "";
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) out += n.nodeValue ?? "";
    else if (n.nodeName === "BR") {
      if (!isSentinel(n)) out += "\n";
    } else n.childNodes.forEach(walk);
  };
  el.childNodes.forEach(walk);
  return out;
}

function offsetOfPoint(root: HTMLElement, node: Node, nodeOffset: number): number {
  let total = 0;
  let found = -1;
  const walk = (n: Node): boolean => {
    if (n === node && n.nodeType !== Node.TEXT_NODE && n.nodeName !== "BR") {
      // An element position: nodeOffset counts CHILDREN — resolve by walking that
      // many children first.
      for (let i = 0; i < n.childNodes.length; i++) {
        if (i === nodeOffset) {
          found = total;
          return true;
        }
        if (walk(n.childNodes[i])) return true;
      }
      if (nodeOffset >= n.childNodes.length) {
        found = total;
        return true;
      }
      return false;
    }
    if (n.nodeType === Node.TEXT_NODE) {
      if (n === node) {
        found = total + Math.min(nodeOffset, (n.nodeValue ?? "").length);
        return true;
      }
      total += (n.nodeValue ?? "").length;
    } else if (n.nodeName === "BR") {
      if (n === node) {
        found = total;
        return true;
      }
      if (!isSentinel(n)) total += 1;
    } else {
      for (const c of Array.from(n.childNodes)) {
        if (walk(c)) return true;
      }
    }
    return false;
  };
  walk(root);
  return found >= 0 ? found : total;
}

/** Current selection as [start, end] offsets into the serialized text, or null when
 * the selection isn't inside `el`. */
export function selectionOffsets(
  el: HTMLElement,
): { start: number; end: number } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const r = sel.getRangeAt(0);
  if (!el.contains(r.startContainer) || !el.contains(r.endContainer)) return null;
  const start = offsetOfPoint(el, r.startContainer, r.startOffset);
  const end = r.collapsed
    ? start
    : offsetOfPoint(el, r.endContainer, r.endOffset);
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function pointAtOffset(
  el: HTMLElement,
  offset: number,
): { node: Node; offset: number } {
  let remaining = offset;
  let last: { node: Node; offset: number } = { node: el, offset: 0 };
  const walk = (n: Node): { node: Node; offset: number } | null => {
    if (n.nodeType === Node.TEXT_NODE) {
      const len = (n.nodeValue ?? "").length;
      if (remaining <= len) return { node: n, offset: remaining };
      remaining -= len;
      last = { node: n, offset: len };
      return null;
    }
    if (n.nodeName === "BR") {
      if (isSentinel(n)) return null; // zero-width — never consumes an offset
      const parent = n.parentNode!;
      const idx = Array.prototype.indexOf.call(parent.childNodes, n);
      if (remaining === 0) return { node: parent, offset: idx };
      remaining -= 1;
      last = { node: parent, offset: idx + 1 };
      return null;
    }
    for (const c of Array.from(n.childNodes)) {
      const hit = walk(c);
      if (hit) return hit;
    }
    return null;
  };
  return walk(el) ?? last;
}

/** Place the selection at [start, end] (serialized-text offsets) inside `el`. */
export function setSelectionOffsets(el: HTMLElement, start: number, end = start) {
  const sel = window.getSelection();
  if (!sel) return;
  const a = pointAtOffset(el, start);
  const b = end === start ? a : pointAtOffset(el, end);
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  sel.removeAllRanges();
  sel.addRange(range);
}
