import { autorun, comparer, reaction } from "mobx";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { DateFilter } from "../filter/date-filter.model";
import { SetFilter } from "../filter/set-filter.model";
import { TextFilter } from "../filter/text-filter.model";
import { BLANK } from "../filter/util";
import { lazyArray } from "../lazy/lazy";
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

// realistic epoch millis: a DateFilter reads a bare number by magnitude, so toy values like 100
// would be interpreted as seconds
const T = Date.UTC(2026, 0, 1);
const logs: Log[] = [
  { id: 1, level: "info", message: "started", time: T },
  { id: 2, level: "error", message: "boom", time: T + 60_000 },
  { id: 3, level: "warn", message: "slow", time: T + 120_000 },
  { id: 4, level: "error", message: "boom again", time: T + 180_000 },
];

const ids = (rows: RowData[]): number[] => rows.map((r) => r.id as number);

const filterOfMessage = (table: TableModel): TextFilter => {
  const filter = table.column("message")?.filter;
  if (!(filter instanceof TextFilter)) throw new Error("no TextFilter on message");
  return filter;
};

const makeTable = (
  columns: ColumnsDef<Log>,
  config: Partial<TableConfig<Log>> = {},
): TableModel => {
  const table = new TableModel({ data: logs, columns, getRowId: (l: Log) => l.id, ...config });
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
    expect(ids(table.clientFilteredRows)).toEqual([1, 2, 3, 4]);
    expect(table.filterPredicate).toBeUndefined();
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
    expect(ids(table.clientFilteredRows)).toEqual([2, 4]);
    // only the server filter is serialized
    expect(table.filterQuery).toEqual([{ field: "level", op: "in", value: ["error"] }]);
    // but both count as narrowing the table
    expect(table.activeColumnFilters.length).toBe(2);
  });

  test("field overrides the wire name; key is the default", () => {
    const time = new DateFilter();
    const level = new SetFilter({ options: ["error"] });
    const table = makeTable([
      { key: "time", filter: time, filterMode: "server", field: "created_at" },
      { key: "level", filter: level, filterMode: "server" },
    ]);

    time.setRange(T + 30_000, T + 150_000);
    level.toggle("error");

    expect(table.filterQuery).toEqual([
      { field: "created_at", op: "range", value: { min: T + 30_000, max: T + 150_000 } },
      { field: "level", op: "in", value: ["error"] },
    ]);
  });

  test("each filter kind names its own op", () => {
    const set = new SetFilter({ options: ["a"], matchMode: "all", selected: ["a"] });
    const range = new DateFilter({ min: T });
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
    table.setData(logs.filter((l) => l.level === "error"));

    message.setText("again");
    expect(ids(table.clientFilteredRows)).toEqual([4]);
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
    table.setData(logs.filter((l) => l.level === "error"));

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

describe("clearColumnFilters by mode", () => {
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
    table.clearColumnFilters();
    expect(server.active).toBe(false);
    expect(client.active).toBe(false);
  });

  test('mode: "client" leaves the server ones alone', () => {
    const { table, server, client } = build();
    table.clearColumnFilters({ mode: "client" });
    expect(client.active).toBe(false);
    expect(server.active).toBe(true);
    expect(table.filterQuery).toEqual([{ field: "level", op: "in", value: ["error"] }]);
  });

  test('mode: "server" leaves the client ones alone', () => {
    const { table, server, client } = build();
    table.clearColumnFilters({ mode: "server" });
    expect(server.active).toBe(false);
    expect(client.active).toBe(true);
    expect(table.filterQuery).toBeUndefined();
  });
});

