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

/** Every <br> in `el` that is ZERO-width: it contributes no "\n" to the serialization
 * and consumes no offset. Serialization, offset counting and offset placement all read
 * this ONE set — they must agree on which <br>s exist, or the caret lands off by the
 * newlines they disagree about.
 *
 * Two kinds qualify, for the same reason: WebKit gives a trailing empty line no line
 * box of its own (measured — `<span>a\n</span>` is 18px tall, `<span>a\n</span><br>` is
 * 36), so a caret sitting after a final "\n" needs a stand-in element. buildRunDom
 * appends OUR sentinel for that; WebKit inserts its OWN placeholder the instant an edit
 * empties the last line, and our input handler sees that DOM first — backspacing the
 * last character of "alpha\nbravo" gives `<span>alpha\n<br></span>`. Counting that
 * placeholder as a newline appended a phantom empty line to the model on EVERY "delete
 * the last line" (backspace, forward-delete or a selection), which then persisted in
 * the store (shipped bug, fixed).
 *
 * Deliberately narrow: only the LAST <br>, and only when the text before it already
 * ends in "\n" — i.e. exactly when its line break is one the model already carries. The
 * no-text case is the same placeholder in a fully emptied editor, and skipping it is
 * what keeps a just-emptied node counting as empty (so Backspace still deletes it). A
 * <br> that carries a newline of its OWN — text dropped into the editor, the one
 * insertion path we don't intercept — still serializes as "\n". */
function zeroWidthBrs(el: HTMLElement): Set<Node> {
  const parts: { node: Node; br: boolean; text: string }[] = [];
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE)
      parts.push({ node: n, br: false, text: n.nodeValue ?? "" });
    else if (n.nodeName === "BR") parts.push({ node: n, br: true, text: "\n" });
    else n.childNodes.forEach(walk);
  };
  el.childNodes.forEach(walk);

  const zero = new Set<Node>();
  for (const p of parts) if (p.br && isSentinel(p.node)) zero.add(p.node);
  // The last part that renders anything: an empty text node is no more content than a
  // sentinel is.
  let i = parts.length - 1;
  while (i >= 0 && (zero.has(parts[i].node) || parts[i].text === "")) i--;
  if (i >= 0 && parts[i].br) {
    const before = parts
      .slice(0, i)
      .filter((p) => !zero.has(p.node))
      .map((p) => p.text)
      .join("");
    if (before === "" || before.endsWith("\n")) zero.add(parts[i].node);
  }
  return zero;
}

/** The editor's text: text nodes in document order; <br> counts as "\n" unless it is
 * zero-width (see `zeroWidthBrs`). */
export function serializeEditor(el: HTMLElement): string {
  const zero = zeroWidthBrs(el);
  let out = "";
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) out += n.nodeValue ?? "";
    else if (n.nodeName === "BR") {
      if (!zero.has(n)) out += "\n";
    } else n.childNodes.forEach(walk);
  };
  el.childNodes.forEach(walk);
  return out;
}

function offsetOfPoint(
  root: HTMLElement,
  node: Node,
  nodeOffset: number,
  zero: Set<Node>,
): number {
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
      if (!zero.has(n)) total += 1;
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
  const zero = zeroWidthBrs(el);
  const start = offsetOfPoint(el, r.startContainer, r.startOffset, zero);
  const end = r.collapsed
    ? start
    : offsetOfPoint(el, r.endContainer, r.endOffset, zero);
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function pointAtOffset(
  el: HTMLElement,
  offset: number,
  zero: Set<Node>,
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
      if (zero.has(n)) return null; // zero-width — never consumes an offset
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
  const zero = zeroWidthBrs(el);
  const a = pointAtOffset(el, start, zero);
  const b = end === start ? a : pointAtOffset(el, end, zero);
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  sel.removeAllRanges();
  sel.addRange(range);
}
