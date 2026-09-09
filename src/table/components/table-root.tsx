import { observer } from "mobx-react-lite";
import type { FC } from "react";
import { TableProvider, TableSlotsProvider } from "../table.context";
import type { TableModel } from "../table.model";
import { NativeCheckbox, type TableCheckboxProps } from "./checkbox";

export interface TableRootProps {
  table: TableModel;
  children?: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
  /**
   * Selection control used by `<Table.SelectionCell>` / `<Table.SelectAll>` when no render-prop is
   * given. Register it once here to capture your app's checkbox everywhere. Defaults to a native
   * `<input type="checkbox">`.
   */
  checkbox?: FC<TableCheckboxProps>;
}

/**
 * The table's outer box: a flex column holding `<Table.Scroll>` and whatever chrome sits outside
 * the scrollbars — `<Table.StatusBar>`, a toolbar, pagination. Owns the shared CSS variables and
 * the model context; measures nothing itself.
 *
 * Chrome is an ordinary flex child, so the space it takes is subtracted from the scrolling box by
 * the browser rather than reserved by arithmetic here. Nothing has to be told how tall a status bar
 * is, and the vertical scrollbar terminates at it instead of running past.
 *
 * `className`/`style` land here, on the box a border and a `border-radius` belong on;
 * `<Table.Scroll>` takes its own for styling the scrolling area.
 *
 * **The table's shape is three CSS values on this element**, which is why there is no prop for any
 * of them — `style` reaches the right box, and the browser does the rest:
 *
 * | | |
 * | --- | --- |
 * | *(default)* | `height: 100%` — fills a sized parent; a short list leaves dead space below the rows, which is the classic table shape and what a bordered design wants |
 * | `maxHeight: 480` | caps the box, so whatever follows in flow sits directly beneath it |
 * | `height: "auto"` | hugs the rows — no dead space, and `<Table.StatusBar>` follows the last row. Pair it with a `minHeight` if the table can be empty, since an empty box hugs to just its header and `<Table.Overlay>` has nowhere to put the message |
 */
export const TableRoot: FC<TableRootProps> = observer(
  ({ table, children, style, className, checkbox }) => (
    <TableProvider value={table}>
      <TableSlotsProvider value={{ checkbox: checkbox ?? NativeCheckbox }}>
        <div
          className={["table-viewport", className].filter(Boolean).join(" ")}
          style={
            {
              display: "flex",
              flexDirection: "column",
              width: "100%",
              height: "100%",
              position: "relative",
              "--table-row-height": `${table.rowHeight}px`,
              // Published, not consumed: `<Table.Header>` measures itself and this hands the
              // number to consumer CSS that needs it — insetting a custom scrollbar below the
              // header being the case that asks for it. `0px` until a header mounts.
              "--table-header-height": `${table.headerHeight}px`,
              ...style,
            } as React.CSSProperties
          }
        >
          {children}
        </div>
      </TableSlotsProvider>
    </TableProvider>
  ),
);
