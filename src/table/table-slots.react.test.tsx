// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { lazyObservableArray } from "../lazy-observable/lazy-observable";
import { SetFilter } from "../filter/set-filter.model";
import { Table } from "./components";
import { TableModel } from "./table.model";
import { useTable } from "./use-table";
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
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
    <Table.Error>FAILED</Table.Error>
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

    // rows stay on screen and stay interactive — a refresh is not a load, and the table has no
    // state for it at all; the lazy is where anyone who cares can see one is running
    expect(lazy.refreshing).toBe(true);
    expect(table.loading).toBe(false);
    expect(container.textContent).toContain("alpha");
    expect(container.textContent).not.toContain("LOADING");
    expect(container.textContent).not.toContain("NOTHING HERE");

    second.resolve([{ id: 1, name: "beta" }]);
    await act(async () => {});
    expect(lazy.refreshing).toBe(false);
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

describe("Table.Error gates on a failure with nothing to show", () => {
  test("a failed first load shows the error slot, not a spinner forever", async () => {
    vi.useFakeTimers();
    const gate = deferred<RowData[]>();
    const lazy = lazyObservableArray(() => gate.promise);
    const container = await mount(<Grid table={sized({ rows: lazy })} />);

    await advance(300);
    expect(container.textContent).toContain("LOADING");

    await act(async () => {
      gate.reject(new Error("boom"));
    });
    await advance(1000);

    // the whole point: the wait ends, and it ends in something the user can read
    expect(container.textContent).toContain("FAILED");
    expect(container.textContent).not.toContain("LOADING");
    expect(container.textContent).not.toContain("NOTHING HERE");
  });

  test("a failed refresh leaves the rows alone and shows no slot at all", async () => {
    let calls = 0;
    const lazy = lazyObservableArray(() => {
      calls++;
      return calls === 1
        ? Promise.resolve([{ id: 1, name: "alpha" }])
        : Promise.reject(new Error("boom"));
    });

    const table = sized({ rows: lazy });
    const container = await mount(<Grid table={table} />);
    await act(async () => {});
    expect(container.textContent).toContain("alpha");

    await act(async () => {
      await lazy.reload().catch(() => undefined);
    });

    // blanking a working table over a background request is the failure mode this gate prevents
    expect(container.textContent).toContain("alpha");
    expect(container.textContent).not.toContain("FAILED");
    expect(container.textContent).not.toContain("LOADING");
    expect(container.textContent).not.toContain("NOTHING HERE");

    // it is still a real failure, still readable where the caller keeps it — the table just
    // declines to render anything about it
    expect(table.error).toBeUndefined();
    expect(lazy.error).toBeInstanceOf(Error);
  });

  test("the error slot receives the error, so the wording can come from it", async () => {
    const lazy = lazyObservableArray(() => Promise.reject(new Error("teapot")));
    const container = await mount(
      <Table.Root table={sized({ rows: lazy })}>
        <Table.Error>{(error) => `FAILED: ${(error as Error).message}`}</Table.Error>
      </Table.Root>,
    );
    await act(async () => {});

    expect(container.textContent).toContain("FAILED: teapot");
    expect(container.querySelector("[data-error]")).not.toBeNull();
  });

  test("a plain array shows no error slot, since there is no failure to know about", async () => {
    const container = await mount(<Grid table={sized({ rows: [{ id: 1, name: "alpha" }] })} />);

    expect(container.textContent).not.toContain("FAILED");
  });
});

describe("Table.Overlay is the placement primitive with no gate", () => {
  test("it renders whenever the consumer says so, over a perfectly healthy table", async () => {
    const container = await mount(
      <Table.Root table={sized({ rows: [{ id: 1, name: "alpha" }] })}>
        <Table.Body>{(row) => <Table.Row row={row}>{() => null}</Table.Row>}</Table.Body>
        <Table.Overlay>SAVE FAILED</Table.Overlay>
      </Table.Root>,
    );

    expect(container.textContent).toContain("SAVE FAILED");
  });

  test("it claims none of the table's own markers", async () => {
    const container = await mount(
      <Table.Root table={sized({ rows: [{ id: 1, name: "alpha" }] })}>
        <Table.Overlay>SAVE FAILED</Table.Overlay>
      </Table.Root>,
    );

    // `data-empty` / `data-loading` / `data-error` mean "the table decided this"; a hand-shown
    // overlay has decided nothing, so it carries no claim it can't back up
    expect(container.querySelector("[data-empty]")).toBeNull();
    expect(container.querySelector("[data-loading]")).toBeNull();
    expect(container.querySelector("[data-error]")).toBeNull();
  });
});

describe("the slots gate off the controlled props too", () => {
  /** The controlled wiring end to end: props in, gated slots out, no row source anywhere. */
  const Controlled = ({
    rows,
    loading,
    error,
  }: {
    rows?: RowData[];
    loading?: boolean;
    error?: unknown;
  }) => {
    const table = useTable({ rows, loading, error });
    table.setWidth(600);
    table.setHeight(120);
    return <Grid table={table} />;
  };

  test("loading with no rows shows the loading slot", async () => {
    vi.useFakeTimers();
    const container = await mount(<Controlled rows={[]} loading />);
    await advance(300);

    expect(container.textContent).toContain("LOADING");
    expect(container.textContent).not.toContain("NOTHING HERE");
    expect(container.textContent).not.toContain("FAILED");
  });

  test("an error with no rows shows the error slot", async () => {
    const container = await mount(<Controlled rows={[]} error={new Error("boom")} />);

    expect(container.textContent).toContain("FAILED");
    expect(container.textContent).not.toContain("LOADING");
    expect(container.textContent).not.toContain("NOTHING HERE");
  });

  test("an error behind rows shows no slot at all", async () => {
    const container = await mount(
      <Controlled rows={[{ id: 1, name: "alpha" }]} error={new Error("boom")} />,
    );

    expect(container.textContent).toContain("alpha");
    expect(container.textContent).not.toContain("FAILED");
  });

  test("settled with no rows shows the empty slot", async () => {
    const container = await mount(<Controlled rows={[]} loading={false} />);

    expect(container.textContent).toContain("NOTHING HERE");
    expect(container.textContent).not.toContain("LOADING");
    expect(container.textContent).not.toContain("FAILED");
  });
});
