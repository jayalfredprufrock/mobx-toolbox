// @vitest-environment happy-dom
import { StrictMode, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { lazyArray } from "../lazy/lazy";
import type { TableModel } from "./table.model";
import type { RowData, UseTableConfig } from "./table.types";
import { useTable } from "./use-table";

const rowsOf = (...names: string[]): RowData[] => names.map((name, id) => ({ id, name }));

const containers: HTMLElement[] = [];
afterEach(() => {
  for (const c of containers.splice(0)) c.remove();
});

/** Re-renders `useTable` with whatever config the caller passes, as a component tree would. */
const mount = async (config: UseTableConfig<RowData>) => {
  let table!: TableModel;
  const Probe = ({ config }: { config: UseTableConfig<RowData> }) => {
    table = useTable(config);
    return null;
  };

  const container = document.createElement("div");
  document.body.appendChild(container);
  containers.push(container);
  const root = createRoot(container);

  const render = async (next: UseTableConfig<RowData>) => {
    await act(async () => {
      root.render(<Probe config={next} />);
    });
  };

  await render(config);
  return { table: () => table, render };
};

/** The five states, as a caller would read them off the model. */
const state = (table: TableModel) => ({
  loading: table.loading,
  error: table.error,
  isEmpty: table.isEmpty,
});

const settled = { loading: false, error: undefined };

describe("the controlled form: rows plus loading/error props", () => {
  test("a first load reports loading, not empty", async () => {
    const { table } = await mount({ data: undefined, loading: true });

    expect(state(table())).toEqual({ ...settled, loading: true, isEmpty: false });
  });

  test("an empty array while loading is still a first load, not a settled empty result", async () => {
    // the trap this mapping exists for: `useState<Row[]>([])` is the most common way to hold rows,
    // and trusting the array alone would flash "No results" over every first load
    const { table } = await mount({ data: [], loading: true });

    expect(table().loading).toBe(true);
    expect(table().isEmpty).toBe(false);
  });

  test("rows arriving settle it", async () => {
    const { table, render } = await mount({ data: [], loading: true });
    await render({ data: rowsOf("alpha", "beta"), loading: false });

    expect(state(table())).toEqual({ ...settled, isEmpty: false });
    expect(table().rows).toHaveLength(2);
  });

  test("a settled empty result is empty", async () => {
    const { table } = await mount({ data: [], loading: false });

    expect(state(table())).toEqual({ ...settled, isEmpty: true });
  });

  test("loading behind rows is a refresh: the rows stay, and no state changes", async () => {
    const rows = rowsOf("alpha", "beta");
    const { table, render } = await mount({ data: rows, loading: false });
    table().selectedIds.add(0);

    await render({ data: rows, loading: true });

    // the table reports nothing — you passed `loading`, so you already know a request is running
    expect(state(table())).toEqual({ ...settled, isEmpty: false });
    expect(table().rows).toHaveLength(2);
    expect([...table().selectedIds]).toEqual([0]);
  });

  test("an error with nothing to show is fatal", async () => {
    const boom = new Error("boom");
    const { table, render } = await mount({ data: undefined, loading: true });
    await render({ data: undefined, loading: false, error: boom });

    expect(state(table())).toEqual({ ...settled, error: boom, isEmpty: false });
  });

  test("an error behind rows disturbs nothing, and the table stays quiet about it", async () => {
    const boom = new Error("boom");
    const rows = rowsOf("alpha", "beta");
    const { table, render } = await mount({ data: rows, loading: false });
    await render({ data: rows, loading: false, error: boom });

    // you passed the error in, so you still have it; the table declines to blank good rows over it
    expect(state(table())).toEqual({ ...settled, isEmpty: false });
    expect(table().rows).toHaveLength(2);
  });

  test("clearing the error settles it again", async () => {
    const rows = rowsOf("alpha");
    const { table, render } = await mount({ data: rows, error: new Error("boom") });
    await render({ data: rows, error: undefined });

    expect(state(table())).toEqual({ ...settled, isEmpty: false });
  });

  test("a getter form takes the same props", async () => {
    const rows = rowsOf("alpha");
    const { table, render } = await mount({ data: () => rows, loading: true });

    // a getter that already has rows to give reads as a refresh, exactly as an array would: the
    // rows stay and nothing else moves
    expect(table().loading).toBe(false);
    expect(table().isEmpty).toBe(false);
    expect(table().rows).toHaveLength(1);

    await render({ data: () => rows, loading: false, error: new Error("boom") });
    expect(table().error).toBeUndefined();
    expect(table().rows).toHaveLength(1);
  });
});

describe("the uncontrolled form is unaffected", () => {
  test("a lazy works out its own state", async () => {
    const lazy = lazyArray(async () => rowsOf("alpha"));
    const { table } = await mount({ data: lazy });
    await act(async () => {});

    expect(state(table())).toEqual({ ...settled, isEmpty: false });
    expect(table().rows).toHaveLength(1);
    expect(table().lazy).toBe(lazy);
  });

  test("pairing a lazy with the status props is a compile error", async () => {
    const lazy = lazyArray(async () => rowsOf("alpha"));

    // A lazy is authoritative about its own dataset, so `loading` here isn't a preference the table
    // could honour — it's a contradiction. Caught at the call site rather than silently ignored.
    // @ts-expect-error `loading` is not assignable alongside a lazy `data`
    const { table } = await mount({ data: lazy, loading: true });
    await act(async () => {});

    expect(table().rows).toHaveLength(1);
  });

  test("a plain array with no status props behaves exactly as before", async () => {
    const { table, render } = await mount({ data: rowsOf("alpha") });
    expect(state(table())).toEqual({ ...settled, isEmpty: false });

    await render({ data: [] });
    expect(state(table())).toEqual({ ...settled, isEmpty: true });
  });

  test("a config with no rows key installs nothing, so setRows keeps working", async () => {
    const { table } = await mount({ getRowId: (row: RowData) => (row as { id: number }).id });

    await act(async () => {
      table().setData(rowsOf("alpha", "beta"));
    });

    // nothing was installed that could overwrite what the caller put there
    expect(table().rows).toHaveLength(2);
    expect(state(table())).toEqual({ ...settled, isEmpty: false });
  });
});

describe("a StrictMode remount", () => {
  test("survives the dispose/activate cycle without blanking the table", async () => {
    // StrictMode runs mount -> cleanup -> mount against the same surviving model, which re-arms the
    // rows reaction. The controlled source has to still be the binding on the other side of that,
    // or the table comes back holding nothing.
    let table!: TableModel;
    const Probe = ({ config }: { config: UseTableConfig<RowData> }) => {
      table = useTable(config);
      return null;
    };

    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);

    const rows = rowsOf("alpha", "beta");
    await act(async () => {
      root.render(
        <StrictMode>
          <Probe config={{ data: rows, loading: false }} />
        </StrictMode>,
      );
    });

    expect(table.rows).toHaveLength(2);
    expect(state(table)).toEqual({ ...settled, isEmpty: false });

    // and it still tracks props afterwards rather than being deaf: an empty dataset that is still
    // loading has to come back as a first load, which only a live prop mirror can report
    await act(async () => {
      root.render(
        <StrictMode>
          <Probe config={{ data: [], loading: true }} />
        </StrictMode>,
      );
    });
    expect(table.loading).toBe(true);
    expect(table.isEmpty).toBe(false);
  });
});
