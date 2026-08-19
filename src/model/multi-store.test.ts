import { describe, expect, test, vi } from "vite-plus/test";
import * as T from "typebox";
import { autorun, makeObservable, observable } from "mobx";
import { makeModel } from "./make-model";
import { createStore, makeStore } from "./make-store";

// ---------------------------------------------------------------------------
// One store per collection, instead of one store with many collections.
// The question: does the model-level identity map make these behave as one?
// ---------------------------------------------------------------------------

const SurveySchema = T.Object({ id: T.Number(), title: T.String(), status: T.String() });

const setup = () => {
  let rows = [
    { id: 1, title: "Alpha", status: "draft" },
    { id: 2, title: "Beta", status: "published" },
  ];

  const api = {
    list: (status: string) =>
      Promise.resolve(rows.filter((r) => r.status === status).map((r) => ({ ...r }))),
    rename: vi.fn(({ id }: { id: number }, body: { title: string }) => {
      const row = rows.find((r) => r.id === id)!;
      row.title = body.title;
      return Promise.resolve({ ...row });
    }),
    remove: vi.fn(({ id }: { id: number }) => {
      rows = rows.filter((r) => r.id !== id);
      return Promise.resolve();
    }),
    create: vi.fn((body: { title: string; status: string }) => {
      const row = { id: rows.length + 10, ...body };
      rows = [...rows, row];
      return Promise.resolve({ ...row });
    }),
  };

  const SurveyModel = makeModel(SurveySchema, {
    keys: ["id"] as const,
    update: api.rename,
    delete: api.remove,
  });

  // Two stores, one per status. No collections feature involved.
  const DraftStore = makeStore(SurveyModel, { list: () => api.list("draft") });
  const PublishedStore = makeStore(SurveyModel, { list: () => api.list("published") });

  return { api, SurveyModel, DraftStore, PublishedStore };
};

describe("one store per collection", () => {
  test("separate stores share model instances", async () => {
    const { SurveyModel, DraftStore } = setup();
    const drafts = new DraftStore();
    await drafts.list.getOrLoad();

    const fromList = drafts.list.value[0]!;
    const fromGet = SurveyModel.instantiate({ id: 1, title: "Alpha", status: "draft" });

    expect(fromGet).toBe(fromList);
  });

  test("an edit through one store is visible in another", async () => {
    const { DraftStore } = setup();
    // two stores over the same query, so the same record really is in both lists
    const a = new DraftStore();
    const b = new DraftStore();
    await a.list.getOrLoad();
    await b.list.getOrLoad();
    expect(b.list.value[0]).toBe(a.list.value[0]);

    await a.list.value[0]!.update({ title: "Renamed" });

    expect(b.list.value[0]!.title).toBe("Renamed");
  });

  test("a model belongs to no store in particular", async () => {
    const { DraftStore } = setup();
    const a = new DraftStore();
    const b = new DraftStore(); // two stores over the same query
    await a.list.getOrLoad();
    await b.list.getOrLoad();

    // the same instance is in both lists, and there is no notion of which one owns it
    expect(b.list.value[0]).toBe(a.list.value[0]);
    expect("store" in a.list.value[0]!).toBe(false);
  });

  test("delete removes the model from every store listening to the model", async () => {
    const { DraftStore } = setup();
    const a = new DraftStore();
    const b = new DraftStore();
    await a.list.getOrLoad();
    await b.list.getOrLoad();

    await a.list.value[0]!.delete();

    expect(a.list.value).toHaveLength(0);
    expect(b.list.value).toHaveLength(0);
  });

  test("a create marks every store's list stale, without either having to know about the other", async () => {
    const { api, SurveyModel } = setup();
    const CreatingModel = makeModel(SurveySchema, {
      keys: ["id"] as const,
      create: (body: { title: string; status: string }) => api.create(body),
    });
    void SurveyModel;
    const a = createStore(CreatingModel, { list: () => api.list("draft") });
    const b = createStore(CreatingModel, { list: () => api.list("draft") });
    const stopA = autorun(() => void a.list.value.slice());
    const stopB = autorun(() => void b.list.value.slice());
    await vi.waitUntil(() => a.list.loaded && b.list.loaded);
    expect(a.list.value).toHaveLength(1);

    await a.create({ title: "New", status: "draft" });
    await vi.waitUntil(() => a.list.value.length === 2 && b.list.value.length === 2);

    stopA();
    stopB();
  });
});

