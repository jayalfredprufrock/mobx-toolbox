import { describe, expect, test } from "vite-plus/test";
import { autorun, observable, runInAction } from "mobx";
import { lazyArray } from "../lazy/lazy";
import { SetFilter } from "../filter/set-filter.model";
import { TableModel } from "./table.model";
import type { RowData } from "./table.types";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

const makeLazy = (rows?: () => Promise<{ id: number; name: string }[]>) => {
  let n = 0;
  const calls = { count: 0 };
  const lazy = lazyArray(
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
const render = (table: TableModel) => autorun(() => void table.clientFilteredRows.length);

const rowName = (table: TableModel, i = 0) =>
  (table.clientFilteredRows[i] as { name: string }).name;

describe("binding a table to a lazy observable array", () => {
  // The recommended binding: hand the lazy over whole. The table tracks the array's contents
  // itself, so there is no `.slice()` to remember, and it can tell a first load from an empty
  // result — which an array or a getter can never say.
  test("the lazy form loads, updates, derives columns, and keeps selection", async () => {
    const { lazy, calls } = makeLazy();
    const table = new TableModel({
      data: lazy,
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

  test("a lazy distinguishes a first load from a refresh from an empty result", async () => {
    let release!: (rows: { id: number; name: string }[]) => void;
    const gate = new Promise<{ id: number; name: string }[]>((resolve) => {
      release = resolve;
    });

    const { lazy } = makeLazy(() => gate);
    const table = new TableModel({ data: lazy });
    const stop = render(table);
    await tick(0);

    // nothing loaded yet, request in flight — and emphatically not "empty"
    expect(table.loading).toBe(true);
    expect(table.isEmpty).toBe(false);

    release([
      { id: 1, name: "alpha" },
      { id: 2, name: "beta" },
    ]);
    await tick(20);

    expect(table.loading).toBe(false);
    expect(table.isEmpty).toBe(false);

    // rows present, request in flight: they stay, and the table reports nothing at all. A refresh
    // is the lazy's business — `lazy.refreshing` — not a state the table needs to carry.
    const reloading = lazy.reload();
    expect(lazy.refreshing).toBe(true);
    expect(table.loading).toBe(false);
    expect(table.isEmpty).toBe(false);
    expect(table.rows).toHaveLength(2); // never blanked
    await reloading;
    await tick(20);
    expect(lazy.refreshing).toBe(false);

    stop();
  });

  // The documented way to tell "no data" from "filtered to nothing" inside <Table.Empty>. It rests
  // on `rows` being the pre-filter dataset, so these pin that it stays true through a first load
  // and a discard — the two states this release introduced.
  describe("telling no-data from filtered-to-nothing", () => {
    test("data present but filtered away reads as filtered, not as no-data", async () => {
      const { lazy } = makeLazy();
      const table = new TableModel({ data: lazy });
      const stop = render(table);
      await tick(20);

      // a data-only column whose filter matches nothing, so `rows` stays populated while
      // `displayRows` empties — the two states this section is about
      table.addColumn({
        key: "_none",
        value: () => "present",
        filter: new SetFilter({ selected: ["absent"] }),
        hidden: true,
        hideable: false,
      });

      expect(table.isEmpty).toBe(true); // the slot renders
      expect(table.rows.length).toBeGreaterThan(0); // ...and says "No matches"
      expect(table.displayRows).toHaveLength(0);
      stop();
    });

    test("a genuinely empty result reads as no-data", async () => {
      const { lazy } = makeLazy(() => Promise.resolve([]));
      const table = new TableModel({ data: lazy });
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
      const table = new TableModel({ data: lazy });
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
      const table = new TableModel({ data: lazy });
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
    const table = new TableModel({ data: lazy });
    const stop = render(table);
    await tick(20);

    expect(lazy.loaded).toBe(true);
    expect(table.loading).toBe(false);
    expect(table.isEmpty).toBe(true);
    stop();
  });

  test("an array or getter form reports no loading state at all", async () => {
    const table = new TableModel({ data: [{ id: 1, name: "alpha" }] });
    const stop = render(table);
    await tick(0);

    // no source, so the table does not invent a loading story for a dataset it was handed
    expect(table.loading).toBe(false);
    expect(table.isEmpty).toBe(false);
    stop();
  });

  // The case that still needs `setRows` to intersect rather than clear: a getter that *derives*
  // rows produces a new array whenever the data changes, so the dataset is re-applied on every load.
  test("a derived getter re-applies on every load, and keeps selection anyway", async () => {
    const { lazy, calls } = makeLazy();
    const applied: number[] = [];
    const table = new TableModel({
      data: () => lazy.value?.filter((row) => row.id > 0) ?? [],
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
      data: lazy,
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
      data: lazy,
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

  test("a lazy is applied once, then updates in place", async () => {
    const { lazy } = makeLazy();
    const table = new TableModel({
      data: lazy,
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

describe("a lazy that fails", () => {
  // The bug this exists to pin: `loading` used to be "no value yet", which a failed first load
  // satisfies forever. The spinner never came down, and `isEmpty` stayed false behind it, so the
  // table had no state left to render.
  test("a failed first load reports an error instead of loading forever", async () => {
    const { lazy } = makeLazy(() => Promise.reject(new Error("boom")));
    const table = new TableModel({ data: lazy });
    const stop = render(table);
    await tick(20);

    expect(table.loading).toBe(false);
    expect(table.error).toBeInstanceOf(Error);
    expect((table.error as Error).message).toBe("boom");

    // and it is not quietly re-labelled as an empty result, which would be its own lie
    expect(table.isEmpty).toBe(false);
    stop();
  });

  test("a failed refresh disturbs nothing, and the table stays quiet about it", async () => {
    let calls = 0;
    const lazy = lazyArray(
      () => {
        calls++;
        return calls === 1
          ? Promise.resolve([
              { id: 1, name: "alpha" },
              { id: 2, name: "beta" },
            ])
          : Promise.reject(new Error("boom"));
      },
      { deep: false },
    );

    const table = new TableModel({
      data: lazy,
      getRowId: (row: RowData) => (row as { id: number }).id,
    });
    const stop = render(table);
    await tick(20);
    table.selectedIds.add(1);

    await lazy.reload().catch(() => undefined);
    await tick(20);

    // the working table stays working: rows, selection and every derived state untouched
    expect(table.rows).toHaveLength(2);
    expect(rowName(table)).toBe("alpha");
    expect([...table.selectedIds]).toEqual([1]);
    expect(table.loading).toBe(false);
    expect(table.isEmpty).toBe(false);

    // the failure is real and still readable — on the lazy, where whoever owns the fetching can
    // put it on a refresh control or in a toast. The table says nothing, which is the point: these
    // are good rows, and blanking them over a background request costs more than the failure did.
    expect(table.error).toBeUndefined();
    expect(lazy.error).toBeInstanceOf(Error);
    stop();
  });

  test("a retry clears the error", async () => {
    let calls = 0;
    const lazy = lazyArray(
      () => {
        calls++;
        return calls === 1
          ? Promise.reject(new Error("boom"))
          : Promise.resolve([{ id: 1, name: "alpha" }]);
      },
      { deep: false },
    );

    const table = new TableModel({ data: lazy });
    const stop = render(table);
    await tick(20);
    expect(table.error).toBeInstanceOf(Error);

    await lazy.reload();
    await tick(20);

    expect(table.error).toBeUndefined();
    expect(table.loading).toBe(false);
    expect(table.rows).toHaveLength(1);
    stop();
  });

  test("the error is observable, so a slot gated on it re-renders", async () => {
    const { lazy } = makeLazy(() => Promise.reject(new Error("boom")));
    const table = new TableModel({ data: lazy });

    const seen: boolean[] = [];
    const stop = autorun(() => seen.push(table.error !== undefined));
    await tick(20);

    expect(seen).toEqual([false, true]);
    stop();
  });

  test("an array or getter form never reports an error", async () => {
    const table = new TableModel({ data: [{ id: 1, name: "alpha" }] });
    const stop = render(table);
    await tick(0);

    // no source, so the table has no failure story to tell either — same rule as `loading`
    expect(table.error).toBeUndefined();
    stop();
  });
});

describe("re-pointing at a different lazy", () => {
  // A keyed collection hands out a different lazy per key, so `store.byOrg({ orgId })` is a new
  // source whenever `orgId` changes. Every state the table derives reads through whichever source
  // is current, so replacing it has to invalidate them — untracked, an observer kept showing the
  // previous key's settled answer while the new key was still fetching.
  test("swapping to a lazy that has not loaded re-derives `loading` for observers", async () => {
    const { lazy: first } = makeLazy();
    const { lazy: second } = makeLazy(() => new Promise(() => {}));

    const table = new TableModel({ data: first });
    const seen: boolean[] = [];
    const stop = autorun(() => seen.push(table.loading));
    await tick(20);
    expect(table.loading).toBe(false);

    table.setData(second);
    await tick(20);

    expect(seen.at(-1)).toBe(true);
    expect(table.isEmpty).toBe(false); // and the empty slot stays out of the way
    stop();
  });
});

describe("reaching the lazy from the model", () => {
  // The one case a caller cannot serve for itself: a component handed a `TableModel` and nothing
  // else — a generic wrapper, a toolbar from context — deciding whether to offer a refresh control.
  test("a lazy is reachable, with its own type and its full API", async () => {
    const { lazy, calls } = makeLazy();
    const table = new TableModel({ data: lazy });
    const stop = render(table);
    await tick(20);

    expect(table.lazy).toBe(lazy);

    // not a structural squint — the concrete lazy, so the whole API is there
    await table.lazy?.reload();
    await tick(20);
    expect(calls.count).toBe(2);
    expect(table.lazy?.refreshing).toBe(false);
    expect(table.lazy?.fetchedAt).toBeTypeOf("number");
    stop();
  });

  test("`fetching` reports a reload the lazy started by itself", async () => {
    let release!: (rows: { id: number; name: string }[]) => void;
    let calls = 0;
    const lazy = lazyArray(
      () => {
        calls++;
        if (calls === 1) return Promise.resolve([{ id: 1, name: "alpha" }]);
        return new Promise<{ id: number; name: string }[]>((resolve) => {
          release = resolve;
        });
      },
      { deep: false },
    );

    const table = new TableModel({ data: lazy });
    const stop = render(table);
    await tick(20);
    expect(table.lazy?.fetching).toBe(false);

    // not a call anyone made through the table: invalidation is the source revalidating itself,
    // which is exactly what a refresh indicator should be able to see
    const seen: boolean[] = [];
    const watch = autorun(() => seen.push(table.lazy?.fetching ?? false));
    lazy.invalidate();
    await tick(20);

    expect(table.lazy?.fetching).toBe(true);
    expect(seen).toContain(true); // and it is reactive, not just readable

    release([{ id: 1, name: "beta" }]);
    await tick(20);
    expect(table.lazy?.fetching).toBe(false);
    watch();
    stop();
  });

  test("a failed reload is derivable from the lazy alone", async () => {
    let calls = 0;
    const lazy = lazyArray(
      () => {
        calls++;
        return calls === 1
          ? Promise.resolve([{ id: 1, name: "alpha" }])
          : Promise.reject(new Error("boom"));
      },
      { deep: false },
    );

    const table = new TableModel({ data: lazy });
    const stop = render(table);
    await tick(20);

    await table.lazy?.reload().catch(() => undefined);
    await tick(20);

    // `loaded` alongside `error` is the split the table itself declines to make: rows are still
    // there, so this failure is a refresh's, not a reason to blank anything
    expect(table.lazy?.error).toBeInstanceOf(Error);
    expect(table.lazy?.loaded).toBe(true);
    expect(table.error).toBeUndefined();
    stop();
  });

  test("an array or getter form exposes no lazy, so there is nothing to offer", async () => {
    const fromArray = new TableModel({ data: [{ id: 1, name: "alpha" }] });
    const fromGetter = new TableModel({ data: () => [{ id: 1, name: "alpha" }] });

    expect(fromArray.lazy).toBeUndefined();
    expect(fromGetter.lazy).toBeUndefined();
  });

  test("re-pointing swaps which lazy the model hands back", async () => {
    const { lazy: first } = makeLazy();
    const { lazy: second } = makeLazy();
    const table = new TableModel({ data: first });
    const stop = render(table);
    await tick(20);
    expect(table.lazy).toBe(first);

    table.setData(second);
    expect(table.lazy).toBe(second);
    stop();
  });
});

describe("setData across shapes", () => {
  // The one genuinely new path in the consolidation: an array has no binding to follow, so a
  // reaction left over from a previous lazy or getter has to be dropped, or it writes that
  // dataset straight back over the array it was just handed.
  test("an array replacing a lazy drops the lazy's reaction", async () => {
    const { lazy } = makeLazy();
    const table = new TableModel({ data: lazy });
    const stop = render(table);
    await tick(20);
    expect(table.rows).toHaveLength(2);
    expect(table.lazy).toBe(lazy);

    table.setData([{ id: 9, name: "manual" }]);
    expect(table.rows).toHaveLength(1);
    expect(table.lazy).toBeUndefined();

    // the abandoned lazy loading again must not reach back into the table
    await lazy.reload();
    await tick(20);
    expect(table.rows).toHaveLength(1);
    expect(rowName(table)).toBe("manual");
    stop();
  });

  test("a replaced lazy cannot write back when its in-flight load lands", async () => {
    // The hazard the binding is read *through* rather than captured for: a lazy swapped away while
    // a request is still open used to need its reaction explicitly disposed, or the response would
    // arrive and overwrite whatever replaced it. Re-tracking drops the dependency instead.
    let release!: (rows: { id: number; name: string }[]) => void;
    const slow = lazyArray(
      () =>
        new Promise<{ id: number; name: string }[]>((resolve) => {
          release = resolve;
        }),
      { deep: false },
    );

    const table = new TableModel({ data: slow });
    const stop = render(table);
    await tick(20);
    expect(table.rows).toHaveLength(0); // still in flight

    table.setData([{ id: 9, name: "replacement" }]);
    expect(rowName(table)).toBe("replacement");

    // the abandoned request lands afterwards, and reaches nothing
    release([{ id: 1, name: "stale" }]);
    await tick(20);
    expect(table.rows).toHaveLength(1);
    expect(rowName(table)).toBe("replacement");
    stop();
  });

  test("a lazy replacing an array picks up where the lazy is", async () => {
    const { lazy } = makeLazy();
    const table = new TableModel({ data: [{ id: 9, name: "manual" }] });
    const stop = render(table);
    expect(table.lazy).toBeUndefined();

    table.setData(lazy);
    await tick(20);

    expect(table.lazy).toBe(lazy);
    expect(table.rows).toHaveLength(2);
    stop();
  });

  test("a getter replacing an array is tracked", async () => {
    const source = observable.box([{ id: 1, name: "alpha" }]);
    const table = new TableModel({ data: [{ id: 9, name: "manual" }] });
    const stop = render(table);

    table.setData(() => source.get());
    expect(table.rows).toHaveLength(1);
    expect(rowName(table)).toBe("alpha");

    runInAction(() =>
      source.set([
        { id: 1, name: "alpha" },
        { id: 2, name: "beta" },
      ]),
    );
    expect(table.rows).toHaveLength(2);
    stop();
  });
});
