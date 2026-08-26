import { autorun, comparer, reaction } from "mobx";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { RangeFilter } from "../filter/range-filter.model";
import { SetFilter } from "../filter/set-filter.model";
import { TextFilter } from "../filter/text-filter.model";
import { BLANK } from "../filter/util";
import { TableModel } from "./table.model";
import type { ColumnsDef, FilterCondition, RowData, TableConfig } from "./table.types";

const disposeList: (() => void)[] = [];
const observe = (fn: () => void): void => {
  disposeList.push(autorun(fn));
};
afterEach(() => {
  while (disposeList.length) disposeList.pop()?.();
});

interface Log {
  id: number;
  level: string;
  message: string;
  time: number;
}

const logs: Log[] = [
  { id: 1, level: "info", message: "started", time: 100 },
  { id: 2, level: "error", message: "boom", time: 200 },
  { id: 3, level: "warn", message: "slow", time: 300 },
  { id: 4, level: "error", message: "boom again", time: 400 },
];

const ids = (rows: RowData[]): number[] => rows.map((r) => r.id as number);

const makeTable = (
  columns: ColumnsDef<Log>,
  config: Partial<TableConfig<Log>> = {},
): TableModel => {
  const table = new TableModel({ rows: logs, columns, getRowId: (l: Log) => l.id, ...config });
  table.setWidth(1000);
  table.setHeight(200);
  return table;
};

// ---------------------------------------------------------------------------
// the client/server partition
// ---------------------------------------------------------------------------

describe("server-mode filters", () => {
  test("default is client mode", () => {
    const table = makeTable([{ key: "level", filter: new SetFilter() }]);
    expect(table.column("level")?.filterMode).toBe("client");
    expect(table.filterQuery).toBeUndefined();
  });

  test("a server-mode filter is never applied client-side", () => {
    const filter = new SetFilter({ options: ["info", "error", "warn"] });
    const table = makeTable([{ key: "level", filter, filterMode: "server" }]);

    filter.toggle("error");
    // the rows arrived already filtered; running it again here would filter twice
    expect(ids(table.filteredRows)).toEqual([1, 2, 3, 4]);
    expect(table.predicate).toBeUndefined();
  });

  test("it serializes into filterQuery instead", () => {
    const filter = new SetFilter({ options: ["info", "error"] });
    const table = makeTable([{ key: "level", filter, filterMode: "server" }]);

    expect(table.filterQuery).toBeUndefined();

    filter.toggle("error");
    expect(table.filterQuery).toEqual([{ field: "level", op: "in", value: ["error"] }]);
  });

  test("the two sets are disjoint — every filter applied exactly once", () => {
    const level = new SetFilter({ options: ["error"] });
    const message = new TextFilter();
    const table = makeTable([
      { key: "level", filter: level, filterMode: "server" },
      { key: "message", filter: message },
    ]);

    level.toggle("error");
    message.setText("boom");

    // only the client filter narrows here
    expect(ids(table.filteredRows)).toEqual([2, 4]);
    // only the server filter is serialized
    expect(table.filterQuery).toEqual([{ field: "level", op: "in", value: ["error"] }]);
    // but both count as narrowing the table
    expect(table.activeFilterCount).toBe(2);
  });

  test("field overrides the wire name; key is the default", () => {
    const time = new RangeFilter();
    const level = new SetFilter({ options: ["error"] });
    const table = makeTable([
      { key: "time", filter: time, filterMode: "server", field: "created_at" },
      { key: "level", filter: level, filterMode: "server" },
    ]);

    time.setRange(150, 350);
    level.toggle("error");

    expect(table.filterQuery).toEqual([
      { field: "created_at", op: "range", value: { min: 150, max: 350 } },
      { field: "level", op: "in", value: ["error"] },
    ]);
  });

  test("each filter kind names its own op", () => {
    const set = new SetFilter({ options: ["a"], matchMode: "all", selected: ["a"] });
    const range = new RangeFilter({ min: 1 });
    const contains = new TextFilter({ text: "x" });
    const starts = new TextFilter({ text: "x", match: "startsWith" });

    const table = makeTable([
      { key: "level", filter: set, filterMode: "server" },
      { key: "time", filter: range, filterMode: "server" },
      { key: "message", filter: contains, filterMode: "server" },
      { key: "extra", value: (l) => l.message, filter: starts, filterMode: "server" },
    ]);

    expect(table.filterQuery?.map((c) => c.op)).toEqual(["all", "range", "contains", "startsWith"]);
  });

  test("filterQuery is plain JSON and compares structurally", () => {
    const filter = new SetFilter({ options: ["error"] });
    const table = makeTable([{ key: "level", filter, filterMode: "server" }]);
    filter.toggle("error");

    const query = table.filterQuery;
    expect(JSON.parse(JSON.stringify(query))).toEqual(query);

    // the shape a page reacts on: unrelated churn must not fire a refetch
    const fired: (FilterCondition[] | undefined)[] = [];
    disposeList.push(
      reaction(
        () => table.filterQuery,
        (q) => fired.push(q),
        { equals: comparer.structural },
      ),
    );

    table.setSort("time", "desc");
    table.column("level")?.setHidden(true);
    expect(fired).toEqual([]);

    filter.toggle("warn");
    expect(fired).toEqual([[{ field: "level", op: "in", value: ["error", "warn"] }]]);
  });

  test("a hidden server-mode column still serializes", () => {
    const filter = new SetFilter({ options: ["error"] });
    const table = makeTable([{ key: "level", filter, filterMode: "server" }, "message"]);

    filter.toggle("error");
    table.column("level")?.setHidden(true);
    expect(table.filterQuery).toEqual([{ field: "level", op: "in", value: ["error"] }]);
  });

  test("client filters narrow server results without extra machinery", () => {
    const level = new SetFilter({ options: ["error"] });
    const message = new TextFilter();
    const table = makeTable([
      { key: "level", filter: level, filterMode: "server" },
      { key: "message", filter: message },
    ]);

    level.toggle("error");
    // what the server sent back for that query
    table.setRows(logs.filter((l) => l.level === "error"));

    message.setText("again");
    expect(ids(table.filteredRows)).toEqual([4]);
  });
});

