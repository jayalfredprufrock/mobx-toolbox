import { observer } from "mobx-react-lite";
import type { FC, HTMLAttributes, ReactNode } from "react";
import { useScrollportGuard, useTableContext } from "../table.context";

export type TableOverlayProps = HTMLAttributes<HTMLDivElement>;

/**
 * The placement primitive every table-wide message is built from, and the one the gated slots —
 * `<Table.Empty>`, `<Table.Loading>`, `<Table.Error>` — each wrap. Render it after `<Table.Body>`
 * and show it yourself.
 *
 * It exists as public API because the placement is the hard part and the gate isn't. Filling the
 * viewport below a sticky header, staying centred in the visible area at any horizontal scroll
 * offset, and sizing off the table's own height takes a measured header and a sticky child;
 * deciding whether to mention a failed save takes an `if`. The gated slots cover the states the
 * table can evaluate for itself — everything else is yours:
 *
 * ```tsx
 * {saveError && <Table.Overlay>Couldn't save changes</Table.Overlay>}
 * ```
 *
 * Carries no data attribute of its own: `data-empty` and friends mean "the table decided this",
 * and a hand-shown overlay hasn't earned that claim. Pass your own if you want a styling hook.
 *
 * Structurally it is a zero-height sticky wrapper with an absolutely positioned child. The sticky
 * wrapper is what keeps the message in the visible area at any horizontal scroll offset; the child
 * being out of flow is what keeps the overlay from contributing to the scrollport's content height,
 * which would otherwise make a root that hugs its content circular — the box sized from the
 * overlay, the overlay sized from the box.
 */
export const TableOverlay: FC<TableOverlayProps & { children?: ReactNode }> = observer(
  ({ children, className, style, ...rest }) => {
    const table = useTableContext();
    useScrollportGuard("Overlay");
    return (
      <div
        role="presentation"
        style={{ position: "sticky", left: 0, height: 0, width: "var(--table-scroll-width)" }}
      >
        <div
          {...rest}
          className={className}
          style={{
            position: "absolute",
            top: `${table.headerHeight}px`,
            left: 0,
            width: "100%",
            // `table.headerHeight` is the header's measured border box, so the consumer's own
            // header padding is already in it — nothing to declare, and a table with no header
            // gets the full height rather than reserving space for one that isn't there.
            height: `${Math.max(0, table.height - table.headerHeight)}px`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            ...style,
          }}
        >
          {children}
        </div>
      </div>
    );
  },
);
