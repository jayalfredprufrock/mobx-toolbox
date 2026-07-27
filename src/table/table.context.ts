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
