import { useEffect, useState } from "react";
import { FocusPane } from "./components/FocusPane";
import { OutlineView } from "./components/OutlineView";
import { SettingsPanel } from "./components/SettingsPanel";
import { TopBar } from "./components/TopBar";
import { api, onRowMenuAction } from "./lib/api";
import { endAnimNow } from "./state/collapseAnim";
import {
  collapseSelectionToCaret,
  copyBlock,
  deleteBlockAndFocus,
  holdVisible,
  indentTargetParent,
  mergeSelectionIntoPrompt,
  performRowMenuAction,
  setCollapsed,
  setCollapsedAll,
} from "./state/controller";
import { mirror, startMirror, subscribeStructure } from "./state/mirror";
import { selectionIds, useSelection } from "./state/selection";
import { useSettings } from "./state/settings";
import { useWindowState } from "./state/windowState";

/** Keys while a NODE selection is live (nothing is first responder then) — the
 * OutlineSelectionKeyMonitor port. Runs in capture phase; every combo it doesn't
 * claim passes through. */
function handleSelectionKey(e: KeyboardEvent): boolean {
  const sel = useSelection.getState();
  if (!sel.isActive()) return false;
  const ids = selectionIds();
  const s = useWindowState.getState();
  const done = () => {
    e.preventDefault();
    e.stopPropagation();
    sel.refresh();
  };
  if (e.key === "Escape") {
    // No ⋯-menu guard needed: that menu is a native NSMenu running AppKit's own modal
    // loop, so while it's open Escape closes IT and never reaches the webview at all.
    // One layer per press, for free.
    e.preventDefault();
    sel.clear();
    return true;
  }
  if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    const dir = e.key === "ArrowUp" ? -1 : 1;
    if (e.shiftKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      sel.step(dir, s.hideCompleted);
      return true;
    }
    if (e.altKey && !e.metaKey) {
      void api.moveBlockBy(ids, dir, s.hideCompleted).then(() => sel.refresh());
      done();
      return true;
    }
    if (!e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
      // A BARE arrow ends the selection and puts the caret back in the outline, just
      // outside the block. Nothing is first responder while a selection is live, so
      // before this the key fell through to no one and the selection was a dead end.
      e.preventDefault();
      e.stopPropagation();
      collapseSelectionToCaret(dir);
      return true;
    }
  }
  if (e.key === "Tab" && !e.metaKey) {
    if (e.shiftKey) {
      void api.outdentBlock(ids).then(() => sel.refresh());
    } else {
      // Expand the destination BEFORE the invoke — same reason as the single-node Tab
      // (see indentTargetParent). `ids[0]` is the block's first node in sibling order,
      // matching Rust's normalized_block, because a selection is a contiguous
      // one-level sibling range.
      const target = indentTargetParent(ids[0], s.hideCompleted);
      if (target) s.expandMany([target]);
      void api.indentBlock(ids, s.hideCompleted).then((out) => {
        s.expandMany(out.expand);
        sel.refresh();
      });
    }
    done();
    return true;
  }
  if (e.metaKey && e.key === "Enter") {
    // Mirrors controller.toggleCompleted: arm the grace BEFORE the invoke, as ONE hold,
    // so the whole block waits and then leaves in a single animation.
    if (s.hideCompleted) {
      holdVisible(ids.filter((id) => !mirror.get(id)?.isCompleted));
    }
    void api.toggleCompletedBlock(ids).then(() => sel.refresh());
    done();
    return true;
  }
  if (
    e.metaKey &&
    !e.shiftKey &&
    !e.altKey &&
    !e.ctrlKey &&
    (e.key === "b" || e.key === "B")
  ) {
    // Whole-text bold across the block, as a UNIFORM toggle (Store::toggle_bold_block).
    // The per-character ⌘B lives in RowEditor and needs a caret; nothing is first
    // responder while a selection is live, so this is the only place it can land.
    void api.toggleBoldBlock(ids).then(() => sel.refresh());
    done();
    return true;
  }
  if (e.metaKey && (e.key === "1" || e.key === "2" || e.key === "3")) {
    const kind =
      e.key === "1" ? "bulletPoint" : e.key === "2" ? "checkbox" : "promptDraft";
    // ⌘3 over two-or-more NON-prompt nodes FOLDS them into a single prompt — the whole
    // tinted block, members and their subtrees alike, becomes its INDENTED "- " list and
    // every folded node is deleted (Store::merge_into_prompt) — rather than converting
    // each into a prompt of its own. That is the "collect these lines into a prompt"
    // gesture; a prompt already inside the range means the user is converting a mixed
    // selection instead, so that falls through to the per-node form.
    // Dividers are inert to ⌘1/2/3, so they neither count toward the two nor block it.
    // The prompt test is MEMBER-level, like the count: a draft nested somewhere inside a
    // member's subtree is content being collected, not a sign the user meant to convert.
    const foldable = ids.filter((id) => {
      const k = mirror.get(id)?.kind;
      return k !== undefined && k !== "line";
    });
    if (
      kind === "promptDraft" &&
      foldable.length > 1 &&
      foldable.every((id) => mirror.get(id)?.kind !== "promptDraft")
    ) {
      e.preventDefault();
      e.stopPropagation();
      void mergeSelectionIntoPrompt(foldable);
      return true;
    }
    void api.setKindBlock(ids, kind).then(() => sel.refresh());
    done();
    return true;
  }
  if (e.metaKey && (e.key === "c" || e.key === "C") && !e.shiftKey) {
    void copyBlock(ids);
    e.preventDefault();
    e.stopPropagation();
    return true;
  }
  if ((e.key === "Backspace" || e.key === "Delete") && !e.metaKey) {
    // Clears the selection AND lands the caret where the block was — deleting used to
    // leave nothing focused, so the cursor simply vanished.
    void deleteBlockAndFocus(ids);
    e.preventDefault();
    e.stopPropagation();
    return true;
  }
  return false;
}

