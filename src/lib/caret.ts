/** Caret geometry + selection offsets for the row editor (a contenteditable div;
 * previously a textarea — the mirror-measurement technique is element-agnostic).
 * Offsets are indices into the SERIALIZED text (text nodes in order, <br> = "\n"). */

import { declFor, lineClass, markerHang } from "./runs";
import { isList, mdLines } from "./mdLines";

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
  // The `font` SHORTHAND writes line-height as a px LENGTH ("16px / 21.6px …"), which
  // silently drops the one property a markdown prompt depends on: `--row-line-height` is
  // a UNITLESS number, so it re-multiplies against each descendant's own font-size and a
  // 1.5em heading span gets a 32.4px line box for free. Pinned to px in the mirror, that
  // heading would measure 21.6px and every line below it would be attributed to the
  // wrong visual line. Re-assert it as the RATIO.
  //
  // Unit-guarded on purpose: a bare `isFinite` check cannot tell "21.6px" from "1.35",
  // and dividing the latter by the font size would collapse the mirror to
  // `line-height: 0.084` for EVERY kind, not just prompts.
  const lh = cs.lineHeight;
  const fs = parseFloat(cs.fontSize);
  m.style.lineHeight =
    lh.endsWith("px") && fs > 0 ? String(parseFloat(lh) / fs) : lh;
  m.style.letterSpacing = cs.letterSpacing;
  m.style.tabSize = cs.tabSize;
  // Fractional width: the hugging editor shrink-wraps to a fractional advance;
  // clientWidth's integer truncation mis-detects wrap boundaries.
  m.style.width = `${el.getBoundingClientRect().width}px`;
}

/** A plain-text span carrying one region's markdown decoration. The mirror measures
 * unstyled text by design (see `caretTop`), but it cannot ignore the DECORATION: a
 * heading is a different point size, so it wraps at a different column and occupies a
 * taller line. */
function mirrorSpan(text: string, heading: number, marker: boolean): HTMLSpanElement {
  const sp = document.createElement("span");
  const d = declFor({ text, bold: false, italic: false, underline: false, heading, marker });
  if (d) Object.assign(sp.style, d);
  sp.textContent = text;
  return sp;
}

/** Lay `value.slice(0, offset)` into the mirror with the SAME line structure the editor
 * renders, and return the element the caret marker belongs in.
 *
 * Lines are classified from the FULL value and then truncated, never classified from the
 * prefix: with the caret sitting between "#" and its space, the prefix alone reads as
 * plain and the line would measure at body size while the editor draws it as a title.
 *
 * No sentinel <br> is ever emitted here. The mirror is measured, not edited — its
 * trailing line box comes from the marker span the caller appends, and an extra <br>
 * after content already ending in "\n" ADDS a line box (measured: 18px vs 36px), which
 * would put every ArrowDown one line early. */
function buildMirrorLines(
  m: HTMLDivElement,
  value: string,
  offset: number,
  fontSize: number,
): HTMLElement {
  m.replaceChildren();
  let host: HTMLElement = m;
  for (const line of mdLines(value)) {
    if (line.start > offset) break;
    const lineEnd = line.end + (line.hasNewline ? 1 : 0);
    const stop = Math.min(offset, lineEnd);
    const level = line.kind === "h1" ? 1 : line.kind === "h2" ? 2 : line.kind === "h3" ? 3 : 0;
    const el = document.createElement("span");
    el.className = lineClass(line.kind);
    if (isList(line.kind)) {
      // The hang widens the block's padding and pulls its first line back, so a wrapped
      // line breaks at a different column — the mirror has to carry it or it partitions
      // lines the editor does not.
      const hang = markerHang(fontSize, value.slice(line.start, line.markerEnd));
      if (hang > 0) el.style.setProperty("--md-hang", `${hang}px`);
    }
    const markEnd = Math.min(stop, line.markerEnd);
    el.appendChild(mirrorSpan(value.slice(line.start, markEnd), level, true));
    el.appendChild(mirrorSpan(value.slice(markEnd, stop), level, false));
    host = el;
    m.appendChild(el);
    if (stop >= offset) break;
  }
  return host;
}

/** Y offset (px) of the caret at `offset` inside `value` laid out like `el`.
 * NOTE: measures PLAIN text — styled runs (bold is wider) shift wrap points
 * slightly, so boundary detection is approximate on wrapped styled lines. */
function caretTop(
  el: HTMLElement,
  value: string,
  offset: number,
  md = false,
  fontSize = 16,
): number {
  const m = mirror();
  syncTypography(el, m);
  let host: HTMLElement = m;
  let heading = 0;
  if (md) {
    host = buildMirrorLines(m, value, offset, fontSize);
    const line = mdLines(value).find(
      (l) => offset >= l.start && offset <= l.end + (l.hasNewline ? 1 : 0),
    );
    heading = line?.kind === "h1" ? 1 : line?.kind === "h2" ? 2 : line?.kind === "h3" ? 3 : 0;
  } else {
    m.textContent = value.slice(0, offset);
  }
  const marker = document.createElement("span");
  // A zero-width marker measures the NEXT character's line when the caret sits at a
  // soft-wrap boundary; a text node marker sticks to the previous line. Use "​".
  marker.textContent = "​";
  // ...and it carries its LINE's point size, so its box top is the line box's top. Left
  // at body size inside a 1.5em heading it is baseline-aligned, i.e. several px down,
  // and `caretLineInfo`'s `y < lh*0.5` test loses most of its margin and inverts.
  if (heading > 0) marker.style.fontSize = `${[0, 1.5, 1.25, 1.125][heading]}em`;
  host.appendChild(marker);
  // Rects rather than `offsetTop`: the marker now lands inside a nested host (a grid
  // cell), and a rect difference is mirror-relative by construction rather than by
  // relying on which ancestor happens to be positioned. It is also fractional where
  // `offsetTop` rounds, which the binary search in `lastVisualLineStart` prefers.
  return marker.getBoundingClientRect().top - m.getBoundingClientRect().top;
}

