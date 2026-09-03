import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { autorun, isObservableArray, observable, reaction, runInAction } from "mobx";
import { lazyPages, type LazyPageRequest, type LazyPageResult } from "./lazy";

interface Row {
  id: number;
  name: string;
}

const rows = (from: number, count: number): Row[] =>
  Array.from({ length: count }, (_, i) => ({ id: from + i, name: `row-${from + i}` }));

describe("lazyPages", () => {
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

  /** A cursor-paginated endpoint over `total` rows, `size` at a time. */
  const cursorApi = (total: number, size = 2) => {
    const fetch = vi.fn(({ cursor, limit }: LazyPageRequest<any>): Promise<LazyPageResult<Row>> => {
      const start = cursor === undefined ? 0 : Number(cursor);
      const items = rows(start, Math.min(limit ?? size, total - start));
      const next = start + items.length;
      return Promise.resolve({ items, cursor: next < total ? String(next) : null, total });
    });
    return fetch;
  };

  // -------------------------------------------------------------------------
  // it is a lazy first
  // -------------------------------------------------------------------------

  test("holds nothing until the first page lands", () => {
    const feed = lazyPages(cursorApi(10), { pageSize: 2 });
    expect(feed.loaded).toBe(false);
    expect(feed.value).toBeUndefined();
    expect(feed.pages).toBe(0);
    expect(feed.hasMore).toBe(true); // the first page is a page
    expect(feed.total).toBeUndefined();
  });

  test("fetches the first page on first observation", async () => {
    const fetch = cursorApi(10);
    const feed = lazyPages(fetch, { pageSize: 2 });

    observe(() => void feed.value);
    await Promise.resolve();
    await Promise.resolve();

    expect(fetch).toHaveBeenCalledOnce();
    expect(feed.loaded).toBe(true);
    expect(isObservableArray(feed.value)).toBe(true);
    expect(feed.value?.map((r) => r.id)).toEqual([0, 1]);
    expect(feed.pages).toBe(1);
    expect(feed.total).toBe(10);
  });

  test("drops its pages when nothing observes it, and starts over on the next observation", async () => {
    const fetch = cursorApi(10);
    const feed = lazyPages(fetch, { pageSize: 2 });

    const dispose = observe(() => void feed.value);
    await Promise.resolve();
    await Promise.resolve();
    await feed.loadMore();
    expect(feed.pages).toBe(2);

    dispose();
    disposeList = disposeList.filter((d) => d !== dispose);

    expect(feed.loaded).toBe(false);
    expect(feed.value).toBeUndefined();
    expect(feed.pages).toBe(0);
    expect(feed.hasMore).toBe(true);
    expect(feed.total).toBeUndefined();

    observe(() => void feed.value);
    await Promise.resolve();
    await Promise.resolve();
    expect(feed.value?.map((r) => r.id)).toEqual([0, 1]);
  });

  test("value keeps its identity as pages accumulate", async () => {
    const feed = lazyPages(cursorApi(10), { pageSize: 2 });
    await feed.getOrLoad();
    const first = feed.value;
    await feed.loadMore();
    expect(feed.value).toBe(first);
    expect(first?.length).toBe(4);
  });

  // -------------------------------------------------------------------------
  // loadMore
  // -------------------------------------------------------------------------

  test("loadMore appends the next page", async () => {
    const feed = lazyPages(cursorApi(6), { pageSize: 2 });

    await feed.getOrLoad();
    expect(feed.value?.map((r) => r.id)).toEqual([0, 1]);

    await feed.loadMore();
    expect(feed.value?.map((r) => r.id)).toEqual([0, 1, 2, 3]);
    expect(feed.pages).toBe(2);
    expect(feed.hasMore).toBe(true);

    await feed.loadMore();
    expect(feed.value?.map((r) => r.id)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(feed.hasMore).toBe(false);
  });

  test("loadMore on an empty list fetches the first page", async () => {
    const fetch = cursorApi(6);
    const feed = lazyPages(fetch, { pageSize: 2 });

    await feed.loadMore();

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]![0].cursor).toBeUndefined();
    expect(fetch.mock.calls[0]![0].offset).toBe(0);
    expect(feed.value?.map((r) => r.id)).toEqual([0, 1]);
    expect(feed.pages).toBe(1);
  });

  test("loadMore resolves immediately when there is nothing more", async () => {
    const fetch = cursorApi(2);
    const feed = lazyPages(fetch, { pageSize: 2 });

    await feed.getOrLoad();
    expect(feed.hasMore).toBe(false);
    fetch.mockClear();

    const value = await feed.loadMore();
    expect(fetch).not.toHaveBeenCalled();
    expect(value).toBe(feed.value);
  });

  test("concurrent loadMore calls join one request rather than double-appending", async () => {
    const fetch = cursorApi(20);
    const feed = lazyPages(fetch, { pageSize: 2 });
    await feed.getOrLoad();
    fetch.mockClear();

    await Promise.all([feed.loadMore(), feed.loadMore(), feed.loadMore()]);

    expect(fetch).toHaveBeenCalledOnce();
    expect(feed.value?.map((r) => r.id)).toEqual([0, 1, 2, 3]);
  });

  test("loadMore during a first load joins it instead of appending a second page", async () => {
    const fetch = cursorApi(20);
    const feed = lazyPages(fetch, { pageSize: 2 });

    const load = feed.getOrLoad();
    const more = feed.loadMore();
    await Promise.all([load, more]);

    expect(fetch).toHaveBeenCalledOnce();
    expect(feed.value?.map((r) => r.id)).toEqual([0, 1]);
    expect(feed.pages).toBe(1);
  });

  test("passes cursor, offset, limit and page through to the fetch", async () => {
    const fetch = cursorApi(20);
    const feed = lazyPages(fetch, { pageSize: 3 });

    await feed.getOrLoad();
    await feed.loadMore();

    expect(fetch.mock.calls[0]![0]).toMatchObject({
      cursor: undefined,
      offset: 0,
      limit: 3,
      page: 0,
    });
    expect(fetch.mock.calls[1]![0]).toMatchObject({ cursor: "3", offset: 3, limit: 3, page: 1 });
  });

  // -------------------------------------------------------------------------
  // reload vs loadMore vs setQuery
  // -------------------------------------------------------------------------

  test("reload starts the list over at page one", async () => {
    const fetch = cursorApi(20);
    const feed = lazyPages(fetch, { pageSize: 2 });

    await feed.getOrLoad();
    await feed.loadMore();
    expect(feed.value?.length).toBe(4);

    await feed.reload();

    expect(feed.value?.map((r) => r.id)).toEqual([0, 1]);
    expect(feed.pages).toBe(1);
    expect(fetch.mock.calls.at(-1)![0].cursor).toBeUndefined();
  });

  test("refreshing reports a reload and loadingMore reports an append; never both", async () => {
    let release!: (r: LazyPageResult<Row>) => void;
    const fetch = vi.fn(
      (): Promise<LazyPageResult<Row>> => new Promise((resolve) => (release = resolve)),
    );
    const feed = lazyPages(fetch, { pageSize: 2 });

    const load = feed.getOrLoad();
    expect(feed.refreshing).toBe(false); // nothing held yet: this is a first load
    expect(feed.loadingMore).toBe(false);
    release({ items: rows(0, 2), cursor: "2" });
    await load;

    const more = feed.loadMore();
    expect(feed.loadingMore).toBe(true);
    expect(feed.refreshing).toBe(false);
    release({ items: rows(2, 2), cursor: "4" });
    await more;

    const again = feed.reload();
    expect(feed.refreshing).toBe(true);
    expect(feed.loadingMore).toBe(false);
    release({ items: rows(0, 2), cursor: "2" });
    await again;

    expect(feed.refreshing).toBe(false);
    expect(feed.loadingMore).toBe(false);
  });

  test("rows stay readable while a reload is in flight", async () => {
    let release!: (r: LazyPageResult<Row>) => void;
    const fetch = vi
      .fn<() => Promise<LazyPageResult<Row>>>()
      .mockResolvedValueOnce({ items: rows(0, 2), cursor: "2" })
      .mockImplementation(() => new Promise((resolve) => (release = resolve)));
    const feed = lazyPages(fetch, { pageSize: 2 });

    await feed.getOrLoad();
    const reloading = feed.reload();

    expect(feed.loaded).toBe(true);
    expect(feed.value?.map((r) => r.id)).toEqual([0, 1]);

    release({ items: rows(0, 2), cursor: null });
    await reloading;
  });

  test("setQuery starts the list over, keeping rows readable until page one lands", async () => {
    const seen: unknown[] = [];
    let release!: (r: LazyPageResult<Row>) => void;
    const fetch = vi.fn(
      ({ query }: LazyPageRequest<{ status: string }>): Promise<LazyPageResult<Row>> => {
        seen.push(query);
        return new Promise((resolve) => (release = resolve));
      },
    );
    const feed = lazyPages(fetch, { pageSize: 2, query: { status: "draft" } });

    observe(() => void feed.value);
    await Promise.resolve();
    await Promise.resolve();
    release({ items: rows(0, 2), cursor: "2", total: 9 });
    await Promise.resolve();

    expect(feed.pages).toBe(1);
    expect(feed.total).toBe(9);

    feed.setQuery({ status: "published" });

    // stale rows still on screen, but the list already reports itself as restarted
    expect(feed.loaded).toBe(true);
    expect(feed.value?.length).toBe(2);
    expect(feed.pages).toBe(0);
    expect(feed.hasMore).toBe(true);
    expect(feed.total).toBeUndefined();

    await Promise.resolve();
    await Promise.resolve();
    release({ items: rows(100, 2), cursor: null, total: 2 });
    await Promise.resolve();

    expect(feed.value?.map((r) => r.id)).toEqual([100, 101]);
    expect(seen).toEqual([{ status: "draft" }, { status: "published" }]);
  });

  test("setQuery ignores a structurally equal query", async () => {
    const fetch = cursorApi(20);
    const feed = lazyPages(fetch, { pageSize: 2, query: { status: "draft" } });

    observe(() => void feed.value);
    await Promise.resolve();
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledOnce();

    feed.setQuery({ status: "draft" }); // a fresh object, same contents
    await Promise.resolve();
    await Promise.resolve();

    expect(fetch).toHaveBeenCalledOnce();
    expect(feed.pages).toBe(1);
  });

  test("a loadMore issued while a query change is pending fetches page one", async () => {
    const fetch = cursorApi(20);
    const feed = lazyPages(fetch, { pageSize: 2, query: { q: "a" } });

    await feed.getOrLoad();
    await feed.loadMore();
    expect(feed.value?.length).toBe(4);

    feed.setQuery({ q: "b" }); // nothing observing, so no reload runs yet
    fetch.mockClear();

    await feed.loadMore();

    // page one of the new query, not the page after rows belonging to the old one
    expect(fetch.mock.calls[0]![0]).toMatchObject({ cursor: undefined, offset: 0, page: 0 });
    expect(feed.value?.map((r) => r.id)).toEqual([0, 1]);
    expect(feed.pages).toBe(1);
  });

  // -------------------------------------------------------------------------
  // hasMore resolution
  // -------------------------------------------------------------------------

  test("an empty page ends the list whatever it claims", async () => {
    const fetch = vi
      .fn<() => Promise<LazyPageResult<Row>>>()
      .mockResolvedValue({ items: [], hasMore: true, cursor: "next" });
    const feed = lazyPages(fetch, { pageSize: 2 });

    await feed.getOrLoad();

    expect(feed.hasMore).toBe(false);
    expect(feed.loaded).toBe(true);
    expect(feed.value?.length).toBe(0);
  });

  test("an explicit hasMore outranks cursor and total", async () => {
    const fetch = vi
      .fn<() => Promise<LazyPageResult<Row>>>()
      .mockResolvedValue({ items: rows(0, 2), hasMore: false, cursor: "2", total: 100 });
    const feed = lazyPages(fetch, { pageSize: 2 });

    await feed.getOrLoad();
    expect(feed.hasMore).toBe(false);
  });

  test("a null cursor ends the list", async () => {
    const fetch = vi
      .fn<() => Promise<LazyPageResult<Row>>>()
      .mockResolvedValue({ items: rows(0, 2), cursor: null });
    const feed = lazyPages(fetch, { pageSize: 2 });

    await feed.getOrLoad();
    expect(feed.hasMore).toBe(false);
  });

  test("total decides when there is no cursor — offset pagination", async () => {
    const fetch = vi.fn(
      ({ offset, limit }: LazyPageRequest<any>): Promise<LazyPageResult<Row>> =>
        Promise.resolve({ items: rows(offset, Math.min(limit, 5 - offset)), total: 5 }),
    );
    const feed = lazyPages(fetch, { pageSize: 2 });

    await feed.getOrLoad();
    expect(feed.hasMore).toBe(true);
    await feed.loadMore();
    expect(feed.hasMore).toBe(true);
    await feed.loadMore();
    expect(feed.value?.length).toBe(5);
    expect(feed.hasMore).toBe(false);
  });

  test("a bare array is a page, and a short one is the last", async () => {
    const fetch = vi
      .fn<() => Promise<LazyPageResult<Row>>>()
      .mockResolvedValueOnce(rows(0, 2))
      .mockResolvedValueOnce(rows(2, 1));
    const feed = lazyPages(fetch, { pageSize: 2 });

    await feed.getOrLoad();
    expect(feed.hasMore).toBe(true);
    expect(feed.total).toBeUndefined();

    await feed.loadMore();
    expect(feed.value?.map((r) => r.id)).toEqual([0, 1, 2]);
    expect(feed.hasMore).toBe(false);
  });

  // -------------------------------------------------------------------------
  // dedupeBy
  // -------------------------------------------------------------------------

  test("dedupeBy drops a record a later page repeats", async () => {
    const fetch = vi
      .fn<() => Promise<LazyPageResult<Row>>>()
      .mockResolvedValueOnce({ items: rows(0, 3), cursor: "3" })
      .mockResolvedValueOnce({ items: [...rows(2, 1), ...rows(3, 2)], cursor: "5" });
    const feed = lazyPages(fetch, { pageSize: 3, dedupeBy: (r) => r.id });

    await feed.getOrLoad();
    await feed.loadMore();

    expect(feed.value?.map((r) => r.id)).toEqual([0, 1, 2, 3, 4]);
    // the page was full as far as the server was concerned, so the list is not over
    expect(feed.hasMore).toBe(true);
  });

  test("dedupe state resets when the list starts over", async () => {
    const fetch = vi
      .fn<() => Promise<LazyPageResult<Row>>>()
      .mockResolvedValue({ items: rows(0, 2), cursor: "2" });
    const feed = lazyPages(fetch, { pageSize: 2, dedupeBy: (r) => r.id });

    await feed.getOrLoad();
    await feed.reload();

    expect(feed.value?.map((r) => r.id)).toEqual([0, 1]);
  });

  // -------------------------------------------------------------------------
  // errors, abort, set
  // -------------------------------------------------------------------------

  test("a failed append keeps the pages already held", async () => {
    const fetch = vi
      .fn<(request: LazyPageRequest<undefined>) => Promise<LazyPageResult<Row>>>()
      .mockResolvedValueOnce({ items: rows(0, 2), cursor: "2" })
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ items: rows(2, 2), cursor: "4" });
    const feed = lazyPages(fetch, { pageSize: 2 });

    await feed.getOrLoad();
    await expect(feed.loadMore()).rejects.toThrow("boom");

    expect(feed.loaded).toBe(true);
    expect(feed.value?.map((r) => r.id)).toEqual([0, 1]);
    expect(feed.error).toBeInstanceOf(Error);
    expect(feed.loadingMore).toBe(false);
    // the cursor survives, so a retry asks for the page that failed
    expect(feed.hasMore).toBe(true);
    await feed.loadMore();
    expect(fetch.mock.calls.at(-1)![0]).toMatchObject({ cursor: "2" });
    expect(feed.value?.map((r) => r.id)).toEqual([0, 1, 2, 3]);
    expect(feed.error).toBeUndefined();
  });

  test("a failed first load reports the error and holds nothing", async () => {
    const fetch = vi.fn<() => Promise<LazyPageResult<Row>>>().mockRejectedValue(new Error("nope"));
    const feed = lazyPages(fetch, { pageSize: 2 });

    await expect(feed.getOrLoad()).rejects.toThrow("nope");
    expect(feed.loaded).toBe(false);
    expect(feed.value).toBeUndefined();
    expect(feed.error).toBeInstanceOf(Error);
  });

  test("a superseded page request is aborted and never applied", async () => {
    const signals: AbortSignal[] = [];
    let release!: (r: LazyPageResult<Row>) => void;
    const fetch = vi.fn(({ signal }: LazyPageRequest<any>): Promise<LazyPageResult<Row>> => {
      signals.push(signal);
      return new Promise((resolve) => (release = resolve));
    });
    const feed = lazyPages(fetch, { pageSize: 2 });

    const first = feed.getOrLoad();
    const stale = release;
    const second = feed.reload();

    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);

    stale({ items: rows(900, 2), cursor: "902" });
    release({ items: rows(0, 2), cursor: "2" });
    await Promise.all([first, second]);

    expect(feed.value?.map((r) => r.id)).toEqual([0, 1]);
    expect(feed.pages).toBe(1);
  });

  test("set replaces the rows and declares the list complete", async () => {
    const fetch = cursorApi(20);
    const feed = lazyPages(fetch, { pageSize: 2 });

    await feed.getOrLoad();
    await feed.loadMore();
    fetch.mockClear();

    feed.set(rows(50, 3));

    expect(feed.value?.map((r) => r.id)).toEqual([50, 51, 52]);
    expect(feed.hasMore).toBe(false);
    expect(feed.total).toBe(3);
    expect(feed.pages).toBe(1);

    await feed.loadMore();
    expect(fetch).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // reactivity
  // -------------------------------------------------------------------------

  test("an append notifies observers of the contents", async () => {
    const feed = lazyPages(cursorApi(20), { pageSize: 2 });
    const lengths: number[] = [];

    observe(() => lengths.push(feed.value?.length ?? 0));
    await Promise.resolve();
    await Promise.resolve();
    await feed.loadMore();

    expect(lengths).toEqual([0, 2, 4]);
  });

  test("trackDependencies starts the list over when a dependency changes", async () => {
    const status = observable.box("draft");
    const fetch = vi.fn(({ cursor, limit }: LazyPageRequest<any>): Promise<LazyPageResult<Row>> => {
      void status.get();
      const start = cursor === undefined ? 0 : Number(cursor);
      return Promise.resolve({
        items: rows(start, limit),
        cursor: String(start + limit),
      });
    });
    const feed = lazyPages(fetch, { pageSize: 2, trackDependencies: true });

    observe(() => void feed.value);
    await Promise.resolve();
    await Promise.resolve();
    await feed.loadMore();
    expect(feed.pages).toBe(2);

    runInAction(() => status.set("published"));
    await Promise.resolve();
    await Promise.resolve();

    expect(feed.pages).toBe(1);
    expect(feed.value?.length).toBe(2);
  });

  test("an append does not re-enter dependency tracking", async () => {
    const status = observable.box("draft");
    const fetch = vi.fn(({ cursor, limit }: LazyPageRequest<any>): Promise<LazyPageResult<Row>> => {
      void status.get();
      const start = cursor === undefined ? 0 : Number(cursor);
      return Promise.resolve({ items: rows(start, limit), cursor: String(start + limit) });
    });
    const feed = lazyPages(fetch, { pageSize: 2, trackDependencies: true });

    observe(() => void feed.value);
    await Promise.resolve();
    await Promise.resolve();
    await feed.loadMore();
    fetch.mockClear();

    // tracking installed by the load must survive the append
    runInAction(() => status.set("published"));
    await Promise.resolve();
    await Promise.resolve();

    expect(fetch).toHaveBeenCalledOnce();
    expect(feed.pages).toBe(1);
  });

  test("pages is the signal for a restart rather than a growth", async () => {
    const feed = lazyPages(cursorApi(20), { pageSize: 2 });
    const restarts: number[] = [];

    observe(() => void feed.value);
    disposeList.push(
      reaction(
        () => feed.pages,
        (pages) => restarts.push(pages),
      ),
    );

    await Promise.resolve();
    await Promise.resolve();
    await feed.loadMore();
    await feed.reload();

    expect(restarts).toEqual([1, 2, 0, 1]);
  });

  test("reading hasMore or total does not observe the list", async () => {
    const fetch = cursorApi(20);
    const feed = lazyPages(fetch, { pageSize: 2 });

    observe(() => {
      void feed.hasMore;
      void feed.total;
      void feed.pages;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(fetch).not.toHaveBeenCalled();
    expect(feed.observed).toBe(false);
  });

  test("reading loadingMore does observe the list", async () => {
    const fetch = cursorApi(20);
    const feed = lazyPages(fetch, { pageSize: 2 });

    observe(() => void feed.loadingMore);
    await Promise.resolve();
    await Promise.resolve();

    expect(fetch).toHaveBeenCalledOnce();
    expect(feed.observed).toBe(true);
  });

  // -------------------------------------------------------------------------
  // it substitutes for a LazyArray
  // -------------------------------------------------------------------------

  test("keepOnUnobserved holds every page loaded", async () => {
    const fetch = cursorApi(20);
    const feed = lazyPages(fetch, { pageSize: 2, keepOnUnobserved: true });

    const dispose = observe(() => void feed.value);
    await Promise.resolve();
    await Promise.resolve();
    await feed.loadMore();

    dispose();
    disposeList = disposeList.filter((d) => d !== dispose);

    expect(feed.loaded).toBe(true);
    expect(feed.value?.length).toBe(4);
    expect(feed.pages).toBe(2);
  });

  test("invalidate with discard returns the list to holding nothing", async () => {
    const feed = lazyPages(cursorApi(20), { pageSize: 2 });

    await feed.getOrLoad();
    await feed.loadMore();

    feed.invalidate({ discard: true });

    expect(feed.loaded).toBe(false);
    expect(feed.value).toBeUndefined();
    expect(feed.pages).toBe(0);
    expect(feed.hasMore).toBe(true);
    expect(feed.total).toBeUndefined();
  });

  test("an append does not swallow an invalidation issued in the same tick", async () => {
    const fetch = cursorApi(20);
    const feed = lazyPages(fetch, { pageSize: 2 });

    observe(() => void feed.value);
    await Promise.resolve();
    await Promise.resolve();
    expect(feed.pages).toBe(1);

    // a store event lands, and a scroll handler asks for the next page before the reload runs
    feed.invalidate();
    void feed.loadMore();

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // the reload won: page one, not page one plus an append onto rows it was told to replace
    expect(feed.pages).toBe(1);
    expect(feed.value?.map((r) => r.id)).toEqual([0, 1]);
    expect(fetch.mock.calls.at(-1)![0]).toMatchObject({ cursor: undefined, page: 0 });
  });

  test("an append leaves an unobserved list stale, so the next demand reloads it", async () => {
    const fetch = cursorApi(20);
    const feed = lazyPages(fetch, { pageSize: 2 });

    await feed.getOrLoad();
    feed.invalidate();
    await feed.loadMore();
    fetch.mockClear();

    await feed.getOrLoad();

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]![0]).toMatchObject({ cursor: undefined, page: 0 });
  });

  test("satisfies the structural test a table binding uses", () => {
    const feed = lazyPages(cursorApi(20), { pageSize: 2 });
    expect("loaded" in feed).toBe(true);
    expect("getOrLoad" in feed).toBe(true);
  });
});
