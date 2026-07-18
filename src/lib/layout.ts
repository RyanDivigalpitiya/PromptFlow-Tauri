/** Visual constants shared across the outline — a direct port of the SwiftUI app's
 * `OutlineLayout`. Glyph dimensions scale with the body font size (Cmd+=/Cmd+-) so
 * bullets, checkboxes and guides stay proportional to the text at any size. */
export const OutlineLayout = {
  indentPerLevel: 22,
  rowVerticalPadding: 3,
  /** Document margins around the flattened list. */
  documentHInset: 18,
  documentVInset: 12,
  /** 0 since the glyph/text vertical-alignment fix — the slot centers on the text's
   * first line box with no optical nudge (the 1px nudge read as misalignment). */
  glyphTopInset: 0,

  /** Font size the glyph base dimensions were tuned against (scale == 1 here). */
  baseFontSize: 14,
  minFontSize: 9,
  maxFontSize: 40,

  /** The note line renders at this fraction of the node's font size. */
  noteFontFactor: 0.82,

  /** The ONE horizontal gap in a row's leading run: glyph slot → content. */
  glyphGap: 6,

  scale(fontSize: number): number {
    return fontSize / OutlineLayout.baseFontSize;
  },

  clampFontSize(size: number): number {
    return Math.min(
      OutlineLayout.maxFontSize,
      Math.max(OutlineLayout.minFontSize, size),
    );
  },

  /** The leading glyph slot: reserved for EVERY kind so mixed-kind siblings share one
   * text column. */
  bulletHitSize(fontSize: number): number {
    return Math.round(18 * OutlineLayout.scale(fontSize));
  },

  /** Side/diameter of a PARENT node's progress glyph (bullet ring / checkbox circle). */
  parentGlyphSize(fontSize: number): number {
    return 16 * OutlineLayout.scale(fontSize);
  },

  /** Width of the trailing cluster's fixed slots (chevron / + / zoom / ⋯). */
  disclosureWidth(fontSize: number): number {
    return Math.round(14 * OutlineLayout.scale(fontSize));
  },

  /** X (from a row's leading edge) of the glyph column's center at `depth`. */
  glyphCenterX(depth: number, fontSize: number): number {
    return (
      depth * OutlineLayout.indentPerLevel * OutlineLayout.scale(fontSize) +
      OutlineLayout.bulletHitSize(fontSize) / 2
    );
  },

  /** X of the vertical indent guide for nesting `level` (1-based) — the glyph column
   * of the ancestor at depth level−1. Falls strictly inside the row's empty leading
   * gutter, which is why the guides are unbroken. */
  guideX(level: number, fontSize: number): number {
    return OutlineLayout.glyphCenterX(level - 1, fontSize);
  },

  /** First-line height of the body font — matches the CSS `--row-line-height: 1.35`. */
  lineHeight(fontSize: number): number {
    return fontSize * 1.35;
  },

  /** Y (from a row's top) of the leading glyph's center — first-line optical center. */
  glyphCenterY(fontSize: number): number {
    return (
      OutlineLayout.rowVerticalPadding +
      OutlineLayout.glyphTopInset +
      OutlineLayout.lineHeight(fontSize) / 2
    );
  },

  /** Distance from the glyph slot's leading edge to the content's leading edge. */
  glyphSlotToContent(fontSize: number): number {
    return (
      OutlineLayout.bulletHitSize(fontSize) +
      OutlineLayout.glyphGap * OutlineLayout.scale(fontSize)
    );
  },

  /** X (in outline space) of the glyph column center at `depth` — the drop marker's
   * ball for a SIBLING drop. */
  bulletCenterInset(depth: number, fontSize: number): number {
    return (
      OutlineLayout.documentHInset + OutlineLayout.glyphCenterX(depth, fontSize)
    );
  },

  /** X (in outline space) of a row's content leading edge at `depth` — the drop
   * marker's ball for a CHILD drop. */
  contentLeadingInset(depth: number, fontSize: number): number {
    return (
      depth * OutlineLayout.indentPerLevel * OutlineLayout.scale(fontSize) +
      OutlineLayout.documentHInset +
      OutlineLayout.glyphSlotToContent(fontSize)
    );
  },
};

/** Theme constants (ported from AppTheme / HighlightTheme). */
export const Theme = {
  /** The ONE color completion speaks in. */
  completeColor: "#06FF9A",
  defaultHighlightHex: "#3B82F6",
  defaultIndentGuideHex: "#5B5B60",
  defaultBgTint: 0.45,
  maxBgTint: 0.95,
};
