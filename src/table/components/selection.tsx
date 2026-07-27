import { observer } from "mobx-react-lite";
import type { FC, ReactNode } from "react";
import type { ColumnModel } from "../column.model";
import { useTableContext, useTableSlots } from "../table.context";
import type { RowData } from "../table.types";
import type { TableCheckboxProps } from "./checkbox";
import { TableCell } from "./table-body";
import { TableColumnHeader } from "./table-header";

// The selection state a render-prop receives — a subset of TableCheckboxProps.
type RowSelectState = Pick<TableCheckboxProps, "checked" | "onChange">;
type SelectAllState = Pick<TableCheckboxProps, "checked" | "indeterminate" | "onChange">;

// centers the control both axes regardless of the consumer's cell CSS
const centerStyle = { display: "flex", alignItems: "center", justifyContent: "center" } as const;

export interface SelectionCellProps {
  column: ColumnModel;
  row: RowData;
  /** Custom control. Omit to use the checkbox registered on `<Table.Root>` (native by default). */
  children?: (state: RowSelectState) => ReactNode;
}

/** A body cell wired to per-row selection. Renders the registered checkbox unless given a render-prop. */
export const SelectionCell: FC<SelectionCellProps> = observer(({ column, row, children }) => {
  const table = useTableContext();
  const { checkbox: Checkbox } = useTableSlots();
  const state: RowSelectState = {
    checked: table.isRowSelected(row),
    onChange: () => table.toggleRow(row),
  };
  return (
    <TableCell column={column} style={centerStyle}>
      {children ? children(state) : <Checkbox {...state} aria-label="Select row" />}
    </TableCell>
  );
});

export interface SelectAllProps {
  /** Custom control. Omit to use the checkbox registered on `<Table.Root>` (native by default). */
  children?: (state: SelectAllState) => ReactNode;
}

/** The select-all control (checked / indeterminate / none). Place inside a header cell, or use `<Table.SelectionHeaderCell>`. */
export const SelectAll: FC<SelectAllProps> = observer(({ children }) => {
  const table = useTableContext();
  const { checkbox: Checkbox } = useTableSlots();
  const state: SelectAllState = {
    checked: table.allRowsSelected,
    indeterminate: table.someRowsSelected,
    onChange: () => table.toggleAllRows(),
  };
  return children ? <>{children(state)}</> : <Checkbox {...state} aria-label="Select all rows" />;
});

export interface SelectionHeaderCellProps {
  column: ColumnModel;
  children?: (state: SelectAllState) => ReactNode;
}

/** A header cell holding the centered select-all control — the header twin of `<Table.SelectionCell>`. */
export const SelectionHeaderCell: FC<SelectionHeaderCellProps> = observer(
  ({ column, children }) => {
    return (
      <TableColumnHeader column={column} style={centerStyle}>
        <SelectAll>{children}</SelectAll>
      </TableColumnHeader>
    );
  },
);
