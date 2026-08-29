// @vitest-environment happy-dom
import { observable, runInAction } from "mobx";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test } from "vite-plus/test";
import type { TableModel } from "./table.model";
import type { RowData, UseTableConfig } from "./table.types";
import { useTable } from "./use-table";

const makeRows = (count: number, tag = "a"): RowData[] =>
  Array.from({ length: count }, (_, i) => ({ id: i, name: `${tag}-${i}` }));

const containers: HTMLElement[] = [];

afterEach(() => {
  for (const c of containers.splice(0)) c.remove();
});

/** Mounts a component that calls useTable with whatever config the last render passed. */
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

  const unmount = async () => {
    await act(async () => {
      root.unmount();
    });
  };

  await render(config);
  return { table: () => table, render, unmount };
};

describe("useTable", () => {
  test("keeps the same model across renders", async () => {
    const rows = makeRows(2);
    const { table, render } = await mount({ data: rows });
    const first = table();

    await render({ data: rows });
    expect(table()).toBe(first);
  });

  test("applies a new rows array without remounting", async () => {
    // the case this exists for: route params change, React reconciles the
    // same page component in place, and the old org's rows would otherwise
    // stay on screen
    const { table, render } = await mount({ data: makeRows(2, "org1") });
    expect(table().rows).toHaveLength(2);

    await render({ data: makeRows(5, "org2") });
    expect(table().rows).toHaveLength(5);
    expect(table().rows[0]?.name).toBe("org2-0");
  });

  test("re-rendering with the same array leaves row-keyed state alone", async () => {
    const rows = makeRows(3);
    const { table, render } = await mount({ data: rows });
    table().toggleRow(rows[0]!);

    await render({ data: rows });
    expect(table().selectedRows).toHaveLength(1);
  });

  test("a getter follows its observable source, whatever React does", async () => {
    const source = observable.box(makeRows(2));
    const rows = () => source.get();
    const { table, render } = await mount({ data: rows });
    expect(table().rows).toHaveLength(2);

    // no re-render involved — MobX decides here
    await act(async () => {
      runInAction(() => source.set(makeRows(4)));
    });
    expect(table().rows).toHaveLength(4);

    // and a re-render does not re-apply anything
    table().toggleRow(table().rows[0]!);
    await render({ data: rows });
    expect(table().selectedRows).toHaveLength(1);
  });

  test("the model's reactions are disposed with the component", async () => {
    const source = observable.box(makeRows(2));
    const { table, unmount } = await mount({ data: () => source.get() });
    const model = table();

    await unmount();
    runInAction(() => source.set(makeRows(9)));
    expect(model.rows).toHaveLength(2);
  });
});
