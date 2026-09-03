import { describe, expect, test, vi } from "vite-plus/test";
import { autorun } from "mobx";
import * as T from "typebox";
import { makeModel } from "./make-model";
import { createStore, makeStore } from "./make-store";
import type { LazyPageRequest, LazyPageResult } from "../lazy/lazy";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

const SurveySchema = T.Object({
  id: T.Number(),
  title: T.String(),
  status: T.String(),
});
type SurveyPayload = T.Static<typeof SurveySchema>;

const payloads = (from: number, count: number): SurveyPayload[] =>
  Array.from({ length: count }, (_, i) => ({
    id: from + i,
    title: `s${from + i}`,
    status: "draft",
  }));

/** A cursor-paginated endpoint over `total` records. */
const api = (total: number) =>
  vi.fn(({ cursor, limit }: LazyPageRequest<any>): Promise<LazyPageResult<SurveyPayload>> => {
    const start = cursor === undefined ? 0 : Number(cursor);
    const items = payloads(start, Math.min(limit, total - start));
    const next = start + items.length;
    return Promise.resolve({ items, cursor: next < total ? String(next) : null, total });
  });

const makeSurveyModel = () =>
  makeModel(SurveySchema, {
    keys: ["id"],
    create: (body: Partial<SurveyPayload>) =>
      Promise.resolve({ id: 999, title: "new", status: "draft", ...body }),
    delete: () => Promise.resolve(undefined),
  });

