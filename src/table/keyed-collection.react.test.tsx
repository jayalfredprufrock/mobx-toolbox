// @vitest-environment happy-dom
import * as T from "typebox";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { autorun } from "mobx";
import { observer } from "mobx-react-lite";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { makeModel } from "../model/make-model";
import { makeStore } from "../model/make-store";
import { useCollection } from "../model/use-collection";
import { TableModel } from "./table.model";
import { useTable } from "./use-table";

const Schema = T.Object({ id: T.Number(), orgId: T.String(), title: T.String() });

const setup = (gate?: Promise<void>) => {
  const calls: string[] = [];
  const Survey = makeModel(Schema, { keys: ["id"] });
  const list = async ({ orgId }: { orgId: string }) => {
    calls.push(orgId);
    // the second key onward can be held open, so "still loading" is observable rather than a race
    if (gate && calls.length > 1) await gate;
    return [{ id: orgId === "acme" ? 1 : 2, orgId, title: `${orgId} row` }];
  };
  class Surveys extends makeStore(Survey) {
    byOrg = this.collectionMap(["orgId"], ({ orgId }, o) => list({ orgId, ...o }));
  }
  return { Survey, list, Surveys, calls };
};

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
});

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const mount = async (node: React.ReactNode) => {
  const c = document.createElement("div");
  document.body.appendChild(c);
  containers.push(c);
  const root = createRoot(c);
  await act(async () => {
    root.render(node);
  });
  return c;
};

const titles = (table: TableModel) =>
  table.rows.map((r) => (r as { title: string }).title).join(",");

describe("feeding a table from a parameterised collection", () => {
  // A `collectionMap` hands out a *different* lazy per key, so the table has to follow the new one
  // rather than keep reading the one it was built with.
  test("a keyed collection re-points the table when the key changes", async () => {
    const { Surveys, calls } = setup();
    const store = new Surveys();
    let setOrg: (v: string) => void = () => {};
    let table!: TableModel;

    const Probe = observer(() => {
      const [orgId, setter] = useState("acme");
      setOrg = setter;
      table = useTable({ rows: store.byOrg({ orgId }), getRowId: (r) => (r as { id: number }).id });
      return <span>{titles(table)}</span>;
    });

    const c = await mount(<Probe />);
    await tick();
    expect(c.textContent).toBe("acme row");

    await act(async () => setOrg("globex"));
    await tick();

    expect(c.textContent).toBe("globex row");
    expect(table.rows).toHaveLength(1);
    expect(calls).toEqual(["acme", "globex"]);
  });

  test("returning to a key refetches, because nothing was watching it in between", async () => {
    const { Surveys, calls } = setup();
    const store = new Surveys();
    let setOrg: (v: string) => void = () => {};

    const Probe = observer(() => {
      const [orgId, setter] = useState("acme");
      setOrg = setter;
      const table = useTable({ rows: store.byOrg({ orgId }) });
      return <span>{titles(table)}</span>;
    });

    const c = await mount(<Probe />);
    await tick();
    await act(async () => setOrg("globex"));
    await tick();
    await act(async () => setOrg("acme"));
    await tick();

    expect(c.textContent).toBe("acme row");
    // `keepOnUnobserved` defaults to false, so the acme list dropped its rows the moment the table
    // stopped reading it — coming back is a fresh load, exactly as a first one is. Pass
    // `keepOnUnobserved` on the collection to hold them instead.
    expect(calls).toEqual(["acme", "globex", "acme"]);
  });

  test("the loading states follow the new key too", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { Surveys } = setup(gate);
    const store = new Surveys();
    let setOrg: (v: string) => void = () => {};
    let table!: TableModel;

    const Probe = observer(() => {
      const [orgId, setter] = useState("acme");
      setOrg = setter;
      table = useTable({ rows: store.byOrg({ orgId }) });
      return <span>{titles(table)}</span>;
    });

    await mount(<Probe />);
    await tick();
    expect(table.loading).toBe(false);

    await act(async () => setOrg("globex"));
    // a key never fetched before has nothing yet, so this is a first load rather than a refresh
    expect(table.loading).toBe(true);
    expect(table.isEmpty).toBe(false);

    release();
    await tick();
    expect(table.loading).toBe(false);
  });

  // The component-scoped counterpart: one lazy whose params live in an observable box, so its
  // identity never changes and the table simply follows its contents.
  test("useCollection params keep one source, and the table follows its contents", async () => {
    const { Survey, list } = setup();
    let setOrg: (v: string) => void = () => {};
    const sources = new Set<unknown>();

    const Probe = observer(() => {
      const [orgId, setter] = useState("acme");
      setOrg = setter;
      const rows = useCollection(Survey, ({ orgId }, o) => list({ orgId, ...o }), {
        params: { orgId },
      });
      sources.add(rows);
      const table = useTable({ rows, getRowId: (r) => (r as { id: number }).id });
      return <span>{titles(table)}</span>;
    });

    const c = await mount(<Probe />);
    await tick();
    expect(c.textContent).toBe("acme row");

    await act(async () => setOrg("globex"));
    await tick();

    expect(c.textContent).toBe("globex row");
    // one lazy throughout — the params changed inside it rather than replacing it
    expect(sources.size).toBe(1);
  });

  test("selection survives a key change when getRowId is configured", async () => {
    const { Surveys } = setup();
    const store = new Surveys();
    let setOrg: (v: string) => void = () => {};
    let table!: TableModel;

    const Probe = observer(() => {
      const [orgId, setter] = useState("acme");
      setOrg = setter;
      table = useTable({ rows: store.byOrg({ orgId }), getRowId: (r) => (r as { id: number }).id });
      return <span>{titles(table)}</span>;
    });

    await mount(<Probe />);
    await tick();
    table.selectedIds.add(1);

    await act(async () => setOrg("globex"));
    await tick();

    // `setRows` intersects: an id that still resolves to a row survives, and one that does not
    // drops. Row 1 belongs to acme, so switching keys drops it rather than leaving a selection
    // pointing at nothing.
    expect([...table.selectedIds]).toEqual([]);
    expect(table.visibleSelectedRows).toHaveLength(0);
  });

  test("re-pointing at the binding already in place changes nothing", async () => {
    const { Surveys, calls } = setup();
    const store = new Surveys();
    const source = store.byOrg({ orgId: "acme" });
    const table = new TableModel({ rows: source });
    table.setWidth(600);
    table.setHeight(120);
    const stop = autorun(() => void table.filteredRows.length);
    await tick();

    const before = table.rows;
    table.setRowSource(source);
    await tick();

    // the same binding is not a change: no re-arm, no re-application, no second request
    expect(table.rows).toBe(before);
    expect(calls).toEqual(["acme"]);
    stop();
  });
});
