import { observer } from "mobx-react-lite";
import type { FC, HTMLAttributes, ReactNode } from "react";
import { useTableContext } from "../table.context";

export interface TableGutterProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
  /**
   * Height in pixels. Defaults to the table's `rowHeight`, so the strip reads as one more row and
   * needs no measuring — the same fixed-height contract the rows themselves are under.
   */
  height?: number;
}

/**
 * One more row's worth of space at the **end of the rows**, inside the scroll flow.
 *
 * You only see it by scrolling to the bottom of the list, which is exactly what it is for: the
 * indicator that shows up when you outrun the fetch. With a paged source the table is already
 * loading the next page as the window nears the end, so the only thing left to say down there is
 * either "still coming" or "that was all":
 *
 * ```tsx
 * <Table.Gutter>
 *   {feed.loadingMore ? <Spinner /> : !feed.hasMore && <EndOfResults total={feed.total} />}
 * </Table.Gutter>
 * ```
 *
 * Render it after `<Table.Body>`. It is part of the scroll content rather than floating over it,
 * which is the whole point and the reason it can't be built from `<Table.Overlay>`: an overlay
 * fills the viewport and stays centred in it, so a message built on one would cover the rows
 * instead of following them. `<Table.Body>` already reserves the virtualized height in normal flow,
 * so this lands after it with no geometry of its own.
 *
 * **It is not a bar across the bottom of the table.** A persistent "Showing 1,000 of 2,000" belongs
 * on screen whether or not you have scrolled anywhere, which is a different component in a
 * different place — and the two are wanted together, a spinner at the tail *and* a count that is
 * always visible. Nor is it a `<tfoot>`: that is a row, aligned to the columns and scrolling
 * horizontally with them, where this is a strip that knows nothing about columns.
 *
 * **Ungated, unlike `<Table.Empty>` / `<Table.Loading>` / `<Table.Error>`** — what goes here is
 * what the *source* knows, so the condition is yours. Nothing needs guarding for the empty and
 * error states in practice, since both render an overlay across the viewport and there are no rows
 * to scroll past to reach this.
 *
 * **Entirely ungated** — unlike `<Table.Empty>` / `<Table.Loading>` / `<Table.Error>`, which render
 * the states the table can evaluate for itself. What goes here is what the *source* knows, so the
 * condition is yours:
 *
 * ```tsx
 * <Table.Footer>
 *   {feed.loadingMore ? <Spinner /> : feed.hasMore ? null : <EndOfResults total={feed.total} />}
 * </Table.Footer>
 * ```
 *
 * Reach the source through `table.pages` when all you have is the model:
 *
 * ```tsx
 * const FooterStatus = observer(() => {
 *   const { pages } = useTableContext();
 *   if (!pages) return null;
 *   return pages.loadingMore ? <Spinner /> : pages.hasMore ? null : <EndOfResults />;
 * });
 * ```
 *
 * Rendering `null` children still occupies the strip. Skip the element entirely for no footer at
 * all — a table with nothing to say below its rows shouldn't reserve a row's worth of space.
 *
 * Sticky-left at the visible width, like every other table-wide surface, so it stays put under
 * horizontal scrolling rather than sliding out of view with the columns. Vertically it scrolls with
 * the rows — it is part of the list, not part of the frame.
 */
export const TableGutter: FC<TableGutterProps> = observer(
  ({ children, className, style, height, ...rest }) => {
    const table = useTableContext();
    return (
      <div
        {...rest}
        role="presentation"
        data-table-gutter=""
        className={className}
        style={{
          position: "sticky",
          left: 0,
          width: "var(--table-viewport-width)",
          height: `${height ?? table.rowHeight}px`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          ...style,
        }}
      >
        {children}
      </div>
    );
  },
);
