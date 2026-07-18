import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { api } from "../lib/api";
import { adjustRangesForEdit, toggleBold } from "../lib/bold";
import {
  caretLineInfo,
  lastVisualLineStart,
  selectionOffsets,
  serializeEditor,
  setSelectionOffsets,
} from "../lib/caret";
import { resolveKey, type EditorKey } from "../lib/keys";
import { Theme } from "../lib/layout";
import { buildRunDom, segments, toMarkdown, type StyleSet } from "../lib/runs";
import type { NodeRec } from "../lib/types";
import { applyWrap, wrapAction } from "../lib/wrap";
import {
  deleteAndFocusPrev,
  moveFocused,
  performDecision,
  setKindGuarded,
  toggleHighlight,
} from "../state/controller";
import { mirror, nodeVersion, subscribeNode } from "../state/mirror";
import { useSelection } from "../state/selection";
import { useWindowState } from "../state/windowState";

/** Map a click point to a character offset inside a rendered text element. */
function textOffsetFromPoint(
  container: HTMLElement,
  x: number,
  y: number,
): number | null {
  const doc = document as Document & {
    caretRangeFromPoint?(x: number, y: number): Range | null;
  };
  let node: Node | null = null;
  let offset = 0;
  if (doc.caretRangeFromPoint) {
    const r = doc.caretRangeFromPoint(x, y);
    if (!r) return null;
    node = r.startContainer;
    offset = r.startOffset;
  } else if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(x, y);
    if (!p) return null;
    node = p.offsetNode;
    offset = p.offset;
  } else {
    return null;
  }
  let total = 0;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    if (walker.currentNode === node) return total + offset;
    total += (walker.currentNode.textContent ?? "").length;
  }
  return total;
}

function recStyles(rec: NodeRec): StyleSet {
  return {
    bold: rec.boldRanges,
    italic: rec.italicRanges,
    underline: rec.underlineRanges,
  };
}

/** Completed/highlight styling shared by the static span and the live editor, so
 * focusing never changes metrics or colors. */
function wrapperStyle(rec: NodeRec, highlightColor: string): React.CSSProperties {
  const style: React.CSSProperties = {};
  if (rec.isCompleted) {
    style.textDecoration = "line-through";
    style.textDecorationColor = Theme.completeColor;
    style.opacity = 0.55;
  }
  if (rec.isHighlighted) {
    style.color = highlightColor;
    style.fontWeight = 600;
  }
  return style;
}

/** Static text render: bold/italic/underline runs + completed strike + highlight
 * color, in spans — the exact structure the live editor builds imperatively. */
function StaticText({
  rec,
  highlightColor,
}: {
  rec: NodeRec;
  highlightColor: string;
}) {
  const segs = segments(rec.text, recStyles(rec));
  return (
    <span className="node-text-static" style={wrapperStyle(rec, highlightColor)}>
      {segs.map((s, i) => (
        <span
          key={i}
          style={{
            // 700, not 600: highlighted rows set 600 on the wrapper, and bold
            // must stay visibly heavier inside them.
            fontWeight: s.bold ? 700 : undefined,
            fontStyle: s.italic ? "italic" : undefined,
            textDecoration: s.underline ? "underline" : undefined,
          }}
        >
          {s.text}
        </span>
      ))}
      {rec.text === "" && "​"}
    </span>
  );
}

export interface RowEditorProps {
  nodeId: string;
  isFocused: boolean;
  isDrillRoot: boolean;
  highlightColor: string;
}

/** One row's main text. Unfocused rows are cheap static spans (thousands of them);
 * the ONE focused row becomes a contenteditable div — SAME span structure, so
 * styled runs stay visible while editing and focusing shifts nothing. The DOM is
 * controlled: every input re-renders from the local model and restores the caret;
 * the browser's own rich-text editing (⌘B, styled paste) is suppressed. */
