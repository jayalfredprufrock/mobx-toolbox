import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { autorun, isObservable, isObservableArray, observable, reaction, runInAction } from "mobx";
import { lazyObservable, lazyObservableArray } from "./lazy-observable";

// ---------------------------------------------------------------------------
// lazyObservable
// ---------------------------------------------------------------------------

describe("lazyObservable", () => {
  let disposeList: (() => void)[] = [];

  // Helper that observes a lazy observable and tracks the dispose function.
  const observe = (fn: () => unknown) => {
    const dispose = autorun(fn);
    disposeList.push(dispose);
    return dispose;
  };

  afterEach(() => {
    for (const dispose of disposeList) dispose();
    disposeList = [];
    vi.restoreAllMocks();
  });

  test("starts in init status with undefined value", () => {
    const lazy = lazyObservable(() => Promise.resolve(42));
    expect(lazy.loaded).toBe(false);
    expect(lazy.fetching).toBe(false);
    expect(lazy.value).toBeUndefined();
    expect(lazy.loading).toBe(false);
    expect(lazy.loaded).toBe(false);
  });

  test("uses provided initialValue before loading", () => {
    const lazy = lazyObservable(() => Promise.resolve(42), { initialValue: 0 });
    expect(lazy.value).toBe(0);
  });

  // Load-on-observe is deferred by a microtask so it never mutates state inside the render pass of
  // the component that triggered it — see `scheduleLoad`. These three tests pin that contract.

  test("transitions to loading a microtask after being first observed", async () => {
    const fetchFn = vi.fn().mockResolvedValue(42);
    const lazy = lazyObservable(fetchFn);

    observe(() => void lazy.value);

    // still untouched in the synchronous turn that observed it
    expect(lazy.loaded).toBe(false);
    expect(lazy.fetching).toBe(false);
    expect(lazy.loading).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();

    await Promise.resolve();

    expect(lazy.loading).toBe(true);
    expect(lazy.loading).toBe(true);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  test("skips the deferred load when unobserved again before it runs", async () => {
    const fetchFn = vi.fn().mockResolvedValue(42);
    const lazy = lazyObservable(fetchFn);

    const dispose = observe(() => void lazy.value);
    dispose(); // gone within the same turn, e.g. a component that mounted and immediately unmounted
    disposeList = disposeList.filter((d) => d !== dispose);

    await Promise.resolve();

    expect(fetchFn).not.toHaveBeenCalled();
    expect(lazy.loaded).toBe(false);
    expect(lazy.fetching).toBe(false);
  });

  test("an explicit getOrLoad still loads synchronously and is not double-fetched", async () => {
    const fetchFn = vi.fn().mockResolvedValue(42);
    const lazy = lazyObservable(fetchFn);

    observe(() => void lazy.value);
    // imperative calls are never in a render pass, so they are not deferred
    const promise = lazy.getOrLoad();
    expect(lazy.loading).toBe(true);
    expect(fetchFn).toHaveBeenCalledOnce();

    await promise;
    await Promise.resolve();

    // the queued microtask sees a non-init status and stands down
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(lazy.value).toBe(42);
  });

  test("loads value when observed", async () => {
    const lazy = lazyObservable(() => Promise.resolve(42));
    observe(() => void lazy.value);

    await lazy.getOrLoad();

    expect(lazy.value).toBe(42);
    expect(lazy.loaded).toBe(true);
    expect(lazy.loaded).toBe(true);
    expect(lazy.loading).toBe(false);
  });

  test("only calls fetch once for multiple observers", async () => {
    const fetchFn = vi.fn().mockResolvedValue(42);
    const lazy = lazyObservable(fetchFn);

    observe(() => void lazy.value);
    observe(() => void lazy.loaded);

    await lazy.getOrLoad();

    expect(fetchFn).toHaveBeenCalledOnce();
  });

  test("getOrLoad returns immediately when already loaded", async () => {
    const fetchFn = vi.fn().mockResolvedValue(42);
    const lazy = lazyObservable(fetchFn);
    observe(() => void lazy.value);

    await lazy.getOrLoad();
    await lazy.getOrLoad(); // second call

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(lazy.value).toBe(42);
  });

  test("set() updates value and marks loaded without fetching", () => {
    const fetchFn = vi.fn().mockResolvedValue(99);
    const lazy = lazyObservable(fetchFn);

    runInAction(() => lazy.set(42));

    expect(lazy.value).toBe(42);
    expect(lazy.loaded).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("reload() re-fetches and updates value", async () => {
    let callCount = 0;
    const lazy = lazyObservable(() => Promise.resolve(++callCount * 10));
    observe(() => void lazy.value);

    await lazy.getOrLoad();
    expect(lazy.value).toBe(10);

    await lazy.reload();
    expect(lazy.value).toBe(20);
  });

  test("invalidate({ discard: true }) restores the initial state", async () => {
    const lazy = lazyObservable(() => Promise.resolve(42));
    await lazy.getOrLoad();

    lazy.invalidate({ discard: true });

    expect(lazy.loaded).toBe(false);
    expect(lazy.fetching).toBe(false);
    expect(lazy.value).toBeUndefined();
  });

  test("invalidate() keeps the current value by default", async () => {
    const lazy = lazyObservable(() => Promise.resolve(42));
    await lazy.getOrLoad();

    lazy.invalidate();

    expect(lazy.value).toBe(42);
    expect(lazy.loaded).toBe(true);
  });

  test("records error status on async fetch rejection", async () => {
    const err = new Error("network error");
    const fetchFn = vi.fn().mockRejectedValue(err);
    const lazy = lazyObservable(fetchFn);
    observe(() => void lazy.value);

    try {
      await lazy.getOrLoad();
    } catch {}

    expect(lazy.error).toBeDefined();
    expect(lazy.error).toBe(err);
  });

  test("records error status when fetch throws synchronously", async () => {
    const err = new Error("sync error");
    const lazy = lazyObservable(() => {
      throw err;
    });
    observe(() => void lazy.value);

    try {
      await lazy.getOrLoad();
    } catch {}

    expect(lazy.error).toBeDefined();
    expect(lazy.error).toBe(err);
  });

  test("deep: false stores the value as-is, without converting it", async () => {
    const source = { a: 1 };
    const lazy = lazyObservable(() => Promise.resolve(source), { deep: false });
    observe(() => void lazy.value);
    await lazy.getOrLoad();

    expect(lazy.value).toBe(source);
    expect(isObservable(lazy.value)).toBe(false);
  });

  test("deep defaults to true, converting the value", async () => {
    const lazy = lazyObservable(() => Promise.resolve({ a: 1 }));
    observe(() => void lazy.value);
    await lazy.getOrLoad();

    expect(lazy.value).toEqual({ a: 1 });
    expect(isObservable(lazy.value)).toBe(true);
  });

  test("keepOnUnobserved: true keeps value after unobserve", async () => {
    const lazy = lazyObservable(() => Promise.resolve(42), { keepOnUnobserved: true });
    const dispose = observe(() => void lazy.value);
    await lazy.getOrLoad();

    dispose();
    disposeList = disposeList.filter((d) => d !== dispose);

    expect(lazy.loaded).toBe(true);
    expect(lazy.value).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// lazyObservableArray
// ---------------------------------------------------------------------------

describe("lazyObservableArray", () => {
  let disposeList: (() => void)[] = [];

  afterEach(() => {
    for (const dispose of disposeList) dispose();
    disposeList = [];
  });

  const observe = (fn: () => unknown) => {
    const dispose = autorun(fn);
    disposeList.push(dispose);
    return dispose;
  };

  test("holds nothing until a load lands — not an empty array", () => {
    const lazy = lazyObservableArray(() => Promise.resolve([1, 2, 3]));

    // `[]` would be a claim there are zero rows, which is not what is known yet
    expect(lazy.value).toBeUndefined();
    expect(lazy.loaded).toBe(false);
  });

  test("an explicit initialValue is loaded from the start, and still owed a fetch", async () => {
    const lazy = lazyObservableArray(() => Promise.resolve([1, 2, 3]), {
      initialValue: [9],
    });

    // seeded: there is something to render immediately
    expect(lazy.value).toEqual([9]);
    expect(lazy.loaded).toBe(true);
    // ...but nothing has been fetched, which is what `fetchedAt` records
    expect(lazy.fetchedAt).toBeUndefined();

    // and the seed does not suppress the load — it is a starting point, not an answer
    observe(() => void lazy.value);
    await vi.waitUntil(() => lazy.fetchedAt !== undefined);
    expect(lazy.value).toEqual([1, 2, 3]);
  });

  test("an explicit undefined initialValue is the same as none", () => {
    const lazy = lazyObservableArray(() => Promise.resolve([1, 2, 3]), {
      initialValue: undefined,
    });
    expect(lazy.value).toBeUndefined();
    expect(lazy.loaded).toBe(false);
  });

  test("loads array when observed", async () => {
    const lazy = lazyObservableArray(() => Promise.resolve([1, 2, 3]));
    observe(() => void lazy.value);

    await lazy.getOrLoad();

    expect(lazy.value).toEqual([1, 2, 3]);
    expect(lazy.loaded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// invalidate
// ---------------------------------------------------------------------------

describe("invalidate", () => {
  let disposeList: (() => void)[] = [];

  const observe = (fn: () => unknown) => {
    const dispose = autorun(fn);
    disposeList.push(dispose);
    return dispose;
  };

  afterEach(() => {
    for (const dispose of disposeList) dispose();
    disposeList = [];
    vi.restoreAllMocks();
  });

  test("reloads immediately while observed", async () => {
    let count = 0;
    const lazy = lazyObservable(() => Promise.resolve(++count));
    observe(() => void lazy.value);
    await vi.waitUntil(() => lazy.loaded);
    expect(lazy.value).toBe(1);

    lazy.invalidate();
    await vi.waitUntil(() => lazy.value === 2);
    expect(lazy.loaded).toBe(true);
  });

  test("drops the value without fetching when unobserved, then loads on next observation", async () => {
    const fetch = vi.fn().mockResolvedValue(42);
    const lazy = lazyObservable(fetch, { keepOnUnobserved: true });
    await lazy.getOrLoad();
    expect(lazy.value).toBe(42);

    lazy.invalidate({ discard: true });
    expect(lazy.loaded).toBe(false);
    expect(lazy.fetching).toBe(false);
    expect(lazy.value).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);

    observe(() => void lazy.value);
    await vi.waitUntil(() => lazy.loaded);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("loads regardless of observation while a caller is awaiting a value", async () => {
    let count = 0;
    const lazy = lazyObservable(() => Promise.resolve(++count));
    const promise = lazy.getOrLoad();
    lazy.invalidate();

    // nothing observes this lazy, but someone is awaiting it — that is demand, not staleness
    await expect(promise).resolves.toBe(2);
    expect(lazy.value).toBe(2);
  });

  test("a failed reload surfaces on error rather than as an unhandled rejection", async () => {
    let attempt = 0;
    const lazy = lazyObservable(() => {
      attempt++;
      return attempt === 1 ? Promise.resolve(1) : Promise.reject(new Error("boom"));
    });
    observe(() => void lazy.value);
    await vi.waitUntil(() => lazy.loaded);

    lazy.invalidate();
    await vi.waitUntil(() => lazy.error !== undefined);
    expect((lazy.error as Error).message).toBe("boom");
  });
});

// ---------------------------------------------------------------------------
// Regressions — each of these was a confirmed bug in the edge-triggered core
// ---------------------------------------------------------------------------

describe("regressions", () => {
  let disposeList: (() => void)[] = [];

  const observe = (fn: () => unknown) => {
    const dispose = autorun(fn);
    disposeList.push(dispose);
    return dispose;
  };

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  afterEach(() => {
    for (const dispose of disposeList) dispose();
    disposeList = [];
    vi.restoreAllMocks();
  });

  test("a consumer reading status does not blank a sibling reading value when it unmounts", async () => {
    let calls = 0;
    const lazy = lazyObservable(() => Promise.resolve(++calls));
    const rendered: unknown[] = [];

    // A reads all three boxes (a spinner), B reads only the value (a list)
    const a = observe(() => {
      void lazy.loaded;
      void lazy.error;
      void lazy.value;
    });
    observe(() => rendered.push(lazy.value));
    await vi.waitUntil(() => lazy.loaded);

    a();
    disposeList = disposeList.filter((d) => d !== a);
    await tick();

    expect(lazy.observed).toBe(true);
    expect(lazy.loaded).toBe(true);
    expect(lazy.value).toBe(1);
    expect(rendered).toEqual([undefined, 1]);
    expect(calls).toBe(1);
  });

  test("observed is accurate for any mix of observed boxes", () => {
    const lazy = lazyObservable(() => Promise.resolve(1));
    expect(lazy.observed).toBe(false);

    const a = observe(() => void lazy.loaded);
    const b = observe(() => void lazy.value);
    expect(lazy.observed).toBe(true);

    a();
    disposeList = disposeList.filter((d) => d !== a);
    expect(lazy.observed).toBe(true);

    b();
    disposeList = disposeList.filter((d) => d !== b);
    expect(lazy.observed).toBe(false);
  });

  test("a superseded fetch cannot overwrite a newer one", async () => {
    const filter = observable.box("a");
    const inflight: { key: string; resolve: (value: string) => void }[] = [];
    const lazy = lazyObservable<string>(
      () =>
        new Promise((resolve) => {
          inflight.push({ key: filter.get(), resolve });
        }),
      { trackDependencies: true },
    );
    observe(() => void lazy.value);
    await tick();

    runInAction(() => filter.set("b"));
    await tick();
    expect(inflight.map((r) => r.key)).toEqual(["a", "b"]);

    inflight[1]!.resolve("result-for-b"); // newer request lands first
    await tick();
    inflight[0]!.resolve("result-for-a"); // superseded request lands second
    await tick();

    expect(lazy.value).toBe("result-for-b");
  });

  test("set() wins over an in-flight fetch and resolves the pending promise", async () => {
    let resolveFetch!: (value: string) => void;
    const lazy = lazyObservable<string>(() => new Promise((r) => (resolveFetch = r)));
    const promise = lazy.getOrLoad();

    lazy.set("set-by-hand");
    resolveFetch("from-fetch");
    await tick();

    expect(lazy.value).toBe("set-by-hand");
    await expect(promise).resolves.toBe("set-by-hand");
  });

  test("reload() starts a fresh fetch even while one is in flight", async () => {
    let calls = 0;
    const resolvers: ((value: number) => void)[] = [];
    const lazy = lazyObservable<number>(() => {
      calls++;
      return new Promise((r) => resolvers.push(r));
    });

    void lazy.getOrLoad();
    const promise = lazy.reload();
    expect(calls).toBe(2);

    resolvers[0]!(1); // the abandoned first request
    resolvers[1]!(2);
    await expect(promise).resolves.toBe(2);
    expect(lazy.value).toBe(2);
  });

  test("getOrLoad() joins a load already in flight instead of starting another", async () => {
    let calls = 0;
    const lazy = lazyObservable(() => {
      calls++;
      return Promise.resolve(42);
    });

    const [a, b] = await Promise.all([lazy.getOrLoad(), lazy.getOrLoad()]);
    expect([a, b]).toEqual([42, 42]);
    expect(calls).toBe(1);
  });
});

describe("regressions — demand", () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  test("an awaited getOrLoad still settles when the lazy unobserves mid-flight", async () => {
    let calls = 0;
    const resolvers: ((value: number) => void)[] = [];
    const lazy = lazyObservable<number>(() => {
      calls++;
      return new Promise((r) => resolvers.push(r));
    });

    const dispose = autorun(() => void lazy.value);
    await tick();
    const promise = lazy.getOrLoad();

    dispose(); // the last observer leaves, abandoning the in-flight request
    resolvers[0]!(1); // the abandoned request lands and is discarded

    // the awaiting caller is demand: a fresh load was started for them
    expect(calls).toBe(2);
    resolvers[1]!(2);
    await expect(promise).resolves.toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Aborting superseded requests
// ---------------------------------------------------------------------------

describe("abort", () => {
  let disposeList: (() => void)[] = [];

  const observe = (fn: () => unknown) => {
    const dispose = autorun(fn);
    disposeList.push(dispose);
    return dispose;
  };

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  afterEach(() => {
    for (const dispose of disposeList) dispose();
    disposeList = [];
    vi.restoreAllMocks();
  });

  // A fetcher that records every signal it was handed and never resolves on its own.
  const controllable = <T>() => {
    const signals: AbortSignal[] = [];
    const resolvers: ((value: T) => void)[] = [];
    const fetch = ({ signal }: { signal: AbortSignal }) =>
      new Promise<T>((resolve) => {
        signals.push(signal);
        resolvers.push(resolve);
      });
    return { fetch, signals, resolvers };
  };

  test("reload() aborts the request it supersedes", async () => {
    const { fetch, signals, resolvers } = controllable<number>();
    const lazy = lazyObservable(fetch);

    void lazy.getOrLoad();
    const promise = lazy.reload();

    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);

    resolvers[1]!(2);
    await expect(promise).resolves.toBe(2);
    expect(lazy.loaded).toBe(true);
  });

  test("a dependency change aborts the previous request", async () => {
    const filter = observable.box("a");
    const signals: AbortSignal[] = [];
    const lazy = lazyObservable<string>(
      ({ signal }) => {
        const key = filter.get();
        signals.push(signal);
        return new Promise(() => {
          void key;
        });
      },
      { trackDependencies: true },
    );
    observe(() => void lazy.value);
    await tick();

    runInAction(() => filter.set("b"));
    await tick();

    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
  });

  test("set() aborts an in-flight request", () => {
    const { fetch, signals } = controllable<string>();
    const lazy = lazyObservable(fetch);
    void lazy.getOrLoad();

    lazy.set("mine");

    expect(signals[0]!.aborted).toBe(true);
    expect(lazy.value).toBe("mine");
  });

  test("invalidate() aborts an in-flight request", async () => {
    const { fetch, signals } = controllable<number>();
    const lazy = lazyObservable(fetch);
    observe(() => void lazy.value);
    await tick();

    lazy.invalidate();
    await tick();

    expect(signals[0]!.aborted).toBe(true);
    // still observed, so a fresh request took its place
    expect(signals).toHaveLength(2);
    expect(signals[1]!.aborted).toBe(false);
  });

  test("going unobserved aborts an in-flight request", async () => {
    const { fetch, signals } = controllable<number>();
    const lazy = lazyObservable(fetch);
    const dispose = observe(() => void lazy.value);
    await tick();
    expect(signals[0]!.aborted).toBe(false);

    dispose();
    disposeList = disposeList.filter((d) => d !== dispose);

    expect(signals[0]!.aborted).toBe(true);
  });

  test("an aborted request never writes error state", async () => {
    const signals: AbortSignal[] = [];
    const lazy = lazyObservable<number>(
      ({ signal }) =>
        new Promise((resolve, reject) => {
          signals.push(signal);
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    );
    observe(() => void lazy.value);
    await tick();

    lazy.invalidate();
    await tick();
    await tick();

    expect(signals[0]!.aborted).toBe(true);
    expect(lazy.error).toBeUndefined();
    expect(lazy.loading).toBe(true);
  });

  test("a successful request leaves its signal unaborted", async () => {
    const seen: AbortSignal[] = [];
    const lazy = lazyObservable(({ signal }) => {
      seen.push(signal);
      return Promise.resolve(42);
    });
    await lazy.getOrLoad();

    expect(lazy.value).toBe(42);
    expect(seen[0]!.aborted).toBe(false);
  });
});

describe("regressions — atomic writes", () => {
  test("an observer never sees a half-applied state", async () => {
    const lazy = lazyObservable(() => Promise.resolve(42));
    await lazy.getOrLoad();

    const pairs: string[] = [];
    const dispose = autorun(() => pairs.push(`${lazy.loaded}/${String(lazy.value)}`));
    pairs.length = 0;

    lazy.invalidate({ discard: true });

    // one atomic transition — `loaded` and `value` are never observed disagreeing, which is the
    // whole reason they are two getters over one pair of boxes rather than independent state
    expect(pairs).toEqual(["false/undefined"]);
    dispose();
  });

  test("a full load cycle notifies a value consumer exactly once", async () => {
    const lazy = lazyObservable(() => Promise.resolve(42));
    let runs = 0;
    const dispose = autorun(() => {
      void lazy.value;
      void lazy.loaded;
      void lazy.error;
      runs++;
    });

    await vi.waitUntil(() => lazy.loaded);
    // Starting the request changes none of these — there is still no value, still no error — so a
    // consumer that renders from the value alone re-renders once, when the value lands, rather
    // than a second time for a transition that showed it nothing.
    expect(runs).toBe(2); // its own first run, plus the one that mattered
    dispose();
  });

  test("a consumer that watches `fetching` does see the request start", async () => {
    const lazy = lazyObservable(() => Promise.resolve(42));
    const seen: boolean[] = [];
    const dispose = autorun(() => {
      void lazy.value;
      seen.push(lazy.fetching);
    });

    await vi.waitUntil(() => lazy.loaded);
    // false (nothing yet) → true (in flight) → false (landed): the extra notification is there for
    // anyone who asked for it, which is what keeps it off everyone who did not.
    expect(seen).toEqual([false, true, false]);
    dispose();
  });
});

// ---------------------------------------------------------------------------
// Refreshing without blanking
// ---------------------------------------------------------------------------

describe("fetching", () => {
  let disposeList: (() => void)[] = [];

  const observe = (fn: () => unknown) => {
    const dispose = autorun(fn);
    disposeList.push(dispose);
    return dispose;
  };

  afterEach(() => {
    for (const dispose of disposeList) dispose();
    disposeList = [];
    vi.restoreAllMocks();
  });

  test("a first load is both loading and fetching", async () => {
    let resolveFetch!: (value: number) => void;
    const lazy = lazyObservable<number>(() => new Promise((r) => (resolveFetch = r)));
    const promise = lazy.getOrLoad();

    expect(lazy.fetching).toBe(true);
    expect(lazy.loading).toBe(true);
    expect(lazy.loaded).toBe(false);

    resolveFetch(42);
    await promise;
    expect(lazy.fetching).toBe(false);
    expect(lazy.loading).toBe(false);
  });

  test("a refresh keeps the value readable and only sets fetching", async () => {
    let resolveFetch!: (value: number) => void;
    let calls = 0;
    const lazy = lazyObservable<number>(() => {
      calls++;
      return calls === 1 ? Promise.resolve(1) : new Promise((r) => (resolveFetch = r));
    });
    observe(() => void lazy.value);
    await vi.waitUntil(() => lazy.loaded);

    lazy.invalidate();
    await vi.waitUntil(() => lazy.fetching);

    // the old rows stay on screen while the new ones are in flight
    expect(lazy.value).toBe(1);
    expect(lazy.loaded).toBe(true);
    expect(lazy.loaded).toBe(true);
    expect(lazy.loading).toBe(false);

    resolveFetch(2);
    await vi.waitUntil(() => lazy.value === 2);
    expect(lazy.fetching).toBe(false);
  });

  test("an observer never sees the value blank during a default invalidate", async () => {
    let calls = 0;
    const lazy = lazyObservable(() => Promise.resolve(++calls));
    const rendered: unknown[] = [];
    observe(() => rendered.push(lazy.value));
    await vi.waitUntil(() => lazy.loaded);
    expect(rendered).toEqual([undefined, 1]);

    lazy.invalidate();
    await vi.waitUntil(() => lazy.value === 2);

    // straight from the old value to the new one — no undefined in between
    expect(rendered).toEqual([undefined, 1, 2]);
  });

  test("reload() also keeps the previous value readable", async () => {
    let resolveFetch!: (value: number) => void;
    let calls = 0;
    const lazy = lazyObservable<number>(() => {
      calls++;
      return calls === 1 ? Promise.resolve(1) : new Promise((r) => (resolveFetch = r));
    });
    await lazy.getOrLoad();

    const promise = lazy.reload();
    expect(lazy.value).toBe(1);
    expect(lazy.loaded).toBe(true);
    expect(lazy.fetching).toBe(true);

    resolveFetch(2);
    await expect(promise).resolves.toBe(2);
  });

  test("a failed refresh reports the error but leaves the value readable", async () => {
    let calls = 0;
    const lazy = lazyObservable(() => {
      calls++;
      return calls === 1 ? Promise.resolve(1) : Promise.reject(new Error("boom"));
    });
    observe(() => void lazy.value);
    await vi.waitUntil(() => lazy.loaded);

    lazy.invalidate();
    await vi.waitUntil(() => lazy.error !== undefined);

    expect((lazy.error as Error).message).toBe("boom");
    expect(lazy.value).toBe(1);
    expect(lazy.fetching).toBe(false);
  });

  test("discard clears the value and reports a fresh load", async () => {
    let resolveFetch!: (value: number) => void;
    let calls = 0;
    const lazy = lazyObservable<number>(() => {
      calls++;
      return calls === 1 ? Promise.resolve(1) : new Promise((r) => (resolveFetch = r));
    });
    observe(() => void lazy.value);
    await vi.waitUntil(() => lazy.loaded);

    lazy.invalidate({ discard: true });
    await vi.waitUntil(() => lazy.loading);

    expect(lazy.value).toBeUndefined();
    expect(lazy.loaded).toBe(false);
    expect(lazy.fetching).toBe(true);

    resolveFetch(2);
    await vi.waitUntil(() => lazy.value === 2);
  });
});

// ---------------------------------------------------------------------------
// loadedAt
// ---------------------------------------------------------------------------

describe("loadedAt", () => {
  test("is undefined until a value lands, then records when", async () => {
    const lazy = lazyObservable(() => Promise.resolve(42));
    expect(lazy.fetchedAt).toBeUndefined();

    const before = Date.now();
    await lazy.getOrLoad();

    expect(lazy.fetchedAt).toBeGreaterThanOrEqual(before);
    expect(lazy.fetchedAt).toBeLessThanOrEqual(Date.now());
  });

  test("tracks the value, not the request: a refresh keeps the old stamp until new data lands", async () => {
    let resolveFetch!: (value: number) => void;
    let calls = 0;
    const lazy = lazyObservable<number>(() => {
      calls++;
      return calls === 1 ? Promise.resolve(1) : new Promise((r) => (resolveFetch = r));
    });
    await lazy.getOrLoad();
    const firstStamp = lazy.fetchedAt;

    const promise = lazy.reload();
    expect(lazy.fetchedAt).toBe(firstStamp); // still describes the value on screen

    resolveFetch(2);
    await promise;
    expect(lazy.fetchedAt).toBeGreaterThanOrEqual(firstStamp!);
    expect(lazy.value).toBe(2);
  });

  test("a failed refresh leaves the stamp untouched", async () => {
    let calls = 0;
    const lazy = lazyObservable(() => {
      calls++;
      return calls === 1 ? Promise.resolve(1) : Promise.reject(new Error("boom"));
    });
    await lazy.getOrLoad();
    const stamp = lazy.fetchedAt;

    await expect(lazy.reload()).rejects.toThrow("boom");
    expect(lazy.fetchedAt).toBe(stamp);
    expect(lazy.value).toBe(1);
  });

  test("set() stamps the value as current, discard clears the stamp", async () => {
    const lazy = lazyObservable(() => Promise.resolve(1));
    lazy.set(9);
    expect(lazy.fetchedAt).toBeDefined();

    lazy.invalidate({ discard: true });
    expect(lazy.fetchedAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// trackDependencies
// ---------------------------------------------------------------------------

describe("trackDependencies", () => {
  let disposeList: (() => void)[] = [];

  const observe = (fn: () => unknown) => {
    const dispose = autorun(fn);
    disposeList.push(dispose);
    return dispose;
  };

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  afterEach(() => {
    for (const dispose of disposeList) dispose();
    disposeList = [];
    vi.restoreAllMocks();
  });

  test("is off by default: an observable read by fetch does not trigger a refetch", async () => {
    const filter = observable.box("a");
    let calls = 0;
    const lazy = lazyObservable(() => {
      calls++;
      return Promise.resolve(filter.get());
    });
    observe(() => void lazy.value);
    await vi.waitUntil(() => lazy.loaded);
    expect(calls).toBe(1);

    runInAction(() => filter.set("b"));
    await tick();

    expect(calls).toBe(1);
    expect(lazy.value).toBe("a");
  });

  test("true refetches when a dependency changes", async () => {
    const filter = observable.box("a");
    const lazy = lazyObservable(() => Promise.resolve(filter.get()), {
      trackDependencies: true,
    });
    observe(() => void lazy.value);
    await vi.waitUntil(() => lazy.value === "a");

    runInAction(() => filter.set("b"));
    await vi.waitUntil(() => lazy.value === "b");
  });

  test("{ throttle } loads immediately but waits before refetching", async () => {
    const filter = observable.box("a");
    let calls = 0;
    const lazy = lazyObservable(
      () => {
        calls++;
        return Promise.resolve(filter.get());
      },
      { trackDependencies: { throttle: 40 } },
    );

    // the first load is never delayed
    void lazy.getOrLoad();
    expect(calls).toBe(1);
    await vi.waitUntil(() => lazy.value === "a");

    runInAction(() => filter.set("b"));
    await tick();
    expect(calls).toBe(1); // still waiting

    await vi.waitUntil(() => lazy.value === "b", { timeout: 500 });
    expect(calls).toBe(2);
  });

  test("{ throttle } folds a burst of changes into one request", async () => {
    const filter = observable.box(0);
    let calls = 0;
    const lazy = lazyObservable(
      () => {
        calls++;
        return Promise.resolve(filter.get());
      },
      { trackDependencies: { throttle: 40 } },
    );
    observe(() => void lazy.value);
    await vi.waitUntil(() => lazy.loaded);
    expect(calls).toBe(1);

    for (let i = 1; i <= 5; i++) runInAction(() => filter.set(i));

    await vi.waitUntil(() => lazy.value === 5, { timeout: 500 });
    expect(calls).toBe(2); // one initial load plus a single coalesced refetch
  });
});

describe("keepOnUnobserved", () => {
  const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

  test("{ delay } holds the value for that long, then drops it", async () => {
    const fetch = vi.fn().mockResolvedValue(42);
    const lazy = lazyObservable(fetch, { keepOnUnobserved: { for: 40 } });

    const dispose = autorun(() => void lazy.value);
    await vi.waitUntil(() => lazy.loaded);
    dispose();

    // still cached right after the last observer leaves
    expect(lazy.loaded).toBe(true);
    expect(lazy.value).toBe(42);

    await tick(60);
    expect(lazy.loaded).toBe(false);
    expect(lazy.fetching).toBe(false);
    expect(lazy.value).toBeUndefined();
  });

  test("{ delay } survives a quick unmount/remount without refetching", async () => {
    const fetch = vi.fn().mockResolvedValue(42);
    const lazy = lazyObservable(fetch, { keepOnUnobserved: { for: 60 } });

    const first = autorun(() => void lazy.value);
    await vi.waitUntil(() => lazy.loaded);
    first();

    const second = autorun(() => void lazy.value);
    await tick(80);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(lazy.value).toBe(42);
    second();
  });
});

// ---------------------------------------------------------------------------
// reloadEvery
// ---------------------------------------------------------------------------

describe("reloadEvery", () => {
  let disposeList: (() => void)[] = [];

  const observe = (fn: () => unknown) => {
    const dispose = autorun(fn);
    disposeList.push(dispose);
    return dispose;
  };

  const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

  afterEach(() => {
    for (const dispose of disposeList) dispose();
    disposeList = [];
    vi.restoreAllMocks();
  });

  test("refreshes on an interval while observed", async () => {
    let calls = 0;
    const lazy = lazyObservable(() => Promise.resolve(++calls), { reloadEvery: 40 });
    observe(() => void lazy.value);

    await vi.waitUntil(() => (lazy.value ?? 0) >= 3, { timeout: 1000 });
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  test("does not refresh while unobserved", async () => {
    const fetch = vi.fn().mockResolvedValue(42);
    const lazy = lazyObservable(fetch, { reloadEvery: 30, keepOnUnobserved: true });
    await lazy.getOrLoad();
    expect(fetch).toHaveBeenCalledTimes(1);

    await tick(120);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("refreshes immediately when observed again after the interval has passed", async () => {
    const fetch = vi.fn().mockResolvedValue(42);
    const lazy = lazyObservable(fetch, { reloadEvery: 30, keepOnUnobserved: true });
    await lazy.getOrLoad();

    await tick(80); // ages past the interval with nobody watching
    expect(fetch).toHaveBeenCalledTimes(1);

    observe(() => void lazy.value);
    await vi.waitUntil(() => fetch.mock.calls.length >= 2, { timeout: 1000 });
  });

  test("keeps the value readable across an automatic refresh", async () => {
    let calls = 0;
    const lazy = lazyObservable(() => Promise.resolve(++calls), { reloadEvery: 40 });
    const rendered: unknown[] = [];
    observe(() => rendered.push(lazy.value));

    await vi.waitUntil(() => (lazy.value ?? 0) >= 2, { timeout: 1000 });

    // straight from one value to the next — an automatic refresh never blanks the data
    expect(rendered.slice(0, 3)).toEqual([undefined, 1, 2]);
    expect(rendered.slice(1).every((entry) => entry !== undefined)).toBe(true);
  });

  test("a manual reload resets the interval rather than stacking on it", async () => {
    let calls = 0;
    const lazy = lazyObservable(() => Promise.resolve(++calls), { reloadEvery: 120 });
    observe(() => void lazy.value);
    await lazy.getOrLoad(); // deterministic first load, unlike polling for `loaded`
    expect(calls).toBe(1);

    await tick(80); // 80ms into the window — no automatic reload yet
    expect(calls).toBe(1);

    await lazy.reload(); // resets the clock
    expect(calls).toBe(2);

    await tick(80); // would have fired at 120ms had the clock not reset
    expect(calls).toBe(2);
  });

  test("no interval means no automatic refreshing", async () => {
    const fetch = vi.fn().mockResolvedValue(1);
    const lazy = lazyObservable(fetch);
    observe(() => void lazy.value);
    await vi.waitUntil(() => lazy.loaded);

    await tick(120);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The array a lazy owns
// ---------------------------------------------------------------------------

describe("lazyObservableArray identity", () => {
  const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

  test("value is always the same observable array across loads", async () => {
    let n = 1;
    const lazy = lazyObservableArray(() =>
      Promise.resolve(Array.from({ length: n++ }, (_, i) => ({ id: i }))),
    );

    await lazy.getOrLoad();
    const ref = lazy.value;
    expect(isObservableArray(ref)).toBe(true);
    expect(ref).toHaveLength(1);

    await lazy.reload();

    expect(lazy.value).toBe(ref);
    expect(ref).toHaveLength(2);
  });

  test("set() replaces the contents rather than the array", async () => {
    const lazy = lazyObservableArray(() => Promise.resolve([1]));
    await lazy.getOrLoad();
    const ref = lazy.value;

    lazy.set([7, 8, 9]);

    expect(lazy.value).toBe(ref);
    expect(ref!.slice()).toEqual([7, 8, 9]);
    expect(lazy.loaded).toBe(true);
  });

  test("a discard drops the value, and the next load hands back the same array", async () => {
    const lazy = lazyObservableArray(() => Promise.resolve([1, 2]));
    await lazy.getOrLoad();
    const ref = lazy.value;

    lazy.invalidate({ discard: true });

    // discarded means nothing is held — an emptied array would read as "there are zero rows"
    expect(lazy.value).toBeUndefined();
    expect(lazy.loaded).toBe(false);

    await lazy.getOrLoad();

    // the array itself was never replaced, so a reference taken before the discard is still valid
    expect(lazy.value).toBe(ref);
    expect(ref!.slice()).toEqual([1, 2]);
  });

  test("going unobserved drops the value, and the next load hands back the same array", async () => {
    const lazy = lazyObservableArray(() => Promise.resolve([1, 2]));
    const dispose = autorun(() => void lazy.value?.slice());
    await vi.waitUntil(() => lazy.loaded);
    const ref = lazy.value;
    expect(ref!.slice()).toEqual([1, 2]);

    dispose();
    await tick();

    expect(lazy.value).toBeUndefined();
    expect(lazy.loaded).toBe(false);

    await lazy.getOrLoad();
    expect(lazy.value).toBe(ref);
  });

  test("an explicit initialValue is restored on discard, not carried over", async () => {
    const lazy = lazyObservableArray(() => Promise.resolve([9]), { initialValue: [0] });
    const ref = lazy.value;
    expect(ref!.slice()).toEqual([0]);

    await lazy.getOrLoad();
    expect(ref!.slice()).toEqual([9]);

    lazy.invalidate({ discard: true });
    expect(ref!.slice()).toEqual([0]);
  });

  test("loadedAt is the signal that new data arrived", async () => {
    let n = 1;
    const lazy = lazyObservableArray(() => Promise.resolve([n++]));
    await lazy.getOrLoad();

    const stamps: (number | undefined)[] = [];
    const dispose = reaction(
      () => lazy.fetchedAt,
      () => stamps.push(lazy.value![0]),
    );
    await tick(2);
    await lazy.reload();

    // the array reference never changed, but loadedAt did
    expect(stamps).toEqual([2]);
    dispose();
  });

  test("deep: false leaves items unconverted; the default converts them", async () => {
    const row = { id: 1 };
    const shallowLazy = lazyObservableArray(() => Promise.resolve([row]), { deep: false });
    await shallowLazy.getOrLoad();
    expect(shallowLazy.value![0]).toBe(row);
    expect(isObservable(shallowLazy.value![0]!)).toBe(false);

    const deepLazy = lazyObservableArray(() => Promise.resolve([{ id: 1 }]));
    await deepLazy.getOrLoad();
    expect(isObservable(deepLazy.value![0]!)).toBe(true);
  });

  test("remove() works on the value, including with deep: false", async () => {
    const rows = [{ id: 1 }, { id: 2 }];
    const lazy = lazyObservableArray(() => Promise.resolve(rows), { deep: false });
    await lazy.getOrLoad();

    lazy.value!.remove(rows[0]!);

    expect(lazy.value!.slice()).toEqual([{ id: 2 }]);
  });
});
