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
   * Cap the table's height, in pixels, instead of letting it fill its parent.
   *
   * For putting something *below* the table — pagination, a caption, a second panel — without
   * building a layout that reserves space for it. The table's own box ends at this height, so the
   * next thing in flow follows it.
   *
   * It goes on the **viewport**, not the scroll container, and that distinction is the whole
   * feature: the measured height is what drives the render window, the auto-fetch threshold and
   * `<Table.Overlay>`'s size, so measuring an already-capped box is what keeps all of them
   * consistent. Capping the scroll container instead — which is where a `style={{ maxHeight }}`
   * lands — leaves `table.height` reporting the *uncapped* height, and every one of those goes
   * wrong quietly: a 300px box that says it holds twenty rows renders twenty and fetches ahead as
   * if it did.
   *
   * Fewer rows than the cap still leaves the box at the cap, with empty space below the last row —
   * the table fills what it is given. For a bar that follows the rows on a short list, use
   * `<Table.StatusBar>`, which sits inside the scroll container and needs none of this.
   */
  maxHeight?: number;
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
  ({ table, children, style, className, maxHeight, checkbox }) => {
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
                // `height: 100%` with a `max-height` resolves to the smaller of the two, so the
                // ResizeObserver below reports the capped height and everything derived from it
                // follows. Nothing in the model needs to know about the cap.
                maxHeight: maxHeight === undefined ? undefined : `${maxHeight}px`,
                position: "relative",
                "--table-row-height": `${table.rowHeight}px`,
              } as React.CSSProperties
            }
          >
            <div
              ref={scrollContainerRef}
              role="table"
              // only a window of rows/columns is in the DOM, so assistive tech needs the true
              // extent (+1 row for the header) and each row/cell carries its absolute index.
              // For a paged dataset that extent is the server's, not the count fetched so far —
              // see `ariaRowCount`, which reports -1 when it is genuinely unknown.
              aria-rowcount={table.ariaRowCount}
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
