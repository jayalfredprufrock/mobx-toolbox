import { reaction } from "mobx";
import { observer } from "mobx-react-lite";
import { type ComponentPropsWithRef, type FC, useEffect, useRef } from "react";
import { useMergedRef } from "../../react-util/useMergedRef";
import { useResize } from "../../react-util/useResize";
import { TableScrollportProvider, useTableContext } from "../table.context";
import { useScroll } from "../use-scroll";

export type TableScrollProps = ComponentPropsWithRef<"div">;

/**
 * The scrolling box: the element that actually overflows, and the one whose size the whole
 * virtualization budget is measured from. Header, body and the overlay surfaces go inside it;
 * anything that belongs *outside* the scrollbars — `<Table.StatusBar>`, a toolbar, pagination —
 * goes directly in `<Table.Root>` alongside this.
 *
 * That separation is the point. A bar rendered inside here is inside the box the vertical scrollbar
 * measures, so the scrollbar always runs past it and no amount of consumer styling reaches the
 * overlap. As a sibling, the bar spans the full width — scrollbar gutter included — and the
 * scrollbar terminates at its top edge.
 *
 * **Sizing lives in flex, not in JS.** This is `flex: 1 1 auto; min-height: 0` inside `<Table.Root>`'s
 * column, so the browser resolves all four cases — filling a sized parent, shrinking when the
 * content overflows, hugging the rows when the root is `height: auto`, and absorbing the difference
 * under a `maxHeight` — and `table.height` is then measured off the result rather than computed
 * ahead of it. `min-height: 0` is load-bearing: flex items default to `min-height: auto` and refuse
 * to shrink below their content, which would leave the box uncapped.
 *
 * Takes every div prop, and merges an incoming `ref` with its own, so a scroll-area primitive that
 * needs the scrolling element (Ark UI's `<ScrollArea.Viewport asChild>`, for instance) can compose
 * onto it. Nested that way it is no longer a direct child of the root's flex column, so move the
 * sizing to the wrapper and pass `style={{ flex: "initial", height: "100%" }}` here.
 */
export const TableScroll: FC<TableScrollProps> = observer(
  ({ children, className, style, ref, ...rest }) => {
    const table = useTableContext();
    const scrollRef = useRef<HTMLDivElement>(null);
    const mergedRef = useMergedRef(scrollRef, ref);

    useScroll(scrollRef, (x, y) => table.setScroll(x, y));

    // Both dimensions come from this element's content box, which excludes the scrollbars: width
    // excludes the vertical one (or a reserved `scrollbar-gutter` strip) so column widths fill the
    // visible area with no phantom horizontal scroll, and height excludes the horizontal one so
    // `table.height` is the row area rather than the row area plus a scrollbar strip.
    //
    // Measuring the box that scrolls used to be circular, because JS also set its `max-height`.
    // Nothing does now — flex resolves the height — so this is a pure read.
    useResize(scrollRef, (width, height) => {
      table.setWidth(width);
      table.setHeight(height);
    });

    // Execute programmatic scroll intents (scrollToRow/scrollToEnd). The sticky header's flow
    // height exactly offsets the content's start, so blockOffset values map 1:1 onto scrollTop.
    useEffect(
      () =>
        reaction(
          () => table.scrollRequest,
          (request) => {
            const container = scrollRef.current;
            if (!request || !container) return;
            container.scrollTo({
              top: request.y === "end" ? container.scrollHeight : request.y,
            });
            table.clearScrollRequest();
          },
        ),
      [table],
    );

    return (
      <TableScrollportProvider value={true}>
        <div
          {...rest}
          ref={mergedRef}
          role="table"
          // only a window of rows/columns is in the DOM, so assistive tech needs the true
          // extent (+1 row for the header) and each row/cell carries its absolute index.
          // For a paged dataset that extent is the server's, not the count fetched so far —
          // see `ariaRowCount`, which reports -1 when it is genuinely unknown.
          aria-rowcount={table.ariaRowCount}
          aria-colcount={table.orderedColumns.length}
          aria-multiselectable={table.selectable || undefined}
          className={["table-scroll", className].filter(Boolean).join(" ")}
          style={
            {
              position: "relative",
              overflow: "auto",
              flex: "1 1 auto",
              minHeight: 0,
              // scroll-state query container: the documented pattern for pinned-edge
              // shadows (`@container scroll-state(scrollable: …)`) needs the container
              // declared here or those consumer rules silently never match
              containerType: "scroll-state",
              scrollSnapType: "x proximity",
              scrollPaddingLeft: `${table.leftPinnedRenderedColumns.reduce((sum, c) => sum + c.width, 0)}px`,
              width: "100%",
              // this box's visible content width, vertical scrollbar already excluded — what
              // everything pinned horizontally is sized against, including the rounded header
              // background layer (`.table-header::before`)
              "--table-scroll-width": `${table.width}px`,
              ...style,
            } as React.CSSProperties
          }
        >
          {/*
           * Gated on width alone. Height deliberately isn't a precondition: when the root hugs its
           * content, this box's height *comes from* what renders here, so requiring it first
           * deadlocks — nothing renders, nothing measures, forever. Width is safe because it comes
           * from the parent either way, and height bootstraps on its own since `<Table.Body>`'s
           * spacer is `virtualHeight`, which depends on the row count rather than on `table.height`.
           */}
          {table.width > 0 && children}
        </div>
      </TableScrollportProvider>
    );
  },
);
