// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { Observer } from "mobx-react-lite";
import { afterEach, describe, expect, test } from "vite-plus/test";
import * as T from "typebox";
import { useLazy, useLazyArray } from "./use-lazy";
import { useStable } from "../react-util/useStable";
import { makeModel } from "../model/make-model";

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
  return container;
};

// ---------------------------------------------------------------------------
// useStable
// ---------------------------------------------------------------------------

describe("useStable", () => {
  test("builds once and keeps the value across re-renders", async () => {
    let builds = 0;
    let bump: (n: number) => void = () => {};
    const seen: object[] = [];

    const Probe = () => {
      const [n, setN] = useState(0);
      bump = setN;
      const value = useStable(() => {
        builds++;
        return {};
      }, []);
      seen.push(value);
      return <span>{n}</span>;
    };

    await mount(<Probe />);
    await act(async () => bump(1));
    await act(async () => bump(2));

    expect(builds).toBe(1);
    expect(seen.every((v) => v === seen[0])).toBe(true);
  });

  test("rebuilds when a dep changes, and only then", async () => {
    let builds = 0;
    let setId: (n: number) => void = () => {};

    const Probe = () => {
      const [id, setter] = useState(1);
      setId = setter;
      useStable(() => {
        builds++;
        return {};
      }, [id]);
      return null;
    };

    await mount(<Probe />);
    expect(builds).toBe(1);

    await act(async () => setId(2));
    expect(builds).toBe(2);

    // same value — Object.is, exactly as React compares
    await act(async () => setId(2));
    expect(builds).toBe(2);
  });

  test("rebuilds when the deps list changes length", async () => {
    let builds = 0;
    let setExtra: (v: boolean) => void = () => {};

    const Probe = () => {
      const [extra, setter] = useState(false);
      setExtra = setter;
      useStable(
        () => {
          builds++;
          return {};
        },
        extra ? [1, 2] : [1],
      );
      return null;
    };

    await mount(<Probe />);
    await act(async () => setExtra(true));
    expect(builds).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// useLazy
// ---------------------------------------------------------------------------

describe("useLazy", () => {
  test("loads when the value is observed and renders it", async () => {
    const container = await mount(
      <Observer>
        {() => {
          const study = useLazy(async () => ({ name: "Study A" }), []);
          return <span>{study.value?.name ?? "loading"}</span>;
        }}
      </Observer>,
    );

    await act(async () => {});
    expect(container.textContent).toBe("Study A");
  });

  test("does not fetch until something observes it", async () => {
    let calls = 0;
    await mount(
      <Observer>
        {() => {
          useLazy(async () => {
            calls++;
            return 1;
          }, []);
          return <span>nothing read</span>;
        }}
      </Observer>,
    );

    await act(async () => {});
    expect(calls).toBe(0);
  });

  test("keeps one lazy across re-renders that don't change deps", async () => {
    let calls = 0;
    let bump: (n: number) => void = () => {};

    const Probe = () => {
      const [n, setN] = useState(0);
      bump = setN;
      return (
        <Observer>
          {() => {
            const lazy = useLazy(async () => {
              calls++;
              return n;
            }, []);
            return <span>{String(lazy.value)}</span>;
          }}
        </Observer>
      );
    };

    await mount(<Probe />);
    await act(async () => {});
    await act(async () => bump(1));
    await act(async () => bump(2));

    expect(calls).toBe(1);
  });

  test("builds a new lazy when deps change, so the value starts empty again", async () => {
    let setId: (n: number) => void = () => {};
    const seen: (string | undefined)[] = [];

    const Probe = () => {
      const [id, setter] = useState(1);
      setId = setter;
      return (
        <Observer>
          {() => {
            const study = useLazy(async () => `study ${id}`, [id]);
            seen.push(study.value);
            return <span>{study.value ?? "loading"}</span>;
          }}
        </Observer>
      );
    };

    const container = await mount(<Probe />);
    await act(async () => {});
    expect(container.textContent).toBe("study 1");

    await act(async () => setId(2));
    // the new lazy has nothing yet — the previous study is not shown in its place
    expect(seen).toContain(undefined);
    expect(seen.indexOf(undefined, seen.indexOf("study 1"))).toBeGreaterThan(-1);

    await act(async () => {});
    expect(container.textContent).toBe("study 2");
  });

  test("passes fetch options through, so a superseded request aborts", async () => {
    const aborted: number[] = [];
    const release: Array<() => void> = [];
    let setId: (n: number) => void = () => {};

    // Never settles on its own: resolving on a timer races the re-render, and a first request that
    // lands before the deps change leaves nothing to abort — which passes or fails on scheduling
    // rather than on behaviour.
    const Probe = () => {
      const [id, setter] = useState(1);
      setId = setter;
      return (
        <Observer>
          {() => {
            const lazy = useLazy(
              ({ signal }) =>
                new Promise<number>((resolve) => {
                  signal.addEventListener("abort", () => aborted.push(id));
                  release.push(() => resolve(id));
                }),
              [id],
            );
            return <span>{String(lazy.value)}</span>;
          }}
        </Observer>
      );
    };

    await mount(<Probe />);
    expect(aborted).toHaveLength(0); // still in flight, so there is something to supersede

    await act(async () => setId(2));

    // the first lazy is unobserved once replaced, which abandons its request — and it is that
    // one specifically, not merely "something aborted"
    expect(aborted).toEqual([1]);

    for (const settle of release) settle();
    await act(async () => {});
  });
});

// ---------------------------------------------------------------------------
// useLazyArray
// ---------------------------------------------------------------------------

describe("useLazyArray", () => {
  test("loads rows and renders them", async () => {
    const container = await mount(
      <Observer>
        {() => {
          const rows = useLazyArray(async () => ["a", "b"], []);
          return <span>{rows.value?.join(",") ?? "loading"}</span>;
        }}
      </Observer>,
    );

    await act(async () => {});
    expect(container.textContent).toBe("a,b");
  });

  test("keeps one array identity while the deps hold", async () => {
    let bump: (n: number) => void = () => {};
    const arrays: unknown[] = [];

    const Probe = () => {
      const [n, setN] = useState(0);
      bump = setN;
      return (
        <Observer>
          {() => {
            const rows = useLazyArray(async () => ["a"], []);
            // only once there is one — the point is that it never changes after that
            if (rows.value) arrays.push(rows.value);
            return <span>{n}</span>;
          }}
        </Observer>
      );
    };

    await mount(<Probe />);
    await act(async () => {});
    await act(async () => bump(1));

    expect(arrays.every((a) => a === arrays[0])).toBe(true);
  });

  test("a deps change ends that lazy's lifetime, so the array is a new one", async () => {
    let setId: (n: number) => void = () => {};
    const arrays: unknown[] = [];

    const Probe = () => {
      const [id, setter] = useState(1);
      setId = setter;
      return (
        <Observer>
          {() => {
            const rows = useLazyArray(async () => [`row ${id}`], [id]);
            if (rows.value) arrays.push(rows.value);
            return <span>{rows.value?.join(",") ?? "loading"}</span>;
          }}
        </Observer>
      );
    };

    const container = await mount(<Probe />);
    await act(async () => {});
    await act(async () => setId(2));
    await act(async () => {});

    expect(container.textContent).toBe("row 2");
    expect(new Set(arrays).size).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// useLazy over a cached model
// ---------------------------------------------------------------------------

describe("useLazy with a cached model", () => {
  const StudySchema = T.Object({ id: T.Number(), name: T.String() });

  test("returning to a record already loaded paints without a request", async () => {
    let calls = 0;
    const StudyModel = makeModel(StudySchema, {
      keys: ["id"],
      cache: true,
      // the second parameter is what lets the hook pass fetch options through, exactly as a real
      // api client would take them
      get: async ({ id }: { id: number }, _options?: { signal: AbortSignal }) => {
        calls++;
        return { id, name: `Study ${id}` };
      },
    });

    let setId: (n: number) => void = () => {};
    const Probe = () => {
      const [id, setter] = useState(1);
      setId = setter;
      return (
        <Observer>
          {() => {
            const study = useLazy((o) => StudyModel.get({ id }, o), [id]);
            return <span>{study.value?.name ?? "loading"}</span>;
          }}
        </Observer>
      );
    };

    const container = await mount(<Probe />);
    await act(async () => {});
    expect(container.textContent).toBe("Study 1");
    expect(calls).toBe(1);

    // a different record: new lazy, real request
    await act(async () => setId(2));
    await act(async () => {});
    expect(container.textContent).toBe("Study 2");
    expect(calls).toBe(2);

    // back to the first: the hook rebuilds its lazy, but cache answers the load
    await act(async () => setId(1));
    await act(async () => {});
    expect(container.textContent).toBe("Study 1");
    expect(calls).toBe(2);
  });
});
