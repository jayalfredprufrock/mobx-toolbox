import { observer } from "mobx-react-lite";
import type { CSSProperties, FC, HTMLAttributes } from "react";
import type { ColumnModel } from "../column.model";
import { useTableContext } from "../table.context";
import { CellSlot, type RenderColumn } from "./cell-slot";
import { pinnedCellStyle } from "./cell-style";

export interface TableHeaderProps {
  className?: string;
  style?: CSSProperties;
  /**
   * Renders one header cell. Called once per *rendered* column (the library owns which columns are
   * live, their order, and the virtualization spacer); return a `<Table.ColumnHeader>` /
   * `<Table.SelectionHeaderCell>`.
   */
  children: RenderColumn;
}

/**
 * The sticky header row group. Owns layout — the grid track template, the left-pinned / spacer /
 * unpinned / right-pinned ordering — and defers each cell's content to the `children` render-prop
 * via a per-cell `CellSlot`.
 */
export const TableHeader: FC<TableHeaderProps> = observer(({ className, style, children }) => {
  const table = useTableContext();

  return (
    <div
      role="rowgroup"
      className={["table-header", className].filter(Boolean).join(" ")}
      style={{
        position: "sticky",
        top: 0,
        zIndex: 20,
        width: `${table.virtualWidth}px`,
        display: "grid",
        gridTemplateColumns: table.gridTemplateColumns,
        ...style,
      }}
    >
      {/*
       * The rounded muted header background is a `.table-header::before` layer (consumer CSS). The
       * rowgroup is `virtualWidth` wide, so a background on it would put its corners at the ends of
       * the scrollable content — never both on screen. That layer is instead `position: sticky;
       * left: 0` with an explicit viewport width so both rounded corners stay visible at any scrollX.
       */}
      <div
        role="row"
        aria-rowindex={1}
        style={{
          gridColumn: "1 / -1",
          gridRow: "1",
          height: `${table.rowHeight}px`,
          display: "grid",
          gridTemplateColumns: "subgrid",
          alignItems: "stretch",
          textAlign: "left",
        }}
      >
        {table.leftPinnedRenderedColumns.map((col) => (
          <CellSlot key={col.key} column={col} render={children} />
        ))}
        <div role="presentation" />
        {table.unpinnedRenderedColumns.map((col) => (
          <CellSlot key={col.key} column={col} render={children} />
        ))}
        {table.rightPinnedRenderedColumns.map((col) => (
          <CellSlot key={col.key} column={col} render={children} />
        ))}
      </div>
    </div>
  );
});

export interface TableColumnHeaderProps extends HTMLAttributes<HTMLDivElement> {
  column: ColumnModel;
}

/**
 * A single header cell. Owns the structural bits (sticky pinning, offset, `data-pinned*`) and stays
 * cosmetically open — the consumer's `className`/`style` add padding, font, borders, etc.; other
 * DOM props pass through.
 */
export const TableColumnHeader: FC<TableColumnHeaderProps> = observer(
  ({ column, children, className, style, ...rest }) => {
    return (
      <div
        {...rest}
        role="columnheader"
        aria-colindex={column.ariaColIndex}
        aria-sort={
          column.sortDirection
            ? column.sortDirection === "asc"
              ? "ascending"
              : "descending"
            : undefined
        }
        data-pinned={column.pinned || undefined}
        data-pinned-edge={column.isPinnedEdge || undefined}
        data-pinned-corner={
          (column.pinned && column.isPinnedOuterEdge && column.pinned) || undefined
        }
        className={className}
        style={{
          ...pinnedCellStyle(column),
          scrollSnapAlign: column.pinned ? undefined : "start",
          ...style,
        }}
      >
        {children}
      </div>
    );
  },
);
