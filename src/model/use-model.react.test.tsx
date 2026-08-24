// @vitest-environment happy-dom
import * as T from "typebox";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { observer } from "mobx-react-lite";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { makeModel } from "./make-model";
import { makeStore } from "./make-store";
import { useModel } from "./use-model";

const StudySchema = T.Object({ id: T.Number(), orgId: T.String(), title: T.String() });

const setup = (config: { cache?: boolean } = {}) => {
  const get = vi.fn(
    async ({ id, orgId }: { id: number; orgId: string }, _o?: { signal: AbortSignal }) => ({
      id,
      orgId,
      title: `study ${id} of ${orgId}`,
    }),
  );
  const StudyModel = makeModel(StudySchema, {
    // keyed on both, so `params` is `{ id, orgId }` — the multi-param case that makes a
    // hand-written dependency array easy to get wrong
    keys: ["id", "orgId"],
    get,
    update: async (_p: { id: number; orgId: string }, body: { title: string }) => ({
      id: 1,
      orgId: "acme",
      title: body.title,
    }),
    ...config,
  });
  return { get, StudyModel };
};

const containers: HTMLElement[] = [];
afterEach(() => {
  for (const c of containers.splice(0)) c.remove();
});

const mount = async (node: React.ReactNode) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  containers.push(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
    },
  };
};

