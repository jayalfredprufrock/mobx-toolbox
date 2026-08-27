// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { lazyObservableArray } from "../lazy-observable/lazy-observable";
import { SetFilter } from "../filter/set-filter.model";
import { Table } from "./components";
import { TableModel } from "./table.model";
import type { RowData } from "./table.types";

beforeEach(() => {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});

const containers: HTMLElement[] = [];
afterEach(() => {
  for (const c of containers.splice(0)) c.remove();
  vi.useRealTimers();
});

const mount = async (el: React.ReactNode) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  containers.push(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(el);
  });
  return container;
};

const advance = async (ms: number) => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

/** A table wired the way a consumer would: both slots rendered unconditionally after the body. */
const Grid = ({ table }: { table: TableModel }) => (
  <Table.Root table={table}>
    <Table.Header>{(column) => <Table.ColumnHeader column={column} />}</Table.Header>
    <Table.Body>
      {(row) => (
        <Table.Row row={row}>
          {(column) => <Table.Cell column={column}>{String(column.getValue(row))}</Table.Cell>}
        </Table.Row>
      )}
    </Table.Body>
    <Table.Empty>NOTHING HERE</Table.Empty>
    <Table.Loading>LOADING</Table.Loading>
  </Table.Root>
);

const sized = (config: ConstructorParameters<typeof TableModel>[0]): TableModel => {
  const table = new TableModel(config);
  table.setWidth(600);
  table.setHeight(120);
  return table;
};

describe("Table.Empty and Table.Loading gate themselves", () => {
  test("a first load shows loading and never the empty slot", async () => {
    vi.useFakeTimers();
    const gate = deferred<RowData[]>();
    const lazy = lazyObservableArray(() => gate.promise);
    const container = await mount(<Grid table={sized({ rows: lazy })} />);

    // the wait has not earned an indicator yet, but it is emphatically not "empty"
    expect(container.textContent).not.toContain("NOTHING HERE");
    expect(container.textContent).not.toContain("LOADING");

    await advance(300);
    expect(container.textContent).toContain("LOADING");
    expect(container.textContent).not.toContain("NOTHING HERE");

    gate.resolve([{ id: 1, name: "alpha" }]);
    await act(async () => {});
    await advance(300);

    expect(container.textContent).not.toContain("LOADING");
    expect(container.textContent).not.toContain("NOTHING HERE");
    expect(container.textContent).toContain("alpha");
  });

  test("a settled load with no rows shows the empty slot", async () => {
    const lazy = lazyObservableArray(async () => []);
    const container = await mount(<Grid table={sized({ rows: lazy })} />);
    await act(async () => {});

    expect(container.textContent).toContain("NOTHING HERE");
    expect(container.textContent).not.toContain("LOADING");
  });

  test("a fast first load never flashes the loading slot", async () => {
    vi.useFakeTimers();
    const lazy = lazyObservableArray(async () => [{ id: 1, name: "alpha" }]);
    const container = await mount(<Grid table={sized({ rows: lazy })} />);

    await act(async () => {});
    await advance(1000);

    expect(container.textContent).not.toContain("LOADING");
    expect(container.textContent).toContain("alpha");
  });

  test("a plain array with rows shows neither slot", async () => {
    const container = await mount(<Grid table={sized({ rows: [{ id: 1, name: "alpha" }] })} />);

    expect(container.textContent).not.toContain("LOADING");
    expect(container.textContent).not.toContain("NOTHING HERE");
  });

  test("a plain empty array is empty, since there is no load to wait for", async () => {
    const container = await mount(<Grid table={sized({ rows: [] })} />);

    expect(container.textContent).toContain("NOTHING HERE");
    expect(container.textContent).not.toContain("LOADING");
  });

  test("a refresh keeps the rows and shows neither slot", async () => {
    // the second fetch is held open, so the refresh is observably in flight rather than a race
    const second = deferred<RowData[]>();
    let calls = 0;
    const lazy = lazyObservableArray(() => {
      calls++;
      return calls === 1 ? Promise.resolve([{ id: 1, name: "alpha" }]) : second.promise;
    });

    const table = sized({ rows: lazy });
    const container = await mount(<Grid table={table} />);
    await act(async () => {});
    expect(container.textContent).toContain("alpha");

    await act(async () => {
      void lazy.reload();
    });

    // rows stay on screen and stay interactive — this is `refreshing`, not `loading`
    expect(table.refreshing).toBe(true);
    expect(table.loading).toBe(false);
    expect(container.textContent).toContain("alpha");
    expect(container.textContent).not.toContain("LOADING");
    expect(container.textContent).not.toContain("NOTHING HERE");

    second.resolve([{ id: 1, name: "beta" }]);
    await act(async () => {});
    expect(table.refreshing).toBe(false);
    expect(container.textContent).toContain("beta");
  });

  test("`sustain={false}` shows the loading slot at once", async () => {
    const gate = deferred<RowData[]>();
    const lazy = lazyObservableArray(() => gate.promise);
    const container = await mount(
      <Table.Root table={sized({ rows: lazy })}>
        <Table.Loading sustain={false}>LOADING</Table.Loading>
      </Table.Root>,
    );

    expect(container.textContent).toContain("LOADING");
    gate.resolve([]);
  });

  test("the empty slot's children still tell the story", async () => {
    // gating is the library's; wording stays the consumer's, including the distinction the
    // gate cannot make — filtered-to-nothing versus nothing at all
    const table = sized({ rows: [{ id: 1, name: "alpha" }] });
    table.addColumn({
      key: "_none",
      value: () => "present",
      filter: new SetFilter({ selected: ["absent"] }),
      hidden: true,
      hideable: false,
    });

    const container = await mount(
      <Table.Root table={table}>
        <Table.Empty>{table.rows.length > 0 ? "NO MATCHES" : "NOTHING HERE"}</Table.Empty>
      </Table.Root>,
    );

    expect(container.textContent).toContain("NO MATCHES");
  });
});
