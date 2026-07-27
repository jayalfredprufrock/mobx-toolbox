import { observer } from "mobx-react-lite";
import {
  type CSSProperties,
  type FC,
  Fragment,
  type HTMLAttributes,
  memo,
  type ReactNode,
} from "react";
import type { ColumnModel } from "../column.model";
import { useTableContext } from "../table.context";
import type { RowData } from "../table.types";
import { CellSlot, type RenderColumn } from "./cell-slot";
import { pinnedCellStyle } from "./cell-style";

export interface TableBodyProps {
  className?: string;
  style?: CSSProperties;
  /** Renders one row. Called once per *rendered* row; return a `<Table.Row>`. */
  children: (row: RowData) => ReactNode;
}

/**
 * The virtualized body. Owns the scroll-sized spacer and the `translate3d` window offset, then maps
 * the rendered slice of rows through the `children` render-prop. Rows are keyed by their row id
 * (see `rowIds`): by default the original index in the source array — stable under sort/filter/
 * scroll and across `appendRows` — or the consumer's `getRowId`, which stays stable even when a
 * refetch replaces the row objects.
 */
export const TableBody: FC<TableBodyProps> = observer(({ className, style, children }) => {
  const table = useTableContext();

  return (
    <div style={{ width: `${table.virtualWidth}px`, height: `${table.virtualHeight}px` }}>
      <div
        style={{
          position: "absolute",
          transform: `translate3d(0px, ${table.virtualOffsetY}px, 0px)`,
        }}
      >
        <div
          role="rowgroup"
          className={className}
          style={{
            display: "grid",
            gridTemplateColumns: table.gridTemplateColumns,
            ...style,
          }}
        >
          {table.renderedRows.map((row) => (
            <Fragment key={table.rowIds.get(row)}>{children(row)}</Fragment>
          ))}
        </div>
      </div>
    </div>
  );
});

export interface TableRowProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  row: RowData;
  /** Renders one body cell. Called once per rendered column; return a `<Table.Cell>` / `<Table.SelectionCell>`. */
  children: RenderColumn;
}

/**
 * A single body row. Mirrors the header's layout ownership (grid subgrid, pinned/spacer ordering)
 * and defers each cell to `children` via a per-cell `CellSlot`. Exposes `data-selected` so the
 * consumer can highlight selected rows in CSS. Reading selection here (not row field data) keeps
 * single-cell content updates from re-rendering the whole row — only a selection toggle does.
 */
const TableRowInner: FC<TableRowProps> = observer(
  ({ row, className, style, children, ...rest }) => {
    const table = useTableContext();
    const displayIndex = table.displayRowIndexMap.get(row);

    return (
      <div
        {...rest}
        role="row"
        // 1-based, offset past the header row (aria-rowindex 1)
        aria-rowindex={displayIndex !== undefined ? displayIndex + 2 : undefined}
        aria-selected={table.selectable ? table.isRowSelected(row) : undefined}
        data-selected={table.isRowSelected(row) || undefined}
        data-expanded={table.isRowExpanded(row) || undefined}
        className={className}
        style={{
          height: `${table.rowHeight}px`,
          display: "grid",
          gridColumn: "1 / -1",
          gridTemplateColumns: "subgrid",
          alignItems: "stretch",
          textAlign: "left",
          ...style,
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
    );
  },
);

/**
 * Memoized on identity so scrolling (and filtering) only renders rows that actually entered/changed.
 * `children` (the per-column render-prop) gets a fresh closure on every `TableBody` render, so it is
 * *deliberately excluded* from the comparison — for a row still in the window that closure is
 * equivalent (it closes over the same `row` and reads row/column state live). Every other prop —
 * including pass-through DOM props like `onClick` — is compared shallowly. Layout changes still
 * flow through because the inner `observer` re-renders on the column/width observables it reads, and
 * per-cell data changes flow through each `CellSlot`'s own observer — neither is gated by this memo.
 * (Pass stable `className`/`style`/handlers, not fresh inline values, or the row re-renders every frame.)
 */
export const TableRow = memo(TableRowInner, (prev, next) => {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const key of keys) {
    if (key === "children") continue;
    if (prev[key as keyof TableRowProps] !== next[key as keyof TableRowProps]) return false;
  }
  return true;
});

export interface TableCellProps extends HTMLAttributes<HTMLDivElement> {
  column: ColumnModel;
}

/**
 * A single body cell. Owns pinning/offset/`data-pinned*`; cosmetics are the consumer's via
 * `className`/`style`, other DOM props pass through.
 */
export const TableCell: FC<TableCellProps> = observer(
  ({ column, children, className, style, ...rest }) => {
    return (
      <div
        {...rest}
        role="cell"
        aria-colindex={column.ariaColIndex}
        data-pinned={column.pinned || undefined}
        data-pinned-corner={
          (column.pinned && column.isPinnedOuterEdge && column.pinned) || undefined
        }
        data-pinned-edge={column.isPinnedEdge || undefined}
        className={className}
        style={{ ...pinnedCellStyle(column), ...style }}
      >
        {children}
      </div>
    );
  },
);
