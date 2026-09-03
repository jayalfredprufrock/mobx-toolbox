import { autorun } from "mobx";
import { describe, expect, test } from "vite-plus/test";
import { SetFilter } from "../filter/set-filter.model";
import { TableModel } from "./table.model";
import type { ColumnsDef, RowData } from "./table.types";

/**
 * `meta` lets a column say what it *represents*, not just how it behaves — for anything rendered
 * about a column rather than about a row. The alternatives it replaces are parsing the column key
 * (which duplicates a format persisted state depends on) and threading a `Map<key, thing>`
 * alongside the defs.
 */
declare module "./table.types" {
  interface ColumnMeta {
    question?: { id: string; prompt: string };
    unit?: string;
  }
}

const rows: RowData[] = [
  { id: 1, score: 10 },
  { id: 2, score: 20 },
];

const build = (columns: ColumnsDef<RowData>) => {
  const table = new TableModel({ data: rows, columns });
  table.setWidth(600);
  table.setHeight(400);
  return table;
};

describe("column meta", () => {
  test("rides from the def to the model", () => {
    const question = { id: "q1", prompt: "How likely…" };
    const table = build([{ key: "score", meta: { question, unit: "pts" } }, "id"]);

    expect(table.column("score")?.meta).toEqual({ question, unit: "pts" });
    expect(table.column("score")?.meta?.question).toBe(question); // by reference, not a copy
    expect(table.column("id")?.meta).toBeUndefined();
  });

  test("a string def and a selection def simply have none", () => {
    const table = build(["id", { selection: true }]);
    expect(table.column("id")?.meta).toBeUndefined();
    expect(table.allColumns.every((c) => c.meta === undefined)).toBe(true);
  });

  test("reading it is reactive, with no observable state of its own", () => {
    const table = build([{ key: "score", meta: { unit: "pts" } }]);
    const seen: (string | undefined)[] = [];
    const dispose = autorun(() => seen.push(table.column("score")?.meta?.unit));

    table.column("score")?.setConfig({ meta: { unit: "kg" } });

    expect(seen).toEqual(["pts", "kg"]);
    dispose();
  });

  // ---------------------------------------------------------------------------
  // the refresh contract — the opposite of `filter`'s, deliberately
  // ---------------------------------------------------------------------------

  test("setColumns re-reads meta for a key that already exists", () => {
    const table = build([{ key: "score", meta: { question: { id: "q1", prompt: "before" } } }]);
    const column = table.column("score");

    table.setColumns([{ key: "score", meta: { question: { id: "q1", prompt: "after" } } }]);

    // the same ColumnModel survives — user state is not disturbed — but it now describes the new def
    expect(table.column("score")).toBe(column);
    expect(table.column("score")?.meta?.question?.prompt).toBe("after");
  });

  test("meta refreshes while everything else about a surviving column is preserved", () => {
    const filter = new SetFilter();
    const table = build([{ key: "score", filter, meta: { unit: "pts" } }, "id"]);
    const column = table.column("score")!;

    column.setPinned("left");
    column.setManualWidth(240);
    filter.toggle(10);
    table.moveColumn("score", 1);

    table.setColumns([{ key: "score", filter: () => new SetFilter(), meta: { unit: "kg" } }, "id"]);

    const after = table.column("score")!;
    expect(after).toBe(column);
    expect(after.meta?.unit).toBe("kg"); // re-read
    expect(after.filter).toBe(filter); // *not* re-read — it holds the user's selection
    expect((after.filter as SetFilter).has(10)).toBe(true);
    expect(after.pinned).toBe("left");
    expect(after.manualWidth).toBe(240);
    expect(table.columnOrder).toEqual(["id", "score"]);
  });

  test("removing meta from a def clears it", () => {
    const table = build([{ key: "score", meta: { unit: "pts" } }]);
    table.setColumns([{ key: "score" }]);
    expect(table.column("score")?.meta).toBeUndefined();
  });

  test("a def rebuilt around the same values is not a change", () => {
    const question = { id: "q1", prompt: "stable" };
    const table = build([{ key: "score", meta: { question } }]);
    const before = table.column("score")!.config;

    // a fresh meta object holding the same references — what a column factory produces every run
    table.setColumns([{ key: "score", meta: { question } }]);

    // config was not replaced, so nothing observing this column re-derived
    expect(table.column("score")!.config).toBe(before);
  });

  test("appending rows does not churn config for a factory def's meta", () => {
    const question = { id: "q1", prompt: "stable" };
    const table = new TableModel({
      data: rows,
      // a factory def is re-invoked on every setData/appendRows, rebuilding its meta object
      columns: [() => ({ key: "score", meta: { question } })],
    });
    table.setWidth(600);
    table.setHeight(400);
    const before = table.column("score")!.config;

    table.appendRows([{ id: 3, score: 30 }]);
    table.appendRows([{ id: 4, score: 40 }]);

    expect(table.column("score")!.config).toBe(before);
    expect(table.column("score")!.meta?.question).toBe(question);
  });

  test("a factory def whose meta genuinely changed is picked up", () => {
    let prompt = "before";
    const table = new TableModel({
      data: rows,
      columns: [() => ({ key: "score", meta: { question: { id: "q1", prompt } } })],
    });
    table.setWidth(600);

    prompt = "after";
    table.appendRows([{ id: 3, score: 30 }]);

    expect(table.column("score")?.meta?.question?.prompt).toBe("after");
  });

  // ---------------------------------------------------------------------------
  // persistence
  // ---------------------------------------------------------------------------

  test("it stays out of the persisted snapshot", () => {
    const table = build([{ key: "score", meta: { question: { id: "q1", prompt: "x" } } }, "id"]);
    const state = table.getState();

    expect(JSON.stringify(state)).not.toContain("prompt");
    expect(state.columns.score).toEqual({ hidden: false, pinned: false });
  });

  test("applying a snapshot leaves it alone", () => {
    const table = build([{ key: "score", meta: { unit: "pts" } }, "id"]);
    table.applyState({
      columnOrder: ["id", "score"],
      columns: { score: { hidden: true, pinned: false } },
    });

    expect(table.column("score")?.hidden).toBe(true);
    expect(table.column("score")?.meta?.unit).toBe("pts");
  });

  test("addColumn carries it, and removeColumn + addColumn replaces it wholesale", () => {
    const table = build(["id"]);
    table.addColumn({ key: "score", meta: { unit: "pts" } });
    expect(table.column("score")?.meta?.unit).toBe("pts");

    table.removeColumn("score");
    table.addColumn({ key: "score", meta: { unit: "kg" } });
    expect(table.column("score")?.meta?.unit).toBe("kg");
  });
});