// ---------------------------------------------------------------------------
// The `{ signal }` fetch contract, and invalidateOn
// ---------------------------------------------------------------------------

describe("list fetch contract", () => {
  const Schema = T.Object({ id: T.Number(), title: T.String(), status: T.String() });

  test("a client whose first parameter is an options bag attaches directly", async () => {
    const signals: AbortSignal[] = [];
    // the shape of a GET with no path variables: options-only first parameter
    const listAll = (options: { signal?: AbortSignal }) => {
      signals.push(options.signal!);
      return Promise.resolve([{ id: 1, title: "Alpha", status: "draft" }]);
    };
    const Model = makeModel(Schema, { keys: ["id"] as const });

    const store = createStore(Model, { list: listAll }); // ← no wrapper arrow
    await store.list.getOrLoad();

    expect(store.list.value).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]!.aborted).toBe(false);
  });

  test("query params spread the options through", async () => {
    const calls: { status: string; signal?: AbortSignal }[] = [];
    const list = (params: { status: string; signal?: AbortSignal }) => {
      calls.push(params);
      return Promise.resolve([{ id: 1, title: "Alpha", status: params.status }]);
    };
    const Model = makeModel(Schema, { keys: ["id"] as const });

    const store = createStore(Model, {
      list: (options) => list({ status: "draft", ...options }),
    });
    await store.list.getOrLoad();

    expect(calls[0]!.status).toBe("draft");
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  test("a superseded list request is aborted", async () => {
    const signals: AbortSignal[] = [];
    const Model = makeModel(Schema, { keys: ["id"] as const });
    const store = createStore(Model, {
      list: ({ signal }) => {
        signals.push(signal);
        return new Promise<never[]>(() => {});
      },
    });

    void store.list.getOrLoad();
    void store.list.reload();

    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
  });
});

describe("invalidateOn", () => {
  const Schema = T.Object({ id: T.Number(), title: T.String(), status: T.String() });

  const setupStore = (invalidateOn?: readonly ("created" | "updated" | "deleted")[]) => {
    let rows = [{ id: 1, title: "Alpha", status: "draft" }];
    const list = vi.fn(() => Promise.resolve(rows.map((r) => ({ ...r }))));
    const Model = makeModel(Schema, {
      keys: ["id"] as const,
      update: ({ id }: { id: number }, body: { title: string }) => {
        const row = rows.find((r) => r.id === id)!;
        row.title = body.title;
        return Promise.resolve({ ...row });
      },
      delete: ({ id }: { id: number }) => {
        rows = rows.filter((r) => r.id !== id);
        return Promise.resolve();
      },
    });
    const store = createStore(Model, invalidateOn ? { list, invalidateOn } : { list });
    return { store, list, Model };
  };

  test("an update does not refetch by default", async () => {
    const { store, list } = setupStore();
    const stop = autorun(() => void store.list.value.slice());
    await vi.waitUntil(() => store.list.loaded);
    expect(list).toHaveBeenCalledTimes(1);

    await store.list.value[0]!.update({ title: "Renamed" });
    await new Promise((r) => setTimeout(r, 20));

    // identity already showed the change, so no request was needed
    expect(list).toHaveBeenCalledTimes(1);
    expect(store.list.value[0]!.title).toBe("Renamed");
    stop();
  });

  test("listing updated opts into refetching", async () => {
    const { store, list } = setupStore(["updated"]);
    const stop = autorun(() => void store.list.value.slice());
    await vi.waitUntil(() => store.list.loaded);

    await store.list.value[0]!.update({ title: "Renamed" });
    await vi.waitUntil(() => list.mock.calls.length === 2);
    stop();
  });

  test("a delete removes the row without refetching by default", async () => {
    const { store, list } = setupStore();
    const stop = autorun(() => void store.list.value.slice());
    await vi.waitUntil(() => store.list.loaded);

    await store.list.value[0]!.delete();
    await new Promise((r) => setTimeout(r, 20));

    expect(store.list.value).toHaveLength(0);
    expect(list).toHaveBeenCalledTimes(1);
    stop();
  });

  test("listing deleted refetches as well as removing", async () => {
    const { store, list } = setupStore(["deleted"]);
    const stop = autorun(() => void store.list.value.slice());
    await vi.waitUntil(() => store.list.loaded);

    await store.list.value[0]!.delete();

    // removed immediately, and the list refetched on top of that
    expect(store.list.value).toHaveLength(0);
    await vi.waitUntil(() => list.mock.calls.length === 2);
    stop();
  });
});

