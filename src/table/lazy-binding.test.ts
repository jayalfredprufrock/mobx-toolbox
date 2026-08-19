import { describe, expect, test } from "vite-plus/test";
import { autorun } from "mobx";
import { lazyObservableArray } from "../lazy-observable/lazy-observable";
import { TableModel } from "./table.model";
import type { RowData } from "./table.types";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

const makeLazy = () => {
  let n = 0;
  const calls = { count: 0 };
  const lazy = lazyObservableArray(
    () => {
      calls.count++;
      n++;
      return Promise.resolve([
        { id: 1, name: `alpha ${n}` },
        { id: 2, name: `beta ${n}` },
      ]);
    },
    { deep: false },
  );
  return { lazy, calls };
};

// Something has to render the table for its computeds to be observed; this stands in for that.
const render = (table: TableModel) => autorun(() => void table.filteredRows.length);

describe("binding a table to a lazy observable array", () => {
  // The recommended binding. Documented in the table README.
  test("a getter over `.slice()` loads, updates, derives columns, and keeps selection", async () => {
    const { lazy, calls } = makeLazy();
    const table = new TableModel({
      rows: () => lazy.value.slice(),
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

    expect((table.filteredRows[0] as { name: string }).name).toBe("alpha 2"); // fresh data
    expect([...table.selectedIds]).toEqual([1]); // selection survived the refresh
    stop();
  });

  // The case that still needs `setRows` to intersect rather than clear: any getter that *derives*
  // rows produces a new array whenever the data changes, so the dataset is re-applied on every load.
  test("a derived getter re-applies on every load, and keeps selection anyway", async () => {
    const { lazy, calls } = makeLazy();
    const applied: number[] = [];
    const table = new TableModel({
      rows: () => lazy.value.filter((row) => row.id > 0),
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
    expect((table.filteredRows[0] as { name: string }).name).toBe("alpha 2");
    // ...and the selection survived it, because the ids still resolve
    expect([...table.selectedIds]).toEqual([1]);
    untrack();
    stop();
  });

  // The array form works too: the lazy owns its observable array, so the table's own iteration of
  // it is what marks it observed and starts the load.
  test("the array form loads, because the table iterates the array it was handed", async () => {
    const { lazy, calls } = makeLazy();
    const table = new TableModel({
      rows: lazy.value,
      getRowId: (row: RowData) => (row as { id: number }).id,
    });
    const stop = render(table);
    await tick(20);

    expect(calls.count).toBe(1);
    expect(table.rows).toHaveLength(2);
    expect(table.allColumns).toHaveLength(2);
    expect((table.filteredRows[0] as { name: string }).name).toBe("alpha 1");
    stop();
  });

  // A getter returning the live array loads and updates through the table's own computeds; `setRows`
  // fires only once, so row-keyed state is never even at risk.
  test("a getter over the live array loads, updates, and keeps selection", async () => {
    const { lazy, calls } = makeLazy();
    const table = new TableModel({
      rows: () => lazy.value,
      getRowId: (row: RowData) => (row as { id: number }).id,
    });
    const stop = render(table);
    await tick(20);
    table.selectedIds.add(1);

    expect(calls.count).toBe(1);
    expect(table.rows).toHaveLength(2); // the live array filled in
    expect(table.allColumns).toHaveLength(2); // and columns re-derived once there was a first row

    await lazy.reload();
    await tick(20);

    expect((table.filteredRows[0] as { name: string }).name).toBe("alpha 2");
    expect([...table.selectedIds]).toEqual([1]); // setRows never re-ran, so nothing was reset
    stop();
  });
});
