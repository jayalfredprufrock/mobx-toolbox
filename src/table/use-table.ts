import { useEffect, useRef } from "react";
import { TableModel } from "./table.model";
import type { TableConfig } from "./table.types";

export const useTable = <T>(config?: TableConfig<T>): TableModel => {
  const tableRef = useRef<TableModel | undefined>(undefined);
  if (!tableRef.current) {
    tableRef.current = new TableModel(config);
  }

  // The model's onStateChange reaction must die with the component or it leaks past unmount.
  // activate/dispose as an effect pair (not dispose alone) because StrictMode dev remounts run
  // cleanup against a model the surviving ref will hand out again.
  useEffect(() => {
    tableRef.current?.activate();
    return () => tableRef.current?.dispose();
  }, []);

  return tableRef.current;
};
