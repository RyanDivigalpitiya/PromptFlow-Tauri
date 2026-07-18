import { memo, useState, useSyncExternalStore } from "react";
import { OutlineLayout } from "../lib/layout";
import {
  addRelative,
  copySubtree,
  deleteAndFocusPrev,
  drillInto,
} from "../state/controller";
import { glyphMouseDown } from "../state/dragGesture";
import { mirror, nodeVersion, subscribeNode } from "../state/mirror";
import { useWindowState } from "../state/windowState";
import { Glyph } from "./Glyphs";
import { NoteEditor, RowEditor } from "./RowEditor";

/** Chevron + hover-revealed "+" / zoom / ⋯ hugging the end of the text (the
 * RowTrailingCluster port). Reveal is pure CSS :hover on the first line — no JS
 * hover state, so pointer movement re-renders nothing (the RowHoverBox lesson,
 * solved at the platform level). */
function TrailingCluster(p: {
  nodeId: string;
  hasChildren: boolean;
  isCollapsed: boolean;
  isLine: boolean;
  fontSize: number;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const slot = OutlineLayout.disclosureWidth(p.fontSize);
  const s = useWindowState.getState;
  return (
    <span className="trailing-cluster" style={{ height: OutlineLayout.lineHeight(p.fontSize) }}>
      <button
        className={"chevron" + (p.isCollapsed ? " collapsed" : "")}
        style={{ width: slot, visibility: p.hasChildren ? "visible" : "hidden" }}
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => s().toggleCollapse(p.nodeId)}
        aria-label={p.isCollapsed ? "Expand" : "Collapse"}
      >
        <svg width="10" height="10" viewBox="0 0 10 10">
          <path d="M2 3.5 L5 6.5 L8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <span className="row-actions">
        <button
          className="row-action"
          style={{ width: slot }}
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
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
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => drillInto(p.nodeId)}
            aria-label="Zoom in"
          >
            <svg width="10" height="10" viewBox="0 0 10 10">
              <circle cx="4.2" cy="4.2" r="3" fill="none" stroke="currentColor" strokeWidth="1.2" />
              <line x1="6.5" y1="6.5" x2="9" y2="9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          </button>
        )}
        <span className="row-menu-anchor">
          <button
            className="row-action"
            style={{ width: slot }}
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="Node menu"
          >
            ⋯
          </button>
          {menuOpen && (
            <>
              <div className="menu-backdrop" onClick={() => setMenuOpen(false)} />
              <div className="row-menu">
                {!p.isLine && (
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      drillInto(p.nodeId);
                    }}
                  >
                    Zoom In
                  </button>
                )}
                {!p.isLine && (
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      void copySubtree(p.nodeId);
                    }}
                  >
                    Copy
                  </button>
                )}
                <button
                  className="danger"
                  onClick={() => {
                    setMenuOpen(false);
                    void confirmDelete(p.nodeId);
                  }}
                >
                  Delete
                </button>
              </div>
            </>
          )}
        </span>
      </span>
    </span>
  );
}

/** Delete via the menu: whole subtree, confirming when it's big (the
 * bulletDeleteWarningThreshold port). */
async function confirmDelete(nodeId: string) {
  const count = mirror.descendantsCount(nodeId) - 1;
  if (count >= 10) {
    const ok = window.confirm(
      `Delete this node and its ${count} nested items? (⌘Z undoes)`,
    );
    if (!ok) return;
  }
  await deleteAndFocusPrev(nodeId);
}

/** Faint unbroken vertical guides — one per ancestor level at the ancestor's glyph
 * column — plus the expanded parent's child-connector stub. Anchored on the ROW
 * element (guideX measures from the document's leading edge + documentHInset), so
 * every guide falls inside the row's empty indent gutter. */
function IndentGuides(p: {
  depth: number;
  fontSize: number;
  expandedParent: boolean;
  color: string;
}) {
  const lines = [];
  for (let level = 1; level <= p.depth; level++) {
    lines.push(
      <span
        key={level}
        className="indent-guide"
        style={{
          left: OutlineLayout.documentHInset + OutlineLayout.guideX(level, p.fontSize),
          background: p.color,
        }}
      />,
    );
  }
  if (p.expandedParent) {
    // The child-connector drops from below the glyph to the row bottom, on the SAME
    // column the children draw (guideX identity).
    const top =
      OutlineLayout.glyphCenterY(p.fontSize) + 14 * OutlineLayout.scale(p.fontSize);
    lines.push(
      <span
        key="connector"
        className="indent-guide"
        style={{
          left:
            OutlineLayout.documentHInset +
            OutlineLayout.guideX(p.depth + 1, p.fontSize),
          top,
          background: p.color,
        }}
      />,
    );
  }
  return <>{lines}</>;
}

export interface NodeRowProps {
  nodeId: string;
  depth: number;
  hasChildren: boolean;
  isCollapsed: boolean;
  isFocused: boolean;
  isNoteFocused: boolean;
  isDrillRoot: boolean;
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
  const rec = mirror.get(p.nodeId);
  if (!rec) return null;

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
      />
    </span>
  );

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
      <TrailingCluster
        nodeId={p.nodeId}
        hasChildren={p.hasChildren}
        isCollapsed={p.isCollapsed}
        isLine={isLine}
        fontSize={p.fontSize}
      />
      <div
        className="tap-trailing"
        onMouseDown={(e) => {
          e.preventDefault();
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
        (p.isSelected ? " selected" : p.isSelTinted ? " sel-tint" : "")
      }
      style={{
        position: "relative",
        paddingLeft: OutlineLayout.documentHInset + indent,
        paddingRight: OutlineLayout.documentHInset,
        fontSize: p.fontSize,
        opacity: p.isDragDimmed ? 0.35 : undefined,
      }}
    >
      {p.showGuides && (
        <IndentGuides
          depth={p.depth}
          fontSize={p.fontSize}
          expandedParent={p.hasChildren && !p.isCollapsed}
          color={p.guideColor}
        />
      )}
      <div className="row-inner">
        {glyph}
        {isLine ? (
          <div className="content line-content">
            <hr className="node-divider" />
          </div>
        ) : isPrompt ? (
          <div className="content">
            <div
              className={"prompt-panel" + (rec.isHighlighted ? " highlighted" : "")}
              style={{
                borderColor: rec.isHighlighted
                  ? p.highlightColor
                  : "rgba(255,255,255,0.14)",
              }}
            >
              <span
                className="prompt-line-bullet"
                style={{
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
              <div className="prompt-actions">
                <button
                  className="row-action"
                  tabIndex={-1}
                  title="Copy prompt"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => void navigator.clipboard.writeText(rec.text)}
                >
                  ⧉
                </button>
              </div>
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
 * "(All Completed — Hidden)" hint when hide-completed emptied the list. */
export const AddChildRow = memo(function AddChildRow(p: {
  parentId: string;
  depth: number;
  fontSize: number;
  hiddenCount: number | null;
  onAdd: (parentId: string) => void;
}) {
  const scale = OutlineLayout.scale(p.fontSize);
  const indent = p.depth * OutlineLayout.indentPerLevel * scale;
  return (
    <div
      className="node-row add-child-row"
      style={{
        paddingLeft: OutlineLayout.documentHInset + indent,
        fontSize: p.fontSize,
      }}
    >
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
