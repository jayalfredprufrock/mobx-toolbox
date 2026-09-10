import { observer } from "mobx-react-lite";
import type { FC, HTMLAttributes, ReactNode } from "react";
import { useScrollportGuard, useTableContext } from "../table.context";

export type TableOverlayProps = HTMLAttributes<HTMLDivElement>;

/**
 * The placement primitive every table-wide message is built from, and the one the gated slots —
 * `<Table.Empty>`, `<Table.Loading>`, `<Table.Error>` — each wrap. Render it anywhere inside
 * `<Table.Scroll>` and show it yourself.
 *
 * It exists as public API because the placement is the hard part and the gate isn't. Filling the
 * viewport below a sticky header, staying centred in the visible area at any scroll offset, and
 * sizing off the table's own height takes a measured header and an anchor the consumer can't move;
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
 * Structurally it is an out-of-flow anchor with a sticky child. Both halves are load-bearing:
 *
 * - The anchor is **absolutely positioned at the top of the scrollport**, so where it lands does
 *   not depend on where in `<Table.Scroll>` this was written. A sticky element would inherit its
 *   flow position instead, putting the message below the rows rather than over them — and there is
 *   no ordering rule that could fix that, since it would have to be `virtualHeight` above wherever
 *   the consumer put it.
 * - Being out of flow is also what keeps the overlay from contributing to the scrollport's content
 *   height, which would otherwise make a root that hugs its content circular — the box sized from
 *   the overlay, the overlay sized from the box.
 * - The anchor spans the **scrollable extent** rather than the viewport, because that is the room
 *   the sticky child needs to travel: a shorter anchor clamps it and the message drifts up as you
 *   reach the bottom. `table.height` is the floor for the empty case, where there is no extent to
 *   speak of, and it is the measured client box — so the anchor adds no scrollable overflow of its
 *   own and an empty table gets no scrollbar out of it.
 *
 *   The extent is the model's (`virtualHeight`), not the scrollport's measured `scrollHeight`,
 *   which is what keeps this free of a second measurement. The one thing that gets past it is
 *   `<Table.Gutter>`: it adds a row's worth of flow content the model doesn't count here, so an
 *   overlay shown *over rows* with a gutter present drifts up by the gutter's height at the very
 *   bottom of the scroll. Nothing in the library can reach that today — all three gated slots
 *   render only when there are no rows, and so nothing to scroll — and the alternative is the
 *   gutter reporting its height to the model for one bounded edge case.
 * - The sticky child is what keeps the message in the visible area at any scroll offset, on the
 *   compositor rather than through a re-render per scroll event.
 *
 * `z-index` sits between the rows (`auto`) and the header (`20`), so what the overlay covers is
 * decided here rather than by the order the consumer happened to write things in. The anchor is
 * `pointer-events: none` so only the sized box intercepts, exactly as when the box was the whole
 * of it.
 */
export const TableOverlay: FC<TableOverlayProps & { children?: ReactNode }> = observer(
  ({ children, className, style, ...rest }) => {
    const table = useTableContext();
    useScrollportGuard("Overlay");
    return (
      <div
        role="presentation"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: `${table.virtualWidth}px`,
          height: `${Math.max(table.virtualHeight + table.headerHeight, table.height)}px`,
          zIndex: 10,
          pointerEvents: "none",
        }}
      >
        <div
          {...rest}
          className={className}
          style={{
            position: "sticky",
            // `table.headerHeight` is the border-box height `<Table.Header>` renders at, so any
            // header padding is already inside it and this starts exactly where the rows do. It is
            // the configured number rather than a measured one, so a table composed without a
            // header reserves it anyway — `headerHeight: 0` for one of those.
            top: `${table.headerHeight}px`,
            left: 0,
            width: "var(--table-scroll-width)",
            height: `${Math.max(0, table.height - table.headerHeight)}px`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "auto",
            ...style,
          }}
        >
          {children}
        </div>
      </div>
    );
  },
);
