import { autorun, runInAction } from "mobx";
import { describe, expect, test, vi } from "vite-plus/test";
import { lazyObservable, lazyObservableArray } from "./lazy-observable";

const tick = () => new Promise((r) => setTimeout(r, 0));

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

// ---------------------------------------------------------------------------
// The three axes, and the states they used to be unable to describe
// ---------------------------------------------------------------------------

describe("value presence, request, and outcome are independent", () => {
  test("a failed refresh keeps the value and reports the error", async () => {
    let calls = 0;
    const lazy = lazyObservable(async () => {
      calls++;
      if (calls > 1) throw new Error("offline");
      return "good data";
    });

    const stop = autorun(() => void lazy.value);
    await vi.waitUntil(() => lazy.loaded);

    await lazy.reload().catch(() => {});

    // both true at once, and neither contradicts the other: there is a value, and the last
    // request failed. The old `status` enum had no way to say this and claimed `"error"`, which
    // read as "nothing to show".
    expect(lazy.loaded).toBe(true);
    expect(lazy.value).toBe("good data");
    expect(lazy.error).toBeInstanceOf(Error);
    expect(lazy.fetching).toBe(false);
    stop();
  });

  test("a first load that fails holds nothing", async () => {
    const lazy = lazyObservable(async () => {
      throw new Error("offline");
    });

    await lazy.getOrLoad().catch(() => {});

    expect(lazy.loaded).toBe(false);
    expect(lazy.value).toBeUndefined();
    expect(lazy.error).toBeInstanceOf(Error);
  });

  test("`loading` is nothing-yet-and-working, not merely working", async () => {
    const gate = deferred<string>();
    let calls = 0;
    const lazy = lazyObservable(() => {
      calls++;
      return calls === 1 ? Promise.resolve("first") : gate.promise;
    });

    const stop = autorun(() => void lazy.value);
    await vi.waitUntil(() => lazy.loaded);

    const refreshing = lazy.reload();
    // a request is running, but there is something on screen — so this is a refresh, not a load
    expect(lazy.fetching).toBe(true);
    expect(lazy.loaded).toBe(true); // a refresh, not a load — there is something on screen
    expect(lazy.value).toBe("first");

    gate.resolve("second");
    await refreshing;
    expect(lazy.fetching).toBe(false);
    stop();
  });

  test("a request in flight with nothing held is `loading`", async () => {
    const gate = deferred<string>();
    const lazy = lazyObservable(() => gate.promise);

    const pending = lazy.getOrLoad();
    expect(lazy.loaded).toBe(false); // nothing to show...
    expect(lazy.fetching).toBe(true); // ...and working on it

    gate.resolve("here");
    await pending;
    expect(lazy.loaded).toBe(true);
    expect(lazy.fetching).toBe(false);
  });

  test("a new request clears the previous failure", async () => {
    let calls = 0;
    const lazy = lazyObservable(async () => {
      calls++;
      if (calls === 1) throw new Error("offline");
      return "recovered";
    });

    await lazy.getOrLoad().catch(() => {});
    expect(lazy.error).toBeInstanceOf(Error);

    await lazy.getOrLoad();
    expect(lazy.error).toBeUndefined();
    expect(lazy.value).toBe("recovered");
  });
});

// ---------------------------------------------------------------------------
// Staleness drives loading — not presence
// ---------------------------------------------------------------------------

describe("`undefined` can be a real value", () => {
  // `loaded` is its own flag rather than `value !== undefined`, and this is why: a lazy over an
  // optional value that legitimately resolves to `undefined` would otherwise never count as
  // loaded, and would refetch on every single `getOrLoad`.
  test("a lazy that resolves to undefined is loaded, and stops fetching", async () => {
    let calls = 0;
    const lazy = lazyObservable<string | undefined>(async () => {
      calls++;
      return undefined;
    });

    await lazy.getOrLoad();
    expect(lazy.loaded).toBe(true);
    expect(lazy.value).toBeUndefined();

    await lazy.getOrLoad();
    await lazy.getOrLoad();
    expect(calls).toBe(1);
  });

  test("an empty array is loaded, and distinguishable from nothing", async () => {
    const lazy = lazyObservableArray(async () => []);

    expect(lazy.loaded).toBe(false); // nothing yet
    await lazy.getOrLoad();

    expect(lazy.loaded).toBe(true); // there are none
    expect(lazy.value?.slice()).toEqual([]);
  });
});

