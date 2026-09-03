import { observer } from "mobx-react-lite";
import type { FC, HTMLAttributes, ReactNode } from "react";
import { useTableContext } from "../table.context";

export interface TableStatusBarProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
  /**
   * Height in pixels. Defaults to the table's `rowHeight` — the same fixed-height contract the
   * rows are under, so nothing has to be measured.
   */
  height?: number;
}

/**
 * A bar across the bottom of the table that stays on screen — "Showing 1,000 of 2,000", a Load all
 * button, page controls.
 *
 * Render it after `<Table.Body>` (and after `<Table.Gutter>` if you have both, which is a normal
 * pairing: a count that is always visible *and* a spinner at the tail of the rows).
 *
 * ```tsx
 * <Table.StatusBar>
 *   Showing {table.rows.length} of {table.pages?.total ?? table.rows.length}
 *   {table.pages?.hasMore && (
 *     <button onClick={() => void table.pages?.loadAll()}>Load all</button>
 *   )}
 * </Table.StatusBar>
 * ```
 *
 * **One declaration covers both shapes**, which is the whole reason this is a component rather than
 * a sentence of documentation. It is sticky on both axes inside the scroll container, so it flows at
 * its natural position after the last row and is only *offset* to the bottom edge when that
 * position would be out of view:
 *
 * | | where it lands |
 * | --- | --- |
 * | fewer rows than fit | directly under the last row — no overflow to displace it |
 * | more rows than fit | the bottom edge, visible while you scroll |
 * | scrolled to the very end | settles into the flow space it reserved |
 *
 * The table still fills its container throughout. On a short list the leftover space is simply
 * *below* the bar rather than between it and the rows, which is what makes this work without the
 * consumer reserving anything.
 *
 * The trade is the one every frozen bar makes: while displaced it paints over whichever row is at
 * the bottom edge (hence the `z-index`). Nothing is permanently hidden — scroll to the end and it
 * settles into its own space.
 *
 * **Not a `<tfoot>`.** That is a row: aligned to the columns, scrolling horizontally with them, one
 * cell per column. This spans the table and knows nothing about columns, which is why it is sticky
 * *left* at the visible width rather than `virtualWidth` wide. The name `Table.Footer` is left free
 * for the row.
 *
 * **Ungated**, like `<Table.Gutter>` and unlike `<Table.Empty>` / `<Table.Loading>` /
 * `<Table.Error>`. Those three describe states the table can evaluate; a row count is the source's
 * business. This one is worth guarding, though, because it carries a `z-index` and those surfaces
 * do not — a bar reading "Showing 0 of 0" painted over "Couldn't load" is the result otherwise:
 *
 * ```tsx
 * {!table.error && !table.loading && <Table.StatusBar>…</Table.StatusBar>}
 * ```
 */
export const TableStatusBar: FC<TableStatusBarProps> = observer(
  ({ children, className, style, height, ...rest }) => {
    const table = useTableContext();
    return (
      <div
        {...rest}
        role="presentation"
        data-table-status-bar=""
        className={className}
        style={{
          // Both axes. `left` keeps it from sliding away with the columns; `bottom` keeps it on
          // screen while the rows overflow. Sticky resolves per-axis, so this is one behaviour
          // rather than two competing ones.
          position: "sticky",
          left: 0,
          bottom: 0,
          // Above the rows it overlays while displaced. Matches the header's, which it can never
          // overlap (they are at opposite edges of the same scrollport).
          zIndex: 20,
          width: "var(--table-viewport-width)",
          height: `${height ?? table.rowHeight}px`,
          display: "flex",
          alignItems: "center",
          ...style,
        }}
      >
        {children}
      </div>
    );
  },
);
