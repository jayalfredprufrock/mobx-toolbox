import { autorun } from "mobx";
import { describe, expect, test } from "vite-plus/test";
import { SetFilter } from "../filter/set-filter.model";
import { lazyPages } from "../lazy/lazy";
import { TableModel } from "./table.model";
import type { ColumnsDef, RowData } from "./table.types";

interface Person {
  id: number;
  name: string;
  team: string;
  joined: Date;
  ownerId: number;
  tags: string[];
}

const people: Person[] = [
  { id: 1, name: "Ada", team: "core", joined: new Date(2020, 0, 1), ownerId: 10, tags: ["a"] },
  { id: 2, name: "Grace", team: "infra", joined: new Date(2021, 0, 1), ownerId: 11, tags: [] },
  {
    id: 3,
    name: "Alan",
    team: "core",
    joined: new Date(2019, 0, 1),
    ownerId: 10,
    tags: ["b", "c"],
  },
  { id: 4, name: "Barbara", team: "infra", joined: new Date(2022, 0, 1), ownerId: 12, tags: [] },
];

const owners: Record<number, string> = { 10: "Kay", 11: "Lin", 12: "Mo" };

const makeTable = (columns: ColumnsDef<Person>): TableModel => {
  const table = new TableModel({ data: people, columns, getRowId: (p: Person) => p.id });
  table.setWidth(1000);
  table.setHeight(400);
  return table;
};

const keys = (data: { columns: { key: string }[] }): string[] => data.columns.map((c) => c.key);
const firstCells = (data: { rows: unknown[][] }): unknown[] => data.rows.map((r) => r[0]);

describe("exportData rows", () => {
  test("filtered follows the filters, the search and the sort", () => {
    const team = new SetFilter();
    const table = makeTable(["name", { key: "team", filter: team }]);
    team.select(["core"]);
    table.setSort("name", "desc");
    expect(firstCells(table.exportData({ rows: "filtered" }))).toEqual(["Alan", "Ada"]);

    table.searchFilter.setText("ala");
    expect(firstCells(table.exportData({ rows: "filtered" }))).toEqual(["Alan"]);
  });

  test("selected is in display order and leaves out selected rows a filter hides", () => {
    const team = new SetFilter();
    const table = makeTable([{ selection: true }, "name", { key: "team", filter: team }]);
    for (const p of [people[3]!, people[0]!, people[1]!]) table.toggleRow(p); // Barbara, Ada, Grace
    table.setSort("name", "asc");
    expect(firstCells(table.exportData({ rows: "selected" }))).toEqual(["Ada", "Barbara", "Grace"]);

    team.select(["infra"]);
    expect(firstCells(table.exportData({ rows: "selected" }))).toEqual(["Barbara", "Grace"]);
  });

  test("loaded ignores filters and search but keeps the sort", () => {
    const team = new SetFilter();
    const table = makeTable(["name", { key: "team", filter: team }]);
    team.select(["core"]);
    table.searchFilter.setText("ada");
    table.setSort("name", "asc");
    expect(firstCells(table.exportData({ rows: "loaded" }))).toEqual([
      "Ada",
      "Alan",
      "Barbara",
      "Grace",
    ]);
  });

  test("defaults to selected when a visible row is selected, otherwise filtered", () => {
    const team = new SetFilter();
    const table = makeTable([{ selection: true }, "name", { key: "team", filter: team }]);
    expect(table.exportData().rows).toHaveLength(4);

    table.toggleRow(people[1]!); // Grace
    expect(firstCells(table.exportData())).toEqual(["Grace"]);

    // the only selection is now filtered out of view: back to filtered
    team.select(["core"]);
    expect(firstCells(table.exportData())).toEqual(["Ada", "Alan"]);
  });
});