export interface CaretLineInfo {
  atFirstLine: boolean;
  atLastLine: boolean;
}

export function caretLineInfo(
  el: HTMLElement,
  value: string,
  offset: number,
  md = false,
  fontSize = 16,
): CaretLineInfo {
  if (value.length === 0) return { atFirstLine: true, atLastLine: true };
  const lh = parseFloat(getComputedStyle(el).lineHeight) || 18;
  const y = caretTop(el, value, offset, md, fontSize);
  const yEnd = caretTop(el, value, value.length, md, fontSize);
  return {
    atFirstLine: y < lh * 0.5,
    atLastLine: y > yEnd - lh * 0.5,
  };
}

/** Offset of the START of the last visual line (Arrow-Up entering a wrapped node from
 * below lands here — the mirror of Arrow-Down landing on the top line). */
export function lastVisualLineStart(
  el: HTMLElement,
  value: string,
  md = false,
  fontSize = 16,
): number {
  const len = value.length;
  if (len === 0) return 0;
  const lastTop = caretTop(el, value, len, md, fontSize);
  // offsetTop is monotone in the caret offset — binary search the first offset on
  // the last visual line.
  let lo = 0;
  let hi = len;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (caretTop(el, value, mid, md, fontSize) >= lastTop) hi = mid;
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
  // A markdown prompt renders every LINE — and a list line's MARKER and BODY separately —
  // as its own block box, so WebKit drops a line-box placeholder the moment any one of
  // THOSE is emptied, not only when the editor's last line is. The rule below cannot see
  // those: it asks whether the text before the <br> ends in "\n", and before an emptied
  // bullet body the text ends in the MARKER ("- "). Measured in WebKit, both ways in:
  // backspacing the last character of a trailing bullet's body committed "# a\n- \n" for
  // "# a\n- ", and deleting a middle line's "- " marker committed "- one\n\ntwo\n- three"
  // for "- one\ntwo\n- three" — a phantom line each time, persisted and synced.
  //
  // So ask the same question of the BLOCK instead: every newline in a markdown prompt is
  // a literal character in a text node, so a block that renders NO text carries no
  // newline of its own and a <br> alone in it is furniture. A dropped <br> — the one
  // insertion path we don't intercept — still counts, because a drop leaves text beside
  // it; and a legitimately blank line is not empty either, its block holds the "\n".
  for (const p of parts) {
    if (!p.br || zero.has(p.node)) continue;
    const host = (p.node as ChildNode).parentElement;
    if (
      host &&
      host !== el &&
      host.matches(".md-line, .md-mark, .md-body") &&
      host.textContent === ""
    ) {
      zero.add(p.node);
    }
  }
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
      const v = n.nodeValue ?? "";
      const len = v.length;
      if (remaining <= len) {
        // A boundary offset belongs to the node BEFORE it. That is harmless in the flat
        // DOM, which is one inline flow — but in a MARKDOWN prompt every line is its own
        // block and carries its terminating "\n" as the last character INSIDE it, so a
        // LINE-START offset resolves to the end of the PREVIOUS block: a position after
        // a newline that WebKit gives no line box of its own (the measured fact the
        // sentinel <br> exists for). Measured in WebKit: the caret paints at the end of
        // the previous line and the next character typed lands BEFORE the newline — so
        // Enter in a prompt (which puts the caret at exactly such an offset) then typing
        // wrote onto the line you just left. Hand back the NEXT line's block instead.
        //
        // This also reaches the trailing empty line: for a text ending in "\n" the
        // sentinel sits alone in its own block, which the walk below can otherwise never
        // enter, so a `{type: "end"}` focus landed a line high.
        if (remaining === len && v.endsWith("\n")) {
          const next = (n.parentElement?.closest(".md-line") ?? null)?.nextElementSibling;
          if (next && el.contains(next)) {
            // Descend to the first TEXT position in that block, not the element position
            // in front of it: WebKit resolves an element position by its own rules, and
            // typing at one measured as consuming the blank line's newline. A text offset
            // is unambiguous. A block with no text at all (the trailing line, whose only
            // child is the sentinel <br>) has no such position, so it keeps the element
            // one — which is exactly where that line's caret belongs.
            const w = document.createTreeWalker(next, NodeFilter.SHOW_TEXT);
            const first = w.nextNode();
            return first ? { node: first, offset: 0 } : { node: next, offset: 0 };
          }
        }
        return { node: n, offset: remaining };
      }
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
