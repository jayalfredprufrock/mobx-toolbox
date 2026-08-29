import { useEffect, useRef } from "react";
import { TableModel } from "./table.model";
import type { RowData, UseTableConfig } from "./table.types";

/**
 * Creates a `TableModel` that lives as long as the component.
 *
 * The config is read once, at construction — with three exceptions: `data`, `loading` and `error`
 * are kept in sync, because a route's params can change without remounting the page (same component
 * type at the same tree position), and a table that ignored the new data would keep rendering the
 * previous org's rows.
 *
 * How "changed" is decided depends on which shape of `config.data` you pass, and the difference
 * matters — see {@link TableConfig.data}. An **array** is re-applied when its identity changes, so
 * it must be referentially stable. A **getter** is tracked by MobX instead, and must read
 * observables. A **lazy** is re-pointed when you hand over a different one, which is what makes a
 * keyed collection work: `data={store.byOrg({ orgId })}` is a new lazy each time `orgId` changes.
 *
 * A lazy also knows whether a request is running and how the last one ended, so it needs no help
 * describing itself and `loading` / `error` are ignored. The other two shapes carry no such story,
 * which is what those props are for — pass what your fetching already knows and the table derives
 * `loading`, `error` and `isEmpty` from it just the same.
 *
 * Everything else (`columns`, `getRowId`, `onStateChange`) is captured at construction; change them
 * through the model (`setColumns`/`addColumn`/`removeColumn`, `applyState`) rather than by
 * re-rendering. Per-column filters need none of that — they are instances the caller holds and
 * mutates directly, and the model reads through to them.
 */
export const useTable = <T>(config?: UseTableConfig<T>): TableModel => {
  const tableRef = useRef<TableModel | undefined>(undefined);
  if (!tableRef.current) {
    tableRef.current = new TableModel(config);
  }
  const table = tableRef.current;

  // What the model has actually been given, so the first render doesn't re-apply what the
  // constructor already applied — and a StrictMode remount doesn't either.
  const data = config?.data;
  const appliedData = useRef(data);

  useEffect(() => {
    if (data === appliedData.current) return;
    appliedData.current = data;
    table.setData((data ?? []) as RowData[]);
  }, [table, data]);

  // Mirrored rather than read once: these are ordinary React values that change between renders,
  // and the model is where every state derived from them is computed. Written in an effect so the
  // render itself stays side-effect free; the model lands them one commit later, which no indicator
  // is fast enough to show. A lazy answers for itself, so this is skipped entirely for one.
  const loading = config?.loading ?? false;
  const error = config?.error;
  useEffect(() => {
    if (table.lazy) return;
    table.setStatus(loading, error);
  }, [table, loading, error]);

  // The model's reactions must die with the component or they leak past unmount.
  // activate/dispose as an effect pair (not dispose alone) because StrictMode dev remounts run
  // cleanup against a model the surviving ref will hand out again.
  useEffect(() => {
    table.activate();
    return () => table.dispose();
  }, [table]);

  return table;
};
