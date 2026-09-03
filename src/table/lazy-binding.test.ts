import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { autorun, configure, observable, runInAction } from "mobx";
import { lazyArray, lazyPages } from "../lazy/lazy";
import { SetFilter } from "../filter/set-filter.model";
import { TableModel } from "./table.model";
import type { RowData, TableConfig, TableQuery } from "./table.types";

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

// The rest of the suite runs under MobX's default `enforceActions: "observed"`, which stays quiet
// about a write to an observable nothing is watching yet — so it cannot see a constructor writing
// to its own fresh state. Apps commonly run `"always"`, which does complain, and did.
describe('constructing under enforceActions: "always"', () => {
  afterEach(() => {
    configure({ enforceActions: "observed" });
    vi.restoreAllMocks();
  });

  const warningsWhileConstructing = (build: () => TableModel): string[] => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    configure({ enforceActions: "always" });
    const table = build();
    // Read something, so an assertion failure can't be blamed on a table that never woke up.
    expect(table.rows).toBeDefined();
    return warn.mock.calls.map((args) => String(args[0]));
  };

  test("binding a lazy warns about nothing", () => {
    const { lazy } = makeLazy();
    expect(warningsWhileConstructing(() => new TableModel({ data: lazy }))).toEqual([]);
  });

  test("binding a getter warns about nothing", () => {
    const source = observable.box([{ id: 1, name: "alpha" }]);
    expect(warningsWhileConstructing(() => new TableModel({ data: () => source.get() }))).toEqual(
      [],
    );
  });

  test("binding a plain array warns about nothing", () => {
    expect(
      warningsWhileConstructing(() => new TableModel({ data: [{ id: 1, name: "alpha" }] })),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// lazyPages
// ---------------------------------------------------------------------------

/**
 * A paged list is a `LazyArray` as far as the binding is concerned, so it needs nothing from the
 * table to render: the rows reaction tracks `value` by identity, the source owns one array for its
 * lifetime, and an appended page reaches the computeds through mobx rather than through `setData`.
 *
 * What the table *does* add is three reactions — push the query, fetch as the window nears the end,
 * scroll back on a restart — and the mode defaults that keep it from sorting or filtering one page
 * of a server-driven dataset. These pin all of it.
 */
describe("binding to a paged lazy", () => {
  /** A table with a measured viewport: the auto-fetch is gated on one. */
  const measured = (config: TableConfig<any>) => {
    const table = new TableModel(config);
    table.setWidth(800);
    table.setHeight(400); // 10 rows at the default 40px
    table.activate();
    const dispose = autorun(() => void table.displayRows.length);
    return { table, dispose };
  };

  const pagedApi = (total: number) =>
    vi.fn(({ cursor, limit }: { cursor?: string; limit: number }) => {
      const start = cursor === undefined ? 0 : Number(cursor);
      const items = Array.from({ length: Math.min(limit, total - start) }, (_, i) => ({
        id: start + i,
        name: `r${start + i}`,
      }));
      const next = start + items.length;
      return Promise.resolve({ items, cursor: next < total ? String(next) : null, total });
    });

  test("derives loading, then follows every page with no re-application", async () => {
    const feed = lazyPages(pagedApi(500), { pageSize: 40 });
    const { table, dispose } = measured({ data: feed, columns: ["id", "name"] });

    // nothing has arrived and nothing has failed
    expect(table.loading).toBe(true);
    expect(table.isEmpty).toBe(false);
    expect(table.error).toBeUndefined();

    await tick();

    expect(table.loading).toBe(false);
    expect(table.rows.length).toBe(40);
    expect(table.lazy).toBe(feed);
    expect(table.pages).toBe(feed);

    const rowsArray = table.rows;
    await feed.loadMore();

    expect(table.rows.length).toBe(80);
    expect(table.displayRows.length).toBe(80);
    // the same array throughout: the page reached the computeds without a setData
    expect(table.rows).toBe(rowsArray);

    dispose();
    table.dispose();
  });

  test("mode is inferred from the source, and flips sorting, filters and search with it", () => {
    const feed = lazyPages(pagedApi(500), { pageSize: 40 });
    const filter = new SetFilter();
    const { table, dispose } = measured({
      data: feed,
      columns: [{ key: "name", filter }, "id"],
    });

    expect(table.mode).toBe("server");
    expect(table.sortMode).toBe("manual");
    expect(table.column("name")?.filterMode).toBe("server");
    expect(table.searchFilter.mode).toBe("server");

    dispose();
    table.dispose();
  });

  test("an explicit mode wins, and so does a per-column override", () => {
    const feed = lazyPages(pagedApi(500), { pageSize: 40 });
    const { table, dispose } = measured({
      data: feed,
      mode: "client",
      columns: [{ key: "name", filter: new SetFilter() }],
    });

    expect(table.sortMode).toBe("auto");
    expect(table.column("name")?.filterMode).toBe("client");

    const other = lazyPages(pagedApi(500), { pageSize: 40 });
    const second = measured({
      data: other,
      columns: [{ key: "name", filter: new SetFilter(), filterMode: "client" }, "id"],
    });
    expect(second.table.mode).toBe("server");
    expect(second.table.column("name")?.filterMode).toBe("client");

    dispose();
    table.dispose();
    second.dispose();
    second.table.dispose();
  });

  test("mode follows a setData that points an array-backed table at a paged source", async () => {
    const { table, dispose } = measured({
      data: [{ id: 1, name: "a" }],
      columns: [{ key: "name", filter: new SetFilter() }],
    });

    expect(table.mode).toBe("client");
    expect(table.column("name")?.filterMode).toBe("client");

    table.setData(lazyPages(pagedApi(500), { pageSize: 40 }));
    await tick();

    // the default was resolved through the table, not baked in when the column was built
    expect(table.mode).toBe("server");
    expect(table.column("name")?.filterMode).toBe("server");
    expect(table.sortMode).toBe("manual");

    dispose();
    table.dispose();
  });

  test("pushes the query into the source, and only when it changes", async () => {
    const seen: unknown[] = [];
    const fetch = vi.fn(({ cursor, query }: { cursor?: string; query: TableQuery }) => {
      seen.push(query);
      const start = cursor === undefined ? 0 : Number(cursor);
      const items = Array.from({ length: 50 }, (_, i) => ({
        id: start + i,
        name: `r${start + i}`,
        kind: "x",
      }));
      // one page satisfies the 10-row window, so each query change is exactly one request
      return Promise.resolve({ items, cursor: null, total: 50 });
    });
    const filter = new SetFilter();
    const feed = lazyPages(fetch, { pageSize: 50 });
    const { table, dispose } = measured({
      data: feed,
      columns: [{ key: "kind", filter }, "id", "name"],
    });
    await tick();

    expect(seen[0]).toEqual({ filters: undefined, sorts: [] });

    const before = fetch.mock.calls.length;
    // a column resize is not a query change
    table.column("id")?.setManualWidth(300);
    await tick();
    expect(fetch.mock.calls.length).toBe(before);

    // a server-mode filter is
    filter.toggle("x");
    await tick();
    expect(seen.at(-1)).toEqual({
      filters: [{ field: "kind", op: "in", value: ["x"] }],
      sorts: [],
    });

    // so is a sort, because `sortMode` resolved to manual
    table.setSort("id", "desc");
    await tick();
    expect(seen.at(-1)).toMatchObject({ sorts: [{ key: "id", direction: "desc" }] });

    dispose();
    table.dispose();
  });

  test("query omits sorts the table is applying itself", () => {
    const rows = [{ id: 2 }, { id: 1 }];
    const { table, dispose } = measured({ data: rows, columns: ["id"] });

    table.setSort("id", "asc");
    // client mode: the rows are already in this order, so there is nothing to ask a server for
    expect(table.query).toEqual({ filters: undefined, sorts: [] });
    expect(table.displayRows.map((r) => r.id)).toEqual([1, 2]);

    dispose();
    table.dispose();
  });

  test("query keeps its identity while its contents are unchanged", () => {
    const { table, dispose } = measured({ data: [{ id: 1 }], columns: ["id"], mode: "server" });

    const first = table.query;
    table.setWidth(900);
    table.setScroll(0, 120);
    table.toggleRow(table.rows[0]!);
    // nothing a server would be asked about changed, so this is still the same object — which is
    // what makes it usable as a useEffect dependency or a query key
    expect(table.query).toBe(first);

    table.setSort("id", "asc");
    expect(table.query).not.toBe(first);

    dispose();
    table.dispose();
  });

  test("query identity is stable with no reaction armed and nothing observing", () => {
    // Deliberately not activated: this pins `keepAlive` as the mechanism rather than the query
    // reaction happening to observe the computed. A consumer reading `table.query` from an effect
    // or a query key is in exactly this position.
    const table = new TableModel({ data: [{ id: 1 }], columns: ["id"], mode: "server" });
    table.dispose();

    const first = table.query;
    table.setWidth(900);
    table.setScroll(0, 120);
    expect(table.query).toBe(first);

    table.setSort("id", "asc");
    expect(table.query).not.toBe(first);
    expect(table.query.sorts).toEqual([{ key: "id", direction: "asc" }]);
  });

  test("fetches the next page as the window nears the end, and stops when it runs out", async () => {
    const feed = lazyPages(pagedApi(25), { pageSize: 10 });
    const { table, dispose } = measured({ data: feed, columns: ["id"] });
    await tick();

    // 10 rows, a 10-row viewport: nothing below the window, so it keeps going
    expect(table.rows.length).toBeGreaterThanOrEqual(20);

    // scrolling to the end pulls the last partial page and then stops
    table.setScroll(0, table.virtualHeight);
    await tick();

    expect(table.rows.length).toBe(25);
    expect(feed.hasMore).toBe(false);

    const calls = (feed as any).pages as number;
    table.setScroll(0, table.virtualHeight);
    await tick();
    expect((feed as any).pages).toBe(calls); // nothing left to ask for

    dispose();
    table.dispose();
  });

  test("keeps fetching when a client-side filter rejects an entire page", async () => {
    // 200 rows in pages of 10, of which only the first 5 survive the filter. So after page one the
    // display rows stop growing entirely and `rowsToEnd` never moves — the exact case a thresholded
    // boolean gets wrong, and the reason the trigger carries the page count alongside the distance.
    const TOTAL = 200;
    const fetch = vi.fn(({ cursor }: { cursor?: string }) => {
      const start = cursor === undefined ? 0 : Number(cursor);
      const items = Array.from({ length: Math.min(10, TOTAL - start) }, (_, i) => ({
        id: start + i,
        kind: start + i < 5 ? "keep" : "drop",
      }));
      const next = start + items.length;
      return Promise.resolve({ items, cursor: next < TOTAL ? String(next) : null, total: TOTAL });
    });
    const filter = new SetFilter();
    const feed = lazyPages(fetch, { pageSize: 10 });
    const { table, dispose } = measured({
      data: feed,
      columns: [{ key: "kind", filter, filterMode: "client" }, "id"],
    });
    await tick();
    filter.toggle("keep");
    await tick(50);

    // it walked the whole dataset looking for matches rather than stalling one page in
    expect(feed.hasMore).toBe(false);
    expect(feed.pages).toBe(TOTAL / 10);
    expect(table.rows.length).toBe(TOTAL);
    expect(table.displayRows.map((r) => r.id)).toEqual([0, 1, 2, 3, 4]);

    dispose();
    table.dispose();
  });

  test("does not fetch before the viewport is measured", async () => {
    const fetch = pagedApi(500);
    const feed = lazyPages(fetch, { pageSize: 10 });
    const table = new TableModel({ data: feed, columns: ["id"] });
    table.activate();
    const dispose = autorun(() => void table.displayRows.length);
    await tick();

    // the first page comes from observation; the auto-fetch stays out of it until there is a
    // viewport to measure a threshold against
    expect(fetch.mock.calls.length).toBe(1);

    table.setHeight(400);
    await tick();
    expect(fetch.mock.calls.length).toBeGreaterThan(1);

    dispose();
    table.dispose();
  });

  test("an appended page never costs a selection, with or without getRowId", async () => {
    for (const getRowId of [undefined, (r: RowData) => r.id as number]) {
      const feed = lazyPages(pagedApi(500), { pageSize: 40 });
      const { table, dispose } = measured({ data: feed, columns: ["id"], getRowId });
      await tick();

      table.toggleRow(table.rows[0]!);
      expect(table.selectedRows.map((r) => r.id)).toEqual([0]);

      const before = table.rows.length;
      await feed.loadMore();
      expect(table.rows.length).toBeGreaterThan(before);
      expect(table.selectedRows.map((r) => r.id)).toEqual([0]);

      dispose();
      table.dispose();
    }
  });

  test("a failed first page is fatal to the table; a failed append is not", async () => {
    let firstPageFails = true;
    const fetch = vi.fn(({ cursor }: { cursor?: string }) => {
      // page one obeys the flag; every append fails, which is what the table's own fetch-ahead
      // will run into
      if (cursor === undefined && firstPageFails) return Promise.reject(new Error("first"));
      if (cursor !== undefined) return Promise.reject(new Error("append"));
      return Promise.resolve({
        items: Array.from({ length: 20 }, (_, i) => ({ id: i, name: `r${i}` })),
        cursor: "20",
        total: 100,
      });
    });
    const feed = lazyPages(fetch, { pageSize: 20 });
    const { table, dispose } = measured({ data: feed, columns: ["id"] });
    await tick();

    expect(table.loading).toBe(false);
    expect(table.error).toBeInstanceOf(Error);
    expect(table.isEmpty).toBe(false); // never "no results" about a request that failed

    firstPageFails = false;
    await feed.reload();
    await tick(20);

    // 20 rows with a 10-row viewport leaves fewer than a screenful below the window, so the table
    // asked for the next page on its own initiative — and it failed.
    expect(table.rows.length).toBe(20);
    expect(feed.error).toBeInstanceOf(Error);
    // the rows are still good rows: a failed append is the source's business, not the table's
    expect(table.error).toBeUndefined();
    expect(table.isEmpty).toBe(false);

    dispose();
    table.dispose();
  });

  test("stops fetching after a failed page, and scrolling does not retry it", async () => {
    let calls = 0;
    const fetch = vi.fn(({ cursor }: { cursor?: string }) => {
      calls++;
      if (cursor !== undefined) return Promise.reject(new Error("append"));
      return Promise.resolve({
        items: Array.from({ length: 20 }, (_, i) => ({ id: i })),
        cursor: "20",
        total: 1000,
      });
    });
    const feed = lazyPages(fetch, { pageSize: 20 });
    const { table, dispose } = measured({ data: feed, columns: ["id"] });
    await tick(20);

    expect(feed.error).toBeInstanceOf(Error);
    const afterFailure = calls;

    // a user nudging the scroll near a failing end must not mean a request per row
    for (let y = 0; y < 200; y += 40) {
      table.setScroll(0, y);
      await tick(5);
    }
    expect(calls).toBe(afterFailure);

    // an explicit retry is how it resumes — what a footer retry button does
    await feed.loadMore().catch(() => {});
    expect(calls).toBe(afterFailure + 1);

    dispose();
    table.dispose();
  });

  test("aria row count reports the dataset's extent, not the rows fetched so far", async () => {
    const feed = lazyPages(pagedApi(4382), { pageSize: 20 });
    const filter = new SetFilter();
    const { table, dispose } = measured({
      data: feed,
      columns: [{ key: "name", filter, filterMode: "client" }, "id"],
    });
    await tick(20);

    expect(table.displayRows.length).toBeLessThan(100);
    expect(table.ariaRowCount).toBe(4383); // the server's total, plus the header row

    // a client filter makes that total a claim about rows this table is hiding
    filter.toggle("nothing-matches-this");
    await tick(50);
    expect(table.ariaRowCount).toBe(table.displayRows.length + 1);

    dispose();
    table.dispose();
  });

  test("aria row count is -1 while the extent is genuinely unknown", async () => {
    const fetch = vi.fn(({ cursor }: { cursor?: string }) => {
      const start = cursor === undefined ? 0 : Number(cursor);
      // a cursor endpoint that reports no total: there is more, and nothing says how much
      return Promise.resolve({
        items: Array.from({ length: 20 }, (_, i) => ({ id: start + i })),
        cursor: start < 200 ? String(start + 20) : null,
      });
    });
    const feed = lazyPages(fetch, { pageSize: 20 });
    const { table, dispose } = measured({ data: feed, columns: ["id"] });
    await tick(50);

    expect(feed.hasMore).toBe(true);
    expect(table.ariaRowCount).toBe(-1);

    // once it runs out, the loaded count *is* the extent
    while (feed.hasMore) await feed.loadMore();
    expect(table.ariaRowCount).toBe(table.displayRows.length + 1);

    dispose();
    table.dispose();
  });

  test("a restart scrolls back to the top", async () => {
    const feed = lazyPages(pagedApi(500), { pageSize: 20 });
    const { table, dispose } = measured({ data: feed, columns: ["id"] });
    await tick();

    table.setScroll(0, 600);
    table.clearScrollRequest();
    expect(table.scrollY).toBe(600);

    await feed.reload();
    await tick();

    // parked past the end of one page would read as an empty table — and as "near the end", so the
    // fetch-ahead would immediately refill everything a filter change had just removed
    expect(table.scrollRequest).toEqual({ y: 0 });

    dispose();
    table.dispose();
  });

  test("rowsToEnd measures the distance below the render window", async () => {
    const feed = lazyPages(pagedApi(500), { pageSize: 100 });
    const { table, dispose } = measured({ data: feed, columns: ["id"] });
    await tick();

    expect(table.visibleRowCount).toBe(10);
    expect(table.rowsToEnd).toBe(table.displayRows.length - 1 - table.lastRenderedIndex);
    expect(table.rowsToEnd).toBeGreaterThan(0);

    table.setScroll(0, table.virtualHeight);
    expect(table.rowsToEnd).toBe(0);

    dispose();
    table.dispose();
  });

  test("an array-backed table drives nothing and reports no paged source", async () => {
    const { table, dispose } = measured({ data: [{ id: 1 }], columns: ["id"], mode: "server" });
    await tick();

    expect(table.pages).toBeUndefined();
    expect(table.lazy).toBeUndefined();
    expect(table.mode).toBe("server"); // explicit, with no source to infer from
    expect(table.rowsToEnd).toBe(0);

    dispose();
    table.dispose();
  });
});
