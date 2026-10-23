// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { observable, runInAction } from "mobx";
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
          const study = useLazy(async () => ({ name: "Study A" }));
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
          });
          return <span>nothing read</span>;
        }}
      </Observer>,
    );

    await act(async () => {});
    expect(calls).toBe(0);
  });

  test("without params, one lazy for the component's lifetime", async () => {
    let calls = 0;
    let bump: (n: number) => void = () => {};

    const Probe = () => {
      const [n, setN] = useState(0);
      bump = setN;
      return (
        <Observer>
          {() => {
            const subject = useLazy(async () => {
              calls++;
              return n;
            });
            return <span>{String(subject.value)}</span>;
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

  test("a param change discards by default, so the value starts empty again", async () => {
    let setId: (n: number) => void = () => {};
    const seen: (string | undefined)[] = [];

    const Probe = () => {
      const [id, setter] = useState(1);
      setId = setter;
      return (
        <Observer>
          {() => {
            const study = useLazy(async ({ id }) => `study ${id}`, { params: { id } });
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

  test("a fresh but equal params object every render is not a change, in any key order", async () => {
    let calls = 0;
    let flip: (v: boolean) => void = () => {};

    const Probe = () => {
      const [flipped, setter] = useState(false);
      flip = setter;
      return (
        <Observer>
          {() => {
            const stats = useLazy(
              async ({ a, b }) => {
                calls++;
                return a + b;
              },
              { params: flipped ? { b: 2, a: 1 } : { a: 1, b: 2 } },
            );
            return <span>{String(stats.value)}</span>;
          }}
        </Observer>
      );
    };

    await mount(<Probe />);
    await act(async () => {});
    await act(async () => flip(true));
    await act(async () => {});

    expect(calls).toBe(1);
  });

  test("a discarding change returns to the seed, never the previous value", async () => {
    let setId: (n: number) => void = () => {};
    const seen: { id: number; value: string }[] = [];

    const Probe = () => {
      const [id, setter] = useState(1);
      setId = setter;
      return (
        <Observer>
          {() => {
            const study = useLazy(async ({ id }) => `study ${id}`, {
              params: { id },
              initialValue: "seed",
            });
            seen.push({ id, value: study.value });
            return <span>{study.value}</span>;
          }}
        </Observer>
      );
    };

    const container = await mount(<Probe />);
    await act(async () => {});
    await act(async () => setId(2));
    await act(async () => {});

    expect(container.textContent).toBe("study 2");
    // no render pairs the new params with the old value — not even one before an effect runs
    expect(seen.filter((s) => s.id === 2).map((s) => s.value)).not.toContain("study 1");
    expect(seen.filter((s) => s.id === 2).map((s) => s.value)).toContain("seed");
  });

  test("passes fetch options through, so a superseded request aborts", async () => {
    const aborted: number[] = [];
    const release: Array<() => void> = [];
    let setId: (n: number) => void = () => {};

    // Never settles on its own: resolving on a timer races the re-render, and a first request that
    // lands before the param change leaves nothing to abort — which passes or fails on scheduling
    // rather than on behaviour.
    const Probe = () => {
      const [id, setter] = useState(1);
      setId = setter;
      return (
        <Observer>
          {() => {
            const subject = useLazy(
              ({ id }, { signal }) =>
                new Promise<number>((resolve) => {
                  signal.addEventListener("abort", () => aborted.push(id));
                  release.push(() => resolve(id));
                }),
              { params: { id } },
            );
            return <span>{String(subject.value)}</span>;
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
// useLazy with params
// ---------------------------------------------------------------------------

describe("useLazy with discardOnChange: false", () => {
  test("refetches the same lazy when the params change, keeping the value", async () => {
    let setRange: (r: string) => void = () => {};
    const lazies: unknown[] = [];
    const seen: (string | undefined)[] = [];

    const Probe = () => {
      const [range, setter] = useState("week");
      setRange = setter;
      return (
        <Observer>
          {() => {
            const stats = useLazy(async ({ range }, _options) => `stats for ${range}`, {
              params: { range },
              discardOnChange: false,
            });
            lazies.push(stats);
            seen.push(stats.value);
            return <span>{stats.value ?? "loading"}</span>;
          }}
        </Observer>
      );
    };

    const container = await mount(<Probe />);
    await act(async () => {});
    expect(container.textContent).toBe("stats for week");

    const firstLoad = seen.indexOf("stats for week");
    await act(async () => setRange("month"));
    await act(async () => {});
    expect(container.textContent).toBe("stats for month");

    // one lazy throughout, and the previous value stayed readable while the next loaded
    expect(lazies.every((l) => l === lazies[0])).toBe(true);
    expect(seen.slice(firstLoad)).not.toContain(undefined);
  });

  test("a fresh but equal params object every render is not a change", async () => {
    let calls = 0;
    let bump: (n: number) => void = () => {};

    const Probe = () => {
      const [n, setN] = useState(0);
      bump = setN;
      return (
        <Observer>
          {() => {
            const stats = useLazy(
              async ({ range }) => {
                calls++;
                return range;
              },
              { params: { range: "week" }, discardOnChange: false },
            );
            return <span>{`${stats.value} ${n}`}</span>;
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

  test("a param change aborts the request it supersedes", async () => {
    const aborted: string[] = [];
    const release: Array<() => void> = [];
    let setRange: (r: string) => void = () => {};

    const Probe = () => {
      const [range, setter] = useState("week");
      setRange = setter;
      return (
        <Observer>
          {() => {
            const stats = useLazy(
              ({ range }, { signal }) =>
                new Promise<string>((resolve) => {
                  signal.addEventListener("abort", () => aborted.push(range));
                  release.push(() => resolve(range));
                }),
              { params: { range }, discardOnChange: false },
            );
            return <span>{String(stats.value)}</span>;
          }}
        </Observer>
      );
    };

    await mount(<Probe />);
    expect(aborted).toHaveLength(0);

    await act(async () => setRange("month"));
    expect(aborted).toEqual(["week"]);

    for (const settle of release) settle();
    await act(async () => {});
  });

  test("a seed applies once, and a param change refetches over what is held", async () => {
    let setRange: (r: string) => void = () => {};
    const seen: string[] = [];

    const Probe = () => {
      const [range, setter] = useState("week");
      setRange = setter;
      return (
        <Observer>
          {() => {
            const stats = useLazy(async ({ range }) => `stats for ${range}`, {
              params: { range },
              initialValue: "seed",
              discardOnChange: false,
            });
            seen.push(stats.value);
            return <span>{stats.value}</span>;
          }}
        </Observer>
      );
    };

    const container = await mount(<Probe />);
    await act(async () => {});
    await act(async () => setRange("month"));
    await act(async () => {});

    expect(container.textContent).toBe("stats for month");
    expect(seen.filter((v) => v === "seed").length).toBeGreaterThan(0);
    expect(seen.slice(seen.indexOf("stats for week"))).not.toContain("seed");
  });
});

// ---------------------------------------------------------------------------
// debounce
// ---------------------------------------------------------------------------

const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

describe("params are compared structurally", () => {
  // Each render rebuilds every param — fresh arrays, fresh nested objects, fresh Dates, keys in a
  // different order — so only a real difference in contents may count as a change.
  const setup = (discardOnChange: boolean) => {
    const calls: unknown[] = [];
    const lazies = new Set<unknown>();
    let rerender: (n: number) => void = () => {};
    let setIds: (ids: number[]) => void = () => {};

    const Probe = () => {
      const [n, setN] = useState(0);
      const [ids, setter] = useState([1, 2]);
      rerender = setN;
      setIds = setter;
      const params =
        n % 2
          ? { range: { to: new Date(2026, 0, 2), from: new Date(2026, 0, 1) }, ids: [...ids] }
          : { ids: [...ids], range: { from: new Date(2026, 0, 1), to: new Date(2026, 0, 2) } };
      return (
        <Observer>
          {() => {
            const result = useLazy(
              async (p) => {
                calls.push(p);
                return p.ids.join(",");
              },
              { params, discardOnChange },
            );
            lazies.add(result);
            return <span>{result.value ?? "loading"}</span>;
          }}
        </Observer>
      );
    };

    return {
      calls,
      lazies,
      Probe,
      rerender: (n: number) => rerender(n),
      setIds: (i: number[]) => setIds(i),
    };
  };

  for (const discardOnChange of [true, false]) {
    test(`${discardOnChange ? "discarding" : "keeping"}: equal contents are not a change; different ones are`, async () => {
      const { calls, lazies, Probe, rerender, setIds } = setup(discardOnChange);
      const container = await mount(<Probe />);
      await act(async () => {});

      await act(async () => rerender(1));
      await act(async () => rerender(2));
      await act(async () => {});
      expect(calls).toHaveLength(1);
      expect(lazies.size).toBe(1);

      await act(async () => setIds([1, 3]));
      await act(async () => {});
      expect(calls).toHaveLength(2);
      expect(container.textContent).toBe("1,3");
      expect(lazies.size).toBe(discardOnChange ? 2 : 1);
    });
  }

  test("debounce waits only for a structural change", async () => {
    const calls: number[][] = [];
    let current!: ReturnType<typeof useLazy<string>>;
    let rerender: (n: number) => void = () => {};

    const Probe = () => {
      const [n, setN] = useState(0);
      rerender = setN;
      return (
        <Observer>
          {() => {
            current = useLazy(
              async ({ ids }) => {
                calls.push(ids);
                return `${ids.length} ${n}`;
              },
              { params: { ids: [1, 2] }, discardOnChange: false, debounce: 10_000 },
            );
            return <span>{current.value}</span>;
          }}
        </Observer>
      );
    };

    await mount(<Probe />);
    await act(async () => {});
    expect(calls).toHaveLength(1);
    await act(async () => rerender(1));
    // a fresh array with the same ids is not a param change, so nothing is waiting either
    expect(current.fetching).toBe(false);

    // and a reload with those params goes straight out
    await act(async () => void (await current.reload()));
    expect(calls).toHaveLength(2);
  });
});

describe("useLazy keeping, without tracking the fetch", () => {
  test("an observable the fetch reads is not a reason to refetch — only params are", async () => {
    const tenant = observable.box("acme");
    let calls = 0;

    await mount(
      <Observer>
        {() => {
          const stats = useLazy(
            async ({ range }) => {
              calls++;
              return `${tenant.get()} ${range}`;
            },
            { params: { range: "week" }, discardOnChange: false },
          );
          return <span>{stats.value}</span>;
        }}
      </Observer>,
    );
    await act(async () => {});
    expect(calls).toBe(1);

    await act(async () => runInAction(() => tenant.set("globex")));
    await act(async () => {});
    expect(calls).toBe(1);
  });
});

describe("useLazy with debounce", () => {
  // A keeping search: the shape debounce is for.
  const setup = (debounce: number) => {
    const calls: string[] = [];
    const aborted: string[] = [];
    let setQ: (q: string) => void = () => {};
    let current!: ReturnType<typeof useLazy<string>>;

    const Probe = () => {
      const [q, setter] = useState("a");
      setQ = setter;
      return (
        <Observer>
          {() => {
            current = useLazy(
              async ({ q }, { signal }) => {
                calls.push(q);
                signal.addEventListener("abort", () => aborted.push(q));
                return `results for ${q}`;
              },
              { params: { q }, discardOnChange: false, debounce },
            );
            return <span>{current.value ?? "loading"}</span>;
          }}
        </Observer>
      );
    };

    return { calls, aborted, Probe, setQ: (q: string) => setQ(q), lazy: () => current };
  };

  test("the first load does not wait", async () => {
    const { calls, Probe } = setup(10_000);
    const container = await mount(<Probe />);
    await act(async () => {});

    expect(calls).toEqual(["a"]);
    expect(container.textContent).toBe("results for a");
  });

  test("a burst of changes costs one request, with the last params, once the burst pauses", async () => {
    const { calls, Probe, setQ, lazy } = setup(60);
    const container = await mount(<Probe />);
    await act(async () => {});

    await act(async () => setQ("ab"));
    await wait(30);
    await act(async () => setQ("abc"));
    await wait(30);
    // 60ms since the first change, but only 30 since the last: the wait restarted
    expect(calls).toEqual(["a"]);

    // a request is on its way the whole time, so an indicator can show
    expect(lazy().fetching).toBe(true);
    expect(container.textContent).toBe("results for a");

    await wait(60);
    expect(calls).toEqual(["a", "abc"]);
    expect(container.textContent).toBe("results for abc");
    expect(lazy().fetching).toBe(false);
  });

  test("a reload during the wait goes straight out, with the new params", async () => {
    const { calls, Probe, setQ, lazy } = setup(10_000);
    await mount(<Probe />);
    await act(async () => {});

    await act(async () => setQ("ab"));
    expect(calls).toEqual(["a"]);

    await act(async () => void (await lazy().reload()));
    expect(calls).toEqual(["a", "ab"]);
  });

  test("unmounting during the wait abandons the request before it is sent", async () => {
    const { calls, Probe, setQ } = setup(40);
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);
    await act(async () => root.render(<Probe />));
    await act(async () => {});

    await act(async () => setQ("ab"));
    await act(async () => root.unmount());
    await wait(80);

    expect(calls).toEqual(["a"]);
  });

  test("with discard, a rebuilt lazy waits, empty and fetching, while the first mount does not", async () => {
    const calls: number[] = [];
    let setId: (n: number) => void = () => {};
    let current!: ReturnType<typeof useLazy<string>>;

    const Probe = () => {
      const [id, setter] = useState(1);
      setId = setter;
      return (
        <Observer>
          {() => {
            current = useLazy(
              async ({ id }) => {
                calls.push(id);
                return `study ${id}`;
              },
              { params: { id }, debounce: 40 },
            );
            return <span>{current.value ?? "loading"}</span>;
          }}
        </Observer>
      );
    };

    const container = await mount(<Probe />);
    await act(async () => {});
    expect(calls).toEqual([1]);

    await act(async () => setId(2));
    expect(container.textContent).toBe("loading");
    expect(current.fetching).toBe(true);
    expect(calls).toEqual([1]);

    await wait(80);
    expect(calls).toEqual([1, 2]);
    expect(container.textContent).toBe("study 2");
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
          const rows = useLazyArray(async () => ["a", "b"]);
          return <span>{rows.value?.join(",") ?? "loading"}</span>;
        }}
      </Observer>,
    );

    await act(async () => {});
    expect(container.textContent).toBe("a,b");
  });

  test("keeps one array identity while the params hold", async () => {
    let bump: (n: number) => void = () => {};
    const arrays: unknown[] = [];

    const Probe = () => {
      const [n, setN] = useState(0);
      bump = setN;
      return (
        <Observer>
          {() => {
            const rows = useLazyArray(async () => ["a"]);
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

  test("a discarding param change ends that lazy's lifetime, so the array is a new one", async () => {
    let setId: (n: number) => void = () => {};
    const arrays: unknown[] = [];

    const Probe = () => {
      const [id, setter] = useState(1);
      setId = setter;
      return (
        <Observer>
          {() => {
            const rows = useLazyArray(async ({ id }) => [`row ${id}`], { params: { id } });
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

describe("useLazyArray with discardOnChange: false", () => {
  test("refetches into the same array, with rows readable throughout", async () => {
    let setQ: (q: string) => void = () => {};
    const arrays: unknown[] = [];
    const texts: string[] = [];

    const Probe = () => {
      const [q, setter] = useState("a");
      setQ = setter;
      return (
        <Observer>
          {() => {
            const rows = useLazyArray(async ({ q }, _options) => [`${q}1`, `${q}2`], {
              params: { q },
              discardOnChange: false,
            });
            if (rows.value) arrays.push(rows.value);
            const text = rows.value?.join(",") ?? "loading";
            texts.push(text);
            return <span>{text}</span>;
          }}
        </Observer>
      );
    };

    const container = await mount(<Probe />);
    await act(async () => {});
    expect(container.textContent).toBe("a1,a2");

    await act(async () => setQ("b"));
    await act(async () => {});
    expect(container.textContent).toBe("b1,b2");

    expect(arrays.every((a) => a === arrays[0])).toBe(true);
    expect(texts.slice(texts.indexOf("a1,a2"))).not.toContain("loading");
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
            const study = useLazy(({ id }, o) => StudyModel.get({ id }, o), { params: { id } });
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
