import { observer } from "mobx-react-lite";
import type { FC, HTMLAttributes, ReactNode } from "react";
import { useTableContext } from "../table.context";

export type TableOverlayProps = HTMLAttributes<HTMLDivElement>;

/**
 * The placement primitive every table-wide message is built from, and the one the gated slots —
 * `<Table.Empty>`, `<Table.Loading>`, `<Table.Error>` — each wrap. Render it after `<Table.Body>`
 * and show it yourself.
 *
 * It exists as public API because the placement is the hard part and the gate isn't. Filling the
 * viewport below a sticky header, staying centred in the visible area at any horizontal scroll
 * offset, and sizing off the table's own height takes three CSS variables and a sticky child;
 * deciding whether to mention a failed save takes an `if`. The gated slots cover the states the
 * table can evaluate for itself — everything else is yours:
 *
 * ```tsx
 * {saveError && <Table.Overlay>Couldn't save changes</Table.Overlay>}
 * ```
 *
 * Carries no data attribute of its own: `data-empty` and friends mean "the table decided this",
 * and a hand-shown overlay hasn't earned that claim. Pass your own if you want a styling hook.
 */
export const TableOverlay: FC<TableOverlayProps & { children?: ReactNode }> = observer(
  ({ children, className, style, ...rest }) => {
    const table = useTableContext();
    return (
      <div
        {...rest}
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