describe("server-mode search", () => {
  test("stops narrowing rows and serializes instead", () => {
    const table = makeTable(["level", "message"], { search: { mode: "server" } });

    expect(table.searchFilter.mode).toBe("server");
    table.searchFilter.setText("boom");

    expect(table.searchFilter.predicate).toBeUndefined();
    expect(ids(table.clientFilteredRows)).toEqual([1, 2, 3, 4]);
    // no field: it is not tied to one column
    expect(table.filterQuery).toEqual([{ op: "search", value: "boom" }]);
    // a source, not a column filter — but it is in filterQuery, which is what the server applies
    expect(table.activeColumnFilters).toEqual([]);
  });

  test("client mode is still the default and still narrows", () => {
    const table = makeTable(["level", "message"]);
    table.searchFilter.setText("boom");
    expect(table.searchFilter.mode).toBe("client");
    expect(ids(table.clientFilteredRows)).toEqual([2, 4]);
    expect(table.filterQuery).toBeUndefined();
  });

  test("composes with server-mode column filters in one query", () => {
    const filter = new SetFilter({ options: ["error"] });
    const table = makeTable([{ key: "level", filter, filterMode: "server" }, "message"], {
      search: { mode: "server" },
    });

    filter.toggle("error");
    table.searchFilter.setText("boom");

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

    table.searchFilter.setText("boom");
    expect(seen.at(-1)).toBe(1);

    table.searchFilter.clear();
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

// ---------------------------------------------------------------------------
// availability before the first response
// ---------------------------------------------------------------------------

describe("filterQuery before any rows arrive", () => {
  // A lazy on the very first render: fetching, nothing yet. The rows reaction fires immediately
  // with `undefined` and its handler skips it, so this used to leave the table with no columns at
  // all. `release` lands the rows when a test wants them.
  const pendingSource = () => lazyArray<Log>(() => new Promise<Log[]>(() => {}), { deep: false });

  test("configured columns exist immediately", () => {
    const table = new TableModel({
      data: pendingSource(),
      columns: [{ key: "level", filter: new SetFilter({ options: ["error"] }) }, "message"],
    });

    expect(table.loading).toBe(true);
    expect(table.column("level")).toBeDefined();
    expect(table.allColumns.map((c) => c.key)).toEqual(["level", "message"]);
  });

  test("a seeded server filter is in filterQuery before the first fetch", () => {
    // the bug this guards: a page that *fetches from* filterQuery would otherwise send its first
    // request — the one the user waits on — with no conditions at all
    const level = new SetFilter({ options: ["error"], selected: ["error"] });
    const time = new DateFilter({ min: T });
    const table = new TableModel({
      data: pendingSource(),
      columns: [
        { key: "level", filter: level, filterMode: "server" },
        { key: "time", filter: time, filterMode: "server", field: "created_at" },
      ],
    });

    expect(table.filterQuery).toEqual([
      { field: "level", op: "in", value: ["error"] },
      { field: "created_at", op: "range", value: { min: T } },
    ]);
    expect(table.activeColumnFilters.length).toBe(2);
  });

  test("the query a reaction sees first is already the seeded one", () => {
    const filter = new SetFilter({ options: ["error"], selected: ["error"] });
    const table = new TableModel({
      data: pendingSource(),
      columns: [{ key: "level", filter, filterMode: "server" }],
    });

    const requests: (FilterCondition[] | undefined)[] = [];
    disposeList.push(
      reaction(
        () => table.filterQuery,
        (q) => requests.push(q),
        {
          equals: comparer.structural,
          fireImmediately: true,
        },
      ),
    );

    expect(requests).toEqual([[{ field: "level", op: "in", value: ["error"] }]]);
  });

  test("auto columns still wait for a row, as they must", () => {
    const source = pendingSource();
    const table = new TableModel({ data: source, autoColumns: true });
    expect(table.allColumns).toEqual([]);

    // `set` lands a value without fetching, so the reaction fires synchronously
    source.set(logs);
    expect(table.allColumns.map((c) => c.key)).toEqual(["id", "level", "message", "time"]);
  });
});

describe("activeColumnFilters by mode", () => {
  const build = () => {
    const server = new SetFilter({ options: ["error"], selected: ["error"] });
    const client = new TextFilter({ text: "boom" });
    const table = makeTable([
      { key: "level", filter: server, filterMode: "server" },
      { key: "message", filter: client },
    ]);
    return { table, server, client };
  };

  test("no argument counts both sides, as before", () => {
    const { table } = build();
    expect(table.activeColumnFilters.length).toBe(2);
  });

  test("the client and server shortcuts split the list", () => {
    const { table } = build();
    expect(table.activeClientColumnFilters.map((c) => c.key)).toEqual(["message"]);
    expect(table.activeServerColumnFilters.map((c) => c.key)).toEqual(["level"]);
    expect(table.activeColumnFilters.map((c) => c.key)).toEqual(["level", "message"]);
  });

  test("a server toggle does not invalidate the client list", () => {
    // each side is its own computed, so a client-count chip is not re-rendered by server churn
    const { table, server } = build();
    let recomputes = 0;
    disposeList.push(
      autorun(() => {
        recomputes++;
        void table.activeClientColumnFilters.length;
      }),
    );
    expect(recomputes).toBe(1);

    server.toggle("warn");
    expect(recomputes).toBe(1);

    // nor does editing a client filter that stays active — the *list* hasn't changed
    filterOfMessage(table).setText("other");
    expect(recomputes).toBe(1);

    // deactivating one does, because that is a change to the list
    filterOfMessage(table).clear();
    expect(recomputes).toBe(2);
    expect(table.activeClientColumnFilters).toEqual([]);
  });

  test("each mode counts only its own side", () => {
    const { table } = build();
    expect(table.activeColumnFilters.filter((c) => c.filterMode === "client").length).toBe(1);
    expect(table.activeColumnFilters.filter((c) => c.filterMode === "server").length).toBe(1);
  });

  test("the client count is what a facet rail's Clear should gate on", () => {
    // it must not offer to reset a server-side window it doesn't own
    const { table, client } = build();
    client.clear();
    expect(table.activeColumnFilters.filter((c) => c.filterMode === "client").length).toBe(0);
    expect(table.activeColumnFilters.length).toBe(1);
  });

  test("the client count is what tells an empty state which side emptied it", () => {
    const { table, client } = build();
    client.setText("nothing matches this");
    expect(table.clientFilteredRows).toEqual([]);
    expect(table.rows.length).toBeGreaterThan(0);
    expect(
      table.activeColumnFilters.filter((c) => c.filterMode === "client").length,
    ).toBeGreaterThan(0);
  });

  test("search sits outside the split on either side", () => {
    // the column-qualified members exclude it on either side; a call site that wants it says so
    const client = makeTable(["message"]);
    client.searchFilter.setText("boom");
    expect(client.activeColumnFilters).toEqual([]);

    const server = makeTable(["message"], { search: { mode: "server" } });
    server.searchFilter.setText("boom");
    expect(server.activeColumnFilters).toEqual([]);
    // where it *does* show up is filterQuery, since the server has to apply it
    expect(server.filterQuery).toEqual([{ op: "search", value: "boom" }]);
  });

  test("mirrors clearColumnFilters, so the pair reads the same way", () => {
    const { table } = build();
    table.clearColumnFilters({ mode: "client" });
    expect(table.activeColumnFilters.filter((c) => c.filterMode === "client").length).toBe(0);
    expect(table.activeColumnFilters.filter((c) => c.filterMode === "server").length).toBe(1);
  });
});