describe("collection()", () => {
  const Schema = T.Object({ id: T.Number(), title: T.String(), status: T.String() });
  const Model = makeModel(Schema, {
    keys: ["id"] as const,
    delete: () => Promise.resolve(),
    create: (body: { title: string }) => Promise.resolve({ id: 9, status: "draft", ...body }),
  });

  test("a config `list` and an added collection behave identically", async () => {
    const listA = vi.fn(() => Promise.resolve([{ id: 1, title: "A", status: "draft" }]));
    const listB = vi.fn(() => Promise.resolve([{ id: 2, title: "B", status: "published" }]));

    class TwoLists extends makeStore(Model, { list: listA }) {
      other = this.collection(listB);
    }
    const store = new TwoLists();
    // observed, so an invalidation refetches rather than merely resetting
    const stopA = autorun(() => void store.list.value.slice());
    const stopB = autorun(() => void store.other.value.slice());
    await vi.waitUntil(() => store.list.loaded && store.other.loaded);

    // both transformed into models
    expect(store.list.value[0]!.title).toBe("A");
    expect(store.other.value[0]!.title).toBe("B");

    // both join the store's mutation handling: a delete sweeps every list
    await store.other.value[0]!.delete();
    expect(store.other.value).toHaveLength(0);

    // and a create marks both stale
    await store.create({ title: "New" });
    await vi.waitUntil(() => listA.mock.calls.length === 2 && listB.mock.calls.length === 2);

    stopA();
    stopB();
  });

  test("a collection can override invalidateOn", async () => {
    const quiet = vi.fn(() => Promise.resolve([{ id: 1, title: "A", status: "draft" }]));

    class Quiet extends makeStore(Model) {
      rows = this.collection(quiet, { invalidateOn: [] });
    }
    const store = new Quiet();
    const stop = autorun(() => void store.rows.value.slice());
    await vi.waitUntil(() => store.rows.loaded);

    await store.create({ title: "New" });
    await new Promise((r) => setTimeout(r, 20));

    expect(quiet).toHaveBeenCalledTimes(1); // opted out of refetching
    stop();
  });

  test("a subclass may call makeObservable, but not with an options object", () => {
    class WithState extends makeStore(Model) {
      query = "";
      constructor() {
        super();
        makeObservable(this, { query: observable });
      }
    }
    expect(() => new WithState()).not.toThrow();

    class WithOptions extends makeStore(Model) {
      query = "";
      constructor() {
        super();
        makeObservable(this, { query: observable }, { autoBind: true });
      }
    }
    // the base already made the instance observable, so mobx rejects a second options object
    expect(() => new WithOptions()).toThrow(/Options can't be provided/);
  });
});
