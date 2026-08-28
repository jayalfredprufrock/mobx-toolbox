import { observer } from "mobx-react-lite";
import type { FC } from "react";
import { useTableContext } from "../table.context";
import { useSlowLoading, type SlowLoadingOptions } from "../../util/use-slow-loading";
import { TableOverlay, type TableOverlayProps } from "./table-overlay";

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
 * Needs the table to have been told about loading, which is either form of `rows` state: a
 * `RowSource` that knows, or a `loading` prop passed to `useTable` alongside a plain array.
 */
export const TableLoading: FC<TableLoadingProps> = observer(({ children, sustain, ...rest }) => {
  const table = useTableContext();
  const show = useSlowLoading(
    table.loading,
    sustain === false ? NEVER : sustain === true || sustain === undefined ? undefined : sustain,
  );
  if (!show) return null;
  return (
    <TableOverlay data-loading="" {...rest}>
      {children}
    </TableOverlay>
  );
});
