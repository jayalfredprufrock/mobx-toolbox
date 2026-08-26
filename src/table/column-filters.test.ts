import { autorun } from "mobx";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { RangeFilter } from "../filter/range-filter.model";
import { SetFilter } from "../filter/set-filter.model";
import { TextFilter } from "../filter/text-filter.model";
import { BLANK } from "../filter/util";
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
  category: string | null;
  first: string;
  last: string;
  tags: string[] | null;
  score: number;
}

// One row per interesting shape: a null scalar, an empty array, a null array, and multi-valued
// arrays that overlap. `tags` is what makes the array/blank paths reachable.
const people: Person[] = [
  { id: 1, category: "a", first: "Ada", last: "Lovelace", tags: ["x", "y"], score: 10 },
  { id: 2, category: "b", first: "Alan", last: "Turing", tags: ["y"], score: 20 },
  { id: 3, category: "a", first: "Grace", last: "Hopper", tags: [], score: 30 },
  { id: 4, category: null, first: "Edsger", last: "Dijkstra", tags: null, score: 40 },
  { id: 5, category: "c", first: "Barbara", last: "Liskov", tags: ["x"], score: 50 },
];

const ids = (rows: RowData[]): number[] => rows.map((r) => r.id as number);

const makeTable = (columns: ColumnsDef<Person>, rows: Person[] = people): TableModel => {
  const table = new TableModel({ rows, columns, getRowId: (p: Person) => p.id });
  table.setWidth(1000);
  table.setHeight(200);
  return table;
};

// ---------------------------------------------------------------------------
// the predicate
// ---------------------------------------------------------------------------

describe("column filters", () => {
  test("no filter anywhere means no predicate at all", () => {
    const table = makeTable(["category"]);
    expect(table.predicate).toBeUndefined();
    expect(table.filteredRows).toBe(table.rows);
    expect(table.activeFilterCount).toBe(0);
  });

  test("an inactive filter is still no predicate", () => {
    const table = makeTable([{ key: "category", filter: new SetFilter() }]);
    expect(table.predicate).toBeUndefined();
    expect(table.activeFilterCount).toBe(0);
  });

  test("a filter on a field column narrows rows", () => {
    const filter = new SetFilter();
    const table = makeTable([{ key: "category", filter }]);

    filter.toggle("a");
    expect(ids(table.filteredRows)).toEqual([1, 3]);
    expect(table.activeFilterCount).toBe(1);
  });

  test("a filter on a computed column narrows rows", () => {
    // the case the string-path prototype could not express at all: there is no path to `name`
    const filter = new TextFilter();
    const table = makeTable([
      { key: "name", value: (p) => `${p.first} ${p.last}`, filter },
      "category",
    ]);

    filter.setText("hopper");
    expect(ids(table.filteredRows)).toEqual([3]);
  });

  test("filters AND together across columns", () => {
    const category = new SetFilter({ selected: ["a", "b"] });
    const score = new RangeFilter({ min: 15 });
    const table = makeTable([
      { key: "category", filter: category },
      { key: "score", filter: score },
    ]);

    expect(ids(table.filteredRows)).toEqual([2, 3]);
    expect(table.activeFilterCount).toBe(2);
  });

  test("array values match through the set filter", () => {
    const tags = new SetFilter();
    const table = makeTable([{ key: "tags", filter: tags }]);

    tags.toggle("x");
    expect(ids(table.filteredRows)).toEqual([1, 5]);

    tags.setMatchMode("all");
    tags.toggle("y");
    expect(ids(table.filteredRows)).toEqual([1]);
  });

  test("selecting BLANK reaches the empty-array and null rows alike", () => {
    const tags = new SetFilter({ selected: [BLANK] });
    const table = makeTable([{ key: "tags", filter: tags }]);
    expect(ids(table.filteredRows)).toEqual([3, 4]);
  });

  test("composes with page-level filterSources", () => {
    const filter = new SetFilter({ selected: ["a", "b", "c"] });
    const table = makeTable([{ key: "category", filter }]);
    table.setFilter({ predicate: (row: RowData) => (row.score as number) > 15 });

    expect(ids(table.filteredRows)).toEqual([2, 3, 5]);
    // the table cannot tell how many dimensions a FilterSource stands for, so it counts none
    expect(table.activeFilterCount).toBe(1);
  });

  test("filtering still runs over rows without replacing them, so selection survives", () => {
    const filter = new SetFilter();
    const table = makeTable([{ key: "category", filter }]);

    table.toggleRow(table.rows[4] as RowData);
    expect(table.selectedIds.size).toBe(1);

    filter.toggle("a");
    expect(ids(table.filteredRows)).toEqual([1, 3]);
    expect(table.selectedIds.size).toBe(1);
    expect(table.visibleSelectedRows).toEqual([]);
  });

  test("a hidden column's active filter keeps narrowing", () => {
    const filter = new SetFilter({ selected: ["a"] });
    const table = makeTable([{ key: "category", filter }, "score"]);

    table.column("category")?.setHidden(true);
    expect(ids(table.filteredRows)).toEqual([1, 3]);
    // the count is the disclosure for a filter with no visible control
    expect(table.activeFilterCount).toBe(1);
  });

  test("filterable is advisory — a filterable:false column still narrows", () => {
    const filter = new SetFilter({ selected: ["a"] });
    const table = makeTable([{ key: "category", filter, filterable: false }]);

    expect(table.column("category")?.filterable).toBe(false);
    expect(ids(table.filteredRows)).toEqual([1, 3]);
  });

  test("filterable defaults to true where a filter is attached and false where none is", () => {
    const table = makeTable([{ key: "category", filter: new SetFilter() }, "score"]);
    expect(table.column("category")?.filterable).toBe(true);
    expect(table.column("score")?.filterable).toBe(false);
  });

  test("a selection column is never filterable", () => {
    const table = makeTable([{ selection: true }, "category"]);
    const selection = table.allColumns.find((c) => c.selection);
    expect(selection?.filterable).toBe(false);
  });

  test("the predicate reacts to a swap that leaves `active` unchanged", () => {
    // same selection size throughout, so anything depending on `active` alone would go stale
    const filter = new SetFilter({ selected: ["a"] });
    const table = makeTable([{ key: "category", filter }]);

    const seen: number[][] = [];
    observe(() => seen.push(ids(table.filteredRows)));
    expect(seen).toEqual([[1, 3]]);

    filter.select(["b"]);
    expect(seen.at(-1)).toEqual([2]);
  });
});

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

