import type { NodeKind } from "./types";

/**
 * How a row's glyph animates when its KIND changes (⌘1/⌘2/⌘3/⌘4, the ⋯ menu, another
 * window's edit, ⌘Z). Pure truth table, pinned by `kindMorph.test.ts` — change the
 * semantics here first, then the two layers in `Glyphs.tsx`.
 *
 * - `"scale"` — the two glyphs are CONCENTRIC (a dot/ring and a circle, both centered on
 *   the glyph column), so they can genuinely morph: the outgoing one shrinks to 0 about
 *   its own center while the incoming one grows from 0 at the same point, both
 *   cross-fading.
 * - `"fade"` — a prompt's leading bar shares the glyph COLUMN but nothing else (it is a
 *   full-height 2px bar, and it doesn't even live in the glyph slot — it's an overlay on
 *   the prompt panel). Scaling a bar into a dot reads as a stretch, so these cross-fade
 *   in place.
 * - `null` — no animation; the glyph snaps, exactly as it did before any of this.
 *   Dividers are here because they have no designed transition YET, not because one is
 *   impossible.
 */
export type KindMorphStyle = "scale" | "fade";

export function kindMorphStyle(
  from: NodeKind,
  to: NodeKind,
): KindMorphStyle | null {
  if (from === to) return null;
  if (from === "line" || to === "line") return null;
  if (from === "promptDraft" || to === "promptDraft") return "fade";
  return "scale";
}
