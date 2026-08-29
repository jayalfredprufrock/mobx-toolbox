import { describe, expect, test } from "vite-plus/test";
import { SetFilter } from "../filter/set-filter.model";
import { TableModel } from "./table.model";
import type { ColumnsDef, RowData } from "./table.types";

interface Task {
  id: number;
  name: string;
  start: number;
  end: number;
}

const tasks: Task[] = [
  { id: 1, name: "a", start: 5, end: 9 },
  { id: 2, name: "b", start: 8, end: 2 },
];

const ids = (rows: RowData[]): number[] => rows.map((r) => r.id as number);

const makeTable = (columns: ColumnsDef<Task>): TableModel => {
  const table = new TableModel({ data: tasks, columns, getRowId: (t: Task) => t.id });
  table.setWidth(1000);
  table.setHeight(200);
  return table;
};

describe("def-level hidden", () => {
  test("a column can start hidden without an imperative call", () => {
    const table = makeTable(["name", { key: "start", hidden: true }]);
    expect(table.column("start")?.hidden).toBe(true);
    expect(table.orderedColumns.map((c) => c.key)).toEqual(["name"]);
    // still in allColumns, like any hidden column
    expect(table.allColumns.map((c) => c.key)).toEqual(["name", "start"]);
  });

  test("defaults to visible", () => {
    const table = makeTable(["name"]);
    expect(table.column("name")?.hidden).toBe(false);
  });

  test("is the initial value only — setHidden still moves it", () => {
    const table = makeTable([{ key: "name", hidden: true }]);
    table.column("name")?.setHidden(false);
    expect(table.column("name")?.hidden).toBe(false);
  });

  test("addColumn respects a def that asks to stay hidden", () => {
    const table = makeTable(["name"]);
    table.addColumn({ key: "start", hidden: true });
    expect(table.column("start")?.hidden).toBe(true);

    // a normal added column is still shown, even if a snapshot had hidden it
    table.applyState({ columns: { end: { hidden: true, pinned: false } } });
    table.addColumn({ key: "end" });
    expect(table.column("end")?.hidden).toBe(false);
  });
});

describe("hideable / pinnable", () => {
  test("default to true and are advisory for UI", () => {
    const table = makeTable(["name"]);
    const col = table.column("name");
    expect(col?.hideable).toBe(true);
    expect(col?.pinnable).toBe(true);
  });

  test("setHidden and setPinned are never gated", () => {
    // same convention as sortable/filterable: a page's own layout logic is never denied
    const table = makeTable([{ key: "name", hideable: false, pinnable: false }]);
    const col = table.column("name");
    expect(col?.hideable).toBe(false);

    col?.setHidden(true);
    expect(col?.hidden).toBe(true);
    col?.setPinned("left");
    expect(col?.pinned).toBe("left");
  });

  test("but a snapshot cannot override them", () => {
    // structure outranks a saved view written before the column was locked
    const table = makeTable([
      { key: "name", hideable: false },
      { key: "start", pinnable: false },
      { key: "end", resizable: false },
    ]);
    table.applyState({
      columns: {
        name: { hidden: true, pinned: false },
        start: { hidden: false, pinned: "left" },
        end: { hidden: false, pinned: false, width: 321 },
      },
    });

    expect(table.column("name")?.hidden).toBe(false);
    expect(table.column("start")?.pinned).toBe(false);
    expect(table.column("end")?.manualWidth).toBeUndefined();
  });

  test("an unlocked column still restores normally", () => {
    const table = makeTable(["name"]);
    table.applyState({ columns: { name: { hidden: true, pinned: "right", width: 200 } } });
    expect(table.column("name")?.hidden).toBe(true);
    expect(table.column("name")?.pinned).toBe("right");
    expect(table.column("name")?.manualWidth).toBe(200);
  });
});

describe("a data-only column", () => {
  // hidden + hideable:false is how you declare a column that exists solely to carry a value or a
  // filter — a whole-row predicate, in this case a cross-column one
  const dataOnly: ColumnsDef<Task> = [
    "name",
    {
      key: "_invalid",
      value: (t) => t.start > t.end,
      filter: () => new SetFilter({ selected: [true] }),
      hidden: true,
      hideable: false,
      filterable: false,
      searchable: false,
      sortable: false,
    },
  ];

  test("filters without ever being rendered", () => {
    const table = makeTable(dataOnly);
    expect(table.orderedColumns.map((c) => c.key)).toEqual(["name"]);
    expect(ids(table.clientFilteredRows)).toEqual([2]);
  });

  test("a restored snapshot cannot reveal it", () => {
    // the instability that made this worth a def-level flag
    const table = makeTable(dataOnly);
    table.applyState({ columns: { _invalid: { hidden: false, pinned: false } } });
    expect(table.column("_invalid")?.hidden).toBe(true);
    expect(table.orderedColumns.map((c) => c.key)).toEqual(["name"]);
  });

  test("a picker built off hideable leaves it out", () => {
    const table = makeTable(dataOnly);
    expect(table.allColumns.filter((c) => c.hideable).map((c) => c.key)).toEqual(["name"]);
  });
});
