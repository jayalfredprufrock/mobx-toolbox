import { autorun, runInAction } from "mobx";
import { describe, expect, test, vi } from "vite-plus/test";
import { lazy, lazyArray } from "./lazy";

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
    const subject = lazy(async () => {
      calls++;
      if (calls > 1) throw new Error("offline");
      return "good data";
    });

    const stop = autorun(() => void subject.value);
    await vi.waitUntil(() => subject.loaded);

    await subject.reload().catch(() => {});

    // both true at once, and neither contradicts the other: there is a value, and the last
    // request failed. The old `status` enum had no way to say this and claimed `"error"`, which
    // read as "nothing to show".
    expect(subject.loaded).toBe(true);
    expect(subject.value).toBe("good data");
    expect(subject.error).toBeInstanceOf(Error);
    expect(subject.fetching).toBe(false);
    stop();
  });

  test("a first load that fails holds nothing", async () => {
    const subject = lazy(async () => {
      throw new Error("offline");
    });

    await subject.getOrLoad().catch(() => {});

    expect(subject.loaded).toBe(false);
    expect(subject.value).toBeUndefined();
    expect(subject.error).toBeInstanceOf(Error);
  });

  test("`loading` is nothing-yet-and-working, not merely working", async () => {
    const gate = deferred<string>();
    let calls = 0;
    const subject = lazy(() => {
      calls++;
      return calls === 1 ? Promise.resolve("first") : gate.promise;
    });

    const stop = autorun(() => void subject.value);
    await vi.waitUntil(() => subject.loaded);

    const refreshing = subject.reload();
    // a request is running, but there is something on screen — so this is a refresh, not a load
    expect(subject.fetching).toBe(true);
    expect(subject.loaded).toBe(true); // a refresh, not a load — there is something on screen
    expect(subject.value).toBe("first");

    gate.resolve("second");
    await refreshing;
    expect(subject.fetching).toBe(false);
    stop();
  });

  test("a request in flight with nothing held is `loading`", async () => {
    const gate = deferred<string>();
    const subject = lazy(() => gate.promise);

    const pending = subject.getOrLoad();
    expect(subject.loaded).toBe(false); // nothing to show...
    expect(subject.fetching).toBe(true); // ...and working on it

    gate.resolve("here");
    await pending;
    expect(subject.loaded).toBe(true);
    expect(subject.fetching).toBe(false);
  });

  test("a new request clears the previous failure", async () => {
    let calls = 0;
    const subject = lazy(async () => {
      calls++;
      if (calls === 1) throw new Error("offline");
      return "recovered";
    });

    await subject.getOrLoad().catch(() => {});
    expect(subject.error).toBeInstanceOf(Error);

    await subject.getOrLoad();
    expect(subject.error).toBeUndefined();
    expect(subject.value).toBe("recovered");
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
    const subject = lazy<string | undefined>(async () => {
      calls++;
      return undefined;
    });

    await subject.getOrLoad();
    expect(subject.loaded).toBe(true);
    expect(subject.value).toBeUndefined();

    await subject.getOrLoad();
    await subject.getOrLoad();
    expect(calls).toBe(1);
  });

  test("an empty array is loaded, and distinguishable from nothing", async () => {
    const subject = lazyArray(async () => []);

    expect(subject.loaded).toBe(false); // nothing yet
    await subject.getOrLoad();

    expect(subject.loaded).toBe(true); // there are none
    expect(subject.value?.slice()).toEqual([]);
  });

  // The seed path has to agree with the fetch path above: the same `undefined`, held for the same
  // reason, cannot be a value when it arrives from the network and nothing when it is handed in.
  // Presence of the key is what says "seeded", which is why an explicit `undefined` counts.
  test("seeding with undefined is loaded, matching a fetch that resolves undefined", async () => {
    let calls = 0;
    const subject = lazy<string | undefined>(
      async () => {
        calls++;
        return "fetched";
      },
      { initialValue: undefined },
    );

    expect(subject.loaded).toBe(true);
    expect(subject.value).toBeUndefined();
    expect(calls).toBe(0);

    // seeded still means stale, so the first getOrLoad revalidates
    await subject.getOrLoad();
    expect(subject.value).toBe("fetched");
    expect(calls).toBe(1);
  });

  test("a discarded undefined seed returns to undefined, still loaded", async () => {
    const subject = lazy<string | undefined>(async () => "fetched", {
      initialValue: undefined,
    });
    await subject.getOrLoad();
    expect(subject.value).toBe("fetched");

    subject.invalidate({ discard: true });

    // back to the seed — which is `undefined`, and is still a value it holds
    expect(subject.loaded).toBe(true);
    expect(subject.value).toBeUndefined();
  });

  test("omitting initialValue is not the same as seeding with undefined", async () => {
    const seeded = lazy<string | undefined>(async () => "x", {
      initialValue: undefined,
    });
    const unseeded = lazy<string | undefined>(async () => "x");

    expect(seeded.loaded).toBe(true);
    expect(unseeded.loaded).toBe(false);
    expect(seeded.value).toBe(unseeded.value); // both undefined; only `loaded` tells them apart
  });
});