export const RowEditor = memo(function RowEditor(p: RowEditorProps) {
  useSyncExternalStore(subscribeNode(p.nodeId), () => nodeVersion(p.nodeId));
  const rec = mirror.get(p.nodeId);
  const edRef = useRef<HTMLDivElement | null>(null);
  const [local, setLocal] = useState<string | null>(null);
  /** Bumped when only styles change so the run DOM rebuilds. */
  const [styleEpoch, setStyleEpoch] = useState(0);
  /** Texts sent to the store whose delta echoes haven't arrived yet. */
  const pendingSent = useRef<string[]>([]);
  /** Style runs tracked through the live edit (sent alongside each set_text). */
  const localBold = useRef<number[]>([]);
  const localItalic = useRef<number[]>([]);
  const localUnderline = useRef<number[]>([]);
  /** Caret to restore after the next run-DOM rebuild. */
  const caretReq = useRef<{ start: number; end: number } | null>(null);
  const composing = useRef(false);

  const focusEpoch = useWindowState((s) => (p.isFocused ? s.focusEpoch : 0));
  const caretIntent = useWindowState((s) => (p.isFocused ? s.caretIntent : null));

  // Entering/leaving focus: seed/drop the local editing buffer. LAYOUT effect,
  // declared BEFORE the run-DOM builder: the builder reads the style refs in the
  // same commit, and a passive effect would seed them one paint too late (bold
  // text flashed unstyled on focus).
  useLayoutEffect(() => {
    if (p.isFocused) {
      setLocal((cur) => {
        if (cur !== null) return cur;
        const r = mirror.get(p.nodeId);
        localBold.current = r?.boldRanges ?? [];
        localItalic.current = r?.italicRanges ?? [];
        localUnderline.current = r?.underlineRanges ?? [];
        return r?.text ?? "";
      });
    } else {
      setLocal(null);
      pendingSent.current = [];
    }
  }, [p.isFocused, p.nodeId]);

  // Remote-edit adoption while focused (echo-guarded: our own in-flight texts are
  // acknowledged and skipped; anything else is a REAL remote change and wins).
  // Keyed on the REC OBJECT (fresh per delta), not rec.text: style-only deltas —
  // another window's ⌘B, a store ⌘Z of a style toggle — carry identical text and
  // must still drain their echo / be adopted, or the next local send silently
  // reverts them.
  useEffect(() => {
    if (!p.isFocused || local === null || !rec) return;
    const idx = pendingSent.current.indexOf(rec.text);
    if (idx >= 0) {
      pendingSent.current.splice(0, idx + 1);
      return;
    }
    if (pendingSent.current.length !== 0) return;
    if (rec.text !== local) {
      localBold.current = rec.boldRanges;
      localItalic.current = rec.italicRanges;
      localUnderline.current = rec.underlineRanges;
      const el = edRef.current;
      const sel = el ? selectionOffsets(el) : null;
      const at = Math.min(sel?.start ?? rec.text.length, rec.text.length);
      caretReq.current = { start: at, end: at };
      setLocal(rec.text);
      return;
    }
    const stylesDiffer =
      JSON.stringify(localBold.current) !== JSON.stringify(rec.boldRanges) ||
      JSON.stringify(localItalic.current) !== JSON.stringify(rec.italicRanges) ||
      JSON.stringify(localUnderline.current) !==
        JSON.stringify(rec.underlineRanges);
    if (stylesDiffer) {
      localBold.current = rec.boldRanges;
      localItalic.current = rec.italicRanges;
      localUnderline.current = rec.underlineRanges;
      const el = edRef.current;
      const sel = el ? selectionOffsets(el) : null;
      if (sel) caretReq.current = sel;
      setStyleEpoch((v) => v + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec, p.isFocused]);

  const value = local ?? rec?.text ?? "";

  // Rebuild the editor's run DOM from the model, then restore the caret. Runs on
  // every text/style change — the editor is CONTROLLED (browser DOM mutations are
  // always replaced by a model render).
  useLayoutEffect(() => {
    if (!p.isFocused) return;
    const el = edRef.current;
    if (!el || composing.current) return;
    buildRunDom(el, value, {
      bold: localBold.current,
      italic: localItalic.current,
      underline: localUnderline.current,
    });
    const req = caretReq.current;
    if (req && document.activeElement === el) {
      setSelectionOffsets(el, req.start, req.end);
      caretReq.current = null;
    }
  }, [p.isFocused, value, styleEpoch]);

  // Apply focus + caret intent (after the run DOM exists — declared later on
  // purpose; layout effects run in declaration order).
  useLayoutEffect(() => {
    if (!p.isFocused || !caretIntent) return;
    const el = edRef.current;
    if (!el) return;
    if (document.activeElement !== el) el.focus({ preventScroll: true });
    const len = value.length;
    let at = len;
    if (caretIntent.type === "start") at = 0;
    else if (caretIntent.type === "end") at = len;
    else if (caretIntent.type === "at") at = Math.min(caretIntent.offset, len);
    else if (caretIntent.type === "lastLineStart")
      at = lastVisualLineStart(el, value);
    setSelectionOffsets(el, at);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.isFocused, focusEpoch]);

  if (!rec) return null;

  const send = (text: string) => {
    pendingSent.current.push(text);
    void api.setText(
      p.nodeId,
      text,
      localBold.current,
      localItalic.current,
      localUnderline.current,
    );
  };

  /** Adopt an edited text: adjust every style run across the splice, then render,
   * restore the caret, and persist. */
  const commitText = (next: string, caretStart: number, caretEnd = caretStart) => {
    const prev = local ?? rec.text;
    localBold.current = adjustRangesForEdit(localBold.current, prev, next);
    localItalic.current = adjustRangesForEdit(localItalic.current, prev, next);
    localUnderline.current = adjustRangesForEdit(localUnderline.current, prev, next);
    caretReq.current = { start: caretStart, end: caretEnd };
    setLocal(next);
    setStyleEpoch((v) => v + 1);
    send(next);
  };

  const onInput = () => {
    const el = edRef.current;
    if (!el || composing.current) return;
    const next = serializeEditor(el);
    const sel = selectionOffsets(el);
    const at = sel?.start ?? next.length;
    if (next === (local ?? rec.text)) {
      // No text change (e.g. a formatting keystroke the browser swallowed) — still
      // re-render so any stray browser DOM is replaced.
      caretReq.current = { start: at, end: sel?.end ?? at };
      setStyleEpoch((v) => v + 1);
      return;
    }
    commitText(next, at, sel?.end ?? at);
  };

  const insertText = (ins: string) => {
    const el = edRef.current;
    if (!el) return;
    const sel = selectionOffsets(el) ?? { start: value.length, end: value.length };
    const next = value.slice(0, sel.start) + ins + value.slice(sel.end);
    commitText(next, sel.start + ins.length);
  };

  const selectedRaw = (): string => {
    const el = edRef.current;
    const sel = el ? selectionOffsets(el) : null;
    if (sel && sel.start !== sel.end) return value.slice(sel.start, sel.end);
    return value;
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // During IME composition every key belongs to the IME (Enter commits the
    // candidate — intercepting it would split the node mid-composition).
    if (composing.current || e.nativeEvent.isComposing) return;
    const el = e.currentTarget;
    const sel = selectionOffsets(el) ?? { start: value.length, end: value.length };
    const selStart = sel.start;
    const selEnd = sel.end;
    const meta = e.metaKey;
    const s = useWindowState.getState();

    // Wrap-selection: a typed delimiter over a non-empty selection wraps/unwraps.
    if (
      !meta &&
      !e.ctrlKey &&
      !e.altKey &&
      e.key.length === 1 &&
      selStart !== selEnd
    ) {
      const action = wrapAction(e.key, value, selStart, selEnd);
      if (action) {
        e.preventDefault();
        const r = applyWrap(action, e.key, value, selStart, selEnd);
        // Two single-splice adjustments (old→mid, mid→final): a wrap edits TWO
        // positions, which one adjustRangesForEdit call mis-models.
        const step = (ranges: number[]) =>
          adjustRangesForEdit(
            adjustRangesForEdit(ranges, value, r.mid),
            r.mid,
            r.text,
          );
        localBold.current = step(localBold.current);
        localItalic.current = step(localItalic.current);
        localUnderline.current = step(localUnderline.current);
        caretReq.current = { start: r.selStart, end: r.selEnd };
        setLocal(r.text);
        setStyleEpoch((v) => v + 1);
        send(r.text);
        return;
      }
    }

    // Command-modified shortcuts (the AutoSizingTextView.keyDown ports). ⌘B/⌘I/⌘U
    // must preventDefault even with no selection — the browser's own contenteditable
    // rich-text engine would mutate the DOM behind the model's back.
    if (meta && !e.altKey && !e.ctrlKey) {
      if (!e.shiftKey && (e.key === "b" || e.key === "B")) {
        e.preventDefault();
        localBold.current = toggleBold(localBold.current, value.length, selStart, selEnd);
        caretReq.current = { start: selStart, end: selEnd };
        setStyleEpoch((v) => v + 1);
        send(value);
        return;
      }
      if (!e.shiftKey && (e.key === "i" || e.key === "I")) {
        e.preventDefault();
        localItalic.current = toggleBold(localItalic.current, value.length, selStart, selEnd);
        caretReq.current = { start: selStart, end: selEnd };
        setStyleEpoch((v) => v + 1);
        send(value);
        return;
      }
      if (!e.shiftKey && (e.key === "u" || e.key === "U")) {
        e.preventDefault();
        localUnderline.current = toggleBold(localUnderline.current, value.length, selStart, selEnd);
        caretReq.current = { start: selStart, end: selEnd };
        setStyleEpoch((v) => v + 1);
        send(value);
        return;
      }
      if (e.shiftKey && (e.key === "c" || e.key === "C")) {
        // ⇧⌘C: the selection (or whole text) as markdown.
        e.preventDefault();
        const raw = selectedRaw();
        const off = raw === value ? 0 : selStart;
        const slice = (r: number[]) =>
          r.length === 0
            ? r
            : segRanges(r, off, off + raw.length);
        void navigator.clipboard.writeText(
          toMarkdown(raw, {
            bold: slice(localBold.current),
            italic: slice(localItalic.current),
            underline: slice(localUnderline.current),
          }),
        );
        return;
      }
      if (e.key === "1" || e.key === "2" || e.key === "3") {
        e.preventDefault();
        void setKindGuarded(
          p.nodeId,
          e.key === "1" ? "bulletPoint" : e.key === "2" ? "checkbox" : "promptDraft",
        );
        return;
      }
      if (e.key === "4") {
        // ⌘4 converts to a divider — which has no editor, so focus must leave.
        e.preventDefault();
        void setKindGuarded(p.nodeId, "line").then(() => {
          useWindowState.getState().clearFocus();
        });
        return;
      }
      if (e.shiftKey && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        void toggleHighlight(p.nodeId);
        return;
      }
      if (e.shiftKey && (e.key === "n" || e.key === "N")) {
        e.preventDefault();
        s.focusNode(p.nodeId, "note", { type: "end" });
        return;
      }
    }

    // ⌥↑ / ⌥↓ move the node (resolved before resolveKey, like the Swift keyDown path).
    if (e.altKey && !meta && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      void moveFocused(p.nodeId, e.key === "ArrowUp" ? -1 : 1);
      return;
    }

    // ⌘↑ collapse / ⌘↓ expand the node the caret is in (NodeTextView keyDown
    // parity). A childless node falls through to the native caret jump.
    if (
      meta &&
      !e.altKey &&
      !e.ctrlKey &&
      !e.shiftKey &&
      (e.key === "ArrowUp" || e.key === "ArrowDown")
    ) {
      if (mirror.hasChildren(p.nodeId)) {
        e.preventDefault();
        s.setCollapsed(p.nodeId, e.key === "ArrowUp");
      }
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      if (value === "") {
        void deleteAndFocusPrev(p.nodeId);
      } else {
        el.blur();
        s.clearFocus();
      }
      return;
    }

    let key: EditorKey = "other";
    if (e.key === "Enter") key = "enter";
    else if (e.key === "Tab") key = e.shiftKey ? "backtab" : "tab";
    else if (e.key === "Backspace") key = "deleteBackward";
    else if (e.key === "ArrowUp") key = e.shiftKey ? "shiftMoveUp" : "moveUp";
    else if (e.key === "ArrowDown")
      key = e.shiftKey ? "shiftMoveDown" : "moveDown";
    if (key === "other") return;

    let atFirstLine = true;
    let atLastLine = true;
    if (key === "moveUp" || key === "shiftMoveUp") {
      atFirstLine = caretLineInfo(el, value, selStart).atFirstLine;
    }
    if (key === "moveDown" || key === "shiftMoveDown") {
      atLastLine = caretLineInfo(el, value, selEnd).atLastLine;
    }

    const decision = resolveKey(key, {
      isPrompt: rec.kind === "promptDraft",
      shift: e.shiftKey,
      cmd: meta,
      opt: e.altKey,
      caretAtStartEmpty: value === "",
      atFirstLine,
      atLastLine,
    });

    if (decision === "newline") {
      // The contenteditable default would insert <div>/<br> structure — take over
      // and splice a literal newline into the model instead.
      e.preventDefault();
      insertText("\n");
      return;
    }
    if (decision === "passthrough") {
      if (key === "tab" || key === "backtab") e.preventDefault();
      return; // native editing (typing, caret moves, backspace mid-text)
    }
    e.preventDefault();
    void performDecision(p.nodeId, decision, selStart, selEnd, value);
  };

  const onBlur = () => {
    const s = useWindowState.getState();
    // The controller's focus-state subscription owns empty-node pruning — a
    // direct call here would double-schedule and the second delete rejects.
    if (s.focusId === p.nodeId && s.focusField === "main") s.clearFocus();
  };

  if (p.isFocused) {
    return (
      <div
        // Distinct key: the editor's children are imperative (buildRunDom), which
        // React doesn't know about — swapping branches must replace the DOM node,
        // or React appends the static span NEXT TO the leftover editor spans.
        key="editor"
        ref={edRef}
        className="node-text-wrap node-editor"
        style={wrapperStyle(rec, p.highlightColor)}
        contentEditable
        onInput={onInput}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
          onInput();
        }}
        onPaste={(e) => {
          e.preventDefault();
          insertText(e.clipboardData.getData("text/plain"));
        }}
        onCopy={(e) => {
          // ⌘C is RAW text (never the browser's styled-HTML flavor).
          e.preventDefault();
          e.clipboardData.setData("text/plain", selectedRaw());
        }}
        onCut={(e) => {
          e.preventDefault();
          const el = edRef.current;
          const sel = el ? selectionOffsets(el) : null;
          if (!sel || sel.start === sel.end) return;
          e.clipboardData.setData("text/plain", value.slice(sel.start, sel.end));
          commitText(value.slice(0, sel.start) + value.slice(sel.end), sel.start);
        }}
        spellCheck={false}
      />
    );
  }

  return (
    <div
      key="static"
      className="node-text-wrap"
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        // Without this, the mousedown's DEFAULT action (post-handler focus steal to
        // body) blurs the editor the click just focused.
        e.preventDefault();
        const sel = useSelection.getState();
        if (e.shiftKey) {
          // Shift-click extends a NODE selection from the focused node / live anchor.
          const anchor =
            sel.anchor ?? useWindowState.getState().focusId ?? p.nodeId;
          (document.activeElement as HTMLElement | null)?.blur();
          useWindowState.getState().clearFocus();
          sel.start(anchor, p.nodeId);
          return;
        }
        sel.clear();
        const offset =
          e.currentTarget &&
          textOffsetFromPoint(e.currentTarget, e.clientX, e.clientY);
        useWindowState
          .getState()
          .focusNode(
            p.nodeId,
            "main",
            offset != null ? { type: "at", offset } : { type: "end" },
          );
      }}
    >
      <StaticText rec={rec} highlightColor={p.highlightColor} />
    </div>
  );
});

