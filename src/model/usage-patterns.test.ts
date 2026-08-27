import { describe, expect, test, vi } from "vite-plus/test";
import { action, autorun, makeObservable, observable, runInAction } from "mobx";
import * as T from "typebox";
import { lazyObservableArray } from "../lazy-observable/lazy-observable";
import { TableModel } from "../table/table.model";
import type { RowData } from "../table/table.types";
import { makeModel, type ModelEventType, type ModelListener } from "./make-model";
import { makeStore } from "./make-store";

// ---------------------------------------------------------------------------
// Three shapes a store's single `list` can't express, implemented with today's
// primitives: server-side search, "load more", and page-at-a-time pagination.
// ---------------------------------------------------------------------------

const SurveySchema = T.Object({ id: T.Number(), title: T.String(), status: T.String() });
type Survey = T.Static<typeof SurveySchema>;

const SurveyModel = makeModel(SurveySchema, {
  keys: ["id"] as const,
  delete: () => Promise.resolve(),
  create: (body: { title: string }) => Promise.resolve({ id: 99, status: "draft", ...body }),
});
type SurveyInstance = InstanceType<typeof SurveyModel>;

const makeApi = () => {
  const all: Survey[] = Array.from({ length: 25 }, (_, i) => ({
    id: i + 1,
    title: `Survey ${i + 1}`,
    status: "draft",
  }));
  return {
    all,
    search: vi.fn(
      (params: { q: string; signal?: AbortSignal }) =>
        new Promise<Survey[]>((resolve) => {
          const matched = all.filter((s) => s.title.includes(params.q));
          setTimeout(() => resolve(matched.map((s) => ({ ...s }))), 1);
        }),
    ),
    // a cursor endpoint, returning an envelope rather than a bare array
    feed: vi.fn((params: { cursor?: number; limit: number }) => {
      const start = params.cursor ?? 0;
      const items = all.slice(start, start + params.limit).map((s) => ({ ...s }));
      const next = start + params.limit;
      return Promise.resolve({ items, nextCursor: next < all.length ? next : undefined });
    }),
    // a page endpoint, returning items plus a total
    page: vi.fn((params: { page: number; perPage: number }) => {
      const start = (params.page - 1) * params.perPage;
      return Promise.resolve({
        items: all.slice(start, start + params.perPage).map((s) => ({ ...s })),
        total: all.length,
      });
    }),
  };
};

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// ===========================================================================
// 1. Server-side search
// ===========================================================================

class SurveySearch extends makeStore(SurveyModel) {
  query = "";

  // Reading `this.query` here is what makes the refetch happen; the throttle folds a burst of
  // keystrokes into one request, and the signal aborts whatever it supersedes. Transforming payloads
  // into models and joining the store's mutation handling both come for free.
  results = this.collection((options) => this.api.search({ q: this.query, ...options }), {
    trackDependencies: { throttle: 10 },
  });

  constructor(private readonly api: ReturnType<typeof makeApi>) {
    super();
    // note: no options object — mobx rejects one on an already-observable instance
    makeObservable(this, { query: observable, setQuery: action });
  }

  setQuery(q: string): void {
    this.query = q;
  }
}

// ===========================================================================
// 2. "Load more" — accumulating, imperative
// ===========================================================================

class SurveyFeed implements ModelListener {
  rows = observable.array<SurveyInstance>([], { deep: false });
  loading = false;
  hasMore = true;
  private cursor: number | undefined;

  constructor(private readonly api: ReturnType<typeof makeApi>) {
    makeObservable(this, {
      rows: observable,
      loading: observable,
      hasMore: observable,
      loadMore: true,
      reset: true,
      onModelEvent: true,
    });
    SurveyModel.addListener(this);
  }

  async loadMore(): Promise<void> {
    if (this.loading || !this.hasMore) return;
    runInAction(() => (this.loading = true));
    const page = await this.api.feed({ cursor: this.cursor, limit: 10 });
    runInAction(() => {
      this.rows.push(...page.items.map((r) => SurveyModel.instantiate(r)));
      this.cursor = page.nextCursor;
      this.hasMore = page.nextCursor !== undefined;
      this.loading = false;
    });
  }

