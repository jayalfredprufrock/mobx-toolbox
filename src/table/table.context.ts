import { createContext, type FC, useContext } from "react";
import type { TableCheckboxProps } from "./components/checkbox";
import { NativeCheckbox } from "./components/checkbox";
import type { TableModel } from "./table.model";

export const tableContext = createContext<TableModel | undefined>(undefined);
export const useTableContext = () => {
  const context = useContext(tableContext);
  if (!context) {
    throw new Error("Table context not available. Are you within the <Table.Root /> component?");
  }
  return context;
};

export const TableProvider = tableContext.Provider;

/**
 * Slots let a consumer register defaults once on `<Table.Root>` (currently just the selection
 * `checkbox`) that the built-in parts fall back to. Defaults to a native checkbox so selection
 * works with zero wiring.
 */
export interface TableSlots {
  checkbox: FC<TableCheckboxProps>;
}

const defaultSlots: TableSlots = { checkbox: NativeCheckbox };

export const slotsContext = createContext<TableSlots>(defaultSlots);
export const TableSlotsProvider = slotsContext.Provider;
export const useTableSlots = (): TableSlots => useContext(slotsContext);

declare const process: { env: { NODE_ENV?: string } };

/**
 * Marks the scrollport. `<Table.Scroll>` provides it; the parts that only work inside a scrolling
 * box check for it.
 */
export const scrollportContext = createContext(false);
export const TableScrollportProvider = scrollportContext.Provider;

/**
 * Throws when a part that belongs inside the scrollport is mounted outside one.
 *
 * Worth a hard error rather than a degraded render: without `<Table.Scroll>` no width is ever
 * measured, so the render gate never opens and the table is simply blank — no message, nothing in
 * the DOM to inspect, and every symptom pointing at the data rather than the markup.
 *
 * **Development only**, behind the same `process.env.NODE_ENV` guard mobx uses (see
 * `makeRoutes`), so a consumer's bundler strips it from production builds. The check is purely
 * structural, so production has nothing left to learn from it.
 */
export const useOutsideScrollportGuard = (component: string): void => {
  const inScrollport = useContext(scrollportContext);
  if (process.env.NODE_ENV !== "production" && inScrollport) {
    throw new Error(
      `<Table.${component}> must be rendered outside <Table.Scroll>, as a direct child of ` +
        `<Table.Root>. Inside the scrolling box it sits within the box the scrollbars measure, so ` +
        `the vertical scrollbar runs past it and it stops short of the gutter.`,
    );
  }
};

export const useScrollportGuard = (component: string): void => {
  const inScrollport = useContext(scrollportContext);
  if (process.env.NODE_ENV !== "production" && !inScrollport) {
    throw new Error(
      `<Table.${component}> must be rendered inside <Table.Scroll>. Chrome that belongs outside the ` +
        `scrolling box — <Table.StatusBar>, a toolbar, pagination — goes directly in <Table.Root>.`,
    );
  }
};
