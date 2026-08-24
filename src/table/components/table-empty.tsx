import { observer } from "mobx-react-lite";
import type { FC, HTMLAttributes, ReactNode } from "react";
import { useTableContext } from "../table.context";
import { useSlowLoading, type SlowLoadingOptions } from "../../util/use-slow-loading";

export type TableOverlayProps = HTMLAttributes<HTMLDivElement>;

/**
 * Fills the viewport below the sticky header and pins horizontally like the header pill, so
 * children stay centred in the visible area at any horizontal scroll offset. Shared by the empty
 * and loading slots, which differ only in when they render and which data attribute they carry.
 */
const Overlay: FC<
  TableOverlayProps & { marker: "data-empty" | "data-loading"; children: ReactNode }
> = observer(({ marker, children, className, style, ...rest }) => {
  const table = useTableContext();
  return (
    <div
      {...rest}
      {...{ [marker]: "" }}
      className={className}
      style={{
        position: "sticky",
        left: 0,
        width: "var(--table-viewport-width)",
        height: `calc(${table.height}px - var(--table-header-height, ${table.rowHeight}px) - var(--table-header-gap, 0px))`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        ...style,
      }}
    >
      {children}
    </div>
  );
});

/**
 * The empty-state surface. Render it after `<Table.Body>`; it shows itself only when the table is
 * genuinely empty — settled, with no rows — and renders nothing while a first load is still running.
 *
 * That gating used to be the consumer's, which meant every table author wrote
 * `list.loading ? undefined : <Empty/>` once they noticed their table claiming "no results" during
 * the first fetch. The table can tell the difference now, so it does. The library decides *when*;
 * what to say is still entirely yours, including the distinction the gate can't make for you:
 *
 * ```tsx
 * <Table.Empty>{table.isFiltered ? "No matches" : "No studies yet"}</Table.Empty>
 * ```
 *
 * Owns placement only — cosmetics are the consumer's, and `data-empty` is the styling hook.
 */
export const TableEmpty: FC<TableOverlayProps> = observer(({ children, ...rest }) => {
  const table = useTableContext();
  if (!table.isEmpty) return null;
  return (
    <Overlay marker="data-empty" {...rest}>
      {children}
    </Overlay>
  );
});

export interface TableLoadingProps extends TableOverlayProps {
  /**
   * Timing for the indicator, passed to `useSlowLoading`. Defaults to 300 ms before it appears and
   * 300 ms minimum on screen, so a fast first load renders nothing at all rather than flashing.
   *
   * Pass `false` to show it the moment loading starts.
   */
  sustain?: boolean | SlowLoadingOptions;
}

const NEVER: SlowLoadingOptions = { after: 0, minDuration: 0 };

/**
 * The first-load surface. Render it after `<Table.Body>` alongside `<Table.Empty>`; it shows itself
 * only while the table has nothing yet and a request is in flight, and only once that wait has gone
 * on long enough to be worth mentioning.
 *
 * It has nothing to say about a *refresh* — rows already on screen stay put and stay interactive,
 * because replacing them to fetch mostly-identical rows would throw away scroll position, column
 * arrangement and selection. Use `table.refreshing` to put a quiet indication somewhere that isn't
 * the rows themselves.
 *
 * Requires the `RowSource` form of `rows`; an array or a getter carries no notion of loading.
 */
export const TableLoading: FC<TableLoadingProps> = observer(({ children, sustain, ...rest }) => {
  const table = useTableContext();
  const show = useSlowLoading(
    table.loading,
    sustain === false ? NEVER : sustain === true || sustain === undefined ? undefined : sustain,
  );
  if (!show) return null;
  return (
    <Overlay marker="data-loading" {...rest}>
      {children}
    </Overlay>
  );
});
