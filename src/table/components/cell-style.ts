import type { CSSProperties } from "react";
import type { ColumnModel } from "../column.model";

/**
 * Structural style shared by header and body cells: pinned cells stick to their edge at the
 * column's offset and must be opaque (they overlap scrolling cells). The opaque fill is a CSS var
 * so the consumer owns the color — set `--table-pinned-bg` once (and override it inside the header
 * to match a header background). `Canvas` is a theme-aware system default for zero-config use.
 *
 * These are the *only* styles the library forces on a cell; everything cosmetic (padding, font,
 * borders, hover) is left to the consumer's `className`/`style`.
 */
export const pinnedCellStyle = (column: ColumnModel): CSSProperties => {
  if (!column.pinned) return { position: "relative" };
  return {
    position: "sticky",
    [column.pinned]: column.offset,
    background: "var(--table-pinned-bg, Canvas)",
    // every cell is positioned, so paint order is DOM order — without this lift, the unpinned
    // cells that follow a left-pinned cell would paint over it while scrolling underneath
    zIndex: 1,
  };
};
