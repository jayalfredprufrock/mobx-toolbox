import { describe, expect, test } from "vite-plus/test";
import { autorun } from "mobx";
import { lazyObservableArray } from "../lazy-observable/lazy-observable";
import { TableModel } from "./table.model";
import type { RowData } from "./table.types";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

const makeLazy = (rows?: () => Promise<{ id: number; name: string }[]>) => {
  let n = 0;
  const calls = { count: 0 };
  const lazy = lazyObservableArray(
    () => {
      calls.count++;
      n++;
      return (
        rows?.() ??
        Promise.resolve([
          { id: 1, name: `alpha ${n}` },
          { id: 2, name: `beta ${n}` },
        ])
      );
    },
    { deep: false },
  );
  return { lazy, calls };
};

// Something has to render the table for its computeds to be observed; this stands in for that.
const render = (table: TableModel) => autorun(() => void table.filteredRows.length);

const rowName = (table: TableModel, i = 0) => (table.filteredRows[i] as { name: string }).name;

describe("binding a table to a lazy observable array", () => {
  // The recommended binding: hand the lazy over whole. The table tracks the array's contents
  // itself, so there is no `.slice()` to remember, and it can tell a first load from an empty
  // result — which an array or a getter can never say.
  test("the row-source form loads, updates, derives columns, and keeps selection", async () => {
    const { lazy, calls } = makeLazy();
    const table = new TableModel({
      rows: lazy,
      getRowId: (row: RowData) => (row as { id: number }).id,
    });
    const stop = render(table);
    await tick(20);

    expect(calls.count).toBe(1); // the table's own tracking triggered the load
    expect(table.rows).toHaveLength(2);
    expect(table.allColumns).toHaveLength(2); // derived from the first row

    table.selectedIds.add(1);
    await lazy.reload();
    await tick(20);

    expect(rowName(table)).toBe("alpha 2"); // fresh data
    expect([...table.selectedIds]).toEqual([1]); // selection survived the refresh
    stop();
  });

  test("a row source distinguishes the four states", async () => {
    let release!: (rows: { id: number; name: string }[]) => void;
    const gate = new Promise<{ id: number; name: string }[]>((resolve) => {
      release = resolve;
    });

    const { lazy } = makeLazy(() => gate);
    const table = new TableModel({ rows: lazy });
    const stop = render(table);
    await tick(0);

    // nothing loaded yet, request in flight — and emphatically not "empty"
    expect(table.loading).toBe(true);
    expect(table.isEmpty).toBe(false);
    expect(table.refreshing).toBe(false);

    release([
      { id: 1, name: "alpha" },
      { id: 2, name: "beta" },
    ]);
    await tick(20);

    expect(table.loading).toBe(false);
    expect(table.isEmpty).toBe(false);

    // rows present, request in flight: they stay, and this is a refresh rather than a load
    const reloading = lazy.reload();
    expect(table.refreshing).toBe(true);
    expect(table.loading).toBe(false);
    expect(table.rows).toHaveLength(2); // never blanked
    await reloading;
    await tick(20);
    expect(table.refreshing).toBe(false);

    stop();
  });

  // The documented way to tell "no data" from "filtered to nothing" inside <Table.Empty>. It rests
  // on `rows` being the pre-filter dataset, so these pin that it stays true through a first load
  // and a discard — the two states this release introduced.
  describe("telling no-data from filtered-to-nothing", () => {
    test("data present but filtered away reads as filtered, not as no-data", async () => {
      const { lazy } = makeLazy();
      const table = new TableModel({ rows: lazy });
      const stop = render(table);
      await tick(20);

      table.setFilter({ predicate: () => false });

      expect(table.isEmpty).toBe(true); // the slot renders
      expect(table.rows.length).toBeGreaterThan(0); // ...and says "No matches"
      expect(table.displayRows).toHaveLength(0);
      stop();
    });

    test("a genuinely empty result reads as no-data", async () => {
      const { lazy } = makeLazy(() => Promise.resolve([]));
      const table = new TableModel({ rows: lazy });
      const stop = render(table);
      await tick(20);

      expect(table.isEmpty).toBe(true);
      expect(table.rows).toHaveLength(0); // ...and says "No users yet"
      stop();
    });

    test("a first load never reaches the slot, so the idiom is never consulted early", async () => {
      let release!: (rows: { id: number; name: string }[]) => void;
      const gate = new Promise<{ id: number; name: string }[]>((resolve) => {
        release = resolve;
      });
      const { lazy } = makeLazy(() => gate);
      const table = new TableModel({ rows: lazy });
      const stop = render(table);
      await tick(0);

      // `rows` is empty here and would read as "no data" — `isEmpty` being false is what stops
      // the slot rendering at all
      expect(table.rows).toHaveLength(0);
      expect(table.isEmpty).toBe(false);

      release([{ id: 1, name: "alpha" }]);
      await tick(20);
      expect(table.isEmpty).toBe(false);
      stop();
    });

    test("a discard doesn't make the slot claim there is no data", async () => {
      const { lazy } = makeLazy();
      const table = new TableModel({ rows: lazy });
      const stop = render(table);
      await tick(20);

      lazy.invalidate({ discard: true });

      // rows are gone, but `loading` keeps the empty slot out of the way rather than letting it
      // announce "No users yet" over a list that is simply being refetched
      expect(table.rows).toHaveLength(0);
      expect(table.loading).toBe(true);
      expect(table.isEmpty).toBe(false);
      stop();
    });
  });

  test("a settled load with no rows is empty, not loading", async () => {
    const { lazy } = makeLazy(() => Promise.resolve([]));
    const table = new TableModel({ rows: lazy });
    const stop = render(table);
    await tick(20);

    expect(lazy.loaded).toBe(true);
    expect(table.loading).toBe(false);
    expect(table.isEmpty).toBe(true);
    stop();
  });

  test("an array or getter form reports neither loading nor refreshing", async () => {
    const table = new TableModel({ rows: [{ id: 1, name: "alpha" }] });
    const stop = render(table);
    await tick(0);

    // no source, so the table does not invent a loading story for a dataset it was handed
    expect(table.loading).toBe(false);
    expect(table.refreshing).toBe(false);
    expect(table.isEmpty).toBe(false);
    stop();
  });

  // The case that still needs `setRows` to intersect rather than clear: a getter that *derives*
  // rows produces a new array whenever the data changes, so the dataset is re-applied on every load.
  test("a derived getter re-applies on every load, and keeps selection anyway", async () => {
    const { lazy, calls } = makeLazy();
    const applied: number[] = [];
    const table = new TableModel({
      rows: () => lazy.value?.filter((row) => row.id > 0) ?? [],
      getRowId: (row: RowData) => (row as { id: number }).id,
    });
    const stop = render(table);
    const untrack = autorun(() => applied.push(table.rows.length));
    await tick(20);
    table.selectedIds.add(1);

    await lazy.reload();
    await tick(20);

    expect(calls.count).toBe(2);
    // the derived array is a new one each time, so the dataset really was re-applied...
    expect(applied.length).toBeGreaterThan(1);
    expect(rowName(table)).toBe("alpha 2");
    // ...and the selection survived it, because the ids still resolve
    expect([...table.selectedIds]).toEqual([1]);
    untrack();
    stop();
  });

  test("a plain invalidate keeps the rows on screen while it refetches", async () => {
    const { lazy } = makeLazy();
    const table = new TableModel({
      rows: lazy,
      getRowId: (row: RowData) => (row as { id: number }).id,
    });
    const stop = render(table);
    await tick(20);
    table.selectedIds.add(1);

    // the value is kept, so the rows never leave the screen — this is the case that would
    // otherwise cost the user their scroll position, column widths and selection
    lazy.invalidate();
    expect(table.rows).toHaveLength(2);
    expect(table.isEmpty).toBe(false);

    await tick(20);
    expect(table.rows).toHaveLength(2);
    expect(rowName(table)).toBe("alpha 2");
    expect([...table.selectedIds]).toEqual([1]);
    stop();
  });

  test("a discard blanks the table, and it reads as loading rather than empty", async () => {
    const { lazy } = makeLazy();
    const table = new TableModel({
      rows: lazy,
      getRowId: (row: RowData) => (row as { id: number }).id,
    });
    const stop = render(table);
    await tick(20);
    expect(table.rows).toHaveLength(2);

    // discard is an explicit request to stop showing what we have — the rows go, and `loading`
    // is what stops that reading as "no results"
    lazy.invalidate({ discard: true });
    expect(table.rows).toHaveLength(0);
    expect(table.loading).toBe(true);
    expect(table.isEmpty).toBe(false);

    await tick(20);
    expect(table.rows).toHaveLength(2);
    expect(table.loading).toBe(false);
    stop();
  });

  test("a row source is applied once, then updates in place", async () => {
    const { lazy } = makeLazy();
    const table = new TableModel({
      rows: lazy,
      getRowId: (row: RowData) => (row as { id: number }).id,
    });

    // every distinct dataset object the table has held — one per re-application
    const datasets = new Set<unknown>();
    const watch = autorun(() => datasets.add(table.rows));
    const stop = render(table);

    await tick(20);
    await lazy.reload();
    await tick(20);
    await lazy.reload();
    await tick(20);

    // the lazy keeps one array for its lifetime, so the table applies it once and later loads
    // reach the computeds through MobX — no re-application, and no copy of every row
    expect(datasets.size).toBe(2); // the empty initial dataset, then the lazy's array
    expect(rowName(table)).toBe("alpha 3");
    watch();
    stop();
  });
});