describe("exportData columns", () => {
  test("visible columns come out in on-screen order, after a move and a pin", () => {
    const table = makeTable(["name", "team", "joined", "ownerId"]);
    table.moveColumn("ownerId", 0); // ownerId, name, team, joined
    table.column("joined")?.setPinned("left");
    table.column("name")?.setPinned("right");
    const data = table.exportData();
    expect(keys(data)).toEqual(table.visualColumns.map((c) => c.key));
    expect(keys(data)).toEqual(["joined", "ownerId", "team", "name"]);
  });

  test("all includes hidden columns, where they would sit if shown", () => {
    const table = makeTable(["name", "team", "joined"]);
    table.column("team")?.setHidden(true);
    table.column("joined")?.setPinned("left");
    expect(keys(table.exportData())).toEqual(["joined", "name"]);
    expect(keys(table.exportData({ columns: "all" }))).toEqual(["joined", "name", "team"]);
  });

  test("an explicit key list keeps its order, and a bad key throws", () => {
    const table = makeTable([{ selection: true }, "name", "team", "joined"]);
    table.column("team")?.setHidden(true);
    expect(keys(table.exportData({ columns: ["team", "name"] }))).toEqual(["team", "name"]);
    expect(() => table.exportData({ columns: ["nope"] })).toThrow(/no column "nope"/);
    expect(() => table.exportData({ columns: [table.selectionColumn!.key] })).toThrow(
      /not exportable/,
    );
  });

  test("the selection column and data carriers are never exported, unless a carrier opts in", () => {
    const table = makeTable([
      { selection: true },
      "name",
      { key: "ownerId", hidden: true, hideable: false },
      { key: "team", exportable: false },
      { key: "joined", hidden: true, hideable: false, exportable: true },
    ]);
    expect(table.selectionColumn?.exportable).toBe(false);
    expect(table.column("ownerId")?.exportable).toBe(false);
    expect(keys(table.exportData({ columns: "all" }))).toEqual(["name", "joined"]);
  });

  test("titles are the column titles", () => {
    const table = makeTable([{ key: "name", title: "Full name" }, "ownerId"]);
    expect(table.exportData().columns).toEqual([
      { key: "name", title: "Full name" },
      { key: "ownerId", title: table.column("ownerId")!.title },
    ]);
  });
});

describe("exportData values", () => {
  test("an exportable projection wins over the raw value", () => {
    const table = makeTable([
      "name",
      { key: "ownerId", exportable: (p: Person) => owners[p.ownerId] },
    ]);
    expect(table.exportData().rows[0]).toEqual(["Ada", "Kay"]);
    // sorting and display still see the raw value
    expect(table.column("ownerId")?.getValue(people[0]!)).toBe(10);
  });

  test("raw values pass through untouched", () => {
    const table = makeTable([
      "joined",
      "id",
      "tags",
      { key: "core", value: (p: RowData) => p.team === "core" },
    ]);
    const [row] = table.exportData().rows;
    expect(row![0]).toBe(people[0]!.joined);
    expect(row![0]).toBeInstanceOf(Date);
    expect(row![1]).toBe(1);
    expect(row![2]).toBe(people[0]!.tags);
    expect(row![3]).toBe(true);
  });
});

describe("exportData on a paged table", () => {
  const pagedApi =
    (total: number) =>
    ({ cursor, limit }: { cursor?: string; limit: number }) => {
      const start = cursor === undefined ? 0 : Number(cursor);
      const items = Array.from({ length: Math.min(limit, total - start) }, (_, i) => ({
        id: start + i,
        name: `r${start + i}`,
      }));
      const next = start + items.length;
      return Promise.resolve({ items, cursor: next < total ? String(next) : null, total });
    };

  test("holds only the pages loaded, until loadAll fetches the rest", async () => {
    const feed = lazyPages(pagedApi(100), { pageSize: 40 });
    const table = new TableModel({ data: feed, columns: ["id", "name"] });
    const dispose = autorun(() => void table.displayRows.length);
    await feed.getOrLoad();

    expect(table.exportData({ rows: "loaded" }).rows).toHaveLength(40);
    expect(table.pages?.total).toBe(100);
    expect(table.pages?.hasMore).toBe(true);

    await table.pages!.loadAll();
    expect(table.exportData({ rows: "loaded" }).rows).toHaveLength(100);
    expect(table.pages?.hasMore).toBe(false);

    dispose();
    table.dispose();
  });
});
