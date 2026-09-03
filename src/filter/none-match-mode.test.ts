import { autorun } from "mobx";
import { describe, expect, test } from "vite-plus/test";
import { SetFilter } from "./set-filter.model";
import { BucketFilter } from "./bucket-filter.model";
import { BLANK } from "./util";
import { TableModel } from "../table/table.model";
import type { RowData } from "../table/table.types";

describe('SetFilter matchMode "none"', () => {
  test("excludes the selected values and admits everything else", () => {
    const filter = new SetFilter({ matchMode: "none", selected: ["draft"] });

    expect(filter.matches("draft")).toBe(false);
    expect(filter.matches("live")).toBe(true);
    expect(filter.matches("archived")).toBe(true);

    filter.toggle("archived");
    expect(filter.matches("archived")).toBe(false);
    expect(filter.matches("live")).toBe(true);
  });

  test("an empty selection still matches everything, as in every mode", () => {
    const filter = new SetFilter({ matchMode: "none" });
    expect(filter.active).toBe(false);
    expect(filter.matches("anything")).toBe(true);
    expect(filter.matches(undefined)).toBe(true);
  });

  test("it is exactly the negation of `any` over the same selection", () => {
    const values = ["draft", "live", ["draft", "live"], ["live"], [], null, 0, undefined];
    const any = new SetFilter({ selected: ["draft"] });
    const none = new SetFilter({ matchMode: "none", selected: ["draft"] });

    for (const value of values) {
      expect(none.matches(value)).toBe(!any.matches(value));
    }
  });

  test("over array values it excludes a row carrying any selection", () => {
    const filter = new SetFilter({ multiValue: true, matchMode: "none", selected: ["a", "b"] });

    expect(filter.matches(["a", "c"])).toBe(false);
    expect(filter.matches(["b"])).toBe(false);
    expect(filter.matches(["c", "d"])).toBe(true);
    expect(filter.matches([])).toBe(true);
  });

  test("blanks are excluded like any other value", () => {
    const filter = new SetFilter({ matchMode: "none", selected: [BLANK] });

    expect(filter.matches(undefined)).toBe(false);
    expect(filter.matches(null)).toBe(false);
    expect(filter.matches("")).toBe(false);
    expect(filter.matches("something")).toBe(true);
  });

  test("it narrows, so it reports as intersecting", () => {
    const filter = new SetFilter({ selected: ["a"] });
    expect(filter.intersecting).toBe(false);

    filter.setMatchMode("none");
    expect(filter.intersecting).toBe(true);

    filter.setMatchMode("all");
    expect(filter.intersecting).toBe(true);
  });

  test("serializes as notIn", () => {
    const filter = new SetFilter({ matchMode: "none", selected: ["draft", "archived"] });
    expect(filter.condition).toEqual({ op: "notIn", value: ["draft", "archived"] });

    filter.setMatchMode("any");
    expect(filter.condition).toEqual({ op: "in", value: ["draft", "archived"] });

    filter.setMatchMode("all");
    expect(filter.condition).toEqual({ op: "all", value: ["draft", "archived"] });

    filter.clear();
    expect(filter.condition).toBeUndefined();
  });

  test("round-trips through value/setValue", () => {
    const filter = new SetFilter({ matchMode: "none", selected: ["draft"] });
    expect(filter.value).toEqual({ selected: ["draft"], matchMode: "none" });

    const restored = new SetFilter();
    restored.setValue(JSON.parse(JSON.stringify(filter.value)));
    expect(restored.matchMode).toBe("none");
    expect(restored.matches("draft")).toBe(false);
    expect(restored.matches("live")).toBe(true);
  });

  test("an unrecognised matchMode in a snapshot falls back to any, not none", () => {
    const filter = new SetFilter({ matchMode: "none" });
    filter.setValue({ selected: ["a"], matchMode: "nonsense" });
    // failing open is the safe direction: a stale snapshot must not silently *exclude* rows
    expect(filter.matchMode).toBe("any");
    expect(filter.matches("a")).toBe(true);
  });

  test("clear leaves the mode alone, like the other modes", () => {
    const filter = new SetFilter({ matchMode: "none", selected: ["a"] });
    filter.clear();
    expect(filter.matchMode).toBe("none");
    expect(filter.active).toBe(false);
  });

  test("switching mode is reactive", () => {
    const filter = new SetFilter({ selected: ["draft"] });
    const seen: boolean[] = [];
    const dispose = autorun(() => seen.push(filter.matches("draft")));

    filter.setMatchMode("none");
    expect(seen).toEqual([true, false]);
    dispose();
  });

  test("BucketFilter inherits it", () => {
    const filter = new BucketFilter({
      buckets: [
        { label: "low", max: 50 },
        { label: "high", min: 50 },
      ],
      matchMode: "none",
      selected: ["low"],
    });

    expect(filter.matches(10)).toBe(false);
    expect(filter.matches(90)).toBe(true);
    expect(filter.condition).toEqual({ op: "notIn", value: ["low"] });
  });
});

