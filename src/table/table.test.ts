import { autorun } from "mobx";
import { describe, expect, test, vi } from "vite-plus/test";
import { SELECTION_COLUMN_KEY } from "./column.model";
import { TableModel } from "./table.model";
import type { ColumnsDef, RowData } from "./table.types";
import { compareValues, getPath, titleCase } from "./util";

const makeRows = (count: number): RowData[] =>
  Array.from({ length: count }, (_, i) => ({ id: i, name: `row-${i}`, n: i }));

// A model sized so widths/windowing are deterministic; rowOverscan defaults are opted out of
// wherever a test asserts an exact window.
const makeTable = (
  rows: RowData[],
  config: Partial<ConstructorParameters<typeof TableModel>[0]> = {},
  size: { width?: number; height?: number } = {},
): TableModel => {
  const table = new TableModel({ rows, ...config });
  table.setWidth(size.width ?? 1000);
  table.setHeight(size.height ?? 200);
  return table;
};

// ---------------------------------------------------------------------------
// util
// ---------------------------------------------------------------------------

describe("titleCase", () => {
  test("splits camelCase", () => {
    expect(titleCase("firstName")).toBe("First Name");
  });

  test("splits snake_case and kebab-case", () => {
    expect(titleCase("created_at")).toBe("Created At");
    expect(titleCase("due-date")).toBe("Due Date");
  });
});

describe("getPath", () => {
  test("resolves a dot-path", () => {
    expect(getPath({ owner: { name: "ada" } }, "owner.name")).toBe("ada");
  });

  test("a literal dotted property wins over the path walk", () => {
    expect(getPath({ "a.b": 1, a: { b: 2 } }, "a.b")).toBe(1);
  });

  test("missing segments yield undefined rather than throwing", () => {
    expect(getPath({ a: null }, "a.b.c")).toBeUndefined();
    expect(getPath(undefined, "a")).toBeUndefined();
  });
});

