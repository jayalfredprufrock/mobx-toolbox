import { describe, expect, test, vi } from "vite-plus/test";
import * as T from "typebox";
import { LOADED_AT, RETAINED, makeModel } from "./make-model";

const StudySchema = T.Object({
  id: T.Number(),
  name: T.String(),
});

/**
 * The load stamp is internal metadata, so it is deliberately absent from the instance type. These
 * reach it the way the implementation does, without spraying casts through every test.
 */
const stampOf = (model: object): number | undefined => (model as any)[LOADED_AT];
const setStamp = (model: object, at: number | undefined): void => {
  (model as any)[LOADED_AT] = at;
};

/** A `get` that counts its calls and hands back whatever name is current. */
const makeApi = () => {
  const api = {
    calls: 0,
    name: "First",
    error: undefined as unknown,
    get: async ({ id }: { id: number }) => {
      api.calls++;
      if (api.error) throw api.error;
      return { id, name: api.name };
    },
  };
  return api;
};

const makeStudy = (config: { cache?: boolean | { for: number }; optimistic?: boolean } = {}) => {
  const api = makeApi();
  const StudyModel = makeModel(StudySchema, {
    keys: ["id"],
    get: api.get,
    ...config,
  });
  return { api, StudyModel };
};

// ---------------------------------------------------------------------------
// peek
// ---------------------------------------------------------------------------

describe("Model.peek", () => {
  test("returns undefined for a record that was never loaded", () => {
    const { StudyModel } = makeStudy();
    expect(StudyModel.peek({ id: 1 })).toBeUndefined();
  });

  test("returns the identity-mapped instance once loaded, without fetching", async () => {
    const { api, StudyModel } = makeStudy();
    const loaded = await StudyModel.get({ id: 1 });

    expect(StudyModel.peek({ id: 1 })).toBe(loaded);
    expect(api.calls).toBe(1);
  });

  test("answers for a record a list put in the map, not just one `get` fetched", () => {
    const { StudyModel } = makeStudy();
    StudyModel.instantiate({ id: 7, name: "From a list" });

    expect(StudyModel.peek({ id: 7 })?.name).toBe("From a list");
  });

  test("reports presence, not freshness — a stale record still comes back", async () => {
    const { StudyModel } = makeStudy({ cache: { for: 1000 } });
    const study = await StudyModel.get({ id: 1 });
    setStamp(study, Date.now() - 5000);

    expect(StudyModel.peek({ id: 1 })).toBe(study);
  });

  test("throws the identity error on a model that declared no keys", () => {
    const Detached = makeModel(StudySchema);
    expect(() => (Detached as any).peek({ id: 1 })).toThrow("This model has no identity");
  });
});

// ---------------------------------------------------------------------------
// the load stamp
// ---------------------------------------------------------------------------

describe("load stamp", () => {
  test("setData stamps, so every load path refreshes it", async () => {
    const { StudyModel } = makeStudy();
    const study = await StudyModel.get({ id: 1 });
    const first = stampOf(study);
    expect(first).toBeTypeOf("number");

    vi.setSystemTime(Date.now() + 1000);
    await StudyModel.reload({ id: 1 });
    expect(stampOf(study)).toBeGreaterThan(first!);
    vi.useRealTimers();
  });

  test("stays out of toJSON", async () => {
    const { StudyModel } = makeStudy();
    const study = await StudyModel.get({ id: 1 });
    expect(study.toJSON()).toEqual({ id: 1, name: "First" });
  });
});

// ---------------------------------------------------------------------------
// cache
// ---------------------------------------------------------------------------

