import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { selectionOffsets, serializeEditor, setSelectionOffsets } from "../lib/caret";
import { deleteKind, deleteRange } from "../lib/deleteRange";
import { resolveKey } from "../lib/keys";
import { OutlineLayout } from "../lib/layout";
import { bulletAtCaret, hasMarkdown, indentLines } from "../lib/mdLines";
import { buildRunDom, type StyleSet } from "../lib/runs";
import { TextHistory, type EditKind, type TextSnap } from "../lib/textHistory";
import { applyWrap, wrapAction } from "../lib/wrap";
import { useSelection } from "../state/selection";
import { useTemplateEditor, type TemplateDraft } from "../state/templateEditor";
import { useWindowState } from "../state/windowState";

/** A template is plain text: `apply_template` clears a node's style runs, so there are
 * none to edit here. One frozen empty set, so `buildRunDom`'s comparison sees the same
 * thing every time. */
const NO_STYLES: StyleSet = Object.freeze({ bold: [], italic: [], underline: [] }) as StyleSet;

/** The template body: a controlled contenteditable that renders EXACTLY as a prompt
 * node's text does — the same `buildRunDom` (one block per markdown line, dimmed
 * markers, heading sizes, measured list hangs), the same `.md-line` stylesheet, the same
 * row line-height, at the outline's own font size — and edits the way a prompt does:
 * Enter carries a bullet and ends an empty one, Tab/⇧Tab nest lines, a typed delimiter
 * wraps a selection, and an edit that crosses a line boundary in markdown is computed in
 * the model rather than left to WebKit's paragraph logic (see `lib/deleteRange.ts`).
 *
 * It is a SEPARATE component from `RowEditor` on purpose: that one is bound to a node
 * record (the store echo guard, style runs, the outline's focus model, caret paths
 * between nodes), none of which a template has. What the two share is everything below
 * the component — the renderer, the caret mapping and the editing rules — so they cannot
 * render or edit a line differently.
 *
 * The same text-substitution rules apply as in RowEditor: no `spellCheck={false}` (it
 * is WebKit's hard gate on macOS Text Replacement), and `buildRunDom` skips the rebuild
 * when the DOM already matches, so a substitution pass is never handed a detached tree. */
