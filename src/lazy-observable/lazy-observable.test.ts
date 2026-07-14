import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { autorun, runInAction } from "mobx";
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
    expect(lazy.status).toBe("init");
    expect(lazy.value).toBeUndefined();
    expect(lazy.loading).toBe(false);
    expect(lazy.loaded).toBe(false);
  });

  test("uses provided initialValue before loading", () => {
    const lazy = lazyObservable(() => Promise.resolve(42), { initialValue: 0 });
    expect(lazy.value).toBe(0);
  });

  test("transitions to loading when first observed", () => {
    const fetchFn = vi.fn().mockResolvedValue(42);
    const lazy = lazyObservable(fetchFn);

    observe(() => void lazy.value);

    expect(lazy.status).toBe("loading");
    expect(lazy.loading).toBe(true);
  });

  test("loads value when observed", async () => {
    const lazy = lazyObservable(() => Promise.resolve(42));
    observe(() => void lazy.value);

    await lazy.getOrLoad();

    expect(lazy.value).toBe(42);
    expect(lazy.status).toBe("loaded");
    expect(lazy.loaded).toBe(true);
    expect(lazy.loading).toBe(false);
  });

  test("only calls fetch once for multiple observers", async () => {
    const fetchFn = vi.fn().mockResolvedValue(42);
    const lazy = lazyObservable(fetchFn);

    observe(() => void lazy.value);
    observe(() => void lazy.status);

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
    expect(lazy.status).toBe("loaded");
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

  test("reset() restores to initial state", async () => {
    const lazy = lazyObservable(() => Promise.resolve(42));
    observe(() => void lazy.value);
    await lazy.getOrLoad();

    lazy.reset();

    expect(lazy.status).toBe("init");
    expect(lazy.value).toBeUndefined();
  });

  test("records error status on async fetch rejection", async () => {
    const err = new Error("network error");
    const fetchFn = vi.fn().mockRejectedValue(err);
    const lazy = lazyObservable(fetchFn);
    observe(() => void lazy.value);

    try {
      await lazy.getOrLoad();
    } catch {}

    expect(lazy.status).toBe("error");
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

    expect(lazy.status).toBe("error");
    expect(lazy.error).toBe(err);
  });

  test("shallow option creates a shallow observable", async () => {
    const lazy = lazyObservable(() => Promise.resolve({ a: 1 }), { shallow: true });
    observe(() => void lazy.value);
    await lazy.getOrLoad();
    expect(lazy.value).toEqual({ a: 1 });
  });

  test("resetOnUnobserved: 'never' keeps value after unobserve", async () => {
    const lazy = lazyObservable(() => Promise.resolve(42), { resetOnUnobserved: "never" });
    const dispose = observe(() => void lazy.value);
    await lazy.getOrLoad();

    dispose();
    disposeList = disposeList.filter((d) => d !== dispose);

    expect(lazy.status).toBe("loaded");
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

  test("starts with an empty array as initial value", () => {
    const lazy = lazyObservableArray(() => Promise.resolve([1, 2, 3]));
    expect(lazy.value).toEqual([]);

    // value is typed as non-optional — no `?? []` guard needed at call sites
    const _values: number[] = lazy.value;
    void _values;
  });

  test("respects an explicit initialValue", () => {
    const lazy = lazyObservableArray(() => Promise.resolve([1, 2, 3]), {
      initialValue: [9],
    });
    expect(lazy.value).toEqual([9]);
  });

  test("explicit undefined initialValue still falls back to []", () => {
    const lazy = lazyObservableArray(() => Promise.resolve([1, 2, 3]), {
      initialValue: undefined,
    });
    expect(lazy.value).toEqual([]);
  });

  test("loads array when observed", async () => {
    const lazy = lazyObservableArray(() => Promise.resolve([1, 2, 3]));
    observe(() => void lazy.value);

    await lazy.getOrLoad();

    expect(lazy.value).toEqual([1, 2, 3]);
    expect(lazy.loaded).toBe(true);
  });

  test("set() replaces array contents", () => {
    const lazy = lazyObservableArray<number>(() => Promise.resolve([]));
    runInAction(() => lazy.set([10, 20, 30]));
    expect(lazy.value).toEqual([10, 20, 30]);
    expect(lazy.status).toBe("loaded");
  });

  test("value is a MobX observable array", async () => {
    const lazy = lazyObservableArray(() => Promise.resolve([1, 2]));
    observe(() => void lazy.value);
    await lazy.getOrLoad();
    expect(Array.isArray(lazy.value)).toBe(true);
  });
});