describe("compareValues", () => {
  test("nullish sorts first", () => {
    expect(compareValues(null, 1)).toBe(-1);
    expect(compareValues(1, undefined)).toBe(1);
    expect(compareValues(null, undefined)).toBe(0);
  });

  test("numbers numerically, Dates chronologically", () => {
    expect(compareValues(2, 10)).toBeLessThan(0);
    expect(compareValues(new Date(2), new Date(1))).toBeGreaterThan(0);
  });

  test("everything else by locale string", () => {
    expect(compareValues("a", "b")).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

describe("column defs", () => {
  test("derives columns from the first row's keys when none are configured", () => {
    const table = makeTable([{ id: 1, name: "a" }]);
    expect(table.allColumns.map((c) => c.key)).toEqual(["id", "name"]);
  });

  test("string defs become field columns with a title-cased header", () => {
    const table = makeTable([{ firstName: "ada" }], { columns: ["firstName"] });
    const col = table.allColumns[0]!;
    expect(col.key).toBe("firstName");
    expect(col.title).toBe("First Name");
    expect(col.getValue({ firstName: "ada" })).toBe("ada");
  });

  test("field columns resolve dot-paths", () => {
    const rows = [{ owner: { name: "ada" } }];
    const table = makeTable(rows, { columns: ["owner.name"] as ColumnsDef<RowData> });
    expect(table.allColumns[0]!.getValue(rows[0]!)).toBe("ada");
  });

  test("computed columns use their own value fn", () => {
    const table = makeTable([{ a: 2, b: 3 }], {
      columns: [{ key: "sum", value: (r) => r.a + r.b }],
    });
    expect(table.allColumns[0]!.getValue({ a: 2, b: 3 })).toBe(5);
  });

  test("an explicit title overrides the derived one", () => {
    const table = makeTable([{ a: 1 }], { columns: [{ key: "a", title: "Custom" }] });
    expect(table.allColumns[0]!.title).toBe("Custom");
  });

  test("a selection def gets the built-in key and is never sortable", () => {
    const table = makeTable([{ a: 1 }], { columns: [{ selection: true }, "a"] });
    const [selection, a] = table.allColumns;
    expect(selection!.key).toBe(SELECTION_COLUMN_KEY);
    expect(selection!.selection).toBe(true);
    expect(selection!.sortable).toBe(false);
    expect(table.selectable).toBe(true);
    expect(a!.sortable).toBe(true);
  });

  test("factory defs are built from the first row and skipped when there is no data", () => {
    const columns: ColumnsDef<RowData> = [(firstRow) => Object.keys(firstRow).map((k) => k)];

    const empty = makeTable([], { columns });
    expect(empty.allColumns).toEqual([]);

    const filled = makeTable([{ x: 1, y: 2 }], { columns });
    expect(filled.allColumns.map((c) => c.key)).toEqual(["x", "y"]);
  });

  test("setRows drops columns the new shape no longer has", () => {
    const table = makeTable([{ a: 1, b: 2 }]);
    expect(table.allColumns.map((c) => c.key)).toEqual(["a", "b"]);

    table.setRows([{ a: 1, c: 3 }]);
    expect(table.allColumns.map((c) => c.key)).toEqual(["a", "c"]);
  });

  test("moveColumn reorders the display order", () => {
    const table = makeTable([{ a: 1, b: 2, c: 3 }]);
    table.moveColumn("c", 0);
    expect(table.columnOrder).toEqual(["c", "a", "b"]);

    table.moveColumn("c", 99); // clamped to the end
    expect(table.columnOrder).toEqual(["a", "b", "c"]);
  });

  test("hidden columns leave the layout but stay in allColumns", () => {
    const table = makeTable([{ a: 1, b: 2 }]);
    table.allColumns[0]!.setHidden(true);
    expect(table.allColumns).toHaveLength(2);
    expect(table.orderedColumns.map((c) => c.key)).toEqual(["b"]);
  });
});

// ---------------------------------------------------------------------------
// Width distribution
// ---------------------------------------------------------------------------

describe("columnWidths", () => {
  test("flex columns split the viewport evenly", () => {
    const table = makeTable([{ a: 1, b: 2, c: 3, d: 4 }], {}, { width: 1000 });
    expect(table.orderedColumns.map((c) => c.width)).toEqual([250, 250, 250, 250]);
    expect(table.virtualWidth).toBe(1000);
  });

  test("fixed-px columns claim their width and the rest share the remainder", () => {
    const table = makeTable(
      [{ a: 1, b: 2, c: 3, d: 4 }],
      { columns: [{ key: "a", width: 200 }, "b", "c", "d"] },
      { width: 800 },
    );
    expect(table.orderedColumns.map((c) => c.width)).toEqual([200, 200, 200, 200]);
  });

  test("fr weights divide the free space proportionally", () => {
    const table = makeTable(
      [{ a: 1, b: 2 }],
      {
        columns: [
          { key: "a", width: "2fr" },
          { key: "b", width: "1fr" },
        ],
      },
      { width: 900 },
    );
    expect(table.orderedColumns.map((c) => c.width)).toEqual([600, 300]);
  });

  test("minWidth wins over the viewport — the table overflows and scrolls", () => {
    const columns: ColumnsDef<RowData> = ["a", "b", "c", "d"].map((key) => ({
      key,
      minWidth: 300,
    }));
    const table = makeTable([{ a: 1, b: 2, c: 3, d: 4 }], { columns }, { width: 1000 });
    expect(table.orderedColumns.map((c) => c.width)).toEqual([300, 300, 300, 300]);
    expect(table.virtualWidth).toBeGreaterThan(table.width);
  });

  test("a maxWidth-clamped column freezes and its share is redistributed", () => {
    const table = makeTable(
      [{ a: 1, b: 2 }],
      { columns: [{ key: "a", maxWidth: 300 }, "b"] },
      { width: 1000 },
    );
    expect(table.orderedColumns.map((c) => c.width)).toEqual([300, 700]);
  });

  test("leftover slack is absorbed by the last column so the columns always fill the viewport", () => {
    const table = makeTable(
      [{ a: 1, b: 2 }],
      {
        columns: [
          { key: "a", maxWidth: 300 },
          { key: "b", maxWidth: 300 },
        ],
      },
      { width: 1000 },
    );
    // both flex columns cap at 300; the 400px remainder goes to the last column, past its max
    expect(table.orderedColumns.map((c) => c.width)).toEqual([300, 700]);
    expect(table.virtualWidth).toBe(1000);
  });

  test("a manual width is treated as fixed and reflows the flex columns", () => {
    const table = makeTable([{ a: 1, b: 2, c: 3 }], {}, { width: 900 });
    expect(table.orderedColumns.map((c) => c.width)).toEqual([300, 300, 300]);

    table.allColumns[0]!.setManualWidth(300);
    expect(table.allColumns[0]!.fixedWidth).toBe(300);
    expect(table.orderedColumns.map((c) => c.width)).toEqual([300, 300, 300]);

    table.allColumns[0]!.setManualWidth(undefined);
    expect(table.allColumns[0]!.fixedWidth).toBeUndefined();
  });

  test("grow reflects the fr weight and is 0 when fixed", () => {
    const table = makeTable([{ a: 1, b: 2, c: 3 }], {
      columns: [{ key: "a", width: "3fr" }, { key: "b", width: 100 }, "c"],
    });
    const [a, b, c] = table.allColumns;
    expect(a!.grow).toBe(3);
    expect(b!.grow).toBe(0);
    expect(c!.grow).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Pinning
// ---------------------------------------------------------------------------

describe("pinning", () => {
  test("pinned blocks sit at the visual edges and drive ariaColIndex", () => {
    const table = makeTable([{ a: 1, b: 2, c: 3 }]);
    const [a, b, c] = table.allColumns;
    c!.setPinned("left");

    expect(table.visualColumns.map((col) => col.key)).toEqual(["c", "a", "b"]);
    expect(c!.ariaColIndex).toBe(1);
    expect(a!.ariaColIndex).toBe(2);
    expect(b!.ariaColIndex).toBe(3);
  });

  test("the innermost/outermost pinned columns are flagged for shadow and corner styling", () => {
    const table = makeTable([{ a: 1, b: 2, c: 3 }]);
    const [a, b] = table.allColumns;
    a!.setPinned("left");
    b!.setPinned("left");

    expect(a!.isPinnedOuterEdge).toBe(true);
    expect(a!.isPinnedEdge).toBe(false);
    expect(b!.isPinnedEdge).toBe(true);
    expect(b!.isPinnedOuterEdge).toBe(false);
  });

  test("right-pinned columns are ordered outer-edge-first", () => {
    const table = makeTable([{ a: 1, b: 2, c: 3 }]);
    const [, b, c] = table.allColumns;
    b!.setPinned("right");
    c!.setPinned("right");

    expect(table.rightPinnedRenderedColumns.map((col) => col.key)).toEqual(["c", "b"]);
    expect(c!.isPinnedOuterEdge).toBe(true);
    expect(b!.isPinnedEdge).toBe(true);
  });

  test("offset accumulates widths within a column's own block", () => {
    const table = makeTable([{ a: 1, b: 2, c: 3, d: 4 }], {}, { width: 1000 });
    const [a, b] = table.allColumns;
    expect(a!.offset).toBe(0);
    expect(b!.offset).toBe(250);
  });

  test("gridTemplateColumns emits the virtualization spacer between the blocks", () => {
    const table = makeTable([{ a: 1, b: 2 }], {}, { width: 1000 });
    expect(table.gridTemplateColumns).toBe("0px 500px 500px");
  });
});

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

describe("sorting", () => {
  const rows = [{ n: 3 }, { n: 1 }, { n: 2 }];

  test("setSort replaces the sort list by default (single-sort)", () => {
    const table = makeTable(rows);
    table.setSort("n", "asc");
    expect(table.displayRows.map((r) => r.n)).toEqual([1, 2, 3]);

    table.setSort("n", "desc");
    expect(table.displayRows.map((r) => r.n)).toEqual([3, 2, 1]);
    expect(table.sorts).toHaveLength(1);
  });

  test("unsorted rows keep their source order", () => {
    const table = makeTable(rows);
    expect(table.displayRows.map((r) => r.n)).toEqual([3, 1, 2]);
  });

  test("preserve keeps priority — later columns only break ties", () => {
    const table = makeTable([
      { a: 1, b: 2 },
      { a: 1, b: 1 },
      { a: 0, b: 9 },
    ]);
    table.setSort("a", "asc");
    table.setSort("b", "asc", { preserve: true });

    expect(table.sorts.map((s) => s.key)).toEqual(["a", "b"]);
    expect(table.displayRows.map((r) => [r.a, r.b])).toEqual([
      [0, 9],
      [1, 1],
      [1, 2],
    ]);
  });

  test("preserve flips an existing column in place without changing its priority", () => {
    const table = makeTable([{ a: 1, b: 2 }]);
    table.setSort("a", "asc");
    table.setSort("b", "asc", { preserve: true });
    table.setSort("a", "desc", { preserve: true });

    expect(table.sorts).toEqual([
      { key: "a", direction: "desc" },
      { key: "b", direction: "asc" },
    ]);
  });

  test("clearSort removes one column or all of them", () => {
    const table = makeTable([{ a: 1, b: 2 }]);
    table.setSort("a", "asc");
    table.setSort("b", "asc", { preserve: true });

    table.clearSort("a");
    expect(table.sorts.map((s) => s.key)).toEqual(["b"]);

    table.clearSort();
    expect(table.sorts).toEqual([]);
  });

  test("a column's sortDirection / sortIndex reflect its place in the priority list", () => {
    const table = makeTable([{ a: 1, b: 2 }]);
    const [a, b] = table.allColumns;
    expect(a!.sortDirection).toBeUndefined();
    expect(a!.sortIndex).toBeUndefined();

    a!.sortBy("desc");
    b!.sortBy("asc", { preserve: true });

    expect(a!.sortDirection).toBe("desc");
    expect(a!.sortIndex).toBe(1);
    expect(b!.sortIndex).toBe(2);

    b!.clearSort();
    expect(b!.sortDirection).toBeUndefined();
  });

  test("sorting goes through the column's value accessor, not a raw key lookup", () => {
    const table = makeTable([{ owner: { name: "carol" } }, { owner: { name: "alice" } }], {
      columns: ["owner.name"] as ColumnsDef<RowData>,
    });
    table.setSort("owner.name", "asc");
    expect(table.displayRows.map((r) => r.owner.name)).toEqual(["alice", "carol"]);
  });

  test("a custom compare receives the extracted values", () => {
    const compare = vi.fn((a: number, b: number) => b - a); // inverted
    const table = makeTable([{ n: 1 }, { n: 2 }], { columns: [{ key: "n", compare }] });
    table.setSort("n", "asc");

    expect(table.displayRows.map((r) => r.n)).toEqual([2, 1]);
    expect(compare).toHaveBeenCalled();
  });

  test("sort keys with no matching column are ignored", () => {
    const table = makeTable(rows);
    table.setSorts([{ key: "nope", direction: "asc" }]);
    expect(table.displayRows.map((r) => r.n)).toEqual([3, 1, 2]);
  });

  test("manual sortMode tracks sort state but leaves row order untouched", () => {
    const table = makeTable(rows, { sortMode: "manual" });
    table.setSort("n", "asc");

    expect(table.sorts).toEqual([{ key: "n", direction: "asc" }]);
    expect(table.allColumns[0]!.sortDirection).toBe("asc");
    expect(table.displayRows.map((r) => r.n)).toEqual([3, 1, 2]);
  });
});

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

describe("filtering", () => {
  test("a filter source's predicate narrows the rows without replacing them", () => {
    const rows = makeRows(5);
    const table = makeTable(rows, { filter: { predicate: (r) => r.n > 2 } });

    expect(table.filteredRows.map((r) => r.n)).toEqual([3, 4]);
    expect(table.rows).toBe(rows);
  });

  test("multiple sources are AND-composed", () => {
    const table = makeTable(makeRows(10), {
      filter: [{ predicate: (r) => r.n > 2 }, { predicate: (r) => r.n < 6 }],
    });
    expect(table.filteredRows.map((r) => r.n)).toEqual([3, 4, 5]);
  });

  test("a source with no predicate is a pass-through", () => {
    const table = makeTable(makeRows(3), { filter: {} });
    expect(table.filteredRows).toHaveLength(3);
  });

  test("setFilter replaces the sources and undefined clears them", () => {
    const table = makeTable(makeRows(5));
    table.setFilter({ predicate: (r) => r.n === 0 });
    expect(table.filteredRows).toHaveLength(1);

    table.setFilter(undefined);
    expect(table.filteredRows).toHaveLength(5);
  });

  test("selection survives filtering because it is keyed by row id", () => {
    const rows = makeRows(5);
    const table = makeTable(rows);
    table.toggleRow(rows[0]!);

    table.setFilter({ predicate: (r) => r.n > 2 });
    expect(table.filteredRows.map((r) => r.n)).toEqual([3, 4]);
    expect(table.selectedRows.map((r) => r.n)).toEqual([0]);

    table.setFilter(undefined);
    expect(table.isRowSelected(rows[0]!)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

describe("selection", () => {
  test("toggleRow flips one row and selectedRows comes back in source order", () => {
    const rows = makeRows(3);
    const table = makeTable(rows);

    table.toggleRow(rows[2]!);
    table.toggleRow(rows[0]!);
    expect(table.selectedRows.map((r) => r.n)).toEqual([0, 2]);

    table.toggleRow(rows[0]!);
    expect(table.selectedRows.map((r) => r.n)).toEqual([2]);
  });

  test("select-all state tracks the filtered rows", () => {
    const rows = makeRows(4);
    const table = makeTable(rows, { filter: { predicate: (r) => r.n > 1 } });

    expect(table.allRowsSelected).toBe(false);
    expect(table.someRowsSelected).toBe(false);

    table.toggleRow(rows[2]!);
    expect(table.someRowsSelected).toBe(true);
    expect(table.allRowsSelected).toBe(false);

    table.selectAllRows();
    expect(table.selectedRows.map((r) => r.n)).toEqual([2, 3]);
    expect(table.allRowsSelected).toBe(true);
    expect(table.someRowsSelected).toBe(false);
  });

  test("toggleAllRows selects everything, then clears it", () => {
    const table = makeTable(makeRows(3));
    table.toggleAllRows();
    expect(table.selectedRows).toHaveLength(3);

    table.toggleAllRows();
    expect(table.selectedRows).toHaveLength(0);
  });

  test("setRows resets selection; appendRows preserves it", () => {
    const rows = makeRows(2);
    const table = makeTable(rows);
    table.toggleRow(rows[0]!);

    table.appendRows(makeRows(2));
    expect(table.rows).toHaveLength(4);
    expect(table.selectedRows.map((r) => r.n)).toEqual([0]);

    table.setRows(makeRows(2));
    expect(table.selectedRows).toEqual([]);
  });

  test("a custom getRowId keys selection by business identity", () => {
    const config = { getRowId: (r: RowData) => r.id as string };
    const rows = [{ id: "x" }, { id: "y" }];
    const table = makeTable(rows, config);

    table.toggleRow(rows[0]!);
    expect(table.rowId(rows[0]!)).toBe("x");
    expect([...table.selectedIds]).toEqual(["x"]);

    // a refetch that appends fresh objects still matches on id
    table.appendRows([{ id: "z" }]);
    expect(table.isRowSelected(table.rows[0]!)).toBe(true);
  });

  test("clearSelection empties the set", () => {
    const table = makeTable(makeRows(3));
    table.selectAllRows();
    table.clearSelection();
    expect(table.selectedRows).toEqual([]);
  });

  test("bound actions keep working when detached from the instance", () => {
    const table = makeTable(makeRows(3));
    // Consumers wire these straight into handlers (onClick={table.toggleAllRows}), which works
    // because they are annotated `action.bound`. The lint rule can't see mobx's runtime binding,
    // and this test exists precisely to prove detaching is safe.
    // oxlint-disable-next-line typescript/unbound-method
    const { toggleAllRows, clearSelection } = table;

    toggleAllRows();
    expect(table.selectedRows).toHaveLength(3);

    clearSelection();
    expect(table.selectedRows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

describe("expansion", () => {
  test("toggleRowExpanded tracks expanded rows and grows the virtual height", () => {
    const rows = makeRows(10);
    const table = makeTable(rows, { rowHeight: 40, expansionHeight: 100 });
    expect(table.virtualHeight).toBe(400);

    table.toggleRowExpanded(rows[2]!);
    expect(table.isRowExpanded(rows[2]!)).toBe(true);
    expect(table.expandedDisplayIndices).toEqual([2]);
    expect(table.virtualHeight).toBe(500);

    table.toggleRowExpanded(rows[2]!);
    expect(table.virtualHeight).toBe(400);
  });

  test("expandMode single collapses the previously expanded row", () => {
    const rows = makeRows(3);
    const table = makeTable(rows, { expandMode: "single" });

    table.toggleRowExpanded(rows[0]!);
    table.toggleRowExpanded(rows[1]!);
    expect(table.isRowExpanded(rows[0]!)).toBe(false);
    expect(table.isRowExpanded(rows[1]!)).toBe(true);
  });

  test("blockOffset adds the panels above a row", () => {
    const rows = makeRows(10);
    const table = makeTable(rows, { rowHeight: 40, expansionHeight: 100 });
    table.toggleRowExpanded(rows[2]!);

    expect(table.blockOffset(2)).toBe(80); // its own panel is below it
    expect(table.blockOffset(3)).toBe(220); // 3 rows + one panel
  });

  test("collapseAllRows clears expansion; setRows resets it too", () => {
    const rows = makeRows(3);
    const table = makeTable(rows);
    table.toggleRowExpanded(rows[0]!);
    table.toggleRowExpanded(rows[1]!);
    table.collapseAllRows();
    expect(table.expandedDisplayIndices).toEqual([]);

    table.toggleRowExpanded(rows[0]!);
    table.setRows(makeRows(3));
    expect(table.expandedDisplayIndices).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Virtualization
// ---------------------------------------------------------------------------

describe("row windowing", () => {
  test("renders the visible slice plus overscan", () => {
    const table = makeTable(
      makeRows(100),
      { rowHeight: 40, rowOverscan: 0 },
      { height: 200, width: 1000 },
    );

    expect(table.firstRenderedIndex).toBe(0);
    expect(table.lastRenderedIndex).toBe(5);
    expect(table.renderedRows).toHaveLength(6);
    expect(table.virtualOffsetY).toBe(0);
  });

  test("scrolling shifts the window and the translate offset", () => {
    const table = makeTable(
      makeRows(100),
      { rowHeight: 40, rowOverscan: 0 },
      { height: 200, width: 1000 },
    );
    table.setScroll(0, 400);

    expect(table.firstRenderedIndex).toBe(10);
    expect(table.lastRenderedIndex).toBe(15);
    expect(table.virtualOffsetY).toBe(400);
  });

  test("overscan widens the window and is clamped at the ends", () => {
    const table = makeTable(
      makeRows(100),
      { rowHeight: 40, rowOverscan: 3 },
      { height: 200, width: 1000 },
    );
    expect(table.firstRenderedIndex).toBe(0); // clamped, not -3
    expect(table.lastRenderedIndex).toBe(8);
  });

  test("an expanded row stays rendered while any part of its block is in view", () => {
    const rows = makeRows(10);
    const table = makeTable(
      rows,
      { rowHeight: 40, expansionHeight: 100, rowOverscan: 0 },
      { height: 40, width: 1000 },
    );
    table.toggleRowExpanded(rows[2]!);

    // scrolled past row 2's own top, but its panel still occupies the viewport
    table.setScroll(0, 150);
    expect(table.renderedRows.map((r) => r.n)).toEqual([2]);

    // past the whole block now — back to plain rows, offset by the panel's height
    table.setScroll(0, 250);
    expect(table.renderedRows.map((r) => r.n)).toEqual([3, 4]);
  });

  test("the window follows the display order, not the source order", () => {
    const table = makeTable(
      makeRows(100),
      { rowHeight: 40, rowOverscan: 0 },
      { height: 80, width: 1000 },
    );
    table.setSort("n", "desc");
    expect(table.renderedRows.map((r) => r.n)).toEqual([99, 98, 97]);
  });

  test("the rendered row window does not invalidate while scrolling within one row", () => {
    const table = makeTable(
      makeRows(100),
      { rowHeight: 40, rowOverscan: 0 },
      { height: 200, width: 1000 },
    );

    let computations = 0;
    const dispose = autorun(() => {
      computations++;
      void table.renderedRows;
    });

    table.setScroll(0, 10); // still inside row 0
    table.setScroll(0, 30);
    expect(computations).toBe(1);

    table.setScroll(0, 40); // crossed a boundary
    expect(computations).toBe(2);
    dispose();
  });
});

describe("column windowing", () => {
  test("only the columns overlapping the viewport are rendered", () => {
    const columns: ColumnsDef<RowData> = Array.from({ length: 10 }, (_, i) => ({
      key: `c${i}`,
      width: 100,
    }));
    const table = makeTable([{}], { columns, columnOverscan: 0 }, { width: 300 });

    expect(table.unpinnedRenderedColumns.map((c) => c.key)).toEqual(["c0", "c1", "c2", "c3"]);
    expect(table.virtualOffsetX).toBe(0);

    table.setScroll(500, 0);
    expect(table.unpinnedRenderedColumns[0]!.key).toBe("c5");
    expect(table.virtualOffsetX).toBe(500);
  });

  test("pinned columns are always rendered and sit outside the window", () => {
    const columns: ColumnsDef<RowData> = Array.from({ length: 10 }, (_, i) => ({
      key: `c${i}`,
      width: 100,
    }));
    const table = makeTable([{}], { columns, columnOverscan: 0 }, { width: 300 });
    table.allColumns[9]!.setPinned("right");
    table.setScroll(0, 0);

    expect(table.rightPinnedRenderedColumns.map((c) => c.key)).toEqual(["c9"]);
    expect(table.renderedColumns.map((c) => c.key)).toContain("c9");
  });
});

// ---------------------------------------------------------------------------
// Scroll intents
// ---------------------------------------------------------------------------

describe("scroll intents", () => {
  test("scrollToRow aligns a row's block top or bottom", () => {
    const rows = makeRows(50);
    const table = makeTable(rows, { rowHeight: 40 }, { height: 200, width: 1000 });

    table.scrollToRow(rows[10]!);
    expect(table.scrollRequest).toEqual({ y: 400 });

    table.scrollToRow(rows[10]!, "bottom");
    expect(table.scrollRequest).toEqual({ y: 240 });
  });

  test("scrollToRow accounts for the row's own expansion panel when aligning to the bottom", () => {
    const rows = makeRows(50);
    const table = makeTable(
      rows,
      { rowHeight: 40, expansionHeight: 100 },
      { height: 200, width: 1000 },
    );
    table.toggleRowExpanded(rows[10]!);

    table.scrollToRow(rows[10]!, "bottom");
    expect(table.scrollRequest).toEqual({ y: 340 });
  });

  test("a row outside the display set produces no request", () => {
    const table = makeTable(makeRows(3));
    table.scrollToRow({ n: 999 });
    expect(table.scrollRequest).toBeUndefined();
  });

  test("scrollToEnd defers the target to execution time and clearScrollRequest resets it", () => {
    const table = makeTable(makeRows(3));
    table.scrollToEnd();
    expect(table.scrollRequest).toEqual({ y: "end" });

    table.clearScrollRequest();
    expect(table.scrollRequest).toBeUndefined();
  });

  test("atEnd is true within one row of the content end", () => {
    const table = makeTable(makeRows(10), { rowHeight: 40 }, { height: 200, width: 1000 });
    expect(table.atEnd).toBe(false);

    table.setScroll(0, 160);
    expect(table.atEnd).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Persisted state
// ---------------------------------------------------------------------------

describe("table state", () => {
  test("getState snapshots order, per-column arrangement and sorts", () => {
    const table = makeTable([{ a: 1, b: 2 }]);
    table.allColumns[0]!.setHidden(true);
    table.allColumns[1]!.setPinned("left");
    table.allColumns[1]!.setManualWidth(150);
    table.setSort("b", "desc");

    expect(table.getState()).toEqual({
      columnOrder: ["a", "b"],
      columns: {
        a: { hidden: true, pinned: false },
        b: { hidden: false, pinned: "left", width: 150 },
      },
      sorts: [{ key: "b", direction: "desc" }],
    });
  });

  test("applyState restores a snapshot onto existing columns", () => {
    const table = makeTable([{ a: 1, b: 2 }]);
    table.applyState({
      columnOrder: ["b", "a"],
      columns: { a: { hidden: true, pinned: false }, b: { hidden: false, pinned: "right" } },
      sorts: [{ key: "a", direction: "asc" }],
    });

    expect(table.columnOrder).toEqual(["b", "a"]);
    expect(table.columns.get("a")!.hidden).toBe(true);
    expect(table.columns.get("b")!.pinned).toBe("right");
    expect(table.sorts).toEqual([{ key: "a", direction: "asc" }]);
  });

  test("state applied before the columns exist lands when they appear", () => {
    const table = new TableModel();
    table.applyState({
      columnOrder: ["b", "a"],
      columns: { a: { hidden: true, pinned: false } },
    });

    table.setRows([{ a: 1, b: 2 }]);
    expect(table.columnOrder).toEqual(["b", "a"]);
    expect(table.columns.get("a")!.hidden).toBe(true);
  });

  test("columns the snapshot does not mention keep their state and sort after it", () => {
    const table = makeTable([{ a: 1, b: 2, c: 3 }]);
    table.applyState({ columnOrder: ["c"] });
    expect(table.columnOrder).toEqual(["c", "a", "b"]);
  });

  test("unknown keys in a snapshot are dropped from the order but harmless in sorts", () => {
    const table = makeTable([{ a: 1 }]);
    table.applyState({ columnOrder: ["ghost", "a"], sorts: [{ key: "ghost", direction: "asc" }] });

    expect(table.columnOrder).toEqual(["a"]);
    expect(table.displayRows).toHaveLength(1);
  });

  test("onStateChange fires on arrangement changes and dispose/activate gate it", () => {
    const onStateChange = vi.fn();
    const table = makeTable([{ a: 1, b: 2 }], { onStateChange });
    expect(onStateChange).not.toHaveBeenCalled();

    table.allColumns[0]!.setHidden(true);
    expect(onStateChange).toHaveBeenCalledTimes(1);
    expect(onStateChange.mock.calls[0]![0].columns.a.hidden).toBe(true);

    table.dispose();
    table.allColumns[0]!.setHidden(false);
    expect(onStateChange).toHaveBeenCalledTimes(1);

    table.activate();
    table.setSort("a", "asc");
    expect(onStateChange).toHaveBeenCalledTimes(2);

    table.dispose();
  });

  test("onStateChange ignores ephemeral churn (selection, scroll)", () => {
    const onStateChange = vi.fn();
    const rows = makeRows(3);
    const table = makeTable(rows, { onStateChange });

    table.toggleRow(rows[0]!);
    table.setScroll(0, 80);
    table.toggleRowExpanded(rows[1]!);

    expect(onStateChange).not.toHaveBeenCalled();
    table.dispose();
  });

  test("activate is idempotent so a StrictMode remount does not double-subscribe", () => {
    const onStateChange = vi.fn();
    const table = makeTable([{ a: 1 }], { onStateChange });

    table.activate();
    table.activate();
    table.allColumns[0]!.setHidden(true);

    expect(onStateChange).toHaveBeenCalledTimes(1);
    table.dispose();
  });
});