/** Clip flat [loc,len] ranges to [lo,hi) and rebase to lo — for markdown of a
 * selection slice. */
function segRanges(ranges: number[], lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < ranges.length; i += 2) {
    const a = Math.max(ranges[i], lo);
    const b = Math.min(ranges[i] + ranges[i + 1], hi);
    if (b > a) out.push(a - lo, b - a);
  }
  return out;
}

/** The secondary note line (⌘⇧N) — smaller, grey, below the text. Rendered only
 * while non-empty or focused. Plain text (no style runs — notes have no style
 * storage, matching the SwiftUI original). */
export const NoteEditor = memo(function NoteEditor(p: {
  nodeId: string;
  isNoteFocused: boolean;
}) {
  useSyncExternalStore(subscribeNode(p.nodeId), () => nodeVersion(p.nodeId));
  const rec = mirror.get(p.nodeId);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const [local, setLocal] = useState<string | null>(null);
  const focusEpoch = useWindowState((s) => (p.isNoteFocused ? s.focusEpoch : 0));

  useEffect(() => {
    if (p.isNoteFocused) setLocal((cur) => cur ?? mirror.get(p.nodeId)?.note ?? "");
    else setLocal(null);
  }, [p.isNoteFocused, p.nodeId]);

  useLayoutEffect(() => {
    if (!p.isNoteFocused) return;
    const ta = taRef.current;
    if (!ta) return;
    if (document.activeElement !== ta) ta.focus({ preventScroll: true });
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, [p.isNoteFocused, focusEpoch]);

  if (!rec) return null;
  if (rec.note === "" && !p.isNoteFocused) return null;

  if (p.isNoteFocused) {
    const value = local ?? rec.note;
    return (
      <div className="grow-wrap note-wrap" data-value={value}>
        <textarea
          ref={taRef}
          className="node-textarea note-textarea"
          value={value}
          rows={1}
          onChange={(e) => {
            setLocal(e.target.value);
            void api.setNote(p.nodeId, e.target.value);
          }}
          onKeyDown={(e) => {
            const s = useWindowState.getState();
            if (
              e.key === "Escape" ||
              (e.metaKey && e.shiftKey && (e.key === "n" || e.key === "N"))
            ) {
              e.preventDefault();
              s.focusNode(p.nodeId, "main", { type: "end" });
            }
          }}
          onBlur={() => {
            const s = useWindowState.getState();
            if (s.focusId === p.nodeId && s.focusField === "note") s.clearFocus();
          }}
          spellCheck={false}
        />
      </div>
    );
  }
  return (
    <div
      className="node-note-static"
      onMouseDown={(e) => {
        e.preventDefault();
        useWindowState.getState().focusNode(p.nodeId, "note", { type: "end" });
      }}
    >
      {rec.note}
    </div>
  );
});
