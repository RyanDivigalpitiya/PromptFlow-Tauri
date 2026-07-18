import { memo } from "react";
import { OutlineLayout, Theme } from "../lib/layout";
import type { NodeKind } from "../lib/types";

/** SVG pie-sector path from 12 o'clock, clockwise, `fraction` of the full circle. */
function sectorPath(c: number, r: number, fraction: number): string {
  if (fraction <= 0) return "";
  if (fraction >= 1) {
    // Full circle as two arcs (a single 360° arc renders as nothing).
    return `M ${c} ${c - r} A ${r} ${r} 0 1 1 ${c - 0.001} ${c - r} Z`;
  }
  const angle = fraction * Math.PI * 2 - Math.PI / 2;
  const x = c + r * Math.cos(angle);
  const y = c + r * Math.sin(angle);
  const large = fraction > 0.5 ? 1 : 0;
  return `M ${c} ${c} L ${c} ${c - r} A ${r} ${r} 0 ${large} 1 ${x} ${y} Z`;
}

export interface GlyphProps {
  kind: NodeKind;
  fontSize: number;
  isParent: boolean;
  isCompleted: boolean;
  /** Fraction of DIRECT children completed (parent progress wedge; 1 → green). */
  completedFraction: number;
  isHighlighted: boolean;
  hasHighlightedDescendant: boolean;
  highlightColor: string;
}

/** The leading glyph slot's content for one row. The slot itself is RESERVED for
 * every kind (mixed-kind siblings share one text column); a promptDraft renders an
 * inert spacer here (its line-bullet is an overlay on the panel). */
export const Glyph = memo(function Glyph(p: GlyphProps) {
  const size = OutlineLayout.bulletHitSize(p.fontSize);
  if (p.kind === "promptDraft") {
    return <span style={{ width: size, height: size, flex: "none" }} />;
  }
  if (p.kind === "line") {
    const stroke = Math.max(1.5, 2.5 * OutlineLayout.scale(p.fontSize) - 1);
    return (
      <span className="glyph-dash" style={{ width: size, height: size }}>
        <svg width={size} height={size}>
          <line
            x1={size * 0.15 + stroke / 2}
            y1={size / 2}
            x2={size * 0.85 - stroke / 2}
            y2={size / 2}
            stroke="rgba(255,255,255,0.4)"
            strokeWidth={stroke}
            strokeLinecap="round"
          />
        </svg>
      </span>
    );
  }
  const allDone = p.isParent && p.completedFraction >= 1;
  // ⌘⇧F outranks the derived all-done green in both glyphs; the ancestor
  // breadcrumb tint marks a highlight buried below.
  const accented = p.isHighlighted || p.hasHighlightedDescendant;

  if (p.kind === "checkbox") {
    const d = p.isParent
      ? OutlineLayout.parentGlyphSize(p.fontSize)
      : Math.round(11.5 * OutlineLayout.scale(p.fontSize));
    const c = d / 2;
    const r = c - 1;
    const border = accented
      ? p.highlightColor
      : allDone
        ? Theme.completeColor
        : "rgba(255,255,255,0.45)";
    return (
      <span className="glyph-box" style={{ width: size, height: size }}>
        <svg width={d} height={d}>
          <circle cx={c} cy={c} r={r} fill="none" stroke={border} strokeWidth={1.5} />
          {p.isParent ? (
            // A checkbox parent fills with the SAME wedge as a bullet parent —
            // minus the centre dot, so it reads as a plain pie.
            <path
              d={sectorPath(c, r - 1.5, p.completedFraction)}
              fill={allDone ? Theme.completeColor : "rgba(255,255,255,0.55)"}
            />
          ) : (
            p.isCompleted && (
              <path
                d={`M ${d * 0.28} ${d * 0.52} L ${d * 0.45} ${d * 0.68} L ${d * 0.74} ${d * 0.32}`}
                fill="none"
                stroke={Theme.completeColor}
                strokeWidth={1.6}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )
          )}
        </svg>
      </span>
    );
  }

  // bulletPoint
  const dotColor = accented
    ? p.highlightColor
    : allDone
      ? Theme.completeColor
      : "rgba(255,255,255,0.85)";
  if (!p.isParent) {
    const dot = Math.max(4, Math.round(5 * OutlineLayout.scale(p.fontSize)));
    return (
      <span className="glyph-dot" style={{ width: size, height: size }}>
        <span
          style={{
            width: dot,
            height: dot,
            borderRadius: "50%",
            background: dotColor,
          }}
        />
      </span>
    );
  }
  const d = OutlineLayout.parentGlyphSize(p.fontSize);
  const c = d / 2;
  const r = c - 1;
  const dotR = Math.max(2, 2.5 * OutlineLayout.scale(p.fontSize));
  return (
    <span className="glyph-ring" style={{ width: size, height: size }}>
      <svg width={d} height={d}>
        <circle
          cx={c}
          cy={c}
          r={r}
          fill="none"
          stroke="rgba(255,255,255,0.25)"
          strokeWidth={1.2}
        />
        <path
          d={sectorPath(c, r - 1, p.completedFraction)}
          fill={
            p.completedFraction >= 1
              ? Theme.completeColor
              : "rgba(255,255,255,0.45)"
          }
        />
        <circle cx={c} cy={c} r={dotR} fill={dotColor} />
      </svg>
    </span>
  );
});