describe("column filters across the column lifecycle", () => {
  test("the filter and its state survive setRows and appendRows", () => {
    const filter = new SetFilter({ selected: ["a"] });
    const table = makeTable([{ key: "category", filter }]);

    table.setRows(people.slice(0, 3));
    expect(table.column("category")?.filter).toBe(filter);
    expect(ids(table.filteredRows)).toEqual([1, 3]);

    table.appendRows([{ ...people[4], id: 6, category: "a" } as RowData]);
    expect(table.column("category")?.filter).toBe(filter);
    expect(ids(table.filteredRows)).toEqual([1, 3, 6]);
  });

  test("setColumns keeps the existing filter instance for a surviving key", () => {
    // syncColumns preserves the ColumnModel behind a key it already has, which is what makes the
    // instance-on-the-def design safe — and also why a new def for that key is ignored wholesale
    const original = new SetFilter({ selected: ["a"] });
    const table = makeTable([{ key: "category", filter: original }]);

    table.setColumns([{ key: "category", filter: new SetFilter() }, "score"]);

    expect(table.column("category")?.filter).toBe(original);
    expect(ids(table.filteredRows)).toEqual([1, 3]);
  });

  test("removeColumn drops the filter with the column; addColumn brings a fresh one", () => {
    const original = new SetFilter({ selected: ["a"] });
    const table = makeTable([{ key: "category", filter: original }, "score"]);

    table.removeColumn("category");
    expect(table.column("category")).toBeUndefined();
    expect(ids(table.filteredRows)).toEqual([1, 2, 3, 4, 5]);

    const replacement = new RangeFilter({ min: 40 });
    table.addColumn({ key: "score2", value: (p: Person) => p.score, filter: replacement });
    expect(table.column("score2")?.filter).toBe(replacement);
    expect(ids(table.filteredRows)).toEqual([4, 5]);
  });

  test("clearFilters resets every column filter", () => {
    const category = new SetFilter({ selected: ["a"] });
    const score = new RangeFilter({ min: 25 });
    const table = makeTable([
      { key: "category", filter: category },
      { key: "score", filter: score },
    ]);
    expect(ids(table.filteredRows)).toEqual([3]);

    table.clearFilters();
    expect(category.active).toBe(false);
    expect(score.active).toBe(false);
    expect(table.activeFilterCount).toBe(0);
    expect(ids(table.filteredRows)).toEqual([1, 2, 3, 4, 5]);
  });

  test("clearFilters leaves page-level filterSources alone", () => {
    const filter = new SetFilter({ selected: ["a"] });
    const table = makeTable([{ key: "category", filter }]);
    table.setFilter({ predicate: (row: RowData) => (row.score as number) > 15 });

    table.clearFilters();
    expect(ids(table.filteredRows)).toEqual([2, 3, 4, 5]);
  });

  test("filter state is not part of the persisted snapshot", () => {
    const filter = new SetFilter();
    const table = makeTable([{ key: "category", filter }]);
    const before = JSON.stringify(table.getState());

    filter.toggle("a");
    expect(JSON.stringify(table.getState())).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// facets
// ---------------------------------------------------------------------------

describe("facets", () => {
  test("no filter on the column means no facets", () => {
    const table = makeTable(["category"]);
    expect(table.column("category")?.facets).toEqual([]);
  });

  test("values tier: discovers the domain, sorted, blank last, no counts", () => {
    const table = makeTable([{ key: "category", filter: new SetFilter() }]);
    expect(table.column("category")?.facets).toEqual([
      { value: "a" },
      { value: "b" },
      { value: "c" },
      { value: BLANK, blank: true },
    ]);
  });

  test("values tier flattens array columns into distinct values", () => {
    const table = makeTable([{ key: "tags", filter: new SetFilter() }]);
    expect(table.column("tags")?.facets).toEqual([
      { value: "x" },
      { value: "y" },
      { value: BLANK, blank: true },
    ]);
  });

  test("static tier: declared options in declaration order, no walk, so no blank", () => {
    const filter = new SetFilter({ options: ["z", "a"] });
    const table = makeTable([{ key: "category", filter }]);

    // "z" is not in the data and "b"/"c" are — a declared domain is taken at its word
    expect(table.column("category")?.facets).toEqual([{ value: "z" }, { value: "a" }]);
  });

  test("counted tier: tallies, keeps declared order, and retains zero counts", () => {
    const filter = new SetFilter({ options: ["x", "zzz"], counts: true });
    const table = makeTable([{ key: "tags", filter }]);

    expect(table.column("tags")?.facets).toEqual([
      { value: "x", count: 2 },
      // kept, not dropped: a popover is where you go to undo an over-narrowed filter
      { value: "zzz", count: 0 },
      { value: "y", count: 2 },
      { value: BLANK, blank: true, count: 2 },
    ]);
  });

  test("counted tier cross-filters by every *other* filter", () => {
    const category = new SetFilter();
    const tags = new SetFilter({ counts: true });
    const table = makeTable([
      { key: "category", filter: category },
      { key: "tags", filter: tags },
    ]);

    expect(table.column("tags")?.facets).toEqual([
      { value: "x", count: 2 },
      { value: "y", count: 2 },
      { value: BLANK, blank: true, count: 2 },
    ]);

    // rows 1 and 3 only
    category.toggle("a");
    expect(table.column("tags")?.facets).toEqual([
      { value: "x", count: 1 },
      { value: "y", count: 1 },
      { value: BLANK, blank: true, count: 1 },
    ]);
  });

  test("a discovered value found only in excluded rows stays listed at zero", () => {
    // The dead end this prevents: tick a value, then narrow another column past it. If the domain
    // were built from the surviving rows, the value would vanish from the list while still
    // filtering — funnel active, no checkbox to untick. Declared `options` masked this, which is
    // why the zero-count test above did not catch it.
    const category = new SetFilter();
    const tags = new SetFilter({ counts: true });
    const table = makeTable([
      { key: "category", filter: category },
      { key: "tags", filter: tags },
    ]);

    tags.toggle("y"); // only on rows 1 and 2
    category.toggle("c"); // leaves only row 5, whose tags are ["x"]

    expect(table.column("tags")?.facets).toEqual([
      { value: "x", count: 1 },
      { value: "y", count: 0 },
      { value: BLANK, blank: true, count: 0 },
    ]);
    // still selected, and still reachable to untick
    expect(tags.has("y")).toBe(true);
  });

  test("zero counts do not leak into the uncounted tiers", () => {
    // `cross` is only set when counts were asked for, so the default tier still walks every row
    const category = new SetFilter({ selected: ["c"] });
    const tags = new SetFilter();
    const table = makeTable([
      { key: "category", filter: category },
      { key: "tags", filter: tags },
    ]);

    expect(table.column("tags")?.facets).toEqual([
      { value: "x" },
      { value: "y" },
      { value: BLANK, blank: true },
    ]);
  });

  test("a counted column's own filter never narrows its own facets", () => {
    const tags = new SetFilter({ counts: true });
    const table = makeTable([{ key: "tags", filter: tags }]);

    tags.toggle("x");
    // still every value at its full tally — otherwise the list could not be widened again
    expect(table.column("tags")?.facets).toEqual([
      { value: "x", count: 2 },
      { value: "y", count: 2 },
      { value: BLANK, blank: true, count: 2 },
    ]);
  });

  test("counted tier respects page-level filterSources and the search", () => {
    const tags = new SetFilter({ counts: true });
    const table = makeTable([{ key: "tags", filter: tags }]);
    table.setFilter({ predicate: (row: RowData) => (row.id as number) <= 2 });

    expect(table.column("tags")?.facets).toEqual([
      { value: "x", count: 1 },
      { value: "y", count: 2 },
      // rows 3 and 4 are blank-tagged and excluded by the source: listed, counted zero
      { value: BLANK, blank: true, count: 0 },
    ]);
  });

  test("facets are reactive to rows and to other filters", () => {
    const category = new SetFilter();
    const tags = new SetFilter({ counts: true });
    const table = makeTable([
      { key: "category", filter: category },
      { key: "tags", filter: tags },
    ]);

    // the domain no longer shrinks, so the counts are what moves
    const seen: (number | undefined)[] = [];
    observe(() => seen.push(table.column("tags")?.facets.find((f) => f.value === "y")?.count));
    expect(seen).toEqual([2]);

    category.toggle("c");
    // rows narrowed to id 5, whose tags are ["x"] — "y" drops to zero but stays listed
    expect(table.column("tags")?.facets).toEqual([
      { value: "x", count: 1 },
      { value: "y", count: 0 },
      { value: BLANK, blank: true, count: 0 },
    ]);
    expect(seen.at(-1)).toBe(0);
  });

  test('counts follow matchMode "all", where each pick narrows', () => {
    const tags = new SetFilter({ counts: true, multiValue: true, matchMode: "all" });
    const table = makeTable([{ key: "tags", filter: tags }]);

    tags.toggle("x"); // rows 1 and 5
    expect(ids(table.filteredRows)).toEqual([1, 5]);

    // "y" reads 1 because only row 1 carries both — not 2, which is how many rows carry y at all
    expect(table.column("tags")?.facets).toEqual([
      { value: "x", count: 2 },
      { value: "y", count: 1 },
      { value: BLANK, blank: true, count: 0 },
    ]);
  });

  test('every "all"-mode count predicts the row count you get by ticking it', () => {
    // the invariant the bug broke: a count that does not match what happens when you click it
    const tags = new SetFilter({ counts: true, multiValue: true, matchMode: "all" });
    const table = makeTable([{ key: "tags", filter: tags }]);
    tags.toggle("x");

    for (const facet of table.column("tags")?.facets ?? []) {
      const predicted = facet.count;
      const before = [...tags.selected];
      if (!tags.has(facet.value as string)) tags.toggle(facet.value as string);
      expect({ value: facet.value, rows: table.filteredRows.length }).toEqual({
        value: facet.value,
        rows: predicted,
      });
      tags.select(before);
    }
  });

  test('an "any"-mode count still means "rows carrying this value"', () => {
    // the default semantic is unchanged: picking widens, so the own filter stays out of the tally
    const tags = new SetFilter({ counts: true });
    const table = makeTable([{ key: "tags", filter: tags }]);

    tags.toggle("x");
    expect(table.column("tags")?.facets).toEqual([
      { value: "x", count: 2 },
      { value: "y", count: 2 },
      { value: BLANK, blank: true, count: 2 },
    ]);
  });

  test("switching matchMode reshapes the counts reactively", () => {
    const tags = new SetFilter({ counts: true, multiValue: true });
    const table = makeTable([{ key: "tags", filter: tags }]);
    tags.toggle("x");

    const seen: (number | undefined)[] = [];
    observe(() => seen.push(table.column("tags")?.facets.find((f) => f.value === "y")?.count));
    expect(seen).toEqual([2]);

    tags.setMatchMode("all");
    expect(seen.at(-1)).toBe(1);

    tags.setMatchMode("any");
    expect(seen.at(-1)).toBe(2);
  });

  test('an empty selection under "all" counts like "any"', () => {
    // matches() passes everything while inactive, so the extra gate is a no-op
    const anyMode = new SetFilter({ counts: true });
    const allMode = new SetFilter({ counts: true, multiValue: true, matchMode: "all" });
    const a = makeTable([{ key: "tags", filter: anyMode }]);
    const b = makeTable([{ key: "tags", filter: allMode }]);

    expect(b.column("tags")?.facets).toEqual(a.column("tags")?.facets);
  });

  test("predicateExcluding drops only the named column's filter", () => {
    const category = new SetFilter({ selected: ["a"] });
    const score = new RangeFilter({ min: 25 });
    const table = makeTable([
      { key: "category", filter: category },
      { key: "score", filter: score },
    ]);

    const excluding = table.predicateExcluding("category");
    expect(people.filter((p) => excluding?.(p as RowData)).map((p) => p.id)).toEqual([3, 4, 5]);

    expect(table.predicateExcluding("score")).toBeDefined();
    // nothing left once both are excluded from a two-filter table
    table.clearFilters();
    expect(table.predicateExcluding("category")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// everything at once
// ---------------------------------------------------------------------------

describe("all four filter kinds on one table", () => {
  const build = () => {
    const category = new SetFilter();
    const tags = new SetFilter({ counts: true });
    const score = new RangeFilter();
    const name = new TextFilter();
    const table = makeTable([
      { key: "category", filter: category },
      { key: "name", value: (p) => `${p.first} ${p.last}`, filter: name },
      { key: "tags", filter: tags },
      { key: "score", filter: score },
    ]);
    return { table, category, tags, score, name };
  };

  test("compose, cross-filter, and unwind cleanly", () => {
    const { table, category, tags, score, name } = build();

    expect(table.predicate).toBeUndefined();
    expect(ids(table.filteredRows)).toEqual([1, 2, 3, 4, 5]);

    // a set filter over a field column, a range over a number, text over a computed column
    category.toggle("a");
    score.setRange(undefined, 25);
    expect(ids(table.filteredRows)).toEqual([1]);

    name.setText("lovelace");
    expect(ids(table.filteredRows)).toEqual([1]);
    name.setText("turing");
    expect(ids(table.filteredRows)).toEqual([]);
    name.clear();

    // the counted column's facets reflect the other three, never itself
    const expected = [
      { value: "x", count: 1 },
      { value: "y", count: 1 },
      { value: BLANK, blank: true, count: 0 },
    ];
    expect(table.column("tags")?.facets).toEqual(expected);
    tags.toggle("x");
    expect(table.column("tags")?.facets).toEqual(expected);

    expect(table.activeFilterCount).toBe(3);

    // search stacks on top of all of it, and survives clearFilters
    table.search.setText("ada");
    expect(table.activeFilterCount).toBe(4);
    expect(ids(table.filteredRows)).toEqual([1]);

    table.clearFilters();
    expect(table.search.text).toBe("ada");
    expect(table.activeFilterCount).toBe(1);
    expect(ids(table.filteredRows)).toEqual([1]);

    table.search.clear();
    expect(table.predicate).toBeUndefined();
    expect(ids(table.filteredRows)).toEqual([1, 2, 3, 4, 5]);
  });

  test("a hidden column keeps filtering while the whole stack is live", () => {
    const { table, category, tags } = build();

    category.toggle("a");
    table.column("category")?.setHidden(true);
    expect(ids(table.filteredRows)).toEqual([1, 3]);

    // and its narrowing still reaches another column's counted facets
    expect(table.column("tags")?.facets).toEqual([
      { value: "x", count: 1 },
      { value: "y", count: 1 },
      { value: BLANK, blank: true, count: 1 },
    ]);
    expect(tags.active).toBe(false);
  });
});

describe("filterOption", () => {
  test("is exposed off the column, with the default left to the caller", () => {
    const table = makeTable([
      { key: "category", filter: new SetFilter(), filterOption: (v) => `<${String(v)}>` },
      { key: "score", filter: new RangeFilter() },
    ]);

    const category = table.column("category");
    expect(category?.filterOption?.("a")).toBe("<a>");
    expect(table.column("score")?.filterOption).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// factory filters
// ---------------------------------------------------------------------------

// Narrowing by `instanceof` is how a UI reaches a typed filter off a column — `column.filter` is
// `ColumnFilter | undefined`, deliberately, since no column-key -> filter-type map is derivable.
const filterOf = <T>(
  table: TableModel,
  key: string,
  kind: abstract new (...args: never[]) => T,
): T => {
  const filter = table.column(key)?.filter;
  if (!(filter instanceof kind)) throw new Error(`No ${kind.name} on column "${key}"`);
  return filter;
};

describe("filter factories", () => {
  // The shape a real page uses: defs hoisted out of the component, so they are built once for the
  // lifetime of the module.
  const columns: ColumnsDef<Person> = [
    { key: "category", filter: () => new SetFilter() },
    { key: "score", filter: () => new RangeFilter() },
  ];

  test("each table gets its own filter", () => {
    const a = makeTable(columns);
    const b = makeTable(columns);

    filterOf(a, "category", SetFilter).toggle("a");

    expect(ids(a.filteredRows)).toEqual([1, 3]);
    // the second table built from the same defs is untouched — the bug a shared instance causes
    expect(ids(b.filteredRows)).toEqual([1, 2, 3, 4, 5]);
    expect(b.column("category")?.filter).not.toBe(a.column("category")?.filter);
  });

  test("a shared instance does not — which is why the factory is the recommendation", () => {
    const shared = new SetFilter();
    const sharedColumns: ColumnsDef<Person> = [{ key: "category", filter: shared }];
    const a = makeTable(sharedColumns);
    const b = makeTable(sharedColumns);

    shared.toggle("a");
    expect(ids(a.filteredRows)).toEqual([1, 3]);
    expect(ids(b.filteredRows)).toEqual([1, 3]);
  });

  test("remounting starts clean", () => {
    const first = makeTable(columns);
    filterOf(first, "category", SetFilter).toggle("a");
    first.dispose();

    // what useTable does on a remount: a fresh model from the same defs
    const second = makeTable(columns);
    expect(filterOf(second, "category", SetFilter).active).toBe(false);
    expect(ids(second.filteredRows)).toEqual([1, 2, 3, 4, 5]);
  });

  test("the factory is called once per column, not once per sync", () => {
    // syncColumns runs on every setRows/appendRows, and builds a ColumnModel only for a key it does
    // not already have. If it built one per def per sync, this would mint a filter every time.
    let built = 0;
    const table = makeTable([
      {
        key: "category",
        filter: () => {
          built++;
          return new SetFilter();
        },
      },
    ]);

    expect(built).toBe(1);
    const filter = table.column("category")?.filter;

    table.setRows(people.slice(0, 3));
    table.appendRows([people[3] as RowData]);
    table.setColumns([{ key: "category", filter: () => new SetFilter() }]);

    expect(built).toBe(1);
    expect(table.column("category")?.filter).toBe(filter);
  });

  test("a duplicate key never calls the second def's factory", () => {
    let built = 0;
    const table = makeTable([
      { key: "category", filter: () => new SetFilter() },
      // an auto column would collide the same way; the first def wins and the second is not built
      {
        key: "score",
        filter: () => {
          built++;
          return new RangeFilter();
        },
      },
    ]);

    expect(built).toBe(1);
    expect(table.column("score")?.filter).toBeInstanceOf(RangeFilter);
  });

  test("state survives setRows, as with an instance", () => {
    const table = makeTable(columns);
    const filter = filterOf(table, "category", SetFilter);
    filter.toggle("a");

    table.setRows(people.slice(0, 3));
    expect(table.column("category")?.filter).toBe(filter);
    expect(ids(table.filteredRows)).toEqual([1, 3]);
  });

  test("facets, predicate and filterable all see the resolved filter", () => {
    const table = makeTable(columns);
    expect(table.column("category")?.filterable).toBe(true);
    expect(table.column("category")?.facets).toEqual([
      { value: "a" },
      { value: "b" },
      { value: "c" },
      { value: BLANK, blank: true },
    ]);

    filterOf(table, "score", RangeFilter).setRange(25, undefined);
    expect(ids(table.filteredRows)).toEqual([3, 4, 5]);
    expect(table.activeFilterCount).toBe(1);
  });
});