describe("getOrLoad answers staleness, not just presence", () => {
  test("invalidate then getOrLoad fetches, even unobserved", async () => {
    let n = 0;
    const subject = lazy(async () => `v${++n}`);

    expect(await subject.getOrLoad()).toBe("v1");

    subject.invalidate();

    // nothing is observing, so the gate reaction will not fire — the caller's own demand has to
    // be enough, or an invalidated lazy serves the value it was told to replace, forever
    expect(await subject.getOrLoad()).toBe("v2");
    expect(n).toBe(2);
  });

  test("an observed and an unobserved lazy answer getOrLoad the same way", async () => {
    const make = () => {
      let n = 0;
      return lazy(async () => `v${++n}`);
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
    const subject = lazy(async () => `v${++n}`);

    await subject.getOrLoad();
    await subject.getOrLoad();
    await subject.getOrLoad();

    expect(n).toBe(1);
  });

  test("getOrLoad resolves with what `value` holds, not the raw payload", async () => {
    // For a list lazy these are different objects: the fetch returns a plain array, while `value`
    // is the observable one the lazy owns. Resolving with the payload would hand an awaiting
    // caller a detached snapshot that never updates.
    const subject = lazyArray(async () => [1, 2]);
    const resolved = await subject.getOrLoad();

    expect(resolved).toBe(subject.value);

    // and it stays live
    subject.set([3, 4]);
    expect(resolved.slice()).toEqual([3, 4]);
  });

  test("set() resolves an awaiting caller with the held value too", async () => {
    const subject = lazyArray<number>(() => new Promise(() => {}));
    const pending = subject.getOrLoad();

    subject.set([7]);

    expect(await pending).toBe(subject.value);
  });

  test("set() makes a value authoritative — no fetch is owed", async () => {
    let n = 0;
    const subject = lazy(async () => `fetched${++n}`);

    subject.set("written");

    expect(await subject.getOrLoad()).toBe("written");
    expect(n).toBe(0);
    // and it is stamped as though a request had produced it
    expect(subject.fetchedAt).toBeTypeOf("number");
  });
});

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

describe("initialValue seeds a value that is still owed a fetch", () => {
  test("renders immediately, and revalidates on first observation", async () => {
    const subject = lazy(() => Promise.resolve("fresh"), { initialValue: "hydrated" });

    expect(subject.loaded).toBe(true);
    expect(subject.value).toBe("hydrated");
    // never been to the network, which is exactly what distinguishes this from `set()`
    expect(subject.fetchedAt).toBeUndefined();

    const stop = autorun(() => void subject.value);
    await vi.waitUntil(() => subject.fetchedAt !== undefined);

    expect(subject.value).toBe("fresh");
    stop();
  });

  test("a seeded lazy still fetches through getOrLoad", async () => {
    let n = 0;
    const subject = lazy(async () => `v${++n}`, { initialValue: "seed" });

    expect(await subject.getOrLoad()).toBe("v1");
    expect(n).toBe(1);
  });

  test("the seed is snapshotted, so mutating the caller's array can't rewrite it", async () => {
    const seed = [1, 2];
    const subject = lazyArray(() => Promise.resolve([9]), { initialValue: seed });
    await subject.getOrLoad();

    // the caller still holds the array they passed in
    seed.push(999);
    subject.invalidate({ discard: true });

    expect(subject.value?.slice()).toEqual([1, 2]);
  });

  test("discard restores the seed rather than dropping to nothing", async () => {
    const subject = lazyArray(() => Promise.resolve([9]), { initialValue: [0] });
    await subject.getOrLoad();
    expect(subject.value?.slice()).toEqual([9]);

    subject.invalidate({ discard: true });

    expect(subject.loaded).toBe(true);
    expect(subject.value?.slice()).toEqual([0]);
  });

  // A list is seeded by *having* rows, never by the option being present — `undefined` is not a
  // list. The scalar rule (presence counts) would make every array lazy report loaded at
  // construction, since `lazyArray` always passes the key down to the shared builder.
  test("a list is not seeded by an explicit undefined", async () => {
    const subject = lazyArray(() => Promise.resolve([9]), { initialValue: undefined });

    expect(subject.loaded).toBe(false);
    expect(subject.value).toBeUndefined();

    await subject.getOrLoad();
    expect(subject.value?.slice()).toEqual([9]);

    // and a discard drops to nothing rather than restoring an "undefined seed"
    subject.invalidate({ discard: true });
    expect(subject.loaded).toBe(false);
    expect(subject.value).toBeUndefined();
  });

  test("an unseeded list holds nothing until a load lands", async () => {
    const subject = lazyArray(() => Promise.resolve([9]));

    expect(subject.loaded).toBe(false);
    expect(subject.value).toBeUndefined();
  });

  test("an empty seed is a seed: the list is loaded before anything is fetched", async () => {
    const subject = lazyArray(() => Promise.resolve([9]), { initialValue: [] });

    expect(subject.loaded).toBe(true);
    expect(subject.value?.slice()).toEqual([]);
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
    const subject = lazyArray(fetch);

    const stop = autorun(() => void subject.value);
    await vi.waitUntil(() => subject.loaded);

    expect(fetch).toHaveBeenCalledOnce();
    expect(subject.value?.slice()).toEqual([1, 2, 3]);
    stop();
  });

  test("a scalar lazy loads when its empty value is the only thing read", async () => {
    const fetch = vi.fn(async () => 42);
    const subject = lazy(fetch);

    const stop = autorun(() => void subject.value);
    await vi.waitUntil(() => subject.loaded);

    expect(fetch).toHaveBeenCalledOnce();
    stop();
  });

  test("reading through optional chaining is enough to load", async () => {
    const fetch = vi.fn(async () => [1, 2, 3]);
    const subject = lazyArray(fetch);

    // the shape a component actually writes now that `value` can be undefined
    const stop = autorun(() => void (subject.value?.length ?? 0));
    await vi.waitUntil(() => subject.loaded);

    expect(fetch).toHaveBeenCalledOnce();
    stop();
  });

  test("a lazy built inside a tracked derivation still loads", async () => {
    const fetch = vi.fn(async () => [1, 2, 3]);
    let subject: ReturnType<typeof lazyArray<number>> | undefined;

    // mobx fires onBecomeObserved from the first tracked read, once — constructing inside a
    // derivation is where that transition is easiest to spend on nobody
    const stop = autorun(() => {
      subject ??= lazyArray(fetch);
      void subject.value;
    });

    await vi.waitUntil(() => subject?.loaded === true);
    expect(fetch).toHaveBeenCalledOnce();
    stop();
  });

  test("an array lazy loads when only its length is read", async () => {
    const fetch = vi.fn(async () => [1, 2, 3]);
    const subject = lazyArray(fetch);

    const stop = autorun(() => void subject.value?.length);
    await vi.waitUntil(() => subject.loaded);

    expect(fetch).toHaveBeenCalledOnce();
    stop();
  });
});

// ---------------------------------------------------------------------------
// Array identity across the value coming and going
// ---------------------------------------------------------------------------

describe("array identity survives the value going away", () => {
  test("the same array comes back after a discard and a reload", async () => {
    const subject = lazyArray(() => Promise.resolve([1, 2]));
    await subject.getOrLoad();
    const first = subject.value;

    subject.invalidate({ discard: true });
    expect(subject.value).toBeUndefined();

    await subject.getOrLoad();
    expect(subject.value).toBe(first);
  });

  test("a held reference keeps updating across the gap", async () => {
    let n = 0;
    const subject = lazyArray(async () => [++n]);
    await subject.getOrLoad();
    const held = subject.value!;

    subject.invalidate({ discard: true });
    runInAction(() => void 0);
    await subject.getOrLoad();

    expect(held.slice()).toEqual([2]);
    expect(subject.value).toBe(held);
  });
});