describe("getOrLoad answers staleness, not just presence", () => {
  test("invalidate then getOrLoad fetches, even unobserved", async () => {
    let n = 0;
    const lazy = lazyObservable(async () => `v${++n}`);

    expect(await lazy.getOrLoad()).toBe("v1");

    lazy.invalidate();

    // nothing is observing, so the gate reaction will not fire — the caller's own demand has to
    // be enough, or an invalidated lazy serves the value it was told to replace, forever
    expect(await lazy.getOrLoad()).toBe("v2");
    expect(n).toBe(2);
  });

  test("an observed and an unobserved lazy answer getOrLoad the same way", async () => {
    const make = () => {
      let n = 0;
      return lazyObservable(async () => `v${++n}`);
    };

    const watched = make();
    const stop = autorun(() => void watched.value);
    await vi.waitUntil(() => watched.loaded);
    watched.invalidate();
    await tick();
    const watchedValue = await watched.getOrLoad();
    stop();

    const lonely = make();
    await lonely.getOrLoad();
    lonely.invalidate();
    const lonelyValue = await lonely.getOrLoad();

    // whether something happens to be watching is not supposed to change what a caller gets
    expect(lonelyValue).toBe(watchedValue);
  });

  test("a loaded, fresh lazy answers without fetching", async () => {
    let n = 0;
    const lazy = lazyObservable(async () => `v${++n}`);

    await lazy.getOrLoad();
    await lazy.getOrLoad();
    await lazy.getOrLoad();

    expect(n).toBe(1);
  });

  test("getOrLoad resolves with what `value` holds, not the raw payload", async () => {
    // For a list lazy these are different objects: the fetch returns a plain array, while `value`
    // is the observable one the lazy owns. Resolving with the payload would hand an awaiting
    // caller a detached snapshot that never updates.
    const lazy = lazyObservableArray(async () => [1, 2]);
    const resolved = await lazy.getOrLoad();

    expect(resolved).toBe(lazy.value);

    // and it stays live
    lazy.set([3, 4]);
    expect(resolved.slice()).toEqual([3, 4]);
  });

  test("set() resolves an awaiting caller with the held value too", async () => {
    const lazy = lazyObservableArray<number>(() => new Promise(() => {}));
    const pending = lazy.getOrLoad();

    lazy.set([7]);

    expect(await pending).toBe(lazy.value);
  });

  test("set() makes a value authoritative — no fetch is owed", async () => {
    let n = 0;
    const lazy = lazyObservable(async () => `fetched${++n}`);

    lazy.set("written");

    expect(await lazy.getOrLoad()).toBe("written");
    expect(n).toBe(0);
    // and it is stamped as though a request had produced it
    expect(lazy.fetchedAt).toBeTypeOf("number");
  });
});

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

describe("initialValue seeds a value that is still owed a fetch", () => {
  test("renders immediately, and revalidates on first observation", async () => {
    const lazy = lazyObservable(() => Promise.resolve("fresh"), { initialValue: "hydrated" });

    expect(lazy.loaded).toBe(true);
    expect(lazy.value).toBe("hydrated");
    // never been to the network, which is exactly what distinguishes this from `set()`
    expect(lazy.fetchedAt).toBeUndefined();

    const stop = autorun(() => void lazy.value);
    await vi.waitUntil(() => lazy.fetchedAt !== undefined);

    expect(lazy.value).toBe("fresh");
    stop();
  });

  test("a seeded lazy still fetches through getOrLoad", async () => {
    let n = 0;
    const lazy = lazyObservable(async () => `v${++n}`, { initialValue: "seed" });

    expect(await lazy.getOrLoad()).toBe("v1");
    expect(n).toBe(1);
  });

  test("the seed is snapshotted, so mutating the caller's array can't rewrite it", async () => {
    const seed = [1, 2];
    const lazy = lazyObservableArray(() => Promise.resolve([9]), { initialValue: seed });
    await lazy.getOrLoad();

    // the caller still holds the array they passed in
    seed.push(999);
    lazy.invalidate({ discard: true });

    expect(lazy.value?.slice()).toEqual([1, 2]);
  });

  test("discard restores the seed rather than dropping to nothing", async () => {
    const lazy = lazyObservableArray(() => Promise.resolve([9]), { initialValue: [0] });
    await lazy.getOrLoad();
    expect(lazy.value?.slice()).toEqual([9]);

    lazy.invalidate({ discard: true });

    expect(lazy.loaded).toBe(true);
    expect(lazy.value?.slice()).toEqual([0]);
  });
});

