import { observable, runInAction } from "mobx";
import { useEffect, useRef } from "react";
import { useStable } from "../react-util/useStable";
import { TableModel } from "./table.model";
import type { RowData, RowSource, UseTableConfig } from "./table.types";
import { isRowSource } from "./util";

/**
 * The controlled form: a {@link RowSource} assembled from React props, so the model has exactly one
 * way to describe a dataset's state no matter where that state lives.
 *
 * `value` is the only mapping that takes any thought, because a `RowSource` says "nothing has
 * arrived yet" with `undefined` while React callers say it with a `loading` flag and whatever
 * empty-ish thing their fetch library hands back in the meantime — `undefined` from a query hook,
 * `[]` from a `useState` initializer. Trusting `rows` alone would make `rows={[]} loading` read as
 * a settled empty result and flash "No results" over every first load, which is the exact trap the
 * uncontrolled form exists to avoid. So rows win when there are any, and `loading`/`error` decide
 * what an empty-looking dataset means:
 *
 * | rows      | loading | error | reads as               |
 * | --------- | ------- | ----- | ---------------------- |
 * | some      | –       | –     | rows                   |
 * | some      | yes     | –     | refreshing (rows stay) |
 * | some      | –       | yes   | refresh failed         |
 * | none      | yes     | –     | first load             |
 * | none      | –       | yes   | failed, nothing to show|
 * | none      | no      | no    | genuinely empty        |
 *
 * A refresh of an already-empty dataset is the one case this reads differently than a source would:
 * with no rows to protect it resolves to the first-load or failed reading rather than the refresh
 * one. Nothing is on screen to disturb either way, and a spinner or an error beats "No results"
 * while a request is running or after one failed.
 */
const controlledSource = (
  read: () => { rows: RowData[] | (() => RowData[]) | undefined; loading: boolean; error: unknown },
): RowSource<RowData> => ({
  get value(): RowData[] | undefined {
    const { rows, loading, error } = read();
    const resolved = typeof rows === "function" ? rows() : rows;
    if (resolved && resolved.length > 0) return resolved;
    if (loading || error !== undefined) return undefined;
    return resolved ?? [];
  },
  get fetching(): boolean {
    return read().loading;
  },
  get error(): unknown {
    return read().error;
  },
});

/**
 * Creates a `TableModel` that lives as long as the component.
 *
 * The config is read once, at construction — with three exceptions: `rows`, `loading` and `error`
 * are kept in sync, because a route's params can change without remounting the page (same component
 * type at the same tree position), and a table that ignored the new rows would keep rendering the
 * previous org's data.
 *
 * How "changed" is decided depends on which shape of `config.rows` you pass, and the difference
 * matters — see {@link TableConfig.rows}. An **array** is re-applied when its identity changes, so
 * it must be referentially stable (a MobX `computed` or `useMemo`) or every parent render reads as
 * a new dataset and clears selection with it. A **getter** is tracked by MobX instead, and must
 * read observables — a getter over props or React state is never re-run. A **row source** is
 * re-pointed when you hand over a different one, which is what makes a keyed collection work:
 * `rows={store.byOrg({ orgId })}` is a new lazy each time `orgId` changes.
 *
 * **Controlled or uncontrolled, decided by what `rows` is.** Hand over a `RowSource` — a
 * `LazyObservableArray` is one — and it is uncontrolled: the source already knows whether a request
 * is running and how the last one ended, so the table reads all of it from there and `loading` /
 * `error` are ignored. Hand over anything else and the table is controlled: it knows only what you
 * tell it each render, which is what makes `loading` and `error` worth passing. Both forms end up
 * at the same five states (`loading`, `refreshing`, `error`, `refreshError`, `isEmpty`); they
 * differ only in who works them out.
 *
 * A config with no `rows` key at all is neither — the table is yours to drive with `setRows`, and
 * nothing is installed that could overwrite what you put there.
 *
 * Everything else (`columns`, `getRowId`, `onStateChange`) is captured at construction; change them
 * through the model (`setColumns`/`addColumn`/`removeColumn`, `applyState`) rather than by
 * re-rendering. Per-column filters need none of that — they are instances the caller holds and
 * mutates directly, and the model reads through to them.
 */
export const useTable = <T>(config?: UseTableConfig<T>): TableModel => {
  const rows = config?.rows;

  // Which form this hook is in, decided once. Deciding per render would let a component flip forms
  // when a prop goes conditional — `rows={query.data}` is a source on some renders and `undefined`
  // on others — and the table would silently change how it reads its own state mid-life.
  //
  // `in` rather than a value check because `rows={undefined} loading` is the ordinary first render
  // of a query hook, and `loading: false` is a real answer that must not read as "not controlled".
  const isControlled = useRef(
    config !== undefined &&
      !isRowSource<RowData>(rows) &&
      ("rows" in config || "loading" in config || "error" in config),
  ).current;

  // The props the controlled source reads through, mirrored into observables so MobX sees changes
  // React makes. Written in an effect rather than during render, so rendering stays side-effect
  // free; the model lands them one commit later, which no indicator is fast enough to show.
  const props = useStable(
    () =>
      isControlled
        ? observable.box(
            {
              rows: config?.rows as RowData[] | (() => RowData[]) | undefined,
              loading: config?.loading ?? false,
              error: config?.error,
            },
            { deep: false },
          )
        : undefined,
    [],
  );

  const source = useStable(
    () => (props ? controlledSource(() => props.get()) : undefined),
    [props],
  );

  // Built *with* the source rather than handed it afterwards. A model applies whatever `rows` it is
  // constructed with synchronously, which is what keeps the first paint populated — and installing
  // the source in an effect instead would leave that first paint reading the bare array, with no
  // idea a request was running behind it.
  const tableRef = useRef<TableModel | undefined>(undefined);
  if (!tableRef.current) {
    tableRef.current = new TableModel(
      source ? ({ ...config, rows: source } as UseTableConfig<RowData>) : config,
    );
  }
  const table = tableRef.current;

  const loading = config?.loading ?? false;
  const error = config?.error;
  useEffect(() => {
    if (!props) return;
    const current = props.get();
    if (current.rows === rows && current.loading === loading && current.error === error) return;
    runInAction(() => props.set({ rows: rows as RowData[] | undefined, loading, error }));
  }, [props, rows, loading, error]);

  // What the model has actually been given, so the first render doesn't re-apply what the
  // constructor already applied — and a StrictMode remount doesn't either.
  const appliedRows = useRef(rows);

  useEffect(() => {
    // Controlled: nothing to re-point. The binding was installed at construction and never changes,
    // because every fact the model needs — the rows included — reaches it by reading back through
    // the source, which reads the mirrored props.
    if (source) return;

    if (rows === appliedRows.current) return;
    appliedRows.current = rows;

    // A getter or a row source is a *binding*, not a dataset: handing either to `setRows` would
    // store the function or the lazy itself where rows are expected. Re-point the model at it and
    // let its own reaction read through.
    if (typeof rows === "function" || isRowSource<RowData>(rows)) {
      table.setRowSource(rows as RowSource<RowData> | (() => RowData[]));
      return;
    }

    table.setRows((rows ?? []) as RowData[]);
  }, [table, rows, source]);

  // The model's reactions must die with the component or they leak past unmount.
  // activate/dispose as an effect pair (not dispose alone) because StrictMode dev remounts run
  // cleanup against a model the surviving ref will hand out again.
  useEffect(() => {
    table.activate();
    return () => table.dispose();
  }, [table]);

  return table;
};
