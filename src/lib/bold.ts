/** Bold runs over a node's text, stored as flat [location, length, …] pairs (the
 * BoldRuns port). The plain string stays the source of truth; these are decoration.
 * The editor keeps them in sync as text is edited (splice-diff adjustment) and ⌘B
 * toggles them over the selection. */

function toMarks(ranges: number[], len: number): boolean[] {
  const marks = new Array<boolean>(len).fill(false);
  for (let i = 0; i + 1 < ranges.length; i += 2) {
    const lo = Math.max(0, Math.min(ranges[i], len));
    const hi = Math.max(lo, Math.min(ranges[i] + ranges[i + 1], len));
    for (let j = lo; j < hi; j++) marks[j] = true;
  }
  return marks;
}

function toRanges(marks: boolean[]): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < marks.length) {
    if (marks[i]) {
      const start = i;
      while (i < marks.length && marks[i]) i++;
      out.push(start, i - start);
    } else {
      i++;
    }
  }
  return out;
}

/** ⌘B: if the whole (non-empty) selection is already bold, unbold it; else bold it. */
export function toggleBold(
  ranges: number[],
  textLen: number,
  selStart: number,
  selEnd: number,
): number[] {
  if (selStart >= selEnd) return ranges;
  const marks = toMarks(ranges, textLen);
  const lo = Math.max(0, selStart);
  const hi = Math.min(textLen, selEnd);
  let allBold = true;
  for (let i = lo; i < hi; i++) {
    if (!marks[i]) {
      allBold = false;
      break;
    }
  }
  for (let i = lo; i < hi; i++) marks[i] = !allBold;
  return toRanges(marks);
}

/** Carry bold marks across a text edit, modeled as ONE splice (every textarea change
 * is: common prefix + removed span → inserted span + common suffix). Inserted
 * characters inherit boldness when typed INSIDE a bold run. */
export function adjustRangesForEdit(
  ranges: number[],
  oldText: string,
  newText: string,
): number[] {
  if (ranges.length === 0) return ranges;
  if (oldText === newText) return ranges;
  let p = 0;
  const oldLen = oldText.length;
  const newLen = newText.length;
  const maxP = Math.min(oldLen, newLen);
  while (p < maxP && oldText[p] === newText[p]) p++;
  let s = 0;
  while (
    s < Math.min(oldLen, newLen) - p &&
    oldText[oldLen - 1 - s] === newText[newLen - 1 - s]
  ) {
    s++;
  }
  const insertedLen = newLen - p - s;
  const marks = toMarks(ranges, oldLen);
  const before = marks.slice(0, p);
  const after = s > 0 ? marks.slice(oldLen - s) : [];
  const midBold =
    insertedLen > 0 &&
    p > 0 &&
    marks[p - 1] &&
    (p < oldLen ? marks[p] : false);
  const inserted = new Array<boolean>(insertedLen).fill(midBold);
  return toRanges([...before, ...inserted, ...after]);
}
