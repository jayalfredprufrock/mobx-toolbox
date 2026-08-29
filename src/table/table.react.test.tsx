// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, test } from "vite-plus/test";
import { Table } from "./components";
import { TableModel } from "./table.model";
import type { ColumnsDef, RowData } from "./table.types";

// happy-dom never lays anything out, so ResizeObserver would only ever report 0×0. The tests set
// the model's measured size directly and stub the observer out.
beforeEach(() => {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});

const makeRows = (count: number): RowData[] =>
  Array.from({ length: count }, (_, i) => ({ id: i, name: `row-${i}` }));

const makeTable = (rows: RowData[], columns?: ColumnsDef<RowData>): TableModel => {
  const table = new TableModel({ data: rows, columns, rowHeight: 40, rowOverscan: 0 });
  table.setWidth(600);
  table.setHeight(120);
  return table;
};

const mount = async (el: React.ReactNode) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(el);
  });
  return { container, root };
};

// The minimal consumer composition: Root wraps Header + Body, each using its render-prop.
const BasicTable = ({ table }: { table: TableModel }) => (
  <Table.Root table={table}>
    <Table.Header>
      {(column) =>
        column.selection ? (
          <Table.SelectionHeaderCell column={column} />
        ) : (
          <Table.ColumnHeader column={column}>{column.title}</Table.ColumnHeader>
        )
      }
    </Table.Header>
    <Table.Body className="body">
      {(row) => (
        <Table.Row row={row}>
          {(column) =>
            column.selection ? (
              <Table.SelectionCell column={column} row={row} />
            ) : (
              <Table.Cell column={column}>{String(column.getValue(row))}</Table.Cell>
            )
          }
        </Table.Row>
      )}
    </Table.Body>
  </Table.Root>
);

// The header is a rowgroup with a row in it too, so body queries must be scoped past it.
const bodyRows = (container: HTMLElement) => [...container.querySelectorAll('.body [role="row"]')];

describe("<Table.Root>", () => {
  test("renders the grid roles and the true row/column extent", async () => {
    const table = makeTable(makeRows(50), ["id", "name"]);
    const { container } = await mount(<BasicTable table={table} />);

    const grid = container.querySelector('[role="table"]')!;
    expect(grid.getAttribute("aria-rowcount")).toBe("51"); // 50 rows + header
    expect(grid.getAttribute("aria-colcount")).toBe("2");
    expect(container.querySelectorAll('[role="columnheader"]')).toHaveLength(2);
    expect(container.querySelector('[role="columnheader"]')!.textContent).toBe("Id");
  });

  test("renders nothing until the viewport has been measured", async () => {
    const table = new TableModel({ data: makeRows(5), columns: ["id"] });
    const { container } = await mount(<BasicTable table={table} />);
    expect(container.querySelectorAll('[role="cell"]')).toHaveLength(0);

    await act(async () => {
      table.setWidth(600);
      table.setHeight(120);
    });
    expect(container.querySelectorAll('[role="cell"]').length).toBeGreaterThan(0);
  });

  test("only the windowed rows reach the DOM, and each carries its absolute index", async () => {
    const table = makeTable(makeRows(50), ["id"]);
    const { container } = await mount(<BasicTable table={table} />);

    // 120px viewport / 40px rows, no overscan
    expect(bodyRows(container)).toHaveLength(4);

    await act(async () => {
      table.setScroll(0, 400);
    });
    const shifted = bodyRows(container);
    expect(shifted).toHaveLength(4);
    // aria-rowindex is 1-based and offset past the header row
    expect(shifted[0]!.getAttribute("aria-rowindex")).toBe("12");
    expect(shifted[0]!.textContent).toBe("10");
  });

  test("re-sorting the model re-renders the body in display order", async () => {
    const table = makeTable(makeRows(50), ["id"]);
    const { container } = await mount(<BasicTable table={table} />);
    expect(container.querySelector('[role="cell"]')!.textContent).toBe("0");

    await act(async () => {
      table.setSort("id", "desc");
    });
    expect(container.querySelector('[role="cell"]')!.textContent).toBe("49");
  });
});

