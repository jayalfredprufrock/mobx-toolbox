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

interface Item {
  id: number;
  name: string;
  amount: number;
}

const items: Item[] = [
  { id: 1, name: "b", amount: 20 },
  { id: 2, name: "a", amount: 10 },
];

const makeTable = (columns: ColumnsDef<Item>): TableModel => {
  const table = new TableModel({ rows: items, columns, getRowId: (i: Item) => i.id });
  table.setWidth(1000);
  table.setHeight(200);
  return table;
};

describe("ColumnModel.setConfig", () => {
  test("patches one option and leaves the rest alone", () => {
    const table = makeTable([{ key: "amount", title: "Amount", width: 200 }]);
    const column = table.column("amount");

    column?.setConfig({ title: "Total" });
    expect(column?.title).toBe("Total");
    expect(column?.config.width).toBe(200);
    expect(column?.config.key).toBe("amount");
  });

  test("title is genuinely reactive — it was a computed over frozen config before", () => {
    const table = makeTable([{ key: "amount", title: "Amount" }]);
    const seen: (string | undefined)[] = [];
    observe(() => seen.push(table.column("amount")?.title));
    expect(seen).toEqual(["Amount"]);

    table.column("amount")?.setConfig({ title: "Total" });
    expect(seen).toEqual(["Amount", "Total"]);
  });

  test("clearing title falls back to the titleCase default", () => {
    const table = makeTable([{ key: "amount", title: "Total" }]);
    table.column("amount")?.setConfig({ title: undefined });
    expect(table.column("amount")?.title).toBe("Amount");
  });

  test("a width patch reaches the layout", () => {
    const table = makeTable([{ key: "amount", width: 200 }, "name"]);
    const seen: (number | undefined)[] = [];
    observe(() => seen.push(table.column("amount")?.width));
    expect(seen).toEqual([200]);

    table.column("amount")?.setConfig({ width: 400 });
    expect(seen.at(-1)).toBe(400);
    expect(table.column("name")?.width).toBe(600);
  });

  test("advisory flags are patchable", () => {
    const table = makeTable([{ key: "amount", filter: () => new SetFilter() }]);
    const column = table.column("amount");
    expect(column?.sortable).toBe(true);
    expect(column?.filterable).toBe(true);

    column?.setConfig({ sortable: false, filterable: false });
    expect(column?.sortable).toBe(false);
    expect(column?.filterable).toBe(false);
  });

  test("what the user did to the column survives a patch", () => {
    // hidden/pinned/manualWidth are state, not configuration
    const table = makeTable([{ key: "amount", title: "Amount" }, "name"]);
    const column = table.column("amount");
    column?.setHidden(true);
    column?.setPinned("left");
    column?.setManualWidth(321);

    column?.setConfig({ title: "Total" });
    expect(column?.hidden).toBe(true);
    expect(column?.pinned).toBe("left");
    expect(column?.manualWidth).toBe(321);
  });

  test("an active filter and its selection survive a patch", () => {
    const table = makeTable([{ key: "name", filter: () => new SetFilter() }]);
    const column = table.column("name");
    const filter = column?.filter as SetFilter;
    filter.toggle("a");

    column?.setConfig({ title: "Name" });
    expect(column?.filter).toBe(filter);
    expect(filter.has("a")).toBe(true);
    expect(table.filteredRows.map((r: RowData) => r.id)).toEqual([2]);
  });

  test("patching value reaches sorting and filtering", () => {
    const table = makeTable([{ key: "amount" }]);
    table.setSort("amount", "asc");
    expect(table.displayRows.map((r: RowData) => r.id)).toEqual([2, 1]);

    // negate it: the order flips because sorting goes through `value`
    table.column("amount")?.setConfig({ value: (row: RowData) => -(row.amount as number) });
    expect(table.displayRows.map((r: RowData) => r.id)).toEqual([1, 2]);
  });

  test("patching value alone does not change what is rendered", () => {
    // `render` was defaulted to `value` when the column was built, so it kept the original
    const table = makeTable([{ key: "amount" }]);
    const column = table.column("amount");
    const row = items[0] as RowData;

    column?.setConfig({ value: () => "computed" });
    expect(column?.getValue(row)).toBe("computed");
    expect(column?.config.render(row)).toBe(20);

    column?.setConfig({ render: () => "computed" });
    expect(column?.config.render(row)).toBe("computed");
  });

  test("facets follow a patched value", () => {
    const table = makeTable([{ key: "name", filter: () => new SetFilter() }]);
    expect(table.column("name")?.facets).toEqual([{ value: "a" }, { value: "b" }]);

    table.column("name")?.setConfig({ value: (row: RowData) => `${row.name as string}!` });
    expect(table.column("name")?.facets).toEqual([{ value: "a!" }, { value: "b!" }]);
  });

  test("the three unswappable options are rejected at the type level", () => {
    const column = makeTable(["amount"]).column("amount");
    // @ts-expect-error -- would orphan columns, columnOrder, sorts and any persisted snapshot
    column?.setConfig({ key: "other" });
    // @ts-expect-error -- would silently discard the user's live selection
    column?.setConfig({ filter: new SetFilter() });
    // @ts-expect-error -- decides which components render the column at all
    column?.setConfig({ selection: true });
  });
});
