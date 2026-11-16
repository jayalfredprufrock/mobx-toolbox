import { observer } from "mobx-react-lite";
import type { CSSProperties, FC, MouseEvent, ReactNode } from "react";
import { useTableContext, useTableSlots } from "../table.context";
import type { RowData } from "../table.types";

/**
 * Props an expand-toggle component receives. Spread the `aria-*` props onto a real `<button>` (or
 * your design system's) and keyboard support — Tab, Enter, Space — comes from the element itself.
 */
export interface TableExpandToggleProps {
  expanded: boolean;
  onClick: (event?: MouseEvent) => void;
  "aria-expanded": boolean;
  /** The detail panel's id. Present only while expanded, since the panel only exists then. */
  "aria-controls"?: string;
  "aria-label"?: string;
  /** Set when `visuallyHidden` is on. Spread it onto the button along with the rest. */
  style?: CSSProperties;
}

// The standard visually-hidden recipe: gone from layout and sight, still focusable and announced.
// Applied as a React `style` prop, which the browser sets through the CSSOM — not subject to a
// CSP `style-src`, the same as every other inline style the table parts already set.
const visuallyHiddenStyle: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};

/**
 * Zero-config fallback used by `<Table.ExpandToggle>` when the consumer neither registers an
 * `expandToggle` on `<Table.Root>` nor passes a render-prop.
 */
export const NativeExpandToggle: FC<TableExpandToggleProps> = ({ expanded, ...rest }) => (
  <button type="button" {...rest}>
    {expanded ? "▾" : "▸"}
  </button>
);

export interface ExpandToggleProps {
  row: RowData;
  /** Custom control. Omit to use the toggle registered on `<Table.Root>` (a native button by default). */
  children?: (state: TableExpandToggleProps) => ReactNode;
  /**
   * Hide the control visually while keeping it focusable and announced — for rows that expand on a
   * click anywhere. Pair it with a focus style on the row, e.g. `[role="row"]:has(:focus-visible)`.
   */
  visuallyHidden?: boolean;
}

/**
 * A keyboard-reachable control that expands the row's detail panel (`<Table.Expansion>`). Place it
 * inside a `<Table.Cell>`. A row `onClick` alone is mouse-only; keep one as a shortcut if you like —
 * this control stops its click from bubbling, so the two never toggle twice.
 */
export const ExpandToggle: FC<ExpandToggleProps> = observer(({ row, children, visuallyHidden }) => {
  const table = useTableContext();
  const { expandToggle: Toggle } = useTableSlots();
  const expanded = table.isRowExpanded(row);
  const state: TableExpandToggleProps = {
    expanded,
    onClick: (event) => {
      event?.stopPropagation();
      table.toggleRowExpanded(row);
    },
    "aria-expanded": expanded,
    "aria-controls": expanded ? table.expansionId(row) : undefined,
    "aria-label": "Row details",
    style: visuallyHidden ? visuallyHiddenStyle : undefined,
  };
  return children ? <>{children(state)}</> : <Toggle {...state} />;
});
