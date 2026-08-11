import { useEffect, useRef } from "react";
import { TableModel } from "./table.model";
import type { RowData, TableConfig } from "./table.types";

/**
 * Creates a `TableModel` that lives as long as the component.
 *
 * The config is read once, at construction — with one exception: `rows` is kept in sync, because
 * a route's params can change without remounting the page (same component type at the same tree
 * position), and a table that ignored the new rows would keep rendering the previous org's data.
 *
 * How "changed" is decided depends on which shape of `config.rows` you pass, and the difference
 * matters — see {@link TableConfig.rows}. An **array** is re-applied when its identity changes, so
 * it must be referentially stable (a MobX `computed` or `useMemo`) or every parent render reads as
 * a new dataset and clears selection with it. A **getter** is tracked by MobX instead, and must
 * read observables — a getter over props or React state is never re-run.
 *
 * Everything else (`columns`, `getRowId`, `onStateChange`, `filter`) is captured at construction;
 * change them through the model (`setFilter`, `applyState`) rather than by re-rendering.
 */
export const useTable = <T>(config?: TableConfig<T>): TableModel => {
  const tableRef = useRef<TableModel | undefined>(undefined);
  if (!tableRef.current) {
    tableRef.current = new TableModel(config);
  }
  const table = tableRef.current;

  // What the model has actually been given, so the first render doesn't re-apply what the
  // constructor already applied — and a StrictMode remount doesn't either.
  const appliedRows = useRef(config?.rows);

  const rows = config?.rows;
  useEffect(() => {
    // the getter form maintains itself through the model's own reaction
    if (typeof rows === "function" || rows === appliedRows.current) return;
    appliedRows.current = rows;
    table.setRows((rows ?? []) as RowData[]);
  }, [table, rows]);

  // The model's reactions must die with the component or they leak past unmount.
  // activate/dispose as an effect pair (not dispose alone) because StrictMode dev remounts run
  // cleanup against a model the surviving ref will hand out again.
  useEffect(() => {
    table.activate();
    return () => table.dispose();
  }, [table]);

  return table;
};
