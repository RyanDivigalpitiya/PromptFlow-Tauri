import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { api } from "../lib/api";
import { caretLineInfo, lastVisualLineStart } from "../lib/caret";
import { resolveKey, type EditorKey } from "../lib/keys";
import { Theme } from "../lib/layout";
import type { NodeRec } from "../lib/types";
import { applyWrap, wrapAction } from "../lib/wrap";
import {
  deleteAndFocusPrev,
  moveFocused,
  performDecision,
  pruneIfEmptyOnDefocus,
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

/** Static text render: bold runs + completed strike + highlight color, in spans. */
function StaticText({
  rec,
  highlightColor,
}: {
  rec: NodeRec;
  highlightColor: string;
}) {
  const text = rec.text;
  const segments: { text: string; bold: boolean }[] = [];
  if (rec.boldRanges.length >= 2) {
    // Clamp stale offsets instead of trapping (the BoldRuns.ranges contract).
    const marks = new Array<boolean>(text.length).fill(false);
    for (let i = 0; i + 1 < rec.boldRanges.length; i += 2) {
      const loc = Math.max(0, Math.min(rec.boldRanges[i], text.length));
      const end = Math.max(0, Math.min(loc + rec.boldRanges[i + 1], text.length));
      for (let j = loc; j < end; j++) marks[j] = true;
    }
    let cur = "";
    let curBold = marks[0] ?? false;
    for (let i = 0; i < text.length; i++) {
      if (marks[i] === curBold) {
        cur += text[i];
      } else {
        segments.push({ text: cur, bold: curBold });
        cur = text[i];
        curBold = marks[i];
      }
    }
    if (cur !== "") segments.push({ text: cur, bold: curBold });
  } else {
    segments.push({ text, bold: false });
  }
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
  return (
    <span className="node-text-static" style={style}>
      {segments.map((s, i) =>
        s.bold ? <b key={i}>{s.text}</b> : <span key={i}>{s.text}</span>,
      )}
      {text === "" && "​"}
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
 * the ONE focused row swaps in a textarea — the same single-live-editor economy the
 * SwiftUI app gets from first responder. */
export const RowEditor = memo(function RowEditor(p: RowEditorProps) {
  useSyncExternalStore(subscribeNode(p.nodeId), () => nodeVersion(p.nodeId));
  const rec = mirror.get(p.nodeId);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const staticRef = useRef<HTMLDivElement | null>(null);
  const [local, setLocal] = useState<string | null>(null);
  /** Texts sent to the store whose delta echoes haven't arrived yet. */
  const pendingSent = useRef<string[]>([]);

  const focusEpoch = useWindowState((s) => (p.isFocused ? s.focusEpoch : 0));
  const caretIntent = useWindowState((s) => (p.isFocused ? s.caretIntent : null));

  // Entering/leaving focus: seed/drop the local editing buffer.
  useEffect(() => {
    if (p.isFocused) {
      setLocal((cur) => cur ?? mirror.get(p.nodeId)?.text ?? "");
    } else {
      setLocal(null);
      pendingSent.current = [];
    }
  }, [p.isFocused, p.nodeId]);

  // Remote-edit adoption while focused (echo-guarded: our own in-flight texts are
  // acknowledged and skipped; anything else is a REAL remote change and wins).
  useEffect(() => {
    if (!p.isFocused || local === null || !rec) return;
    const idx = pendingSent.current.indexOf(rec.text);
    if (idx >= 0) {
      pendingSent.current.splice(0, idx + 1);
      return;
    }
    if (pendingSent.current.length === 0 && rec.text !== local) {
      setLocal(rec.text);
      const ta = taRef.current;
      if (ta) {
        const caret = Math.min(ta.selectionStart, rec.text.length);
        requestAnimationFrame(() => ta.setSelectionRange(caret, caret));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec?.text, p.isFocused]);

  // Apply focus + caret intent.
  useLayoutEffect(() => {
    if (!p.isFocused || !caretIntent) return;
    const ta = taRef.current;
    if (!ta) return;
    if (document.activeElement !== ta) ta.focus({ preventScroll: true });
    const len = ta.value.length;
    let at = len;
    if (caretIntent.type === "start") at = 0;
    else if (caretIntent.type === "end") at = len;
    else if (caretIntent.type === "at") at = Math.min(caretIntent.offset, len);
    else if (caretIntent.type === "lastLineStart") at = lastVisualLineStart(ta);
    ta.setSelectionRange(at, at);
  }, [p.isFocused, focusEpoch]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!rec) return null;

  const send = (text: string) => {
    pendingSent.current.push(text);
    void api.setText(p.nodeId, text);
  };

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setLocal(e.target.value);
    send(e.target.value);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;
    const value = ta.value;
    const selStart = ta.selectionStart;
    const selEnd = ta.selectionEnd;
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
        setLocal(r.text);
        send(r.text);
        requestAnimationFrame(() => ta.setSelectionRange(r.selStart, r.selEnd));
        return;
      }
    }

    // Command-modified shortcuts (the AutoSizingTextView.keyDown ports).
    if (meta && !e.altKey && !e.ctrlKey) {
      if (e.key === "1" || e.key === "2" || e.key === "3") {
        e.preventDefault();
        void setKindGuarded(
          p.nodeId,
          e.key === "1" ? "bulletPoint" : e.key === "2" ? "checkbox" : "promptDraft",
        );
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

    if (e.key === "Escape") {
      e.preventDefault();
      if (value === "") {
        void deleteAndFocusPrev(p.nodeId);
      } else {
        ta.blur();
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
      atFirstLine = caretLineInfo(ta, selStart).atFirstLine;
    }
    if (key === "moveDown" || key === "shiftMoveDown") {
      atLastLine = caretLineInfo(ta, selEnd).atLastLine;
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

    if (decision === "passthrough" || decision === "newline") {
      if (key === "tab" || key === "backtab") e.preventDefault();
      return; // let the textarea do its native thing
    }
    e.preventDefault();
    void performDecision(p.nodeId, decision, selStart, selEnd, value);
  };

  const onBlur = () => {
    const s = useWindowState.getState();
    if (s.focusId === p.nodeId && s.focusField === "main") s.clearFocus();
    setTimeout(() => void pruneIfEmptyOnDefocus(p.nodeId), 0);
  };

  if (p.isFocused) {
    const value = local ?? rec.text;
    return (
      <div className="grow-wrap" data-value={value}>
        <textarea
          ref={taRef}
          className="node-textarea"
          value={value}
          rows={1}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
      </div>
    );
  }

  return (
    <div
      ref={staticRef}
      className="node-text-wrap"
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        // Without this, the mousedown's DEFAULT action (post-handler focus steal to
        // body) blurs the textarea the click just focused.
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
          staticRef.current &&
          textOffsetFromPoint(staticRef.current, e.clientX, e.clientY);
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

/** The secondary note line (⌘⇧N) — smaller, grey, below the text. Rendered only
 * while non-empty or focused. */
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
            setTimeout(() => void pruneIfEmptyOnDefocus(p.nodeId), 0);
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