/** Controls that are USING the live selection rather than leaving it behind — the glyph
 * column, which drags the whole block. Everything else drops it. */
const SELECTION_KEEPING_PRESS = ".glyph-slot, .prompt-line-bullet";

/** Any plain press outside a live selection drops it. The outline's own handlers only
 * covered rows and the blank background, so pressing a row's chevron/+/zoom/⋯, the top
 * bar, the focus pane or the settings popover left a tinted block on screen with nothing
 * acting on it — it read as stuck.
 *
 * Window-level and CAPTURE phase, so it resolves before React's root listeners and
 * therefore before `selectionMouseDown` reads the anchor. Two exemptions:
 *   • SHIFT, because that press EXTENDS the selection — RowEditor's static branch and the
 *     mouse sweep both resolve their range from the surviving anchor.
 *   • a glyph press on a row that is itself a MEMBER, because that drags the whole block:
 *     `dragGesture` reads `selectionIds()` at its 4px threshold, long after this ran.
 * The modifier guard otherwise matches `selectionMouseDown`'s, so "is this a plain press"
 * has ONE definition across the two handlers.
 *
 * `Element`, not `HTMLElement`: half the glyph column is SVG (`<circle>`, `<path>`), and
 * an instanceof HTMLElement test would miss exactly the presses the exemption is for. */
function clearSelectionOnOutsidePress(e: MouseEvent) {
  if (e.button !== 0 || e.shiftKey || e.metaKey || e.altKey || e.ctrlKey) return;
  const sel = useSelection.getState();
  if (!sel.isActive()) return;
  const t = e.target instanceof Element ? e.target : null;
  if (t && t.closest(SELECTION_KEEPING_PRESS) && t.closest(".node-row.selected")) {
    return;
  }
  sel.clear();
}

