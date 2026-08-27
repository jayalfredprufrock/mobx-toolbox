import { comparer, reaction } from "mobx";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { NumberFilter } from "../filter/number-filter.model";
import { SetFilter } from "../filter/set-filter.model";
import { TextFilter } from "../filter/text-filter.model";
import { BLANK } from "../filter/util";
import { TableModel } from "./table.model";
import type { ColumnsDef, RowData, TableConfig, TableState } from "./table.types";

const disposeList: (() => void)[] = [];
afterEach(() => {
  while (disposeList.length) disposeList.pop()?.();
});

interface Item {
  id: number;
  category: string | null;
  name: string;
  score: number;
}

const items: Item[] = [
  { id: 1, category: "a", name: "ada", score: 10 },
  { id: 2, category: "b", name: "alan", score: 20 },
  { id: 3, category: "a", name: "grace", score: 30 },
  { id: 4, category: null, name: "edsger", score: 40 },
];

const ids = (rows: RowData[]): number[] => rows.map((r) => r.id as number);

const columns: ColumnsDef<Item> = [
  { key: "category", filter: () => new SetFilter() },
  { key: "name", filter: () => new TextFilter() },
  { key: "score", filter: () => new NumberFilter() },
];

const makeTable = (config: Partial<TableConfig<Item>> = {}): TableModel => {
  const table = new TableModel({ rows: items, columns, getRowId: (i: Item) => i.id, ...config });
  table.setWidth(1000);
  table.setHeight(200);
  return table;
};

// Narrowing by `instanceof` is how a UI reaches a typed filter off a column.
const filterOf = <T>(
  table: TableModel,
  key: string,
  kind: abstract new (...args: never[]) => T,
): T => {
  const filter = table.column(key)?.filter;
  if (!(filter instanceof kind)) throw new Error(`No ${kind.name} on column "${key}"`);
  return filter;
};

// A snapshot that has genuinely been through storage, not a live object handed straight back.
const roundTrip = (state: TableState): TableState =>
  JSON.parse(JSON.stringify(state)) as TableState;

