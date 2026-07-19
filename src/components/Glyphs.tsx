import { memo } from "react";
import { OutlineLayout, Theme } from "../lib/layout";
import type { NodeKind } from "../lib/types";

/** A full circle of radius `r` about (c,c), starting at 12 O'CLOCK and running
 * CLOCKWISE, as two 180° arcs (a single 360° arc renders as nothing). The `d` is
 * CONSTANT for a given glyph size — the progress fraction is carried entirely by
 * stroke-dashoffset, which is the whole point of drawing the pie this way. */
function ringPath(c: number, r: number): string {
  return `M ${c} ${c - r} A ${r} ${r} 0 0 1 ${c} ${c + r} A ${r} ${r} 0 0 1 ${c} ${c - r} Z`;
}

/**
 * The parent progress pie, as a STROKED circle of path-radius R/2 with stroke-width R:
 * the band straddles the path by ±R/2 and so covers radii [0, R] exactly — pixel-wise
 * the same filled sector the old `sectorPath` drew (butt caps give the flat radial
 * edges), but expressed as ONE interpolable number so it can ANIMATE.
 *
 * The old path could not: its segment list changed shape across the fraction (`""` /
 * `M L A Z` / `M A Z`) and the large-arc flag flipped at ½, so `d` was not interpolable
 * at 0, ½ or 1 — and React writes `d` as an attribute anyway, where a CSS transition
 * would never reach it. `stroke-dashoffset` has neither problem, and the same
 * pathLength+dasharray idiom is already proven in this engine by `drawCheck`.
 *
 * A CSS transition needs a previously-RESOLVED value, so this can never self-start on
 * mount: a wedge scrolling back into the virtualizer's window, or a document opened
 * half-complete, paints at its true fraction instead of filling from empty. That
 * guarantee is why the wedge is driven off the FRACTION VALUE rather than a
 * rowAnim-style "just changed" flag — the value path fires for every origin (another
 * window, ⌘Z, a block toggle, the auto-archive sweep), all of which a flag set in
 * `controller.toggleCompleted` would miss.
 *
 * Keep this a COMPONENT, not an inlined `<path>`: in the checkbox branch it alternates
 * with the check mark at the same child index, and React never reconciles a component
 * element with a host element — so a check's resolved dashoffset can't leak into a
 * wedge. Inlining it back would reintroduce that hazard.
 */
function Wedge(p: { c: number; radius: number; fraction: number; color: string }) {
  const f = Math.max(0, Math.min(1, p.fraction));
  return (
    <path
      className="glyph-wedge"
      d={ringPath(p.c, p.radius / 2)}
      // Normalizes the dash units against the length the RASTERIZER measures, so the
      // dash closes exactly at f=1 — a literal 2πr would depend on WebKit's arc→bezier
      // approximation agreeing, and leaves a hairline seam when it doesn't. It also
      // survives ⌘+/⌘− for free: d and stroke-width change, the offset stays valid.
      pathLength={1}
      fill="none"
      strokeWidth={p.radius}
      // Explicit: round/square caps would bulge the wedge's RADIAL edges and stop it
      // reading as a sector.
      strokeLinecap="butt"
      strokeLinejoin="round"
      // Inline STYLE, not presentation attributes: these two must be unambiguous CSS
      // declarations for the transition to apply. `d`/`stroke-width`/`pathLength` stay
      // attributes, so a font-size change snaps with the rest of the zoom.
      style={{ strokeDashoffset: 1 - f, stroke: p.color }}
    />
  );
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
          <circle
            // Parents only: the border goes green in the same instant the pie
            // completes, so it must cross-fade on the same clock or it snaps against a
            // still-filling wedge. A LEAF checkbox keeps its instant flip — that green
            // arrives with glyphPop + drawCheck, and that feel isn't being retuned.
            className={p.isParent ? "glyph-tint" : undefined}
            cx={c}
            cy={c}
            r={r}
            fill="none"
            style={{ stroke: border }}
            strokeWidth={1.5}
          />
          {p.isParent ? (
            // A checkbox parent fills with the SAME wedge as a bullet parent —
            // minus the centre dot, so it reads as a plain pie.
            <Wedge
              key="wedge"
              c={c}
              radius={r - 1.5}
              fraction={p.completedFraction}
              color={allDone ? Theme.completeColor : "rgba(255,255,255,0.55)"}
            />
          ) : (
            p.isCompleted && (
              <path
                key="check"
                className="glyph-check"
                pathLength={1}
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
        {/* R = r − 1. The ring's inner edge sits only ~0.4px outside the wedge's
            outer edge, so never widen this stroke without shrinking the path radius
            to match. */}
        <Wedge
          c={c}
          radius={r - 1}
          fraction={p.completedFraction}
          color={
            p.completedFraction >= 1
              ? Theme.completeColor
              : "rgba(255,255,255,0.45)"
          }
        />
        {/* Drawn OVER the wedge — the visible pie is the annulus [dotR, r−1]. */}
        <circle
          className="glyph-tint"
          cx={c}
          cy={c}
          r={dotR}
          style={{ fill: dotColor }}
        />
      </svg>
    </span>
  );
});
