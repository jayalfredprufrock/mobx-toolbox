import { reaction } from "mobx";
import { observer } from "mobx-react-lite";
import { type FC, useEffect, useRef } from "react";
import { useResize } from "../../react-util/useResize";
import { TableProvider, TableSlotsProvider } from "../table.context";
import type { TableModel } from "../table.model";
import { useScroll } from "../use-scroll";
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
 * The table skeleton: a non-scrolling viewport wrapper (owns measured size + the shared
 * `--table-row-height` var) around the scroll container that everything else renders into. This is
 * the only structural piece consumers mount directly; header/body compose inside it.
 */
export const TableRoot: FC<TableRootProps> = observer(
  ({ table, children, style, className, checkbox }) => {
    const viewportRef = useRef<HTMLDivElement>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);

    useScroll(scrollContainerRef, (x, y) => table.setScroll(x, y));
    // Height comes from the non-scrolling outer container — measuring the scroll container's height
    // would feed back into its own maxHeight.
    useResize(viewportRef, (_width, height) => table.setHeight(height));
    // Width comes from the scroll container, whose content box excludes the vertical scrollbar (or a
    // reserved `scrollbar-gutter` strip) — so column widths fill the visible area with no phantom
    // horizontal scroll, whether or not the consumer reserves the gutter.
    useResize(scrollContainerRef, (width) => table.setWidth(width));

    // Execute programmatic scroll intents (scrollToRow/scrollToEnd). The sticky header's flow
    // height exactly offsets the content's start, so blockOffset values map 1:1 onto scrollTop.
    useEffect(
      () =>
        reaction(
          () => table.scrollRequest,
          (request) => {
            const container = scrollContainerRef.current;
            if (!request || !container) return;
            container.scrollTo({
              top: request.y === "end" ? container.scrollHeight : request.y,
            });
            table.clearScrollRequest();
          },
        ),
      [table, scrollContainerRef],
    );

    return (
      <TableProvider value={table}>
        <TableSlotsProvider value={{ checkbox: checkbox ?? NativeCheckbox }}>
          <div
            ref={viewportRef}
            className="table-viewport"
            style={
              {
                width: "100%",
                height: "100%",
                position: "relative",
                "--table-row-height": `${table.rowHeight}px`,
              } as React.CSSProperties
            }
          >
            <div
              ref={scrollContainerRef}
              role="table"
              // only a window of rows/columns is in the DOM, so assistive tech needs the true
              // extent (+1 row for the header) and each row/cell carries its absolute index
              aria-rowcount={table.displayRows.length + 1}
              aria-colcount={table.orderedColumns.length}
              aria-multiselectable={table.selectable || undefined}
              className={className}
              style={
                {
                  position: "relative",
                  overflow: "auto",
                  // scroll-state query container: the documented pattern for pinned-edge
                  // shadows (`@container scroll-state(scrollable: …)`) needs the container
                  // declared here or those consumer rules silently never match
                  containerType: "scroll-state",
                  scrollSnapType: "x proximity",
                  scrollPaddingLeft: `${table.leftPinnedRenderedColumns.reduce((sum, c) => sum + c.width, 0)}px`,
                  width: "100%",
                  maxHeight: `${table.height}px`,
                  // visible content width (vertical scrollbar already excluded); consumed by the
                  // rounded header background layer (`.table-header::before`)
                  "--table-viewport-width": `${table.width}px`,
                  ...style,
                } as React.CSSProperties
              }
            >
              {table.width > 0 && table.height > 0 && children}
            </div>
          </div>
        </TableSlotsProvider>
      </TableProvider>
    );
  },
);
