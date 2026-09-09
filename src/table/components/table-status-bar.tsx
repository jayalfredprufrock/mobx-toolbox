import { observer } from "mobx-react-lite";
import type { FC, HTMLAttributes, ReactNode } from "react";
import { useOutsideScrollportGuard, useTableContext } from "../table.context";

export interface TableStatusBarProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
  /**
   * Height in pixels. Defaults to the table's `rowHeight` — the same fixed-height contract the
   * rows are under, so nothing has to be measured.
   */
  height?: number;
}

/**
 * A bar across the bottom of the table — "Showing 1,000 of 2,000", a Load all button, page
 * controls. Render it as a direct child of `<Table.Root>`, **after** `<Table.Scroll>`:
 *
 * ```tsx
 * <Table.Root table={table}>
 *   <Table.Scroll>…</Table.Scroll>
 *   <Table.StatusBar>
 *     Showing {table.rows.length} of {table.pages?.total ?? table.rows.length}
 *     {table.pages?.hasMore && (
 *       <button onClick={() => void table.pages?.loadAll()}>Load all</button>
 *     )}
 *   </Table.StatusBar>
 * </Table.Root>
 * ```
 *
 * **Outside the scrolling box**, which is the whole design. Inside it the bar sits within the box
 * the scrollbars measure: the vertical scrollbar spans past it no matter what, and the bar stops
 * short of the scrollbar gutter — a divider along its top edge visibly runs out into the middle of
 * a scrollbar. Out here it spans the full width, gutter included, and the scrollbar terminates at
 * its top edge.
 *
 * Being an ordinary flex child of the root is also what makes it free of arithmetic. The space it
 * takes is subtracted from `<Table.Scroll>` by the browser, so `table.height` — and with it the
 * render window, the auto-fetch threshold and `<Table.Overlay>` — is already correct. Nothing has
 * to be told how tall the bar is.
 *
 * It follows the rows on a short list only if the table hugs its content; by default the table
 * fills its parent and the bar sits at the bottom with the dead space above it. Hug with
 * `style={{ height: "auto" }}` on `<Table.Root>`.
 *
 * A plain block: no `position`, no `z-index`, no background, because nothing scrolls behind it.
 * Style it through your own `className`, or `[data-table-status-bar]`.
 *
 * **Not a `<tfoot>`.** That is a row: aligned to the columns, scrolling horizontally with them, one
 * cell per column — and therefore something that has to live *inside* the scrollport. This spans
 * the table and knows nothing about columns. The name `Table.Footer` is left free for the row.
 *
 * **Ungated**, like `<Table.Gutter>` and unlike `<Table.Empty>` / `<Table.Loading>` /
 * `<Table.Error>`. Those three describe states the table can evaluate; a row count is the source's
 * business. Note that out here it no longer overlaps the overlay surfaces, so a bar reading
 * "Showing 0 of 0" now sits *below* "Couldn't load" rather than painting over it. Gate it yourself
 * if showing both at once reads badly:
 *
 * ```tsx
 * {!table.error && !table.loading && <Table.StatusBar>…</Table.StatusBar>}
 * ```
 */
export const TableStatusBar: FC<TableStatusBarProps> = observer(
  ({ children, className, style, height, ...rest }) => {
    const table = useTableContext();
    useOutsideScrollportGuard("StatusBar");
    return (
      <div
        {...rest}
        role="presentation"
        data-table-status-bar=""
        className={className}
        style={{
          flex: "0 0 auto",
          width: "100%",
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