describe("selection", () => {
  const columns: ColumnsDef<RowData> = [{ selection: true }, "name"];

  test("the select-all checkbox toggles every row and reports indeterminate state", async () => {
    const rows = makeRows(3);
    const table = makeTable(rows, columns);
    const { container } = await mount(<BasicTable table={table} />);

    const selectAll = container.querySelector<HTMLInputElement>(
      '[role="columnheader"] input[type="checkbox"]',
    )!;
    expect(selectAll.checked).toBe(false);

    await act(async () => {
      selectAll.click();
    });
    expect(table.selectedRows).toHaveLength(3);
    expect(selectAll.checked).toBe(true);

    // untick one row → the header control goes indeterminate
    const firstRowBox = container.querySelector<HTMLInputElement>('.body input[type="checkbox"]')!;
    await act(async () => {
      firstRowBox.click();
    });
    expect(table.selectedRows).toHaveLength(2);
    expect(table.someRowsSelected).toBe(true);
    expect(selectAll.indeterminate).toBe(true);
  });

  test("a selected row exposes aria-selected and data-selected", async () => {
    const rows = makeRows(2);
    const table = makeTable(rows, columns);
    const { container } = await mount(<BasicTable table={table} />);

    const row = () => bodyRows(container)[0]!;
    expect(row().getAttribute("aria-selected")).toBe("false");

    await act(async () => {
      table.toggleRow(rows[0]!);
    });
    expect(row().getAttribute("aria-selected")).toBe("true");
    expect(row().hasAttribute("data-selected")).toBe(true);
  });

  test("a checkbox registered on Root replaces the native one everywhere", async () => {
    const table = makeTable(makeRows(2), columns);
    const { container } = await mount(
      <Table.Root
        table={table}
        checkbox={({ checked, onChange }) => (
          <button type="button" data-custom-checkbox="" onClick={onChange}>
            {checked ? "on" : "off"}
          </button>
        )}
      >
        <Table.Header>
          {(column) =>
            column.selection ? (
              <Table.SelectionHeaderCell column={column} />
            ) : (
              <Table.ColumnHeader column={column}>{column.title}</Table.ColumnHeader>
            )
          }
        </Table.Header>
        <Table.Body>
          {(row) => (
            <Table.Row row={row}>
              {(column) =>
                column.selection ? (
                  <Table.SelectionCell column={column} row={row} />
                ) : (
                  <Table.Cell column={column}>{String(column.getValue(row))}</Table.Cell>
                )
              }
            </Table.Row>
          )}
        </Table.Body>
      </Table.Root>,
    );

    const boxes = container.querySelectorAll("[data-custom-checkbox]");
    expect(boxes).toHaveLength(3); // one header + two rows
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);

    await act(async () => {
      (boxes[0] as HTMLButtonElement).click();
    });
    expect(table.selectedRows).toHaveLength(2);
  });
});

describe("pinning and expansion", () => {
  test("pinned cells advertise their side and edge for consumer CSS", async () => {
    const table = makeTable(makeRows(2), ["id", "name"]);
    await act(async () => {
      table.allColumns[0]!.setPinned("left");
    });
    const { container } = await mount(<BasicTable table={table} />);

    const pinned = container.querySelector('[role="columnheader"][data-pinned="left"]')!;
    expect(pinned).toBeTruthy();
    expect(pinned.getAttribute("data-pinned-edge")).toBe("true");
    expect(pinned.getAttribute("data-pinned-corner")).toBe("left");
  });

  test("an expansion panel renders only for the expanded row", async () => {
    const rows = makeRows(3);
    const table = makeTable(rows, ["id"]);

    const ExpandableTable = () => (
      <Table.Root table={table}>
        <Table.Body>
          {(row) => (
            <>
              <Table.Row row={row}>
                {(column) => (
                  <Table.Cell column={column}>{String(column.getValue(row))}</Table.Cell>
                )}
              </Table.Row>
              {table.isRowExpanded(row) && (
                <Table.Expansion row={row}>detail-{row.id}</Table.Expansion>
              )}
            </>
          )}
        </Table.Body>
      </Table.Root>
    );

    const { container } = await mount(<ExpandableTable />);
    expect(container.querySelectorAll("[data-expansion]")).toHaveLength(0);

    await act(async () => {
      table.toggleRowExpanded(rows[1]!);
    });
    const panels = container.querySelectorAll('[role="cell"][data-expansion]');
    expect(panels).toHaveLength(1);
    expect(panels[0]!.textContent).toBe("detail-1");
  });
});

