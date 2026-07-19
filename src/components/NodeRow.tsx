import { memo, useSyncExternalStore, type CSSProperties } from "react";
import { api } from "../lib/api";
import { OutlineLayout } from "../lib/layout";
import { addRelative, drillInto, toggleCollapse } from "../state/controller";
import { glyphMouseDown } from "../state/dragGesture";
import { mirror, nodeVersion, subscribeNode } from "../state/mirror";
import {
  completingVersion,
  isCompleting,
  subscribeCompleting,
} from "../state/rowAnim";
import { useWindowState } from "../state/windowState";
import { Glyph, useKindMorph } from "./Glyphs";
import { NoteEditor, RowEditor } from "./RowEditor";

/** Chevron + hover-revealed "+" / zoom / ⋯ hugging the end of the text (the
 * RowTrailingCluster port). Reveal is pure CSS :hover on the first line — no JS
 * hover state, so pointer movement re-renders nothing (the RowHoverBox lesson,
 * solved at the platform level). Everything scales with the row font (⌘+/⌘−):
 * slots via disclosureWidth, glyphs via a scaled SVG size / em font sizes.
 * A LEAF renders no chevron slot at all (SwiftUI parity) so the hover actions
 * hug the last character without a phantom gap. */
function TrailingCluster(p: {
  nodeId: string;
  hasChildren: boolean;
  isCollapsed: boolean;
  isLine: boolean;
  isDrillRoot: boolean;
  fontSize: number;
}) {
  const slot = OutlineLayout.disclosureWidth(p.fontSize);
  const icon = Math.round(10 * OutlineLayout.scale(p.fontSize));
  // A drilled-into node is always shown expanded and can't be collapsed (collapsing
  // your zoom root would empty the view) — its chevron is locked open.
  const collapsedDisplay = p.isCollapsed && !p.isDrillRoot;

  // No preventDefault on these buttons' mousedown: pressing ANY row control is
  // meant to defocus a node being edited (the natural focus steal does it).
  return (
    <span className="trailing-cluster" style={{ height: OutlineLayout.lineHeight(p.fontSize) }}>
      {p.hasChildren && (
        <button
          className={
            "chevron" +
            (collapsedDisplay ? " collapsed" : "") +
            (p.isDrillRoot ? " locked" : "")
          }
          style={{ width: slot }}
          tabIndex={-1}
          onClick={p.isDrillRoot ? undefined : () => toggleCollapse(p.nodeId)}
          aria-label={
            p.isDrillRoot
              ? "Expanded (zoomed in)"
              : collapsedDisplay
                ? "Expand"
                : "Collapse"
          }
        >
          <svg width={icon} height={icon} viewBox="0 0 10 10">
            <path d="M2 3.5 L5 6.5 L8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
      <span className="row-actions">
        <button
          className="row-action"
          style={{ width: slot }}
          tabIndex={-1}
          onClick={() => void addRelative(p.nodeId)}
          aria-label="Add node"
        >
          +
        </button>
        {!p.isLine && (
          <button
            className="row-action"
            style={{ width: slot }}
            tabIndex={-1}
            onClick={() => drillInto(p.nodeId)}
            aria-label="Zoom in"
          >
            {/* Reproduction of the SF Symbol `text.line.2.summary` (SF Symbols can't
                be referenced by name in a WebKit view — all icons here are inline
                SVG): two text lines feeding an L-shaped flow arrow. */}
            <svg
              width={Math.round(12 * OutlineLayout.scale(p.fontSize))}
              height={Math.round(11 * OutlineLayout.scale(p.fontSize))}
              viewBox="0 0 22 20"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="10" y1="5" x2="20" y2="5" />
              <line x1="10" y1="9.5" x2="16" y2="9.5" />
              <path d="M5 4 V11 a4 4 0 0 0 4 4 H15" />
              <path d="M15 11.8 L20.5 15 L15 18.2 Z" fill="currentColor" strokeWidth={1} />
            </svg>
          </button>
        )}
        <button
          className="row-action"
          style={{ width: slot }}
          tabIndex={-1}
          onClick={(e) => {
            // Open the NATIVE macOS row menu at the button, dropping down from its
            // bottom-left. Rust builds the items per node kind and routes the
            // selection back as a `row-menu-action` event (see controller).
            const r = e.currentTarget.getBoundingClientRect();
            void api.popupRowMenu(p.nodeId, r.left, r.bottom);
          }}
          aria-label="Node menu"
        >
          ⋯
        </button>
      </span>
    </span>
  );
}

/** Faint vertical guides — one per ancestor level at the ancestor's glyph column.
 * Anchored on the ROW element (guideX measures from the document's leading edge +
 * documentHInset), so every guide falls inside the row's empty indent gutter. A guide
 * "run" is the contiguous column of rows at ≥ that level; only the run's two END
 * segments get an inset, so the line reads as one solid stroke with clear air at its
 * top (below the parent's dot) and bottom (above the next node) — never dashed. */
function IndentGuides(p: {
  depth: number;
  /** Depth of the PREVIOUS rendered row (−1 if none) — a level's run STARTS on this
   * row when `level > prevDepth`, so that segment gets a top gap. */
  prevDepth: number;
  /** Depth of the NEXT rendered row (−1 if none) — a level's run ENDS on this row
   * when `level > nextDepth`, so that segment gets a bottom gap. */
  nextDepth: number;
  fontSize: number;
  color: string;
}) {
  // The 1px guide is CENTERED on the glyph column (left = column − ½·width), not
  // hung off its left edge — so it lines up with the prompt bar and the checkbox/
  // bullet glyphs, which are all centered on that same column. (The prompt bar is
  // 2/3px and the guide 1px; centering both on the column is the closest they can
  // sit given the odd/even widths.)
  const scale = OutlineLayout.scale(p.fontSize);
  const GUIDE_W = 1;
  const colLeft = (level: number) =>
    OutlineLayout.documentHInset + OutlineLayout.guideX(level, p.fontSize) - GUIDE_W / 2;
  const endGap = 9 * scale;
  const lines = [];
  for (let level = 1; level <= p.depth; level++) {
    lines.push(
      <span
        key={level}
        className="indent-guide"
        style={{
          left: colLeft(level),
          background: p.color,
          top: level > p.prevDepth ? endGap : undefined,
          bottom: level > p.nextDepth ? endGap : undefined,
        }}
      />,
    );
  }
  return <>{lines}</>;
}

export interface NodeRowProps {
  nodeId: string;
  depth: number;
  /** Depth of the prev/next rendered rows (−1 if none) — for indent-guide end gaps. */
  prevDepth: number;
  nextDepth: number;
  hasChildren: boolean;
  isCollapsed: boolean;
  isFocused: boolean;
  isNoteFocused: boolean;
  isDrillRoot: boolean;
  /** Newly revealed by the in-flight expand — plays the entrance fade. Passed in
   * (not read from the store here) so it clears when the animation ends: this
   * component is memo'd and would otherwise keep a stale class. */
  isEntering: boolean;
  /** Horizontal FLIP offset in px while a Tab/⇧Tab/undo reparent glides: the row is
   * already laid out at its NEW indent, and this shifts it back to where it was
   * painted so it can transition forward. null = not gliding. RENDERED, never written
   * imperatively — React stays the single owner of the row's style, so a stale offset
   * is impossible (the same reason `isEntering` is a prop). */
  glideX: number | null;
  /** True for the one commit that APPLIES that offset, where it must land with the
   * transition off (the FLIP's invert step). See isGlideArming. */
  glideArming: boolean;
  hasHighlightedDescendant: boolean;
  fontSize: number;
  showGuides: boolean;
  guideColor: string;
  highlightColor: string;
  /** Member of the live multi-selection. */
  isSelected: boolean;
  /** Descendant of a selected member (lighter tint). */
  isSelTinted: boolean;
  /** Part of the subtree being dragged (dimmed in place). */
  isDragDimmed: boolean;
}

export const NodeRow = memo(function NodeRow(p: NodeRowProps) {
  useSyncExternalStore(subscribeNode(p.nodeId), () => nodeVersion(p.nodeId));
  useSyncExternalStore(subscribeCompleting, completingVersion);
  const rec = mirror.get(p.nodeId);
  // Above the early return — it holds hooks. A live ⌘1/⌘2 kind change renders the glyph
  // as two cross-animating layers instead of one.
  const morph = useKindMorph(rec?.kind);
  if (!rec) return null;
  // Plays the check-draw/pop once, right after the user completes this node.
  const justCompleted = rec.isCompleted && isCompleting(p.nodeId);

  const scale = OutlineLayout.scale(p.fontSize);
  const indent = p.depth * OutlineLayout.indentPerLevel * scale;
  const isPrompt = rec.kind === "promptDraft";
  const isLine = rec.kind === "line";
  const completedFraction = p.hasChildren
    ? mirror.completedChildFraction(p.nodeId)
    : 0;

  const glyph = (
    <span
      className="glyph-slot"
      style={{
        width: OutlineLayout.bulletHitSize(p.fontSize),
        height: OutlineLayout.lineHeight(p.fontSize),
      }}
      onMouseDown={(e) => glyphMouseDown(e, p.nodeId, p.depth, rec.kind)}
    >
      <Glyph
        kind={rec.kind}
        fontSize={p.fontSize}
        isParent={p.hasChildren}
        isCompleted={rec.isCompleted}
        completedFraction={completedFraction}
        isHighlighted={rec.isHighlighted}
        hasHighlightedDescendant={p.hasHighlightedDescendant}
        highlightColor={p.highlightColor}
        morph={morph}
      />
    </span>
  );

  const cluster = (
    <TrailingCluster
      nodeId={p.nodeId}
      hasChildren={p.hasChildren}
      isCollapsed={p.isCollapsed}
      isLine={isLine}
      isDrillRoot={p.isDrillRoot}
      fontSize={p.fontSize}
    />
  );

  // The prompt's leading bar sits ON the shared glyph column (bullet centers), not
  // hugging the panel edge — panel-relative offset back to the slot center.
  const promptBarWidth = Math.max(1, Math.round(2.5 * scale) - 1);
  // −1: the abs-positioned bar's containing block is the panel's PADDING box,
  // one border-px right of where the glyph-column math starts.
  const promptBarLeft =
    -(
      OutlineLayout.glyphGap * scale +
      OutlineLayout.bulletHitSize(p.fontSize) / 2 +
      promptBarWidth / 2
    ) - 1;

  // A prompt's cluster sits OUTSIDE the panel at the row's right edge (SwiftUI
  // parity) — rendered by the prompt branch below, not inline after the text.
  const firstLine = (
    <div className={"firstline" + (isPrompt ? " prompt" : "")}>
      <div className={"editor-hug" + (isPrompt ? " full" : "")}>
        <RowEditor
          nodeId={p.nodeId}
          isFocused={p.isFocused}
          isDrillRoot={p.isDrillRoot}
          highlightColor={p.highlightColor}
        />
      </div>
      {!isPrompt && cluster}
      <div
        className="tap-trailing"
        onMouseDown={(e) => {
          e.preventDefault();
          // Prompt rows wrap this in a panel that ALSO focuses on empty-space
          // clicks — don't let this bubble up and double-fire the focus.
          e.stopPropagation();
          useWindowState.getState().focusNode(p.nodeId, "main", { type: "end" });
        }}
      />
    </div>
  );

  return (
    <div
      className={
        "node-row kind-" +
        rec.kind +
        (p.isSelected ? " selected" : p.isSelTinted ? " sel-tint" : "") +
        (justCompleted ? " just-completed" : "") +
        (p.isEntering ? " entering" : "") +
        (p.glideX !== null ? " gliding" : "") +
        (p.glideX !== null && p.glideArming ? " glide-arm" : "")
      }
      style={{
        position: "relative",
        paddingLeft: OutlineLayout.documentHInset + indent,
        paddingRight: OutlineLayout.documentHInset,
        fontSize: p.fontSize,
        opacity: p.isDragDimmed ? 0.35 : undefined,
        // A custom property, not `transform`: the transform has to land on .row-inner,
        // NOT on .node-row, whose absolutely-positioned .indent-guide children are a
        // column SHARED with every other row — translating the row would drag its
        // guides off that column and visibly bend the ruler against its static
        // neighbours for the whole animation. Custom properties inherit, so this one
        // inline style reaches .row-inner (and AddChildRow's button/hint) with no prop
        // plumbing, while the guides — which never reference the var — stay put.
        ...(p.glideX !== null
          ? ({ "--pf-glide-x": `${p.glideX}px` } as CSSProperties)
          : null),
      }}
    >
      {p.showGuides && (
        <IndentGuides
          depth={p.depth}
          prevDepth={p.prevDepth}
          nextDepth={p.nextDepth}
          fontSize={p.fontSize}
          color={p.guideColor}
        />
      )}
      <div className="row-inner">
        {glyph}
        {isLine ? (
          <div className="content line-content">
            <hr className="node-divider" />
            {cluster}
          </div>
        ) : isPrompt ? (
          <div className="content">
            <div className="prompt-wrap">
            <div
              className={"prompt-panel" + (rec.isHighlighted ? " highlighted" : "")}
              style={{
                borderColor: rec.isHighlighted ? p.highlightColor : undefined,
              }}
              onMouseDown={(e) => {
                if (e.button !== 0) return;
                // Clicking ANYWHERE in the panel focuses the editor — including the
                // editor's empty grown gutter and the panel's blank space below the
                // text. Only the text, note, and leading bar are exempt (each owns
                // its own click: caret placement, note focus, drill/drag).
                const t = e.target as HTMLElement;
                if (
                  t.closest(
                    ".node-text-wrap, .node-note-static, .note-wrap, .prompt-line-bullet",
                  )
                )
                  return;
                e.preventDefault();
                useWindowState
                  .getState()
                  .focusNode(p.nodeId, "main", { type: "end" });
              }}
            >
              <span
                className="prompt-line-bullet"
                style={{
                  left: promptBarLeft,
                  width: promptBarWidth,
                  background:
                    rec.isHighlighted || p.hasHighlightedDescendant
                      ? p.highlightColor
                      : "rgba(255,255,255,0.35)",
                }}
                onMouseDown={(e) =>
                  glyphMouseDown(e, p.nodeId, p.depth, rec.kind)
                }
              />
              {firstLine}
              <NoteEditor nodeId={p.nodeId} isNoteFocused={p.isNoteFocused} />
            </div>
            {cluster}
            </div>
          </div>
        ) : (
          <div className="content">
            {firstLine}
            <NoteEditor nodeId={p.nodeId} isNoteFocused={p.isNoteFocused} />
          </div>
        )}
      </div>
    </div>
  );
});

/** The faint "+" placeholder at the bottom of an expanded child list, with the
 * "(All Completed — Hidden)" hint when hide-completed emptied the list. Renders
 * the SAME indent guides as node rows so a level's guide line never gaps here. */
export const AddChildRow = memo(function AddChildRow(p: {
  parentId: string;
  depth: number;
  prevDepth: number;
  nextDepth: number;
  fontSize: number;
  hiddenCount: number | null;
  showGuides: boolean;
  guideColor: string;
  /** A derived "+" row enters and leaves with its parent's child list — creating a FIRST
   * child mints two rows for one insert. The leave side already ghosts it (the diff is by
   * ROW id), so it has to play the entrance too or the two directions aren't mirrors. */
  isEntering: boolean;
  /** See NodeRowProps.glideX — a "+" placeholder rides with the subtree it belongs to. */
  glideX: number | null;
  glideArming: boolean;
  onAdd: (parentId: string) => void;
}) {
  const scale = OutlineLayout.scale(p.fontSize);
  const indent = p.depth * OutlineLayout.indentPerLevel * scale;
  return (
    <div
      className={
        "node-row add-child-row" +
        (p.isEntering ? " entering" : "") +
        (p.glideX !== null ? " gliding" : "") +
        (p.glideX !== null && p.glideArming ? " glide-arm" : "")
      }
      style={{
        position: "relative",
        paddingLeft: OutlineLayout.documentHInset + indent,
        fontSize: p.fontSize,
        ...(p.glideX !== null
          ? ({ "--pf-glide-x": `${p.glideX}px` } as CSSProperties)
          : null),
      }}
    >
      {p.showGuides && (
        <IndentGuides
          depth={p.depth}
          prevDepth={p.prevDepth}
          nextDepth={p.nextDepth}
          fontSize={p.fontSize}
          color={p.guideColor}
        />
      )}
      <button
        className="add-child-btn"
        style={{ width: OutlineLayout.bulletHitSize(p.fontSize) }}
        onClick={() => p.onAdd(p.parentId)}
        aria-label={
          p.hiddenCount != null
            ? `Add node (${p.hiddenCount} completed hidden)`
            : "Add node"
        }
      >
        +
      </button>
      {p.hiddenCount != null && (
        <span className="hidden-completed-hint">(All Completed — Hidden)</span>
      )}
    </div>
  );
});