describe("cache", () => {
  test("defaults to off — every get goes to the API", async () => {
    const { api, StudyModel } = makeStudy();
    await StudyModel.get({ id: 1 });
    await StudyModel.get({ id: 1 });
    expect(api.calls).toBe(2);
  });

  test("`true` answers from the identity map after the first load", async () => {
    const { api, StudyModel } = makeStudy({ cache: true });
    const first = await StudyModel.get({ id: 1 });
    const second = await StudyModel.get({ id: 1 });

    expect(second).toBe(first);
    expect(api.calls).toBe(1);
  });

  test("`true` answers with a record a list loaded, without ever fetching it", async () => {
    const { api, StudyModel } = makeStudy({ cache: true });
    StudyModel.instantiate({ id: 7, name: "From a list" });

    expect((await StudyModel.get({ id: 7 })).name).toBe("From a list");
    expect(api.calls).toBe(0);
  });

  test("caches per record, not globally", async () => {
    const { api, StudyModel } = makeStudy({ cache: true });
    await StudyModel.get({ id: 1 });
    await StudyModel.get({ id: 2 });
    await StudyModel.get({ id: 1 });

    expect(api.calls).toBe(2);
  });

  test("`{ for }` answers within the window", async () => {
    const { api, StudyModel } = makeStudy({ cache: { for: 30_000 } });
    await StudyModel.get({ id: 1 });

    vi.setSystemTime(Date.now() + 10_000);
    await StudyModel.get({ id: 1 });
    expect(api.calls).toBe(1);
    vi.useRealTimers();
  });

  test("`{ for }` refetches past the window", async () => {
    const { api, StudyModel } = makeStudy({ cache: { for: 30_000 } });
    await StudyModel.get({ id: 1 });

    vi.setSystemTime(Date.now() + 31_000);
    api.name = "Second";
    const refreshed = await StudyModel.get({ id: 1 });

    expect(api.calls).toBe(2);
    expect(refreshed.name).toBe("Second");
    vi.useRealTimers();
  });

  test("a refetch applies to the same instance", async () => {
    const { api, StudyModel } = makeStudy({ cache: { for: 1 } });
    const first = await StudyModel.get({ id: 1 });

    vi.setSystemTime(Date.now() + 100);
    api.name = "Second";
    const second = await StudyModel.get({ id: 1 });

    expect(second).toBe(first);
    expect(first.name).toBe("Second");
    vi.useRealTimers();
  });

  test("is ignored by a model with no identity — there is nothing to cache in", async () => {
    const api = makeApi();
    const Detached = makeModel(StudySchema, { get: api.get, cache: true } as any);
    await (Detached as any).get({ id: 1 });
    await (Detached as any).get({ id: 1 });
    expect(api.calls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// reload
// ---------------------------------------------------------------------------

describe("Model.reload", () => {
  test("goes to the API even when cache would have answered", async () => {
    const { api, StudyModel } = makeStudy({ cache: true });
    const first = await StudyModel.get({ id: 1 });
    api.name = "Second";
    const reloaded = await StudyModel.reload({ id: 1 });

    expect(api.calls).toBe(2);
    expect(reloaded).toBe(first);
    expect(first.name).toBe("Second");
  });

  test("re-freshens the record, so the next get is cached again", async () => {
    const { api, StudyModel } = makeStudy({ cache: { for: 30_000 } });
    await StudyModel.get({ id: 1 });

    vi.setSystemTime(Date.now() + 31_000);
    await StudyModel.reload({ id: 1 });
    await StudyModel.get({ id: 1 });

    expect(api.calls).toBe(2);
    vi.useRealTimers();
  });

  test("propagates a failure to the caller", async () => {
    const { api, StudyModel } = makeStudy({ cache: true });
    api.error = new Error("boom");
    await expect(StudyModel.reload({ id: 1 })).rejects.toThrow("boom");
  });
});

// ---------------------------------------------------------------------------
// optimistic
// ---------------------------------------------------------------------------

describe("optimistic", () => {
  test("hands back the stale record without waiting, then refreshes it", async () => {
    // the refresh is held open, so "answered before it finished" is observable rather than a race
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    let calls = 0;
    const StudyModel = makeModel(StudySchema, {
      keys: ["id"],
      cache: { for: 1000 },
      optimistic: true,
      get: async ({ id }: { id: number }) => {
        calls++;
        if (calls > 1) await gate;
        return { id, name: calls > 1 ? "Second" : "First" };
      },
    });

    const first = await StudyModel.get({ id: 1 });
    vi.setSystemTime(Date.now() + 5000);

    const stale = await StudyModel.get({ id: 1 });

    // answered from the map while the refresh is still in flight
    expect(stale).toBe(first);
    expect(stale.name).toBe("First");
    expect(calls).toBe(2);

    release();
    await vi.waitFor(() => expect(first.name).toBe("Second"));
    vi.useRealTimers();
  });

  test("does not fire while the record is still fresh", async () => {
    const { api, StudyModel } = makeStudy({ cache: { for: 30_000 }, optimistic: true });
    await StudyModel.get({ id: 1 });
    await StudyModel.get({ id: 1 });
    expect(api.calls).toBe(1);
  });

  test("waits for the API when there is nothing cached to answer with", async () => {
    const { api, StudyModel } = makeStudy({ cache: true, optimistic: true });
    const study = await StudyModel.get({ id: 1 });

    expect(study.name).toBe("First");
    expect(api.calls).toBe(1);
  });

  test("a failed background refresh is logged, not thrown at the caller", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { api, StudyModel } = makeStudy({ cache: { for: 1000 }, optimistic: true });
    await StudyModel.get({ id: 1 });

    vi.setSystemTime(Date.now() + 5000);
    api.error = new Error("offline");
    await expect(StudyModel.get({ id: 1 })).resolves.toBeDefined();

    await vi.waitFor(() => expect(logged).toHaveBeenCalled());
    vi.useRealTimers();
    logged.mockRestore();
  });

  test("a failed background refresh clears the stamp, forcing the next get to the API", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { api, StudyModel } = makeStudy({ cache: { for: 1000 }, optimistic: true });
    const study = await StudyModel.get({ id: 1 });

    vi.setSystemTime(Date.now() + 5000);
    api.error = new Error("offline");
    await StudyModel.get({ id: 1 });
    await vi.waitFor(() => expect(stampOf(study)).toBeUndefined());

    // the next get is a real request, and its error arrives through the normal path
    api.error = undefined;
    api.name = "Recovered";
    expect((await StudyModel.get({ id: 1 })).name).toBe("Recovered");
    expect(api.calls).toBe(3);

    vi.useRealTimers();
    logged.mockRestore();
  });

  test("a failed background refresh expires even `cache: true`", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { api, StudyModel } = makeStudy({ cache: true, optimistic: true });
    const study = await StudyModel.get({ id: 1 });

    // nothing expires under `cache: true`, so drive the refresh by clearing the stamp
    setStamp(study, undefined);
    api.error = new Error("offline");
    await StudyModel.get({ id: 1 });
    await vi.waitFor(() => expect(logged).toHaveBeenCalled());

    // still unstamped, so the next get goes to the API rather than being cached forever
    expect(stampOf(study)).toBeUndefined();
    api.error = undefined;
    await StudyModel.get({ id: 1 });
    expect(api.calls).toBe(3);

    logged.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// concurrent gets
// ---------------------------------------------------------------------------

describe("concurrent get", () => {
  test("two gets for the same record share one request", async () => {
    const { api, StudyModel } = makeStudy();
    const [a, b] = await Promise.all([StudyModel.get({ id: 1 }), StudyModel.get({ id: 1 })]);

    expect(api.calls).toBe(1);
    expect(a).toBe(b);
  });

  test("gets for different records do not share", async () => {
    const { api, StudyModel } = makeStudy();
    await Promise.all([StudyModel.get({ id: 1 }), StudyModel.get({ id: 2 })]);
    expect(api.calls).toBe(2);
  });

  test("a get after the request settles sends a new one", async () => {
    const { api, StudyModel } = makeStudy();
    await StudyModel.get({ id: 1 });
    await StudyModel.get({ id: 1 });
    expect(api.calls).toBe(2);
  });

  test("a failed request is shared, then cleared", async () => {
    const { api, StudyModel } = makeStudy();
    api.error = new Error("offline");
    const results = await Promise.allSettled([
      StudyModel.get({ id: 1 }),
      StudyModel.get({ id: 1 }),
    ]);

    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(api.calls).toBe(1);

    api.error = undefined;
    await expect(StudyModel.get({ id: 1 })).resolves.toBeDefined();
    expect(api.calls).toBe(2);
  });

  test("a get with arguments beyond the params never shares", async () => {
    let calls = 0;
    const StudyModel = makeModel(StudySchema, {
      keys: ["id"],
      get: async ({ id }: { id: number }, _opts?: { tag: string }) => {
        calls++;
        return { id, name: "First" };
      },
    });
    // even the very same object: the rule is "no extra arguments", not an identity comparison
    const opts = { tag: "a" };
    await Promise.all([StudyModel.get({ id: 1 }, opts), StudyModel.get({ id: 1 }, opts)]);
    expect(calls).toBe(2);
  });

  test("optimistic background refreshes share one request", async () => {
    const { api, StudyModel } = makeStudy({ cache: { for: 1000 }, optimistic: true });
    await StudyModel.get({ id: 1 });

    vi.setSystemTime(Date.now() + 5000);
    await Promise.all([StudyModel.get({ id: 1 }), StudyModel.get({ id: 1 })]);
    expect(api.calls).toBe(2);
    vi.useRealTimers();
  });

  test("clearIdentity detaches requests already in flight", async () => {
    const { api, StudyModel } = makeStudy();
    const before = StudyModel.get({ id: 1 });
    StudyModel.clearIdentity();
    await Promise.all([before, StudyModel.get({ id: 1 })]);
    expect(api.calls).toBe(2);
  });

  test("a subclass does not join its parent's request", async () => {
    const { api, StudyModel } = makeStudy();
    class Special extends StudyModel {}
    const [base, special] = await Promise.all([StudyModel.get({ id: 1 }), Special.get({ id: 1 })]);

    expect(api.calls).toBe(2);
    expect(special).toBeInstanceOf(Special);
    expect(base).not.toBeInstanceOf(Special);
  });
});

// ---------------------------------------------------------------------------
// shared requests and abort signals
// ---------------------------------------------------------------------------

describe("shared requests and abort signals", () => {
  /** A `get` held open until released, recording the signal each request was sent with. */
  const makeHeld = (config: { cache?: boolean | { for: number }; optimistic?: boolean } = {}) => {
    const sent: (AbortSignal | undefined)[] = [];
    let release = () => {};
    const StudyModel = makeModel(StudySchema, {
      keys: ["id"],
      get: ({ id }: { id: number }, options?: { signal: AbortSignal }) => {
        sent.push(options?.signal);
        return new Promise<{ id: number; name: string }>((resolve) => {
          release = () => resolve({ id, name: `Fetched ${sent.length}` });
        });
      },
      ...config,
    });
    return { StudyModel, sent, release: () => release() };
  };

  test("gets passing only a signal share one request, sent with a signal of its own", async () => {
    const { StudyModel, sent, release } = makeHeld();
    const a = new AbortController();
    const b = new AbortController();
    const first = StudyModel.get({ id: 1 }, { signal: a.signal });
    const second = StudyModel.get({ id: 1 }, { signal: b.signal });
    release();

    expect(await first).toBe(await second);
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toBe(a.signal);
    expect(sent[0]).not.toBe(b.signal);
  });

  test("one caller aborting rejects only that caller; the request carries on", async () => {
    const { StudyModel, sent, release } = makeHeld();
    const a = new AbortController();
    const first = StudyModel.get({ id: 1 }, { signal: a.signal });
    const second = StudyModel.get({ id: 1 }, { signal: new AbortController().signal });

    a.abort();
    await expect(first).rejects.toBe(a.signal.reason);
    expect(sent[0]!.aborted).toBe(false);

    release();
    expect((await second).name).toBe("Fetched 1");
  });

  test("the request aborts once every caller has, and the next get starts afresh", async () => {
    const { StudyModel, sent } = makeHeld();
    const a = new AbortController();
    const b = new AbortController();
    const first = StudyModel.get({ id: 1 }, { signal: a.signal });
    const second = StudyModel.get({ id: 1 }, { signal: b.signal });

    a.abort();
    expect(sent[0]!.aborted).toBe(false);
    b.abort();
    expect(sent[0]!.aborted).toBe(true);
    await Promise.allSettled([first, second]);

    void StudyModel.get({ id: 1 }, { signal: new AbortController().signal });
    expect(sent).toHaveLength(2);
  });

  test("a caller with no signal keeps the request alive", async () => {
    const { StudyModel, sent, release } = makeHeld();
    const a = new AbortController();
    const withSignal = StudyModel.get({ id: 1 }, { signal: a.signal });
    const without = StudyModel.get({ id: 1 });

    a.abort();
    await expect(withSignal).rejects.toBeDefined();
    expect(sent[0]!.aborted).toBe(false);

    release();
    await expect(without).resolves.toBeDefined();
  });

  test("an already-aborted signal rejects without sending anything", async () => {
    const { StudyModel, sent } = makeHeld();
    const a = new AbortController();
    a.abort();
    await expect(StudyModel.get({ id: 1 }, { signal: a.signal })).rejects.toBe(a.signal.reason);
    expect(sent).toHaveLength(0);
  });

  test("a background refresh is never aborted by the caller that set it off", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { StudyModel, sent, release } = makeHeld({ cache: { for: 1000 }, optimistic: true });
    const first = StudyModel.get({ id: 1 });
    release();
    const study = await first;

    vi.setSystemTime(Date.now() + 5000);
    const a = new AbortController();
    expect(await StudyModel.get({ id: 1 }, { signal: a.signal })).toBe(study);
    a.abort(); // the component that asked unmounts

    expect(sent[1]!.aborted).toBe(false);
    release();
    await vi.waitFor(() => expect(study.name).toBe("Fetched 2"));
    expect(logged).not.toHaveBeenCalled();

    vi.useRealTimers();
    logged.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// retention — `cache` holds records strongly for as long as it promises them
// ---------------------------------------------------------------------------

/** The keys a model class is holding strongly, read fresh on each call. */
const heldKeys = (Model: object) => (): (string | number)[] => (Model as any)[RETAINED]();

describe("retention", () => {
  test("cache: { for } releases the record once the window passes", async () => {
    vi.useFakeTimers();
    const { StudyModel } = makeStudy({ cache: { for: 1000 } });
    await StudyModel.get({ id: 1 });
    const retention = heldKeys(StudyModel);
    expect(retention()).toEqual([1]);

    vi.advanceTimersByTime(1000);
    expect(retention()).toEqual([]);
    vi.useRealTimers();
  });

  test("a reload re-arms the window", async () => {
    vi.useFakeTimers();
    const { StudyModel } = makeStudy({ cache: { for: 1000 } });
    const study = await StudyModel.get({ id: 1 });
    const retention = heldKeys(StudyModel);

    vi.advanceTimersByTime(800);
    await study.reload();
    vi.advanceTimersByTime(800);
    expect(retention()).toEqual([1]);

    vi.advanceTimersByTime(200);
    expect(retention()).toEqual([]);
    vi.useRealTimers();
  });

  test("records expire one by one, on a single timer", async () => {
    vi.useFakeTimers();
    const { StudyModel } = makeStudy({ cache: { for: 1000 } });
    const retention = heldKeys(StudyModel);
    await StudyModel.get({ id: 1 });
    vi.advanceTimersByTime(400);
    await StudyModel.get({ id: 2 });
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(600);
    expect(retention()).toEqual([2]);
    vi.advanceTimersByTime(400);
    expect(retention()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  test("cache: true holds until forget", async () => {
    vi.useFakeTimers();
    const { StudyModel } = makeStudy({ cache: true });
    const retention = heldKeys(StudyModel);
    const study = await StudyModel.get({ id: 1 });

    vi.advanceTimersByTime(1e9);
    expect(retention()).toEqual([1]);
    expect(vi.getTimerCount()).toBe(0);

    StudyModel.forget(study);
    expect(retention()).toEqual([]);
    vi.useRealTimers();
  });

  test("clearIdentity releases everything and stops the timer", async () => {
    vi.useFakeTimers();
    const { StudyModel } = makeStudy({ cache: { for: 1000 } });
    const retention = heldKeys(StudyModel);
    await StudyModel.get({ id: 1 });
    await StudyModel.get({ id: 2 });

    StudyModel.clearIdentity();
    expect(retention()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  test("a model without cache holds nothing", async () => {
    const { StudyModel } = makeStudy();
    await StudyModel.get({ id: 1 });
    expect(heldKeys(StudyModel)()).toEqual([]);
  });

  test("records loaded by a list are held too", async () => {
    const { StudyModel } = makeStudy({ cache: true });
    StudyModel.instantiate({ id: 7, name: "From a list" });
    expect(heldKeys(StudyModel)()).toEqual([7]);
  });
});

// ---------------------------------------------------------------------------
// forgotten mid-flight
// ---------------------------------------------------------------------------

describe("a record forgotten while its fetch is in flight", () => {
  const makeGated = () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const StudyModel = makeModel(StudySchema, {
      keys: ["id"],
      get: async ({ id }: { id: number }) => {
        calls++;
        if (calls > 1) await gate;
        return { id, name: "Fetched" };
      },
      delete: async () => {},
    });
    return { StudyModel, release: () => release(), calls: () => calls };
  };

  test("a get after a delete does not join the request from before it", async () => {
    const { StudyModel, release, calls } = makeGated();
    const study = await StudyModel.get({ id: 1 });

    const late = StudyModel.get({ id: 1 });
    await study.delete();
    const fresh = StudyModel.get({ id: 1 });
    release();

    await Promise.all([late, fresh]);
    expect(calls()).toBe(3);
  });

  test("clearIdentity keeps a pre-teardown fetch out of the map", async () => {
    const { StudyModel, release } = makeGated();
    await StudyModel.get({ id: 1 });

    const late = StudyModel.get({ id: 1 });
    StudyModel.clearIdentity();
    release();

    // the caller still gets its data, detached
    expect((await late).name).toBe("Fetched");
    expect(StudyModel.peek({ id: 1 })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// where the mechanisms meet
// ---------------------------------------------------------------------------

describe("cache, optimistic, sharing and versionKey together", () => {
  test("a failed shared background refresh is logged once and clears the stamp", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { api, StudyModel } = makeStudy({ cache: { for: 1000 }, optimistic: true });
    const study = await StudyModel.get({ id: 1 });

    vi.setSystemTime(Date.now() + 5000);
    api.error = new Error("offline");
    await Promise.all([StudyModel.get({ id: 1 }), StudyModel.get({ id: 1 })]);
    await vi.waitFor(() => expect(stampOf(study)).toBeUndefined());

    expect(api.calls).toBe(2);
    expect(logged).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
    logged.mockRestore();
  });

  test("a get during an optimistic refresh joins it rather than sending another", async () => {
    const { api, StudyModel } = makeStudy({ cache: { for: 1000 }, optimistic: true });
    const study = await StudyModel.get({ id: 1 });

    vi.setSystemTime(Date.now() + 5000);
    api.name = "Second";
    const stale = StudyModel.get({ id: 1 });
    // the stamp is still stale, so this one would refresh too — it joins instead
    const again = StudyModel.get({ id: 1 });

    expect(await stale).toBe(study);
    expect(await again).toBe(study);
    await vi.waitFor(() => expect(study.name).toBe("Second"));
    expect(api.calls).toBe(2);
    vi.useRealTimers();
  });

  test("an older payload landing late is neither applied nor re-arms retention", async () => {
    vi.useFakeTimers();
    const VersionSchema = T.Object({ id: T.Number(), name: T.String(), version: T.Number() });
    let respond: (v: { id: number; name: string; version: number }) => void = () => {};
    const VModel = makeModel(VersionSchema, {
      keys: ["id"],
      versionKey: "version",
      cache: { for: 1000 },
      get: (_params: { id: number }) => new Promise((resolve) => (respond = resolve)),
    });

    const slow = VModel.get({ id: 1 });
    const current = VModel.instantiate({ id: 1, name: "Newer", version: 2 });
    vi.advanceTimersByTime(600);

    respond({ id: 1, name: "Older", version: 1 });
    expect(await slow).toBe(current);
    expect(current.name).toBe("Newer");

    vi.advanceTimersByTime(400);
    expect(heldKeys(VModel)()).toEqual([]);
    vi.useRealTimers();
  });
});
