import { autorun } from "mobx";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { SetFilter } from "../filter/set-filter.model";
import { TableModel } from "./table.model";
import type { ColumnsDef, RowData } from "./table.types";

const disposeList: (() => void)[] = [];
const observe = (fn: () => void): void => {
  disposeList.push(autorun(fn));
};
afterEach(() => {
  while (disposeList.length) disposeList.pop()?.();
});

interface Person {
  id: number;
  first: string;
  last: string;
  secret: string;
  joined: Date;
}

const people: Person[] = [
  { id: 1, first: "Ada", last: "Lovelace", secret: "alpha", joined: new Date("2020-03-01") },
  { id: 2, first: "Alan", last: "Turing", secret: "beta", joined: new Date("2021-07-01") },
  { id: 3, first: "Grace", last: "Hopper", secret: "alpha", joined: new Date("2022-11-01") },
];

const ids = (rows: RowData[]): number[] => rows.map((r) => r.id as number);

const makeTable = (columns: ColumnsDef<Person>): TableModel => {
  const table = new TableModel({ rows: people, columns, getRowId: (p: Person) => p.id });
  table.setWidth(1000);
  table.setHeight(200);
  return table;
};

describe("built-in search", () => {
  test("is inert until something is typed", () => {
    const table = makeTable(["first", "last"]);
    expect(table.search.active).toBe(false);
    expect(table.search.predicate).toBeUndefined();
    expect(table.predicate).toBeUndefined();
    expect(table.activeFilterCount).toBe(0);
  });

  test("ORs across columns, unlike the AND across filters", () => {
    const table = makeTable(["first", "last"]);

    table.search.setText("a");
    expect(ids(table.filteredRows)).toEqual([1, 2, 3]);

    table.search.setText("turing");
    expect(ids(table.filteredRows)).toEqual([2]);
  });

  test("matches case-insensitively", () => {
    const table = makeTable(["first"]);
    table.search.setText("GRA");
    expect(ids(table.filteredRows)).toEqual([3]);
  });

  test("reads a computed column", () => {
    const table = makeTable([{ key: "name", value: (p) => `${p.first} ${p.last}` }]);
    table.search.setText("ada love");
    expect(ids(table.filteredRows)).toEqual([1]);
  });

  test("reads hidden columns — searchable describes the data, not visibility", () => {
    const table = makeTable(["first", "secret"]);
    table.column("secret")?.setHidden(true);

    table.search.setText("beta");
    expect(ids(table.filteredRows)).toEqual([2]);
  });

  test("searchable: false takes a column out", () => {
    const table = makeTable(["first", { key: "secret", searchable: false }]);
    expect(table.column("secret")?.searchable).toBe(false);
    expect(table.searchableColumns.map((c) => c.key)).toEqual(["first"]);

    table.search.setText("alpha");
    expect(table.filteredRows).toEqual([]);
  });

  test("the fn variant supplies a text projection", () => {
    // a date column searched as epoch millis is useless; this is how you search it as text
    const table = makeTable([
      "first",
      { key: "joined", searchable: (p) => p.joined.toISOString().slice(0, 7) },
    ]);

    table.search.setText("2021-07");
    expect(ids(table.filteredRows)).toEqual([2]);

    // and the raw value is genuinely not what is matched
    table.search.setText(String(people[1]?.joined.getTime()));
    expect(table.filteredRows).toEqual([]);
  });

  test("a selection column is never searched", () => {
    const table = makeTable([{ selection: true }, "first"]);
    expect(table.searchableColumns.map((c) => c.key)).toEqual(["first"]);
  });

  test("no searchable columns means no predicate", () => {
    const table = makeTable([{ key: "first", searchable: false }]);
    table.search.setText("ada");
    expect(table.search.predicate).toBeUndefined();
    expect(table.predicate).toBeUndefined();
  });

  test("ANDs with column filters", () => {
    const filter = new SetFilter({ selected: ["alpha"] });
    const table = makeTable(["first", { key: "secret", filter, searchable: false }]);

    table.search.setText("hopper");
    expect(ids(table.filteredRows)).toEqual([]);

    table.search.setText("grace");
    expect(ids(table.filteredRows)).toEqual([3]);
    expect(table.activeFilterCount).toBe(2);
  });

  test("counts toward activeFilterCount but is not cleared by clearFilters", () => {
    const filter = new SetFilter({ selected: ["alpha"] });
    const table = makeTable(["first", { key: "secret", filter }]);

    table.search.setText("ada");
    expect(table.activeFilterCount).toBe(2);

    table.clearFilters();
    // wiping text the user typed as a side effect is more surprising than leaving it
    expect(table.search.text).toBe("ada");
    expect(table.activeFilterCount).toBe(1);
    expect(filter.active).toBe(false);

    table.search.clear();
    expect(table.activeFilterCount).toBe(0);
  });

  test("narrows the counted-facet tally like any other filter", () => {
    const secret = new SetFilter({ counts: true });
    const table = makeTable(["first", { key: "secret", filter: secret }]);

    expect(table.column("secret")?.facets).toEqual([
      { value: "alpha", count: 2 },
      { value: "beta", count: 1 },
    ]);

    table.search.setText("ada");
    expect(table.column("secret")?.facets).toEqual([
      { value: "alpha", count: 1 },
      // "beta" survives at zero so it can still be ticked
      { value: "beta", count: 0 },
    ]);
  });

  test("is reactive", () => {
    const table = makeTable(["first", "last"]);
    const seen: number[][] = [];
    observe(() => seen.push(ids(table.filteredRows)));
    expect(seen).toEqual([[1, 2, 3]]);

    table.search.setText("a");
    expect(seen.at(-1)).toEqual([1, 2, 3]);

    table.search.setText("hopper");
    expect(seen.at(-1)).toEqual([3]);
  });

  test("does not trim — a trailing space is part of the query", () => {
    const table = makeTable([{ key: "name", value: (p) => `${p.first} ${p.last}` }]);
    table.search.setText("ada ");
    expect(ids(table.filteredRows)).toEqual([1]);
    table.search.setText("grace  ");
    expect(table.filteredRows).toEqual([]);
  });
});