describe("filter state in the snapshot", () => {
  test("survives a full JSON round-trip into a fresh table", () => {
    const first = makeTable();
    filterOf(first, "category", SetFilter).select(["a", BLANK]);
    filterOf(first, "score", NumberFilter).set("between", { min: 5, max: 35 });
    first.searchFilter.setText("a");
    const saved = roundTrip(first.getState());

    const second = makeTable();
    second.applyState(saved);

    expect(filterOf(second, "category", SetFilter).value).toEqual({
      selected: ["a", BLANK],
      matchMode: "any",
    });
    expect(filterOf(second, "score", NumberFilter).value).toEqual({
      op: "between",
      operand: { min: 5, max: 35 },
    });
    expect(second.searchFilter.text).toBe("a");
    expect(ids(second.clientFilteredRows)).toEqual(ids(first.clientFilteredRows));
  });

  test("getState -> applyState is exact, including clearing", () => {
    const table = makeTable();
    const pristine = roundTrip(table.getState());

    filterOf(table, "category", SetFilter).toggle("a");
    table.searchFilter.setText("x");
    expect(table.getState().columnFilters).not.toEqual({});

    // the snapshot said nothing was filtered, so restoring it must unfilter
    table.applyState(pristine);
    expect(table.getState()).toEqual(pristine);
    expect(table.activeColumnFilters.length).toBe(0);
  });

  test("a filters key is a complete picture — unmentioned filters are cleared", () => {
    const table = makeTable();
    filterOf(table, "category", SetFilter).toggle("a");
    filterOf(table, "score", NumberFilter).set("gte", 15);

    table.applyState({ columnFilters: { score: { op: "gte", operand: 25 } } });

    expect(filterOf(table, "category", SetFilter).active).toBe(false);
    expect(filterOf(table, "score", NumberFilter).value).toEqual({ op: "gte", operand: 25 });
  });

  test("omitting the filters key leaves filters alone", () => {
    const table = makeTable();
    filterOf(table, "category", SetFilter).toggle("a");

    table.applyState({ sorts: [{ key: "score", direction: "desc" }] });
    expect(filterOf(table, "category", SetFilter).has("a")).toBe(true);
    expect(table.searchFilter.text).toBe("");
  });

  test("matchMode rides along", () => {
    const table = makeTable();
    const filter = filterOf(table, "category", SetFilter);
    filter.select(["a", "b"]);
    filter.setMatchMode("all");

    const restored = makeTable();
    restored.applyState(roundTrip(table.getState()));
    expect(filterOf(restored, "category", SetFilter).matchMode).toBe("all");
  });

  test("configured columns take filter state before any rows arrive", () => {
    const table = new TableModel({ columns, getRowId: (i: Item) => i.id });
    // configured columns don't depend on data, so they exist from construction
    expect(table.column("category")).toBeDefined();

    table.applyState({ columnFilters: { category: { selected: ["a"], matchMode: "any" } } });
    expect(filterOf(table, "category", SetFilter).has("a")).toBe(true);

    table.setRows(items as RowData[]);
    expect(ids(table.clientFilteredRows)).toEqual([1, 3]);
  });

  test("a column that genuinely materializes late still picks its state up", () => {
    // factory defs resolve against the first row, so they are the case that really does wait
    const table = new TableModel({
      columns: [(row: Item) => ({ key: "name", filter: new SetFilter(), title: row.name })],
      getRowId: (i: Item) => i.id,
    });
    table.applyState({ columnFilters: { name: { selected: ["ada"], matchMode: "any" } } });
    expect(table.column("name")).toBeUndefined();

    table.setRows(items as RowData[]);
    expect(filterOf(table, "name", SetFilter).has("ada")).toBe(true);
    expect(ids(table.clientFilteredRows)).toEqual([1]);
  });

  test("onStateChange fires on a filter change and on a keystroke", () => {
    const seen: TableState[] = [];
    const table = makeTable({ onStateChange: (state) => seen.push(state) });

    filterOf(table, "category", SetFilter).toggle("a");
    expect(seen.at(-1)?.columnFilters).toEqual({ category: { selected: ["a"], matchMode: "any" } });

    table.searchFilter.setText("ad");
    expect(seen.at(-1)?.search).toBe("ad");
  });

  test("the arrangement half can be debounced apart from the filter half", () => {
    // why `filters`/`search` are separate top-level keys rather than folded into `columns`
    const table = makeTable();
    const arrangements: unknown[] = [];
    disposeList.push(
      reaction(
        () => {
          const { columnFilters: _f, search: _s, ...arrangement } = table.getState();
          return arrangement;
        },
        (a) => arrangements.push(a),
        { equals: comparer.structural },
      ),
    );

    table.searchFilter.setText("ada");
    filterOf(table, "category", SetFilter).toggle("a");
    expect(arrangements).toEqual([]);

    table.setSort("score", "asc");
    expect(arrangements).toHaveLength(1);
  });
});

describe("restoring untrusted state", () => {
  test("a filter type that changed under the key resets rather than corrupting", () => {
    const table = makeTable();
    // a DateFilter's snapshot left in storage under a key that now holds a SetFilter
    table.applyState({ columnFilters: { category: { min: 1, max: 2 } } });

    const filter = filterOf(table, "category", SetFilter);
    expect(filter.active).toBe(false);
    expect(filter.matchMode).toBe("any");
    expect(ids(table.clientFilteredRows)).toEqual([1, 2, 3, 4]);
  });

  test("garbage entries are dropped, valid ones kept", () => {
    const table = makeTable();
    table.applyState({
      columnFilters: {
        category: { selected: ["a", { nope: true }, null, "b"], matchMode: "sideways" },
        score: { op: "gte", operand: "10" },
        name: { not: "a string" },
      },
    });

    expect(filterOf(table, "category", SetFilter).value).toEqual({
      selected: ["a", "b"],
      matchMode: "any",
    });
    expect(filterOf(table, "score", NumberFilter).value).toEqual({ op: "gte" });
    expect(filterOf(table, "name", TextFilter).text).toBe("");
  });

  test("a key with no column is harmless and does not linger", () => {
    const table = makeTable();
    table.applyState({ columnFilters: { ghost: { selected: ["x"], matchMode: "any" } } });
    expect(table.getState().columnFilters).toEqual({});
    expect(ids(table.clientFilteredRows)).toEqual([1, 2, 3, 4]);
  });

  test("an old snapshot with no filters key still applies", () => {
    const table = makeTable();
    filterOf(table, "category", SetFilter).toggle("a");
    // written before filters were persisted at all
    table.applyState({ columnOrder: ["score", "name", "category"], columns: {}, sorts: [] });

    expect(table.columnOrder).toEqual(["score", "name", "category"]);
    expect(filterOf(table, "category", SetFilter).has("a")).toBe(true);
  });
});