  reset(): void {
    runInAction(() => {
      this.rows.clear();
      this.cursor = undefined;
      this.hasMore = true;
    });
  }

  onModelEvent(type: ModelEventType, model: SurveyInstance): void {
    // a feed must not "invalidate" — that would throw away everything loaded so far
    if (type === "deleted") this.rows.remove(model);
    if (type === "created" && !this.rows.includes(model)) this.rows.unshift(model);
  }
}

// ===========================================================================
// 3. Page-at-a-time pagination
// ===========================================================================

class SurveyPager implements ModelListener {
  page = 1;
  total = 0;
  readonly perPage = 10;

  readonly rows;

  constructor(private readonly api: ReturnType<typeof makeApi>) {
    this.rows = lazyObservableArray(
      async () => {
        const res = await this.api.page({ page: this.page, perPage: this.perPage });
        // the envelope's other fields have to be smuggled out as a side effect
        runInAction(() => (this.total = res.total));
        return res.items.map((r) => SurveyModel.instantiate(r));
      },
      { deep: false, trackDependencies: true },
    );
    makeObservable(
      this,
      { page: observable, total: observable, setPage: true },
      { autoBind: true },
    );
    SurveyModel.addListener(this);
  }

  get pageCount(): number {
    return Math.ceil(this.total / this.perPage);
  }

  setPage(page: number): void {
    this.page = page;
  }

  onModelEvent(type: ModelEventType, model: SurveyInstance): void {
    if (type === "deleted") this.rows.value?.remove(model);
    if (type === "created") this.rows.invalidate();
  }
}

// ===========================================================================

describe("server-side search", () => {
  test("typing drives one throttled request per burst, and aborts what it supersedes", async () => {
    const api = makeApi();
    const search = new SurveySearch(api);
    const stop = autorun(() => void search.results.value?.slice());
    await tick();
    expect(api.search).toHaveBeenCalledTimes(1);

    search.setQuery("1");
    search.setQuery("11");
    search.setQuery("111");
    await tick(60);

    // one coalesced refetch rather than three
    expect(api.search).toHaveBeenCalledTimes(2);
    expect(search.results.value).toHaveLength(0); // no "Survey 111"
    stop();
  });
});

describe("load more", () => {
  test("a table keeps its selection across a load more", async () => {
    const api = makeApi();
    const feed = new SurveyFeed(api);
    await feed.loadMore();

    const table = new TableModel({
      rows: () => feed.rows,
      getRowId: (row: RowData) => (row as SurveyInstance).id,
    });
    const stop = autorun(() => void table.clientFilteredRows.length);
    table.selectedIds.add(1);

    await feed.loadMore();

    expect(table.rows).toHaveLength(20);
    expect([...table.selectedIds]).toEqual([1]);
    stop();
  });

  test("mutations reach the feed without it invalidating everything", async () => {
    const api = makeApi();
    const feed = new SurveyFeed(api);
    await feed.loadMore();
    const loaded = feed.rows.length;

    const created = await SurveyModel.create({ title: "Brand new" });
    expect(feed.rows[0]).toBe(created);
    expect(feed.rows).toHaveLength(loaded + 1);

    await feed.rows[5]!.delete();
    expect(feed.rows).toHaveLength(loaded);
    expect(api.feed).toHaveBeenCalledTimes(1); // nothing was refetched
  });
});

describe("page-at-a-time pagination", () => {
  test("changing the page replaces the rows and reports the total", async () => {
    const api = makeApi();
    const pager = new SurveyPager(api);
    const stop = autorun(() => void pager.rows.value?.slice());
    await tick();

    expect(pager.rows.value).toHaveLength(10);
    expect(pager.rows.value![0]!.id).toBe(1);
    expect(pager.total).toBe(25);
    expect(pager.pageCount).toBe(3);

    pager.setPage(3);
    await tick();

    expect(pager.rows.value!.map((s) => s.id)).toEqual([21, 22, 23, 24, 25]);
    expect(api.page).toHaveBeenCalledTimes(2);
    stop();
  });
});
