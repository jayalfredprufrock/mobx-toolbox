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
  const table = new TableModel({ data: people, columns, getRowId: (p: Person) => p.id });
  table.setWidth(1000);
  table.setHeight(200);
  return table;
};

describe("built-in search", () => {
  test("is inert until something is typed", () => {
    const table = makeTable(["first", "last"]);
    expect(table.searchFilter.active).toBe(false);
    expect(table.searchFilter.predicate).toBeUndefined();
    expect(table.filterPredicate).toBeUndefined();
    expect(table.activeColumnFilters.length).toBe(0);
  });

  test("ORs across columns, unlike the AND across filters", () => {
    const table = makeTable(["first", "last"]);

    table.searchFilter.setText("a");
    expect(ids(table.clientFilteredRows)).toEqual([1, 2, 3]);

    table.searchFilter.setText("turing");
    expect(ids(table.clientFilteredRows)).toEqual([2]);
  });

  test("matches case-insensitively", () => {
    const table = makeTable(["first"]);
    table.searchFilter.setText("GRA");
    expect(ids(table.clientFilteredRows)).toEqual([3]);
  });

  test("reads a computed column", () => {
    const table = makeTable([{ key: "name", value: (p) => `${p.first} ${p.last}` }]);
    table.searchFilter.setText("ada love");
    expect(ids(table.clientFilteredRows)).toEqual([1]);
  });

  test("reads hidden columns — searchable describes the data, not visibility", () => {
    const table = makeTable(["first", "secret"]);
    table.column("secret")?.setHidden(true);

    table.searchFilter.setText("beta");
    expect(ids(table.clientFilteredRows)).toEqual([2]);
  });

  test("searchable: false takes a column out", () => {
    const table = makeTable(["first", { key: "secret", searchable: false }]);
    expect(table.column("secret")?.searchable).toBe(false);
    expect(table.searchableColumns.map((c) => c.key)).toEqual(["first"]);

    table.searchFilter.setText("alpha");
    expect(table.clientFilteredRows).toEqual([]);
  });

  test("the fn variant supplies a text projection", () => {
    // a date column searched as epoch millis is useless; this is how you search it as text
    const table = makeTable([
      "first",
      { key: "joined", searchable: (p) => p.joined.toISOString().slice(0, 7) },
    ]);

    table.searchFilter.setText("2021-07");
    expect(ids(table.clientFilteredRows)).toEqual([2]);

    // and the raw value is genuinely not what is matched
    table.searchFilter.setText(String(people[1]?.joined.getTime()));
    expect(table.clientFilteredRows).toEqual([]);
  });

  test("a selection column is never searched", () => {
    const table = makeTable([{ selection: true }, "first"]);
    expect(table.searchableColumns.map((c) => c.key)).toEqual(["first"]);
  });

  test("no searchable columns means no predicate", () => {
    const table = makeTable([{ key: "first", searchable: false }]);
    table.searchFilter.setText("ada");
    expect(table.searchFilter.predicate).toBeUndefined();
    expect(table.filterPredicate).toBeUndefined();
  });

  test("ANDs with column filters", () => {
    const filter = new SetFilter({ selected: ["alpha"] });
    const table = makeTable(["first", { key: "secret", filter, searchable: false }]);

    table.searchFilter.setText("hopper");
    expect(ids(table.clientFilteredRows)).toEqual([]);

    table.searchFilter.setText("grace");
    expect(ids(table.clientFilteredRows)).toEqual([3]);
    // one column filter; the search narrows too but is a source, not a column filter
    expect(table.activeColumnFilters.length).toBe(1);
  });

  test("is the other kind of filter, so column-qualified members leave it out", () => {
    // One query across many columns, so it has no column of its own — which is exactly what the
    // `column` qualifier excludes. Both names say so without needing a caveat.
    const filter = new SetFilter({ selected: ["alpha"] });
    const table = makeTable(["first", { key: "secret", filter }]);

    table.searchFilter.setText("ada");
    expect(table.activeColumnFilters.map((c) => c.key)).toEqual(["secret"]);
    // everything narrowing the table, which is what a chip shows
    expect(table.activeColumnFilters.length + (table.searchFilter.active ? 1 : 0)).toBe(2);

    table.clearColumnFilters();
    // wiping text the user typed as a side effect is more surprising than leaving it
    expect(table.searchFilter.text).toBe("ada");
    expect(table.activeColumnFilters).toEqual([]);
    expect(filter.active).toBe(false);
  });

  test("narrows the counted-facet tally like any other filter", () => {
    const secret = new SetFilter({ counts: true });
    const table = makeTable(["first", { key: "secret", filter: secret }]);

    expect(table.column("secret")?.facets).toEqual([
      { value: "alpha", count: 2 },
      { value: "beta", count: 1 },
    ]);

    table.searchFilter.setText("ada");
    expect(table.column("secret")?.facets).toEqual([
      { value: "alpha", count: 1 },
      // "beta" survives at zero so it can still be ticked
      { value: "beta", count: 0 },
    ]);
  });

  test("is reactive", () => {
    const table = makeTable(["first", "last"]);
    const seen: number[][] = [];
    observe(() => seen.push(ids(table.clientFilteredRows)));
    expect(seen).toEqual([[1, 2, 3]]);

    table.searchFilter.setText("a");
    expect(seen.at(-1)).toEqual([1, 2, 3]);

    table.searchFilter.setText("hopper");
    expect(seen.at(-1)).toEqual([3]);
  });

  test("does not trim — a trailing space is part of the query", () => {
    const table = makeTable([{ key: "name", value: (p) => `${p.first} ${p.last}` }]);
    table.searchFilter.setText("ada ");
    expect(ids(table.clientFilteredRows)).toEqual([1]);
    table.searchFilter.setText("grace  ");
    expect(table.clientFilteredRows).toEqual([]);
  });
});
