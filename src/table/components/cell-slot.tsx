import { observer } from "mobx-react-lite";
import type { ReactNode } from "react";
import type { ColumnModel } from "../column.model";

export type RenderColumn = (column: ColumnModel) => ReactNode;

/**
 * Per-cell reactive boundary. `Table.Header`/`Table.Row` iterate the rendered columns and hand each
 * off to a `CellSlot` rather than calling the consumer's render function inline — so the render runs
 * inside *this* component's MobX reaction. The upshot: a cell re-renders only when the observables
 * *it* reads change (e.g. one field of one row), never because a sibling cell or the row did.
 *
 * It renders a transparent fragment, so whatever the consumer returns (a `<Table.Cell>`) lands
 * directly in the parent grid with no wrapper element.
 */
export const CellSlot = observer<{ column: ColumnModel; render: RenderColumn }>(
  ({ column, render }) => {
    return <>{render(column)}</>;
  },
);
