import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { kindMorphStyle, type KindMorphStyle } from "../lib/kindMorph";
import { OutlineLayout, Theme } from "../lib/layout";
import type { NodeKind } from "../lib/types";
import { cssDurationMs } from "../state/collapseAnim";

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

/* ---------- Kind morph (⌘1/⌘2/⌘3, the ⋯ menu, ⌘Z, another window) ----------
 *
 * Switching a row's kind used to swap one glyph for another between two paints. Now the
 * two coexist for one beat as absolutely-positioned LAYERS over the same glyph slot, and
 * each plays a one-shot keyframe (see `kindMorphStyle` for which pair gets which).
 *
 * KEYFRAMES, not transitions, and deliberately: the incoming glyph has no
 * previously-resolved value for a transition to start from — the exact hazard the Tab
 * glide had to work around with an extra commit. A keyframe with
 * `animation-fill-mode: both` needs no from-value and no invert commit; measured in
 * WebKit, the animation's clock anchors to the frame the animation-name appeared in, so
 * frame 0 is painted whether the element is fresh or already on screen.
 *
 * Driven off the kind VALUE via a per-row ref, not off a "just changed" flag set in the
 * gesture — same reasoning as the progress wedge: the value path fires for ⌘Z, a remote
 * window's edit and the ⌘1/2/3 block form for free, and it cannot self-start on mount, so
 * a row scrolling back into the virtualizer's window paints its true glyph.
 */

export interface KindMorph {
  /** The kind this row rendered until a beat ago — the LEAVING layer draws it. */
  from: NodeKind;
  /** Always the row's current kind; kept explicit so callers needn't re-derive it. */
  to: NodeKind;
  style: KindMorphStyle;
  /** Distinguishes back-to-back morphs. It KEYS the leaving layer, which is created per
   * morph anyway, so that one remounts and its keyframe restarts for free. The entering
   * layer is permanently mounted (see `Glyph`) and a second morph of the same style
   * leaves its `animation-name` untouched, so it has to be restarted by hand — hence the
   * layout effect in `Glyph`, which reads this. */
  epoch: number;
}

/** Fallback only — `--kind-anim-dur` in styles.css `:root` is the truth (read live). */
const KIND_ANIM_MS = 200;
/** Grace before dropping the layers, so the last frame has settled. Tearing down early
 * would snap the fill-mode's final values away mid-animation. */
const KIND_TEARDOWN_BUFFER_MS = 60;

let morphEpoch = 0;

/**
 * Watch one row's kind and report the morph it should be playing right now (null at
 * rest). Call it ONCE per row, above any early return — it holds hooks.
 *
 * `undefined` means "no record" (the row is being torn down): the previous kind is held,
 * so a record that comes back doesn't animate from nothing.
 */
export function useKindMorph(kind: NodeKind | undefined): KindMorph | null {
  const prev = useRef(kind);
  const [morph, setMorph] = useState<KindMorph | null>(null);

  if (kind !== undefined && prev.current !== kind) {
    const from = prev.current;
    prev.current = kind;
    // Render-phase update of THIS component's own state — React's documented "adjust
    // state when a prop changes" pattern. It re-renders immediately, BEFORE the browser
    // paints, so the two layers mount in the same paint as the new kind; deferring this
    // to an effect would paint one frame of the new glyph at full size first, i.e. the
    // snap this whole file exists to remove.
    const style = from === undefined ? null : kindMorphStyle(from, kind);
    setMorph(
      style && from !== undefined
        ? { from, to: kind, style, epoch: ++morphEpoch }
        : null,
    );
  }

  useEffect(() => {
    if (!morph) return;
    const t = setTimeout(
      () => setMorph((m) => (m === morph ? null : m)),
      cssDurationMs("--kind-anim-dur", KIND_ANIM_MS) + KIND_TEARDOWN_BUFFER_MS,
    );
    return () => clearTimeout(t);
  }, [morph]);

  return morph;
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
  /** Live kind change — adds a second, outgoing layer over the glyph slot. A STABLE
   * object (component state), so it doesn't defeat the memo. */
  morph: KindMorph | null;
  /** The height in px the row's real `.prompt-line-bullet` last measured, for the ghost
   * bar a leaving prompt draws in its place. 0 = never measured (use the CSS fallback). */
  promptBarH: number;
}