// ---------------------------------------------------------------------------
// The subtlest failure mode in the module
// ---------------------------------------------------------------------------

describe("a read that returns nothing still registers observation", () => {
  // `value` returns `undefined` before the first load. If that path skipped the observable read,
  // the lazy would be watched, never learn it, and never load — silently, forever. This is the
  // regression test for that, and it has to observe *only* `value`.
  test("an array lazy loads when its empty value is the only thing read", async () => {
    const fetch = vi.fn(async () => [1, 2, 3]);
    const lazy = lazyObservableArray(fetch);

    const stop = autorun(() => void lazy.value);
    await vi.waitUntil(() => lazy.loaded);

    expect(fetch).toHaveBeenCalledOnce();
    expect(lazy.value?.slice()).toEqual([1, 2, 3]);
    stop();
  });

  test("a scalar lazy loads when its empty value is the only thing read", async () => {
    const fetch = vi.fn(async () => 42);
    const lazy = lazyObservable(fetch);

    const stop = autorun(() => void lazy.value);
    await vi.waitUntil(() => lazy.loaded);

    expect(fetch).toHaveBeenCalledOnce();
    stop();
  });

  test("reading through optional chaining is enough to load", async () => {
    const fetch = vi.fn(async () => [1, 2, 3]);
    const lazy = lazyObservableArray(fetch);

    // the shape a component actually writes now that `value` can be undefined
    const stop = autorun(() => void (lazy.value?.length ?? 0));
    await vi.waitUntil(() => lazy.loaded);

    expect(fetch).toHaveBeenCalledOnce();
    stop();
  });

  test("a lazy built inside a tracked derivation still loads", async () => {
    const fetch = vi.fn(async () => [1, 2, 3]);
    let lazy: ReturnType<typeof lazyObservableArray<number>> | undefined;

    // mobx fires onBecomeObserved from the first tracked read, once — constructing inside a
    // derivation is where that transition is easiest to spend on nobody
    const stop = autorun(() => {
      lazy ??= lazyObservableArray(fetch);
      void lazy.value;
    });

    await vi.waitUntil(() => lazy?.loaded === true);
    expect(fetch).toHaveBeenCalledOnce();
    stop();
  });

  test("an array lazy loads when only its length is read", async () => {
    const fetch = vi.fn(async () => [1, 2, 3]);
    const lazy = lazyObservableArray(fetch);

    const stop = autorun(() => void lazy.value?.length);
    await vi.waitUntil(() => lazy.loaded);

    expect(fetch).toHaveBeenCalledOnce();
    stop();
  });
});

// ---------------------------------------------------------------------------
// Array identity across the value coming and going
// ---------------------------------------------------------------------------

describe("array identity survives the value going away", () => {
  test("the same array comes back after a discard and a reload", async () => {
    const lazy = lazyObservableArray(() => Promise.resolve([1, 2]));
    await lazy.getOrLoad();
    const first = lazy.value;

    lazy.invalidate({ discard: true });
    expect(lazy.value).toBeUndefined();

    await lazy.getOrLoad();
    expect(lazy.value).toBe(first);
  });

  test("a held reference keeps updating across the gap", async () => {
    let n = 0;
    const lazy = lazyObservableArray(async () => [++n]);
    await lazy.getOrLoad();
    const held = lazy.value!;

    lazy.invalidate({ discard: true });
    runInAction(() => void 0);
    await lazy.getOrLoad();

    expect(held.slice()).toEqual([2]);
    expect(lazy.value).toBe(held);
  });
});