function MarkdownEditor(p: {
  initial: string;
  fontSize: number;
  autoFocus: boolean;
  placeholder: string;
  onChange(text: string): void;
}) {
  const edRef = useRef<HTMLDivElement | null>(null);
  const [value, setValue] = useState(p.initial);
  /** Bumped to force a rebuild check when the text did not change (stray browser DOM). */
  const [epoch, setEpoch] = useState(0);
  const caretReq = useRef<{ start: number; end: number } | null>(null);
  const composing = useRef(false);
  const history = useRef(new TextHistory());
  /** The state at the last keydown — what a NATIVE edit (ordinary typing, which only
   * shows up afterwards as `input`) is undone back to. */
  const before = useRef<TextSnap | null>(null);
  const md = hasMarkdown(value);

  useLayoutEffect(() => {
    const el = edRef.current;
    if (!el || composing.current) return;
    const rebuilt = buildRunDom(el, value, NO_STYLES, md, p.fontSize);
    const req = caretReq.current;
    if (req && document.activeElement === el) {
      // Same rule as RowEditor: never touch a selection that is already right — a
      // redundant addRange fires selectionchange and unseats text substitution.
      const cur = rebuilt ? null : selectionOffsets(el);
      if (!cur || cur.start !== req.start || cur.end !== req.end) {
        setSelectionOffsets(el, req.start, req.end);
      }
      caretReq.current = null;
    }
  }, [value, epoch, md, p.fontSize]);

  // Declared after the builder: layout effects run in order, and the caret needs the
  // run DOM to exist.
  useLayoutEffect(() => {
    const el = edRef.current;
    if (!p.autoFocus || !el) return;
    el.focus({ preventScroll: true });
    setSelectionOffsets(el, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const adopt = (next: string, start: number, end: number) => {
    caretReq.current = { start, end };
    setValue(next);
    setEpoch((v) => v + 1);
    p.onChange(next);
  };

  /** A model-computed edit: recorded, rendered, caret restored. */
  const commit = (
    next: string,
    start: number,
    end: number,
    kind: EditKind,
    from: TextSnap,
  ) => {
    history.current.record(from, kind);
    adopt(next, start, end);
  };

  const onInput = () => {
    const el = edRef.current;
    if (!el || composing.current) return;
    const next = serializeEditor(el);
    const sel = selectionOffsets(el);
    const at = sel?.start ?? next.length;
    if (next === value) {
      caretReq.current = { start: at, end: sel?.end ?? at };
      setEpoch((v) => v + 1);
      return;
    }
    history.current.record(before.current ?? { text: value, start: at, end: at }, "type");
    before.current = null;
    caretReq.current = { start: at, end: sel?.end ?? at };
    setValue(next);
    p.onChange(next);
  };

  const insert = (ins: string, kind: EditKind) => {
    const el = edRef.current;
    if (!el) return;
    const sel = selectionOffsets(el) ?? { start: value.length, end: value.length };
    const at = sel.start + ins.length;
    commit(value.slice(0, sel.start) + ins + value.slice(sel.end), at, at, kind, {
      text: value,
      ...sel,
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (composing.current || e.nativeEvent.isComposing) return;
    const el = e.currentTarget;
    const sel = selectionOffsets(el) ?? { start: value.length, end: value.length };
    const { start, end } = sel;
    const here: TextSnap = { text: value, start, end };
    const meta = e.metaKey;
    before.current = here;

    // ⌘Z / ⇧⌘Z undo THIS FIELD. preventDefault is what keeps them from falling through
    // to the native Edit ▸ Undo, which is the OUTLINE's (the store's global history);
    // stopPropagation keeps App's window fallback from doing the same.
    if (meta && !e.altKey && !e.ctrlKey && (e.key === "z" || e.key === "Z")) {
      e.preventDefault();
      e.stopPropagation();
      const snap = e.shiftKey ? history.current.redo(here) : history.current.undo(here);
      if (snap) adopt(snap.text, snap.start, snap.end);
      return;
    }
    // ⌘S / ⌘Enter belong to the sheet (they save); let them bubble untouched.
    if (meta && (e.key === "Enter" || e.key === "s" || e.key === "S")) return;
    // ⌘B/⌘I/⌘U: a template has no style runs, and the browser's own rich-text engine
    // must never get to mutate a controlled editor's DOM.
    if (meta && !e.altKey && !e.ctrlKey && !e.shiftKey && /^[biu]$/i.test(e.key)) {
      e.preventDefault();
      return;
    }

    // A typed delimiter over a selection wraps / unwraps it, as in a node.
    if (!meta && !e.ctrlKey && !e.altKey && e.key.length === 1 && start !== end) {
      const action = wrapAction(e.key, value, start, end);
      if (action) {
        e.preventDefault();
        const r = applyWrap(action, e.key, value, start, end);
        commit(r.text, r.selStart, r.selEnd, "edit", here);
        return;
      }
    }

    // Markdown's two places where WebKit's paragraph model takes over a printable key:
    // replacing a selection that spans lines, and typing at a line start (RowEditor has
    // the measurements).
    if (
      md &&
      !meta &&
      !e.ctrlKey &&
      !e.altKey &&
      e.key.length === 1 &&
      (start !== end
        ? value.slice(start, end).includes("\n")
        : start > 0 && value[start - 1] === "\n")
    ) {
      e.preventDefault();
      const at = start + e.key.length;
      commit(value.slice(0, start) + e.key + value.slice(end), at, at, "type", here);
      return;
    }

    // A delete that crosses a line boundary in markdown is spliced in the model.
    if (md && value !== "") {
      const kind = deleteKind(e.nativeEvent);
      if (kind) {
        const r = deleteRange(kind, value, start, end);
        if (value.slice(r.from, r.to).includes("\n")) {
          e.preventDefault();
          commit(value.slice(0, r.from) + value.slice(r.to), r.from, r.from, "edit", here);
          return;
        }
      }
    }

    if (e.key === "Enter" && !meta && !e.ctrlKey) {
      // Routed through the SAME truth table a prompt node uses, so a bullet carries and
      // an empty one ends the list exactly as it does there. ⌥Enter — a new NODE in a
      // prompt — has no node to make here, and is just a line break.
      e.preventDefault();
      const bullet = bulletAtCaret(value, start, end);
      const decision = resolveKey("enter", {
        isPrompt: true,
        bulletLine: bullet !== null,
        bulletBodyEmpty: bullet?.bodyEmpty ?? false,
        shift: e.shiftKey,
        cmd: false,
        opt: e.altKey,
        caretAtStartEmpty: value === "",
        atFirstLine: false,
        atLastLine: false,
      });
      if (decision === "endBullet" && bullet) {
        const at = bullet.lineStart;
        commit(value.slice(0, at) + value.slice(bullet.markerEnd), at, at, "edit", here);
      } else if (decision === "newlineBullet" && bullet) {
        const ins = "\n" + bullet.marker;
        const at = start + ins.length;
        commit(value.slice(0, start) + ins + value.slice(end), at, at, "edit", here);
      } else {
        const at = start + 1;
        commit(value.slice(0, start) + "\n" + value.slice(end), at, at, "type", here);
      }
      return;
    }

    // Tab / ⇧Tab nest the lines the selection touches. In a prompt NODE that is a list
    // line's job only, because elsewhere Tab moves the node; a template has no node to
    // move, so every line nests.
    if (e.key === "Tab" && !meta && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const r = indentLines(value, start, end, !e.shiftKey);
      if (r) commit(r.text, r.start, r.end, "edit", here);
    }
  };

  return (
    <div
      className="tpl-body"
      style={{ fontSize: p.fontSize }}
      onMouseDown={(e) => {
        // A press in the box's own padding (not on a line): put the caret at the end,
        // the way a press in a prompt panel's blank space opens its editor.
        if (e.target !== e.currentTarget || e.button !== 0) return;
        e.preventDefault();
        const el = edRef.current;
        if (!el) return;
        el.focus({ preventScroll: true });
        setSelectionOffsets(el, value.length);
      }}
    >
      {value === "" && (
        <div className="tpl-placeholder" aria-hidden="true">
          {p.placeholder}
        </div>
      )}
      <div
        ref={edRef}
        className="tpl-editor"
        contentEditable
        role="textbox"
        aria-multiline="true"
        aria-label="Template text"
        onInput={onInput}
        onKeyDown={onKeyDown}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
          onInput();
        }}
        onPaste={(e) => {
          e.preventDefault();
          insert(e.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n"), "edit");
        }}
        onCopy={(e) => {
          // RAW text, never the browser's styled-HTML flavour (it would carry the
          // heading sizes and marker colours into whatever it is pasted into).
          e.preventDefault();
          const el = edRef.current;
          const sel = el ? selectionOffsets(el) : null;
          if (sel && sel.start !== sel.end)
            e.clipboardData.setData("text/plain", value.slice(sel.start, sel.end));
        }}
        onCut={(e) => {
          e.preventDefault();
          const el = edRef.current;
          const sel = el ? selectionOffsets(el) : null;
          if (!sel || sel.start === sel.end) return;
          e.clipboardData.setData("text/plain", value.slice(sel.start, sel.end));
          commit(value.slice(0, sel.start) + value.slice(sel.end), sel.start, sel.start, "edit", {
            text: value,
            ...sel,
          });
        }}
      />
    </div>
  );
}

/** The sheet itself: name, body, and Delete / Cancel / Save. Mounted per open (keyed on
 * the draft's epoch), so it always starts from what the backend had. */
function TemplateEditorSheet({ draft }: { draft: TemplateDraft }) {
  const close = useTemplateEditor((s) => s.close);
  const fontSize = useWindowState((s) => s.fontSize);
  const [name, setName] = useState(draft.name);
  const [body, setBody] = useState(draft.body);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const isNew = draft.id === null;
  // The chrome rides ⌘+/⌘− the way the Settings sheet does; the BODY renders at the
  // outline's own font size, because it has to look exactly like the prompt it becomes.
  const ss = Math.min(Math.max(OutlineLayout.scale(fontSize), 0.9), 2.2);
  const dirty = name !== draft.name || body !== draft.body;
  const canSave = name.trim() !== "" && body.trim() !== "" && !busy;

  // A modal owns the window: whatever the outline had (a caret, a node selection) must
  // not keep taking keys behind it. Focusing the sheet blurs a row editor, which clears
  // the outline's focus the ordinary way.
  useEffect(() => {
    useSelection.getState().clear();
    if (isNew) nameRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const requestClose = () => {
    if (dirty && !window.confirm("Discard your changes to this template?")) return;
    close();
  };

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      await api.savePromptTemplate(draft.id, name, body);
      close();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const remove = async () => {
    if (draft.id === null) return;
    if (!window.confirm(`Delete “${draft.name}”? This cannot be undone.`)) return;
    try {
      await api.deletePromptTemplate(draft.id);
      close();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div
      className="tpl-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      {/* The backdrop covers the TopBar strip, which is the window's drag handle — so
          the strip it covers drags the window too. */}
      <div className="tpl-drag-strip" data-tauri-drag-region />
      <div
        className="tpl-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tpl-sheet-title"
        style={{ fontSize: 13 * ss }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            requestClose();
            return;
          }
          const meta = e.metaKey && !e.altKey && !e.ctrlKey;
          if (meta && (e.key === "s" || e.key === "S" || e.key === "Enter")) {
            e.preventDefault();
            e.stopPropagation();
            void save();
            return;
          }
          if (meta && (e.key === "z" || e.key === "Z")) {
            // Only the NAME field gets here (the body claims its own ⌘Z). Its native
            // undo, asked for directly — left unhandled, ⌘Z falls through to the Edit
            // menu's Undo, which is the outline's.
            e.preventDefault();
            e.stopPropagation();
            document.execCommand(e.shiftKey ? "redo" : "undo");
          }
        }}
      >
        <div className="tpl-head">
          <span id="tpl-sheet-title">{isNew ? "New Template" : "Edit Template"}</span>
          <button className="bar-btn" onClick={requestClose} aria-label="Close" title="Close (Esc)">
            ✕
          </button>
        </div>
        <label className="tpl-field">
          <span>Name</span>
          <input
            ref={nameRef}
            type="text"
            className="tpl-name"
            value={name}
            maxLength={80}
            placeholder="e.g. New Feature: Plan"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              // Enter moves on to the body — a name is one line, and the body is what
              // you came to write.
              if (e.key !== "Enter" || e.metaKey || e.nativeEvent.isComposing) return;
              e.preventDefault();
              document.querySelector<HTMLElement>(".tpl-editor")?.focus();
            }}
          />
        </label>
        <div className="tpl-field tpl-field-body">
          <span>Template</span>
          <MarkdownEditor
            initial={draft.body}
            fontSize={fontSize}
            autoFocus={!isNew}
            placeholder="# Heading, - bullet, 1. numbered — rendered as a prompt renders them"
            onChange={setBody}
          />
        </div>
        {error && (
          <div className="tpl-error" role="alert">
            {error}
          </div>
        )}
        <div className="tpl-actions">
          {!isNew && (
            <button className="tpl-btn tpl-btn-danger" onClick={() => void remove()}>
              Delete…
            </button>
          )}
          <span className="tpl-hint">⌘S to save · Esc to close</span>
          <button className="tpl-btn" onClick={requestClose}>
            Cancel
          </button>
          <button
            className="tpl-btn tpl-btn-primary"
            disabled={!canSave}
            onClick={() => void save()}
          >
            {isNew ? "Create" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Mounted once in App; renders nothing until the Templates menu opens a draft. */
export function TemplateEditor() {
  const draft = useTemplateEditor((s) => s.draft);
  if (!draft) return null;
  return <TemplateEditorSheet key={draft.epoch} draft={draft} />;
}