export default function App() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void startMirror().then(() => setReady(true));
  }, []);

  // Deleted nodes must never linger as focus/drill/history targets.
  useEffect(() => {
    return mirror.onDeleted((ids) => useWindowState.getState().purgeDeleted(ids));
  }, []);

  // A structural change can move/remove selection members — re-resolve.
  useEffect(() => {
    return subscribeStructure(() => useSelection.getState().refresh());
  }, []);

  // A press anywhere outside the selection ends it (see the handler for the two presses
  // that are exempt). Window-level so it also covers the chrome the outline never sees.
  useEffect(() => {
    window.addEventListener("mousedown", clearSelectionOnOutsidePress, true);
    return () =>
      window.removeEventListener("mousedown", clearSelectionOnOutsidePress, true);
  }, []);

  // Native row (⋯) menu selections arrive as events from Rust — run them here.
  useEffect(() => {
    const un = onRowMenuAction((action, node) => {
      void performRowMenuAction(action, node);
    });
    return () => void un.then((f) => f());
  }, []);

  // Trackpad pinch → font size (the MagnifyGesture port): WebKit delivers pinch as
  // proprietary gesture events with a cumulative scale; size = anchor × scale,
  // rounded and clamped, exactly like the SwiftUI app. Some configurations send
  // ctrl+wheel instead — same mapping through an accumulated float.
  useEffect(() => {
    let anchor = 0;
    const start = (e: Event) => {
      e.preventDefault();
      anchor = useWindowState.getState().fontSize;
    };
    const change = (e: Event) => {
      e.preventDefault();
      const scale = (e as { scale?: number }).scale;
      if (anchor > 0 && typeof scale === "number") {
        // A scale change invalidates every px offset an animation is mid-way through
        // (indents, drawer height), and a pinch is not a wheel event, so
        // OutlineView's onWheel guard never sees it. Cheap when nothing is running.
        endAnimNow();
        useWindowState.getState().setFont(anchor * scale);
      }
    };
    const end = (e: Event) => {
      e.preventDefault();
      anchor = 0;
    };
    let wheelFloat: number | null = null;
    let wheelReset: ReturnType<typeof setTimeout> | null = null;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return; // plain wheel = scroll
      e.preventDefault();
      const s = useWindowState.getState();
      if (wheelFloat === null) wheelFloat = s.fontSize;
      wheelFloat = Math.min(40, Math.max(9, wheelFloat * Math.exp(-e.deltaY * 0.01)));
      s.setFont(wheelFloat);
      if (wheelReset) clearTimeout(wheelReset);
      wheelReset = setTimeout(() => {
        wheelFloat = null;
      }, 300);
    };
    window.addEventListener("gesturestart", start, { passive: false });
    window.addEventListener("gesturechange", change, { passive: false });
    window.addEventListener("gestureend", end, { passive: false });
    window.addEventListener("wheel", wheel, { passive: false });
    return () => {
      window.removeEventListener("gesturestart", start);
      window.removeEventListener("gesturechange", change);
      window.removeEventListener("gestureend", end);
      window.removeEventListener("wheel", wheel);
    };
  }, []);

  // Window-level shortcuts (the OutlineView keyboardShortcuts / commands port).
  useEffect(() => {
    const onSelKey = (e: KeyboardEvent) => {
      handleSelectionKey(e);
    };
    window.addEventListener("keydown", onSelKey, true);
    const onKey = (e: KeyboardEvent) => {
      const s = useWindowState.getState();
      // ⌥⇧F toggles the focus pane. It carries no ⌘, so it must resolve BEFORE the
      // ⌘ gate below. Matched on e.code, NEVER e.key: macOS rewrites the character
      // under Option (⌥⇧F yields "Ï"), so e.key has no usable identity here — and
      // the preventDefault is what stops that "Ï" being typed into a focused editor.
      if (e.altKey && e.shiftKey && !e.metaKey && !e.ctrlKey && e.code === "KeyF") {
        e.preventDefault();
        s.toggleFocusPane();
        return;
      }
      const meta = e.metaKey;
      if (!meta) return;
      if (import.meta.env.DEV && e.ctrlKey && e.shiftKey && e.code === "Digit7") {
        // Dev: ⌘⌃⇧7 seeds a large synthetic tree for performance testing. DEV-gated: the
        // seed_demo command ships registered, so an ungated hook let ⌘⌃⇧7 inject ~11k
        // nodes into the user's real outline in a release build.
        e.preventDefault();
        void api.seedDemo(40, 25, 10).then((n) => console.log(`seeded ${n}`));
      } else if (import.meta.env.DEV && e.ctrlKey && e.shiftKey && e.code === "Digit8") {
        // Dev: ⌘⌃⇧8 measures the idle rAF ceiling (no animation) — tells 60Hz-capped
        // webview apart from animation jank.
        e.preventDefault();
        void import("./state/perfMeter").then((m) =>
          m.measureFrames("idle-baseline", 600),
        );
      } else if (!e.shiftKey && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        endAnimNow(); // a scale change invalidates in-flight px offsets — see the pinch
        s.adjustFont(1);
      } else if (!e.shiftKey && e.key === "-") {
        e.preventDefault();
        endAnimNow();
        s.adjustFont(-1);
      } else if (!e.shiftKey && e.key === "0") {
        e.preventDefault();
        endAnimNow();
        s.resetFont();
      } else if (e.key === "[") {
        e.preventDefault();
        s.goBack();
      } else if (e.key === "]") {
        e.preventDefault();
        s.goForward();
      } else if (e.shiftKey && (e.key === "d" || e.key === "D")) {
        e.preventDefault();
        setCollapsedAll(false); // ⌘⇧D expand all (per window)
      } else if (e.shiftKey && (e.key === "e" || e.key === "E")) {
        e.preventDefault();
        setCollapsedAll(true); // ⌘⇧E collapse all (per window)
      } else if (!e.shiftKey && !e.altKey && (e.key === "e" || e.key === "E")) {
        // ⌘E collapse / ⌘D expand the focused node (the setCollapsedFocused
        // port) — no-ops without a focused parent node, like the original.
        e.preventDefault();
        if (s.focusId && mirror.hasChildren(s.focusId))
          setCollapsed(s.focusId, true);
      } else if (!e.shiftKey && !e.altKey && (e.key === "d" || e.key === "D")) {
        e.preventDefault();
        if (s.focusId && mirror.hasChildren(s.focusId))
          setCollapsed(s.focusId, false);
      } else if (!e.shiftKey && (e.key === "z" || e.key === "Z")) {
        // Normally consumed by the native Edit menu; fallback if it wasn't.
        e.preventDefault();
        void api.undo();
      } else if (e.shiftKey && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        void api.redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keydown", onSelKey, true);
    };
  }, []);

  const bgTint = useSettings((s) => s.bgTint);
  const shellStyle = {
    background: `rgba(10, 10, 14, ${bgTint})`,
  } as React.CSSProperties;

  const focusLayout = useWindowState((s) => s.focusPaneLayout);

  if (!ready) return <div className="app-shell" style={shellStyle} />;
  return (
    <div className="app-shell" style={shellStyle}>
      <TopBar />
      {/* The focus pane and the outline share a grid whose areas restack: "top" stacks
          them (focus strip above outline), "sidebar" puts them side by side (focus left).
          Both stay MOUNTED across the switch, so it never remounts the outline. */}
      <div className={"app-body" + (focusLayout === "sidebar" ? " sidebar" : "")}>
        <FocusPane />
        <OutlineView />
      </div>
      <SettingsPanel />
    </div>
  );
}