describe("<Table.Empty>", () => {
  test("the consumer decides when it shows", async () => {
    const table = makeTable([], ["id"]);
    const EmptyAware = () => (
      <Table.Root table={table}>
        <Table.Body>{() => null}</Table.Body>
        {table.displayRows.length === 0 && <Table.Empty>No results</Table.Empty>}
      </Table.Root>
    );

    const { container } = await mount(<EmptyAware />);
    expect(container.querySelector("[data-empty]")!.textContent).toBe("No results");
  });
});

describe("aria wiring outside the rendered window", () => {
  test("column indices follow visual order, so a pinned column reports index 1", async () => {
    const table = makeTable(makeRows(1), ["id", "name"]);
    await act(async () => {
      table.allColumns[1]!.setPinned("left");
    });
    const { container } = await mount(<BasicTable table={table} />);

    const headers = [...container.querySelectorAll('[role="columnheader"]')];
    const pinned = headers.find((h) => h.getAttribute("data-pinned") === "left")!;
    expect(pinned.getAttribute("aria-colindex")).toBe("1");
    expect(pinned.textContent).toBe("Name");
  });
});

describe("row keys and reconciliation", () => {
  // `<Table.Body>` keys each row on `table.rowIds`, so whatever identifies a row for selection also
  // identifies it to React. With the row's own object identity as the default, a reorder *moves*
  // the DOM node; with the row's index it would reuse the node in that position and rewrite its
  // contents — which is the index-as-key antipattern, and costs focus, caret position and any
  // transition mid-flight.
  test("reordering the same rows moves their DOM nodes rather than rewriting them", async () => {
    const alpha = { id: 1, name: "alpha" };
    const beta = { id: 2, name: "beta" };
    const table = makeTable([alpha, beta], ["id", "name"]);
    const { container } = await mount(<BasicTable table={table} />);

    const before = bodyRows(container);
    const alphaNode = before.find((el) => el.textContent?.includes("alpha"));
    expect(before.indexOf(alphaNode!)).toBe(0);

    // the same two objects, other way round
    await act(async () => {
      table.setData([beta, alpha]);
    });

    const after = bodyRows(container);
    const alphaAfter = after.find((el) => el.textContent?.includes("alpha"));

    expect(after.indexOf(alphaAfter!)).toBe(1); // it moved...
    expect(alphaAfter).toBe(alphaNode); // ...and it is the same element
  });

  test("rows replaced by new objects get new nodes, as they should", async () => {
    const table = makeTable([{ id: 1, name: "alpha" }], ["id", "name"]);
    const { container } = await mount(<BasicTable table={table} />);
    const before = bodyRows(container)[0];

    await act(async () => {
      table.setData([{ id: 1, name: "alpha" }]); // same values, different object
    });

    // nothing claims this is the row that was there before, so React builds a new one
    expect(bodyRows(container)[0]).not.toBe(before);
  });

  test("getRowId makes the node survive a replaced object", async () => {
    const table = new TableModel({
      data: [{ id: 1, name: "alpha" }],
      columns: ["id", "name"],
      rowHeight: 40,
      rowOverscan: 0,
      getRowId: (row) => (row as { id: number }).id,
    });
    table.setWidth(600);
    table.setHeight(120);
    const { container } = await mount(<BasicTable table={table} />);
    const before = bodyRows(container)[0];

    await act(async () => {
      table.setData([{ id: 1, name: "alpha renamed" }]);
    });

    const after = bodyRows(container)[0];
    expect(after).toBe(before); // same record by value, so the same node updates in place
    expect(after?.textContent).toContain("renamed");
  });
});
