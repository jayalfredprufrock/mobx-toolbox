// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { observer } from "mobx-react-lite";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import * as T from "typebox";
import { makeModel } from "./make-model";
import { createStore } from "./make-store";
import { useCollection } from "./use-collection";

const SurveySchema = T.Object({ id: T.Number(), orgId: T.String(), title: T.String() });

const rows = [
  { id: 1, orgId: "acme", title: "Alpha" },
  { id: 2, orgId: "globex", title: "Gamma" },
];

const setup = () => {
  const list = vi.fn(({ orgId }: { orgId: string }) =>
    Promise.resolve(rows.filter((r) => r.orgId === orgId).map((r) => ({ ...r }))),
  );
  const rename = vi.fn(({ id }: { id: number }, body: { title: string }) =>
    Promise.resolve({ ...rows.find((r) => r.id === id)!, ...body }),
  );
  const SurveyModel = makeModel(SurveySchema, { keys: ["id"] as const, update: rename });
  return { list, SurveyModel };
};

const containers: HTMLElement[] = [];
afterEach(() => {
  for (const c of containers.splice(0)) c.remove();
});

const render = async (Component: React.FunctionComponent<{ orgId: string }>, orgId: string) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  containers.push(container);
  const root = createRoot(container);

  const rerender = async (next: string) => {
    await act(async () => root.render(<Component orgId={next} />));
  };
  await rerender(orgId);

  return {
    container,
    rerender,
    unmount: async () => {
      await act(async () => root.unmount());
    },
  };
};

describe("useCollection", () => {
  test("loads with the component's params, and refetches when they change", async () => {
    const { list, SurveyModel } = setup();
    const Probe = observer(({ orgId }: { orgId: string }) => {
      const surveys = useCollection(
        SurveyModel,
        ({ orgId }, options) => list({ orgId, ...options }),
        { params: { orgId } },
      );
      return <span>{surveys.value.map((s) => s.title).join(",")}</span>;
    });

    const view = await render(Probe, "acme");
    await vi.waitUntil(() => view.container.textContent === "Alpha");
    expect(list).toHaveBeenCalledTimes(1);

    await view.rerender("globex");
    await vi.waitUntil(() => view.container.textContent === "Gamma");
    expect(list).toHaveBeenCalledTimes(2);

    await view.unmount();
  });

  test("re-rendering with equal params is not a param change", async () => {
    const { list, SurveyModel } = setup();
    const Probe = observer(({ orgId }: { orgId: string }) => {
      // A fresh params object every render — the hook has to see through that.
      const surveys = useCollection(
        SurveyModel,
        ({ orgId }, options) => list({ orgId, ...options }),
        { params: { orgId } },
      );
      return <span>{surveys.value.length}</span>;
    });

    const view = await render(Probe, "acme");
    await vi.waitUntil(() => view.container.textContent === "1");

    await view.rerender("acme");
    await view.rerender("acme");

    expect(list).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  test("the previous rows stay readable while the next set loads", async () => {
    const { SurveyModel } = setup();
    let release!: (value: any[]) => void;
    const list = vi.fn(
      ({ orgId }: { orgId: string }) =>
        new Promise<any[]>((resolve) => {
          if (orgId === "acme") resolve([{ id: 1, orgId: "acme", title: "Alpha" }]);
          else release = resolve;
        }),
    );

    let lazy!: any;
    const Probe = observer(({ orgId }: { orgId: string }) => {
      lazy = useCollection(SurveyModel, ({ orgId }, options) => list({ orgId, ...options }), {
        params: { orgId },
      });
      return <span>{lazy.value.map((s: any) => s.title).join(",")}</span>;
    });

    const view = await render(Probe, "acme");
    await vi.waitUntil(() => view.container.textContent === "Alpha");

    await view.rerender("globex");

    // Mid-flight: still showing acme's rows, reporting a request in flight rather than a load.
    expect(view.container.textContent).toBe("Alpha");
    expect(lazy.fetching).toBe(true);
    expect(lazy.loading).toBe(false);
    expect(lazy.status).toBe("loaded");

    await act(async () => release([{ id: 2, orgId: "globex", title: "Gamma" }]));
    expect(view.container.textContent).toBe("Gamma");

    await view.unmount();
  });

  test("without params the fetch takes the lazy's options alone", async () => {
    const { SurveyModel } = setup();
    const all = vi.fn((_options: { signal?: AbortSignal }) =>
      Promise.resolve(rows.map((r) => ({ ...r }))),
    );
    const Probe = observer(() => {
      const surveys = useCollection(SurveyModel, (options) => all(options));
      return <span>{surveys.value.length}</span>;
    });

    const view = await render(Probe, "acme");
    await vi.waitUntil(() => view.container.textContent === "2");
    expect(all).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  test("shares instances and mutations with an app-wide store", async () => {
    const { list, SurveyModel } = setup();
    const shared = createStore(SurveyModel, {
      collections: { all: () => Promise.resolve(rows.map((r) => ({ ...r }))) },
    });
    await shared.all.getOrLoad();

    let lazy!: any;
    const Probe = observer(({ orgId }: { orgId: string }) => {
      lazy = useCollection(SurveyModel, ({ orgId }, options) => list({ orgId, ...options }), {
        params: { orgId },
      });
      return <span>{lazy.value.map((s: any) => s.title).join(",")}</span>;
    });

    const view = await render(Probe, "acme");
    await vi.waitUntil(() => view.container.textContent === "Alpha");

    // Same record, same instance — identity is the model's, not the store's.
    const scoped = lazy.value[0];
    expect(scoped).toBe(shared.all.value.find((s) => s.id === 1));

    // ...so an edit made anywhere is on screen here.
    await act(async () => void (await scoped.update({ title: "Renamed" })));
    expect(view.container.textContent).toBe("Renamed");
    expect(shared.all.value.find((s) => s.id === 1)!.title).toBe("Renamed");

    await view.unmount();
  });

  test("unmounting drops the rows; nothing needs disposing", async () => {
    const { list, SurveyModel } = setup();
    let lazy!: any;
    const Probe = observer(({ orgId }: { orgId: string }) => {
      lazy = useCollection(SurveyModel, ({ orgId }, options) => list({ orgId, ...options }), {
        params: { orgId },
      });
      return <span>{lazy.value.map((s: any) => s.title).join(",")}</span>;
    });

    const view = await render(Probe, "acme");
    await vi.waitUntil(() => view.container.textContent === "Alpha");

    await view.unmount();

    // The model holds its listeners weakly, so the store is garbage once the component lets go —
    // and the list, still reachable from this test, has simply gone unobserved.
    expect(lazy.value).toHaveLength(0);
    expect(lazy.status).toBe("init");
  });
});