describe("useModel", () => {
  test("loads the record and renders it", async () => {
    const { get, StudyModel } = setup();
    const Probe = observer(() => {
      const study = useModel(StudyModel, { id: 1, orgId: "acme" });
      return <span>{study.value?.title ?? "loading"}</span>;
    });

    const { container } = await mount(<Probe />);
    await act(async () => {});

    expect(container.textContent).toBe("study 1 of acme");
    expect(get).toHaveBeenCalledOnce();
  });

  test("hands back the identity-mapped instance, so edits elsewhere show up", async () => {
    const { StudyModel } = setup();
    let seen!: any;
    const Probe = observer(() => {
      const study = useModel(StudyModel, { id: 1, orgId: "acme" });
      seen = study.value;
      return <span>{study.value?.title ?? "loading"}</span>;
    });

    const { container } = await mount(<Probe />);
    await act(async () => {});
    expect(seen).toBe(StudyModel.peek({ id: 1, orgId: "acme" }));

    // an edit made anywhere in the app lands on the same object
    await act(async () => {
      await seen.update({ title: "Renamed" });
    });
    expect(container.textContent).toBe("Renamed");
  });

  test("re-rendering with equal params does not refetch", async () => {
    const { get, StudyModel } = setup();
    let bump: (n: number) => void = () => {};

    const Probe = observer(() => {
      const [n, setN] = useState(0);
      bump = setN;
      // a new object every render, deliberately
      const study = useModel(StudyModel, { id: 1, orgId: "acme" });
      return <span>{`${n}:${study.value?.title ?? "loading"}`}</span>;
    });

    await mount(<Probe />);
    await act(async () => {});
    await act(async () => bump(1));
    await act(async () => bump(2));

    expect(get).toHaveBeenCalledOnce();
  });

  test("key order in the params object is not a change", async () => {
    const { get, StudyModel } = setup();
    let flip: (v: boolean) => void = () => {};

    const Probe = observer(() => {
      const [swapped, setSwapped] = useState(false);
      flip = setSwapped;
      const params = swapped ? { orgId: "acme", id: 1 } : { id: 1, orgId: "acme" };
      const study = useModel(StudyModel, params as any);
      return <span>{study.value?.title ?? "loading"}</span>;
    });

    await mount(<Probe />);
    await act(async () => {});
    await act(async () => flip(true));
    await act(async () => {});

    expect(get).toHaveBeenCalledOnce();
  });

  test("a param change loads the new record, and blanks rather than showing the old one", async () => {
    const { get, StudyModel } = setup();
    const seen: (string | undefined)[] = [];
    let setId: (n: number) => void = () => {};

    const Probe = observer(() => {
      const [id, setter] = useState(1);
      setId = setter;
      const study = useModel(StudyModel, { id, orgId: "acme" });
      seen.push(study.value?.title);
      return <span>{study.value?.title ?? "loading"}</span>;
    });

    const { container } = await mount(<Probe />);
    await act(async () => {});
    expect(container.textContent).toBe("study 1 of acme");

    await act(async () => setId(2));
    // the new lazy has nothing yet — study 1 is not shown in study 2's place
    expect(seen).toContain(undefined);
    expect(seen.indexOf(undefined, seen.indexOf("study 1 of acme"))).toBeGreaterThan(-1);

    await act(async () => {});
    expect(container.textContent).toBe("study 2 of acme");
    expect(get).toHaveBeenCalledTimes(2);
  });

  test("a param the deps array would have missed still refetches", async () => {
    const { get, StudyModel } = setup();
    let setOrg: (v: string) => void = () => {};

    const Probe = observer(() => {
      const [orgId, setter] = useState("acme");
      setOrg = setter;
      // the whole point: `orgId` is not restated anywhere, so it cannot be left out
      const study = useModel(StudyModel, { id: 1, orgId });
      return <span>{study.value?.title ?? "loading"}</span>;
    });

    const { container } = await mount(<Probe />);
    await act(async () => {});
    await act(async () => setOrg("globex"));
    await act(async () => {});

    expect(container.textContent).toBe("study 1 of globex");
    expect(get).toHaveBeenCalledTimes(2);
  });

  test("passes fetch options through, so a superseded request aborts", async () => {
    const aborted: boolean[] = [];
    const StudyModel = makeModel(StudySchema, {
      keys: ["id"],
      get: ({ id }: { id: number }, options?: { signal: AbortSignal }) =>
        new Promise<any>((resolve) => {
          options?.signal.addEventListener("abort", () => aborted.push(true));
          setTimeout(() => resolve({ id, orgId: "acme", title: `study ${id}` }), 0);
        }),
    });

    let setId: (n: number) => void = () => {};
    const Probe = observer(() => {
      const [id, setter] = useState(1);
      setId = setter;
      const study = useModel(StudyModel, { id });
      return <span>{study.value?.title ?? "loading"}</span>;
    });

    await mount(<Probe />);
    await act(async () => setId(2));
    await act(async () => {});

    expect(aborted.length).toBeGreaterThan(0);
  });

  test("honours the model's cache, so returning to a record costs no request", async () => {
    const { get, StudyModel } = setup({ cache: true });
    let setId: (n: number) => void = () => {};

    const Probe = observer(() => {
      const [id, setter] = useState(1);
      setId = setter;
      const study = useModel(StudyModel, { id, orgId: "acme" });
      return <span>{study.value?.title ?? "loading"}</span>;
    });

    const { container } = await mount(<Probe />);
    await act(async () => {});
    await act(async () => setId(2));
    await act(async () => {});
    expect(get).toHaveBeenCalledTimes(2);

    // back to a record already in the identity map
    await act(async () => setId(1));
    await act(async () => {});

    expect(container.textContent).toBe("study 1 of acme");
    expect(get).toHaveBeenCalledTimes(2);
  });

  test("shares instances with an app-wide store", async () => {
    const { StudyModel } = setup();
    class Studies extends makeStore(StudyModel) {
      all = this.collection(async () => [{ id: 1, orgId: "acme", title: "From the list" }]);
    }
    const store = new Studies();
    await store.all.getOrLoad();

    let seen!: any;
    const Probe = observer(() => {
      const study = useModel(StudyModel, { id: 1, orgId: "acme" });
      seen = study.value;
      return <span>{study.value?.title ?? "loading"}</span>;
    });

    await mount(<Probe />);
    await act(async () => {});

    expect(seen).toBe(store.all.value?.[0]);
  });

  test("unmounting drops the value; nothing needs disposing", async () => {
    const { StudyModel } = setup();
    let lazy!: any;
    const Probe = observer(() => {
      lazy = useModel(StudyModel, { id: 1, orgId: "acme" });
      return <span>{lazy.value?.title ?? "loading"}</span>;
    });

    const view = await mount(<Probe />);
    await act(async () => {});
    expect(lazy.loaded).toBe(true);

    await view.unmount();

    expect(lazy.loaded).toBe(false);
    expect(lazy.value).toBeUndefined();
  });
});