// ---------------------------------------------------------------------------
// facet counts — the part that was reasoned about rather than measured
// ---------------------------------------------------------------------------

describe('facet counts under "none"', () => {
  const rows: RowData[] = [
    { id: 1, status: "draft" },
    { id: 2, status: "draft" },
    { id: 3, status: "live" },
    { id: 4, status: "live" },
    { id: 5, status: "live" },
    { id: 6, status: "archived" },
  ];

  const build = (filter: SetFilter) => {
    const table = new TableModel({ data: rows, columns: [{ key: "status", filter }, "id"] });
    table.setWidth(600);
    table.setHeight(400);
    return table;
  };

  const counts = (table: TableModel) =>
    Object.fromEntries(table.column("status")!.facets.map((f) => [f.value, f.count]));

  test("with nothing selected, counts are the plain tally", () => {
    const filter = new SetFilter({ counts: true, matchMode: "none" });
    const table = build(filter);
    expect(counts(table)).toEqual({ draft: 2, live: 3, archived: 1 });
  });

  test("a count is what excluding that value would remove", () => {
    const filter = new SetFilter({ counts: true, matchMode: "none", selected: ["draft"] });
    const table = build(filter);

    // 4 rows currently pass (live + archived). Excluding "live" too would drop 3 of them.
    expect(table.displayRows.length).toBe(4);
    expect(counts(table).live).toBe(3);
    expect(counts(table).archived).toBe(1);

    filter.toggle("live");
    expect(table.displayRows.length).toBe(4 - 3);
  });

  test("an already-excluded value counts zero, and is still listed so it can be unticked", () => {
    const filter = new SetFilter({ counts: true, matchMode: "none", selected: ["draft"] });
    const table = build(filter);

    // true: excluding it again removes nothing
    expect(counts(table).draft).toBe(0);
    expect(table.column("status")!.facets.map((f) => f.value)).toContain("draft");

    filter.toggle("draft");
    expect(table.displayRows.length).toBe(6);
  });

  test("the same tally under `all` reads the other way, and both are predictive", () => {
    const tagged: RowData[] = [
      { id: 1, tags: ["a", "b"] },
      { id: 2, tags: ["a"] },
      { id: 3, tags: ["b"] },
    ];
    const filter = new SetFilter({
      counts: true,
      multiValue: true,
      matchMode: "all",
      selected: ["a"],
    });
    const table = new TableModel({ data: tagged, columns: [{ key: "tags", filter }, "id"] });
    table.setWidth(600);
    table.setHeight(400);

    const facets = Object.fromEntries(table.column("tags")!.facets.map((f) => [f.value, f.count]));
    // "tick b too and you get 1 row"
    expect(facets.b).toBe(1);
    filter.toggle("b");
    expect(table.displayRows.length).toBe(1);
  });
});