describe("pagedCollection", () => {
  test("payloads become identity-mapped models, page by page", async () => {
    const Survey = makeSurveyModel();
    const fetch = api(100);
    class Surveys extends makeStore(Survey) {
      feed = this.pagedCollection(fetch);
    }
    const store = new Surveys();

    await store.feed.getOrLoad();
    expect(store.feed.value?.length).toBe(50); // the default page size
    expect(store.feed.total).toBe(100);
    expect(store.feed.value?.[0]).toBeInstanceOf(Survey);
    expect(store.feed.value?.[0]).toBe(Survey.peek({ id: 0 }));

    await store.feed.loadMore();
    expect(store.feed.value?.length).toBe(100);
    expect(store.feed.hasMore).toBe(false);
    expect(store.feed.pages).toBe(2);
  });

  test("the envelope survives the trip so `total` and `cursor` still decide hasMore", async () => {
    const Survey = makeSurveyModel();
    // an endpoint that reports a cursor of null on the last page and nothing else
    const fetch = vi.fn(({ cursor }: LazyPageRequest<any>) =>
      Promise.resolve({
        items: payloads(cursor === undefined ? 0 : Number(cursor), 10),
        cursor: cursor === undefined ? "10" : null,
      }),
    );
    class Surveys extends makeStore(Survey) {
      feed = this.pagedCollection(fetch, { pageSize: 10 });
    }
    const store = new Surveys();

    await store.feed.getOrLoad();
    expect(store.feed.hasMore).toBe(true); // cursor present and non-null
    await store.feed.loadMore();
    expect(store.feed.hasMore).toBe(false); // cursor present and null — not "a short page"
    expect(store.feed.value?.length).toBe(20);
  });

  test("a bare array of payloads is a page too", async () => {
    const Survey = makeSurveyModel();
    const fetch = vi
      .fn<(r: LazyPageRequest<any>) => Promise<LazyPageResult<SurveyPayload>>>()
      .mockResolvedValueOnce(payloads(0, 10))
      .mockResolvedValueOnce(payloads(10, 3));
    class Surveys extends makeStore(Survey) {
      feed = this.pagedCollection(fetch, { pageSize: 10 });
    }
    const store = new Surveys();

    await store.feed.getOrLoad();
    expect(store.feed.hasMore).toBe(true);
    await store.feed.loadMore();
    expect(store.feed.value?.map((s) => s.id)).toEqual([...Array(13).keys()]);
    expect(store.feed.hasMore).toBe(false);
  });

  test("deduplicates on identityKey by default — the same record twice is the same object", async () => {
    const Survey = makeSurveyModel();
    const fetch = vi
      .fn<(r: LazyPageRequest<any>) => Promise<LazyPageResult<SurveyPayload>>>()
      // page two repeats the record page one ended on, as a cursor over a non-unique sort key does
      .mockResolvedValueOnce({ items: payloads(0, 3), cursor: "2" })
      .mockResolvedValueOnce({ items: payloads(2, 3), cursor: null });
    class Surveys extends makeStore(Survey) {
      feed = this.pagedCollection(fetch, { pageSize: 3 });
    }
    const store = new Surveys();

    await store.feed.getOrLoad();
    await store.feed.loadMore();

    expect(store.feed.value?.map((s) => s.id)).toEqual([0, 1, 2, 3, 4]);
    // without the dedupe this array would hold the *same instance* at two indices, which is two
    // table rows sharing one React key and one selection toggle hitting both
    const ids = store.feed.value!.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("dedupeBy can be overridden, and a model with no identity gets none", async () => {
    const Detached = makeModel(SurveySchema);
    const fetch = vi
      .fn<(r: LazyPageRequest<any>) => Promise<LazyPageResult<SurveyPayload>>>()
      .mockResolvedValue({ items: payloads(0, 2), cursor: null });
    class Store extends makeStore(Detached) {
      feed = this.pagedCollection(fetch, { pageSize: 2 });
    }
    const store = new Store();

    // no identity to key on, so no deduplication is attempted rather than a throw
    await store.feed.getOrLoad();
    expect(store.feed.value?.length).toBe(2);

    const Survey = makeSurveyModel();
    class ByTitle extends makeStore(Survey) {
      feed = this.pagedCollection(
        vi
          .fn<(r: LazyPageRequest<any>) => Promise<LazyPageResult<SurveyPayload>>>()
          .mockResolvedValueOnce({ items: payloads(0, 2), cursor: "2" })
          .mockResolvedValueOnce({
            items: [{ id: 9, title: "s0", status: "draft" }],
            cursor: null,
          }),
        { pageSize: 2, dedupeBy: (s) => s.title },
      );
    }
    const byTitle = new ByTitle();
    await byTitle.feed.getOrLoad();
    await byTitle.feed.loadMore();
    // a different record, but the same title: dropped, because that is what was asked for
    expect(byTitle.feed.value?.map((s) => s.id)).toEqual([0, 1]);
  });

  test("joins the store's mutation handling: a create restarts it at page one", async () => {
    const Survey = makeSurveyModel();
    const fetch = api(100);
    class Surveys extends makeStore(Survey) {
      feed = this.pagedCollection(fetch, { pageSize: 10 });
    }
    const store = new Surveys();
    const dispose = autorun(() => void store.feed.value);
    await tick(20);
    await store.feed.loadMore();
    expect(store.feed.pages).toBe(2);

    await store.create({ title: "brand new" });
    await tick(20);

    // the `created` event marked it stale, and marking a *paged* list stale means page one again:
    // membership and ordering of every later page depend on the first
    expect(store.feed.pages).toBe(1);
    expect(store.feed.value?.length).toBe(10);

    dispose();
  });

  test("a deletion drops the record from the accumulated pages without a refetch", async () => {
    const Survey = makeSurveyModel();
    const fetch = api(100);
    class Surveys extends makeStore(Survey) {
      feed = this.pagedCollection(fetch, { pageSize: 10 });
    }
    const store = new Surveys();
    const dispose = autorun(() => void store.feed.value);
    await tick(20);
    await store.feed.loadMore();

    const before = store.feed.value!.length;
    const calls = fetch.mock.calls.length;
    const victim = store.feed.value![5]!;
    await victim.delete();

    expect(store.feed.value?.includes(victim)).toBe(false);
    expect(store.feed.value?.length).toBe(before - 1);
    expect(fetch.mock.calls.length).toBe(calls); // removal needs no round trip

    dispose();
  });

  test("invalidateCollections reaches it, and remove() drops a model from it", async () => {
    const Survey = makeSurveyModel();
    const fetch = api(100);
    class Surveys extends makeStore(Survey) {
      feed = this.pagedCollection(fetch, { pageSize: 10 });
      drafts = this.collection(() => Promise.resolve(payloads(0, 2)));
    }
    const store = new Surveys();
    const dispose = autorun(() => {
      void store.feed.value;
      void store.drafts.value;
    });
    await tick(20);
    await store.feed.loadMore();
    expect(store.feed.pages).toBe(2);

    const kept = store.feed.value![0]!;
    store.remove(kept);
    expect(store.feed.value?.includes(kept)).toBe(false);

    store.invalidateCollections();
    await tick(20);
    expect(store.feed.pages).toBe(1);

    dispose();
  });

  test("a store-level sort is not applied one page at a time", async () => {
    const Survey = makeSurveyModel();
    // descending from the server
    const fetch = vi.fn(({ cursor }: LazyPageRequest<any>) => {
      const start = cursor === undefined ? 0 : Number(cursor);
      const items = payloads(start, 3).reverse();
      return Promise.resolve({ items, cursor: start < 3 ? String(start + 3) : null });
    });
    class Surveys extends makeStore(Survey, { sort: (a, b) => a.id - b.id }) {
      feed = this.pagedCollection(fetch, { pageSize: 3 });
      all = this.collection(() => Promise.resolve(payloads(0, 3).reverse()));
    }
    const store = new Surveys();

    await store.all.getOrLoad();
    expect(store.all.value?.map((s) => s.id)).toEqual([0, 1, 2]); // the store's sort applied

    await store.feed.getOrLoad();
    await store.feed.loadMore();
    // server order preserved: sorting each page against itself would have produced [2,1,0,5,4,3],
    // which is neither the server's order nor a sorted list
    expect(store.feed.value?.map((s) => s.id)).toEqual([2, 1, 0, 5, 4, 3]);
  });

  test("declared through createStore's pagedCollections", async () => {
    const Survey = makeSurveyModel();
    const fetch = api(30);
    const store = createStore(Survey, {
      collections: { drafts: () => Promise.resolve(payloads(0, 2)) },
      pagedCollections: { feed: { fetch, pageSize: 10 } },
    });

    await store.feed.getOrLoad();
    expect(store.feed.value?.length).toBe(10);
    expect(store.feed.total).toBe(30);
    await store.feed.loadMore();
    expect(store.feed.pages).toBe(2);

    await store.drafts.getOrLoad();
    expect(store.drafts.value?.length).toBe(2);
  });

  test("a paged collection name may not shadow a store member", () => {
    const Survey = makeSurveyModel();
    expect(() =>
      createStore(Survey, {
        collections: {},
        pagedCollections: { remove: () => Promise.resolve([]) } as any,
      }),
    ).toThrow(/shadow/);
  });

  test("the query reaches the fetch, and setQuery restarts the list", async () => {
    const Survey = makeSurveyModel();
    const seen: unknown[] = [];
    const fetch = vi.fn(({ cursor, query }: LazyPageRequest<{ status: string }>) => {
      seen.push(query);
      const start = cursor === undefined ? 0 : Number(cursor);
      return Promise.resolve({
        items: payloads(start, 5).map((p) => ({ ...p, status: query.status })),
        cursor: String(start + 5),
      });
    });
    class Surveys extends makeStore(Survey) {
      feed = this.pagedCollection(fetch, { pageSize: 5, query: { status: "draft" } });
    }
    const store = new Surveys();

    await store.feed.getOrLoad();
    await store.feed.loadMore();
    expect(store.feed.pages).toBe(2);
    expect(seen).toEqual([{ status: "draft" }, { status: "draft" }]);

    store.feed.setQuery({ status: "live" });
    await store.feed.getOrLoad();

    expect(store.feed.pages).toBe(1);
    expect(seen.at(-1)).toEqual({ status: "live" });
    expect(store.feed.value?.every((s) => s.status === "live")).toBe(true);
  });
});
