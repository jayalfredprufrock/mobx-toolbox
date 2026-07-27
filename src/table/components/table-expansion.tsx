import { observer } from "mobx-react-lite";
import { type CSSProperties, type FC, memo, type ReactNode } from "react";
import { useTableContext } from "../table.context";
import type { RowData } from "../table.types";

export interface TableExpansionProps {
  row: RowData;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

/**
 * The detail panel below an expanded row. Render it as a sibling immediately after the row's
 * `<Table.Row>` inside `<Table.Body>`'s render-prop, gated on `table.isRowExpanded(row)`.
 *
 * Owns the geometry contract: the block is exactly `expansionHeight` tall (taller content scrolls
 * internally), and the cell pins to the viewport (`sticky` + explicit width — the same trick as
 * the header background) so horizontal scrolling moves the columns underneath the panel, not the
 * panel itself. Cosmetics are the consumer's via `className`/`style`.
 */
const TableExpansionInner: FC<TableExpansionProps> = observer(({ className, style, children }) => {
  const table = useTableContext();
  return (
    <div
      role="row"
      data-expansion=""
      style={{ gridColumn: "1 / -1", height: `${table.expansionHeight}px`, minWidth: 0 }}
    >
      <div
        role="cell"
        data-expansion=""
        className={className}
        style={{
          position: "sticky",
          left: 0,
          width: "var(--table-viewport-width)",
          height: "100%",
          overflowY: "auto",
          ...style,
        }}
      >
        {children}
      </div>
    </div>
  );
});

/**
 * Memoized on row identity like `TableRow`, with `children` deliberately excluded: the panel's
 * element tree is rebuilt by the body render-prop every window shift, but for the same row it is
 * equivalent. Panel content must derive from `row` (or be an observer reading live state) — not
 * from other values captured in the render-prop closure.
 */
export const TableExpansion = memo(
  TableExpansionInner,
  (prev, next) =>
    prev.row === next.row && prev.className === next.className && prev.style === next.style,
);
