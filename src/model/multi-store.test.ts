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

  // Two stores, one per status. Each declares its own list, as any subclassed store does.
  class DraftStore extends makeStore(SurveyModel) {
    list = this.collection(() => api.list("draft"));
  }
  class PublishedStore extends makeStore(SurveyModel) {
    list = this.collection(() => api.list("published"));
  }

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
    const a = createStore(CreatingModel, { collections: { list: () => api.list("draft") } });
    const b = createStore(CreatingModel, { collections: { list: () => api.list("draft") } });
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

    const store = createStore(Model, { collections: { list: listAll } }); // ← no wrapper arrow
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
      collections: { list: (options) => list({ status: "draft", ...options }) },
    });
    await store.list.getOrLoad();

    expect(calls[0]!.status).toBe("draft");
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  test("a superseded list request is aborted", async () => {
    const signals: AbortSignal[] = [];
    const Model = makeModel(Schema, { keys: ["id"] as const });
    const store = createStore(Model, {
      collections: {
        list: ({ signal }) => {
          signals.push(signal);
          return new Promise<never[]>(() => {});
        },
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
    const store = createStore(
      Model,
      invalidateOn ? { collections: { list }, invalidateOn } : { collections: { list } },
    );
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

  test("every collection on a subclass behaves identically", async () => {
    const listA = vi.fn(() => Promise.resolve([{ id: 1, title: "A", status: "draft" }]));
    const listB = vi.fn(() => Promise.resolve([{ id: 2, title: "B", status: "published" }]));

    class TwoLists extends makeStore(Model) {
      list = this.collection(listA);
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

// ---------------------------------------------------------------------------
// sort — declared once for the store, overridable per collection
// ---------------------------------------------------------------------------

describe("sort", () => {
  const Schema = T.Object({ id: T.Number(), title: T.String() });
  const unsorted = () => [
    { id: 3, title: "Charlie" },
    { id: 1, title: "Alpha" },
    { id: 2, title: "Bravo" },
  ];
  const byTitle = (a: { title: string }, b: { title: string }) => a.title.localeCompare(b.title);

  test("the store's sort orders every collection", async () => {
    const Model = makeModel(Schema, { keys: ["id"] });
    class Store extends makeStore(Model, { sort: byTitle }) {
      a = this.collection(() => Promise.resolve(unsorted()));
      b = this.collection(() => Promise.resolve(unsorted()));
    }
    const store = new Store();

    const [a, b] = await Promise.all([store.a.getOrLoad(), store.b.getOrLoad()]);

    expect(a.map((m) => m.title)).toEqual(["Alpha", "Bravo", "Charlie"]);
    expect(b.map((m) => m.title)).toEqual(["Alpha", "Bravo", "Charlie"]);
  });

  test("a collection can override the store's sort", async () => {
    const Model = makeModel(Schema, { keys: ["id"] });
    class Store extends makeStore(Model, { sort: byTitle }) {
      byId = this.collection(() => Promise.resolve(unsorted()), {
        sort: (a, b) => a.id - b.id,
      });
    }

    const rows = await new Store().byId.getOrLoad();

    expect(rows.map((m) => m.id)).toEqual([1, 2, 3]);
  });

  test("sort: false keeps server order on that one collection", async () => {
    const Model = makeModel(Schema, { keys: ["id"] });
    class Store extends makeStore(Model, { sort: byTitle }) {
      ranked = this.collection(() => Promise.resolve(unsorted()), { sort: false });
      named = this.collection(() => Promise.resolve(unsorted()));
    }
    const store = new Store();

    const [ranked, named] = await Promise.all([store.ranked.getOrLoad(), store.named.getOrLoad()]);

    expect(ranked.map((m) => m.id)).toEqual([3, 1, 2]);
    expect(named.map((m) => m.title)).toEqual(["Alpha", "Bravo", "Charlie"]);
  });

  test("a created record lands in sorted position rather than on top", async () => {
    const Model = makeModel(Schema, {
      keys: ["id"],
      create: (body: { title: string }) => Promise.resolve({ id: 4, ...body }),
    });
    const store = createStore(Model, {
      sort: byTitle,
      optimisticCreate: true,
      collections: { list: () => Promise.resolve(unsorted()) },
    });
    await store.list.getOrLoad();

    await store.create({ title: "Bravado" });

    expect(store.list.value.map((m) => m.title)).toEqual(["Alpha", "Bravado", "Bravo", "Charlie"]);
  });

  test("without a sort a created record still goes on top", async () => {
    const Model = makeModel(Schema, {
      keys: ["id"],
      create: (body: { title: string }) => Promise.resolve({ id: 4, ...body }),
    });
    const store = createStore(Model, {
      optimisticCreate: true,
      collections: { list: () => Promise.resolve(unsorted()) },
    });
    await store.list.getOrLoad();

    await store.create({ title: "Zulu" });

    expect(store.list.value[0]!.title).toBe("Zulu");
  });
});

// ---------------------------------------------------------------------------
// createStore collections
// ---------------------------------------------------------------------------

describe("createStore collections", () => {
  const Schema = T.Object({ id: T.Number(), title: T.String(), status: T.String() });
  const row = (id: number, status: string) => ({ id, title: `Row ${id}`, status });

  test("each collection lands on the instance under its own name", async () => {
    const Model = makeModel(Schema, { keys: ["id"] });
    const drafts = vi.fn(() => Promise.resolve([row(1, "draft")]));
    const published = vi.fn(() => Promise.resolve([row(2, "published")]));
    const store = createStore(Model, { collections: { drafts, published } });

    const [d, p] = await Promise.all([store.drafts.getOrLoad(), store.published.getOrLoad()]);

    expect(d[0]!.id).toBe(1);
    expect(p[0]!.id).toBe(2);
  });

  test("the verbose form carries that collection's own options", async () => {
    const Model = makeModel(Schema, { keys: ["id"] });
    const quiet = vi.fn(() => Promise.resolve([row(1, "draft")]));
    const store = createStore(Model, {
      collections: { quiet: { fetch: quiet, invalidateOn: [] } },
    });
    const stop = autorun(() => void store.quiet.value.slice());
    await vi.waitUntil(() => store.quiet.loaded);

    store.quiet.value[0]!.setData(row(1, "draft"));
    Model.notifyListeners("created", store.quiet.value[0]!);
    await new Promise((r) => setTimeout(r, 20));

    // invalidateOn: [] — a create does not mark this one stale
    expect(quiet).toHaveBeenCalledTimes(1);
    stop();
  });

  test("every collection joins the store's mutation handling", async () => {
    const Model = makeModel(Schema, {
      keys: ["id"],
      delete: vi.fn().mockResolvedValue(undefined),
    });
    const store = createStore(Model, {
      collections: {
        a: () => Promise.resolve([row(1, "draft")]),
        b: () => Promise.resolve([row(1, "draft")]),
      },
    });
    await Promise.all([store.a.getOrLoad(), store.b.getOrLoad()]);

    await store.a.value[0]!.delete();

    expect(store.a.value).toHaveLength(0);
    expect(store.b.value).toHaveLength(0);
  });

  test("a collection may not shadow a member the store already has", () => {
    const Model = makeModel(Schema, { keys: ["id"] });

    expect(() =>
      createStore(Model, {
        // @ts-expect-error `remove` is a store member, so the name is rejected at compile time too
        collections: { remove: () => Promise.resolve([]) },
      }),
    ).toThrow(/would shadow/);
  });
});

// ---------------------------------------------------------------------------
// optimisticCreate — off unless a list asks for it
// ---------------------------------------------------------------------------

describe("optimisticCreate", () => {
  const Schema = T.Object({ id: T.Number(), title: T.String() });
  const rows = () => [{ id: 1, title: "Alpha" }];
  const makeCreatingModel = () =>
    makeModel(Schema, {
      keys: ["id"],
      create: (body: { title: string }) => Promise.resolve({ id: 2, ...body }),
    });

  test("a created record does not appear until the refetch confirms it", async () => {
    const server = [{ id: 1, title: "Alpha" }];
    const Model = makeModel(Schema, {
      keys: ["id"],
      create: (body: { title: string }) => {
        const row = { id: 2, ...body };
        server.push(row);
        return Promise.resolve(row);
      },
    });
    const store = createStore(Model, {
      collections: { list: () => Promise.resolve(server.map((r) => ({ ...r }))) },
    });
    await store.list.getOrLoad();

    await store.create({ title: "Beta" });

    // nothing was inserted behind the server's back
    expect(store.list.value).toHaveLength(1);

    // but the `created` event marked it stale, so it arrives on the next load
    await store.list.reload();
    expect(store.list.value).toHaveLength(2);
  });

  test("a single collection can opt in while its neighbours stay off", async () => {
    const Model = makeCreatingModel();
    const store = createStore(Model, {
      collections: {
        all: { fetch: () => Promise.resolve(rows()), optimisticCreate: true },
        filtered: () => Promise.resolve(rows()),
      },
    });
    await Promise.all([store.all.getOrLoad(), store.filtered.getOrLoad()]);

    const created = await store.create({ title: "Beta" });

    expect(store.all.value[0]).toBe(created);
    expect(store.filtered.value).toHaveLength(1);
  });

  test("a collection can opt out of a store that turned it on", async () => {
    const Model = makeCreatingModel();
    class Store extends makeStore(Model, { optimisticCreate: true }) {
      all = this.collection(() => Promise.resolve(rows()));
      search = this.collection(() => Promise.resolve(rows()), { optimisticCreate: false });
    }
    const store = new Store();
    await Promise.all([store.all.getOrLoad(), store.search.getOrLoad()]);

    await store.create({ title: "Beta" });

    expect(store.all.value).toHaveLength(2);
    expect(store.search.value).toHaveLength(1);
  });
});
