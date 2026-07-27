import { observer } from "mobx-react-lite";
import type { FC, HTMLAttributes } from "react";
import { useTableContext } from "../table.context";

export type TableEmptyProps = HTMLAttributes<HTMLDivElement>;

/**
 * The empty-state surface. Render it after `<Table.Body>`, gated by the consumer — e.g.
 * `table.displayRows.length === 0 && <Table.Empty>…</Table.Empty>` — the library never decides
 * what "empty" means or what to say about it (no rows vs. filtered-out are different stories,
 * and only the consumer knows the words and recovery actions).
 *
 * Owns placement only: fills the viewport below the sticky header (subtracting the theme-owned
 * header vars, falling back to the row height) and pins horizontally like the header pill, so
 * children center in the visible area at any horizontal scroll offset. Cosmetics are the
 * consumer's; `data-empty` is the styling hook.
 */
export const TableEmpty: FC<TableEmptyProps> = observer(
  ({ children, className, style, ...rest }) => {
    const table = useTableContext();
    return (
      <div
        {...rest}
        data-empty=""
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
  },
);
