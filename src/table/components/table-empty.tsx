import { observer } from "mobx-react-lite";
import type { FC } from "react";
import { useTableContext } from "../table.context";
import { TableOverlay, type TableOverlayProps } from "./table-overlay";

/**
 * The empty-state surface. Render it after `<Table.Body>`; it shows itself only when the table is
 * genuinely empty — settled, with no rows — and renders nothing while a first load is still running.
 *
 * That gating used to be the consumer's, which meant every table author wrote
 * `list.loading ? undefined : <Empty/>` once they noticed their table claiming "no results" during
 * the first fetch. The table can tell the difference now, so it does. The library decides *when*;
 * what to say is still entirely yours, including the distinction the gate can't make for you.
 *
 * To tell "no data" from "a filter hid it all", read `rows` — the dataset *before* filtering.
 * Inside this slot there is nothing on screen by definition, so any rows at all mean the filter
 * is what emptied it:
 *
 * ```tsx
 * <Table.Empty>{table.rows.length ? "No matches" : "No studies yet"}</Table.Empty>
 * ```
 *
 * Owns placement only — cosmetics are the consumer's, and `data-empty` is the styling hook.
 */
export const TableEmpty: FC<TableOverlayProps> = observer(({ children, ...rest }) => {
  const table = useTableContext();
  if (!table.isEmpty) return null;
  return (
    <TableOverlay data-empty="" {...rest}>
      {children}
    </TableOverlay>
  );
});