// ---------------------------------------------------------------------------
// facets under server mode
// ---------------------------------------------------------------------------

describe("server-mode facets", () => {
  test("uses declared options and never walks the rows", () => {
    const filter = new SetFilter({ options: ["info", "warn", "error", "fatal"] });
    const table = makeTable([{ key: "level", filter, filterMode: "server" }]);

    // "fatal" appears in no row and is still offered; nothing is discovered or dropped
    expect(table.column("level")?.facets).toEqual([
      { value: "info" },
      { value: "warn" },
      { value: "error" },
      { value: "fatal" },
    ]);
  });

  test("the list does not collapse as the selection narrows the rows", () => {
    // the failure this rule exists to prevent: discovering the domain from already-filtered rows
    // would shrink the list to whatever is selected, with no way to widen it again
    const filter = new SetFilter({ options: ["info", "warn", "error"] });
    const table = makeTable([{ key: "level", filter, filterMode: "server" }]);

    filter.toggle("error");
    table.setRows(logs.filter((l) => l.level === "error"));

    expect(table.column("level")?.facets).toEqual([
      { value: "info" },
      { value: "warn" },
      { value: "error" },
    ]);
  });

  test("never carries counts, even when asked for", () => {
    const filter = new SetFilter({ options: ["info", "error"], counts: true });
    const table = makeTable([{ key: "level", filter, filterMode: "server" }]);

    // counting an already-narrowed set would describe the current selection, not the alternatives
    expect(table.column("level")?.facets).toEqual([{ value: "info" }, { value: "error" }]);
  });

  test("without options the facet list is empty", () => {
    const table = makeTable([{ key: "level", filter: new SetFilter(), filterMode: "server" }]);
    expect(table.column("level")?.facets).toEqual([]);
  });

  test("a client column's counted facets ignore server filters", () => {
    // those are already applied to `rows`, so counting them again would narrow twice
    const level = new SetFilter({ options: ["error"] });
    const message = new SetFilter({ counts: true });
    const table = makeTable([
      { key: "level", filter: level, filterMode: "server" },
      { key: "message", filter: message },
    ]);

    level.toggle("error");
    expect(table.column("message")?.facets).toEqual([
      { value: "boom", count: 1 },
      { value: "boom again", count: 1 },
      { value: "slow", count: 1 },
      { value: "started", count: 1 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// clearing, and server search
// ---------------------------------------------------------------------------

describe("clearFilters by mode", () => {
  const build = () => {
    const server = new SetFilter({ options: ["error"], selected: ["error"] });
    const client = new TextFilter({ text: "boom" });
    const table = makeTable([
      { key: "level", filter: server, filterMode: "server" },
      { key: "message", filter: client },
    ]);
    return { table, server, client };
  };

  test("no argument clears both sides", () => {
    const { table, server, client } = build();
    table.clearFilters();
    expect(server.active).toBe(false);
    expect(client.active).toBe(false);
  });

  test('mode: "client" leaves the server ones alone', () => {
    const { table, server, client } = build();
    table.clearFilters({ mode: "client" });
    expect(client.active).toBe(false);
    expect(server.active).toBe(true);
    expect(table.filterQuery).toEqual([{ field: "level", op: "in", value: ["error"] }]);
  });

  test('mode: "server" leaves the client ones alone', () => {
    const { table, server, client } = build();
    table.clearFilters({ mode: "server" });
    expect(server.active).toBe(false);
    expect(client.active).toBe(true);
    expect(table.filterQuery).toBeUndefined();
  });
});

describe("server-mode search", () => {
  test("stops narrowing rows and serializes instead", () => {
    const table = makeTable(["level", "message"], { search: { mode: "server" } });

    expect(table.search.mode).toBe("server");
    table.search.setText("boom");

    expect(table.search.predicate).toBeUndefined();
    expect(ids(table.filteredRows)).toEqual([1, 2, 3, 4]);
    // no field: it is not tied to one column
    expect(table.filterQuery).toEqual([{ op: "search", value: "boom" }]);
    expect(table.activeFilterCount).toBe(1);
  });

  test("client mode is still the default and still narrows", () => {
    const table = makeTable(["level", "message"]);
    table.search.setText("boom");
    expect(table.search.mode).toBe("client");
    expect(ids(table.filteredRows)).toEqual([2, 4]);
    expect(table.filterQuery).toBeUndefined();
  });

  test("composes with server-mode column filters in one query", () => {
    const filter = new SetFilter({ options: ["error"] });
    const table = makeTable([{ key: "level", filter, filterMode: "server" }, "message"], {
      search: { mode: "server" },
    });

    filter.toggle("error");
    table.search.setText("boom");

    expect(table.filterQuery).toEqual([
      { field: "level", op: "in", value: ["error"] },
      { op: "search", value: "boom" },
    ]);
  });

  test("filterQuery is reactive", () => {
    const table = makeTable(["message"], { search: { mode: "server" } });
    const seen: number[] = [];
    observe(() => seen.push(table.filterQuery?.length ?? 0));
    expect(seen).toEqual([0]);

    table.search.setText("boom");
    expect(seen.at(-1)).toBe(1);

    table.search.clear();
    expect(seen.at(-1)).toBe(0);
  });
});

describe("blanks survive serialization", () => {
  test("BLANK rides along as an ordinary selected value", () => {
    const filter = new SetFilter({ options: ["info", BLANK] });
    const table = makeTable([{ key: "level", filter, filterMode: "server" }]);

    filter.toggle(BLANK);
    expect(table.filterQuery).toEqual([{ field: "level", op: "in", value: [""] }]);
  });
});