/**
 * The leading glyph slot's content for one row: the glyph, plus — while a kind morph is
 * live — the outgoing kind's glyph over it. The slot itself is RESERVED for every kind
 * (mixed-kind siblings share one text column).
 *
 * The resting glyph IS the entering layer, under a STABLE key, with its animation classes
 * dropped when the morph ends. That identity is load-bearing, not tidiness: React never
 * reconciles a component element with a host one (the same rule the `Wedge` comment
 * states), so a "bare glyph at rest, wrapped glyph while morphing" shape destroyed and
 * rebuilt the whole glyph subtree at BOTH edges of every morph — measured in WebKit as
 * `drawCheck` stroking itself a second time when a ⌘2 landed inside `.just-completed`'s
 * 440ms window, and as a live wedge transition losing its from-value. The LEAVING layer
 * is the opposite case: it is created and destroyed per morph anyway, so it keys on the
 * epoch, which is exactly what restarts its keyframe on a back-to-back kind change.
 */
export const Glyph = memo(function Glyph(p: GlyphProps) {
  const anim = p.morph ? " morph-" + p.morph.style : "";
  // Names the DIRECTION, on BOTH layers, so one direction can be styled on its own — a
  // morph is not always the mirror of itself (checkbox→bullet keeps its ink and eases in;
  // see styles.css). `from` alone identifies the direction: within a style there are only
  // two kinds, so the other end is implied.
  const dir = p.morph ? " from-" + p.morph.from : "";
  const enterRef = useRef<HTMLSpanElement>(null);
  // The price of never remounting the entering layer: a second kind change inside the
  // first morph's window leaves its className — and so its `animation-name` — unchanged,
  // so CSS keeps the RUNNING keyframe going and the new glyph adopts the old clock (a
  // measured 0.88 on its first painted frame), or, if that keyframe had already finished,
  // gets no animation at all and hard-cuts in at full size. ⌘2 then ⌘Z is an ordinary
  // enough pair of keystrokes. Restart it in place instead — element-only
  // `getAnimations()`, so the ink's own drawCheck/glyphPop are untouched, and a LAYOUT
  // effect so the reset lands before the paint.
  useLayoutEffect(() => {
    for (const a of enterRef.current?.getAnimations() ?? []) {
      a.currentTime = 0;
      void a.play();
    }
  }, [p.morph?.epoch]);
  return (
    <>
      {p.morph && (
        // Draws the OLD kind, and is the one branch allowed to draw a prompt's bar
        // itself: the real bar belongs to the panel, which is already unmounted.
        <span
          className={"glyph-layer glyph-leave" + anim + dir}
          key={"leave:" + p.morph.epoch}
        >
          <GlyphInk {...p} kind={p.morph.from} ghostPromptBar />
        </span>
      )}
      <span
        className={"glyph-layer glyph-enter" + anim + dir}
        key="glyph"
        ref={enterRef}
      >
        <GlyphInk {...p} />
      </span>
    </>
  );
});

/** One glyph, drawn. Split out of `Glyph` so a morph can render it TWICE (once per
 * kind) without either copy knowing it's in an animation. */
function GlyphInk(
  p: GlyphProps & {
    /** Draw a promptDraft as its leading bar rather than as the inert spacer — only
     * true on a morph's leaving layer (see `Glyph`). */
    ghostPromptBar?: boolean;
  },
) {
  const size = OutlineLayout.bulletHitSize(p.fontSize);
  if (p.kind === "promptDraft") {
    if (!p.ghostPromptBar) {
      // Its line-bullet is an overlay on the panel, so the slot is just a spacer.
      return <span style={{ width: size, height: size, flex: "none" }} />;
    }
    // A stand-in for `.prompt-line-bullet` — same width formula NodeRow uses, and the
    // HEIGHT the real bar last measured at (NodeRow keeps it): a prompt panel is as tall
    // as its text, and the fixed one-line height this started as truncated a 4-line
    // prompt's bar by ~55px on the animation's FIRST frame, at full opacity — the one
    // thing the fade exists to prevent. 0 falls back to the CSS one-line height.
    return (
      <span
        className="glyph-prompt-ghost"
        style={{
          height: p.promptBarH > 0 ? p.promptBarH : undefined,
          width: Math.max(1, Math.round(2.5 * OutlineLayout.scale(p.fontSize)) - 1),
          // Same tint rule as the real bar (NodeRow) — a ⌘⇧F-highlighted prompt must
          // not lose its colour on the way out.
          background:
            p.isHighlighted || p.hasHighlightedDescendant
              ? p.highlightColor
              : "rgba(255,255,255,0.35)",
        }}
      />
    );
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
}
