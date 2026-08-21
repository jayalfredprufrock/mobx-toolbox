import { describe, expect, test, vi } from "vite-plus/test";
import * as T from "typebox";
import { LOADED_AT, makeModel } from "./make-model";

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
