// @vitest-environment happy-dom
import { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { observer } from "mobx-react-lite";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { useLazyPages } from "./use-lazy";
import type { LazyPageRequest, LazyPageResult } from "./lazy";

const containers: HTMLElement[] = [];

afterEach(() => {
  for (const c of containers.splice(0)) c.remove();
});

const mount = async (node: React.ReactNode) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  containers.push(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  return container;
};

interface Comment {
  id: number;
  body: string;
}

const page = (start: number, count: number): Comment[] =>
  Array.from({ length: count }, (_, i) => ({ id: start + i, body: `c${start + i}` }));

/**
 * A paged list driven entirely from React, with no table involved: a "Load more" button, a footer
 * that distinguishes "loading more" from "that's all", and a sort that requeries in place.
 */
describe("useLazyPages", () => {
  const api = (total: number) =>
    vi.fn(
      ({
        cursor,
        limit,
        query,
      }: LazyPageRequest<{ sort: string } | undefined>): Promise<LazyPageResult<Comment>> => {
        const start = cursor === undefined ? 0 : Number(cursor);
        const items = page(start, Math.min(limit, total - start)).map((c) => ({
          ...c,
          body: query ? `${c.body}/${query.sort}` : c.body,
        }));
        const next = start + items.length;
        return Promise.resolve({
          items,
          cursor: next < total ? String(next) : null,
          total,
        });
      },
    );

  test("renders a load-more list with no table and no reactions of its own", async () => {
    const fetch = api(5);
    let clickMore!: () => void;

    const Feed = observer(() => {
      const feed = useLazyPages(fetch, [], { pageSize: 2 });
      clickMore = () => void feed.loadMore();

      if (!feed.loaded) return <span>loading</span>;
      return (
        <div>
          <ul>
            {feed.value.map((c) => (
              <li key={c.id}>{c.body}</li>
            ))}
          </ul>
          <footer>
            {feed.loadingMore ? "more…" : feed.hasMore ? `more of ${feed.total}` : "end"}
          </footer>
        </div>
      );
    });

    const container = await mount(<Feed />);

    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("footer")?.textContent).toBe("more of 5");

    await act(async () => clickMore());
    expect(container.querySelectorAll("li")).toHaveLength(4);
    expect(container.querySelector("footer")?.textContent).toBe("more of 5");

    await act(async () => clickMore());
    expect(container.querySelectorAll("li")).toHaveLength(5);
    expect(container.querySelector("footer")?.textContent).toBe("end");

    // nothing more to ask for: the button is a no-op rather than a request
    fetch.mockClear();
    await act(async () => clickMore());
    expect(fetch).not.toHaveBeenCalled();
  });

  test("setQuery from an effect requeries in place, keeping rows on screen", async () => {
    const fetch = api(6);
    let setSort!: (s: string) => void;

    const Feed = observer(() => {
      const [sort, set] = useState("new");
      setSort = set;
      const feed = useLazyPages(fetch, [], { pageSize: 2, query: { sort } });

      useEffect(() => feed.setQuery({ sort }), [feed, sort]);

      return (
        <div>
          <span data-pages={feed.pages}>{feed.value?.map((c) => c.body).join(",") ?? "—"}</span>
        </div>
      );
    });

    const container = await mount(<Feed />);
    const row = () => container.querySelector("span")!;

    expect(row().textContent).toBe("c0/new,c1/new");
    expect(row().dataset.pages).toBe("1");

    await act(async () => setSort("old"));

    expect(row().textContent).toBe("c0/old,c1/old");
    expect(row().dataset.pages).toBe("1");
  });

  test("re-rendering does not rebuild the list or refetch", async () => {
    const fetch = api(20);
    let bump!: (n: number) => void;

    const Feed = observer(() => {
      const [n, setN] = useState(0);
      bump = setN;
      const feed = useLazyPages(fetch, [], { pageSize: 2 });
      return <span>{`${n}:${feed.value?.length ?? 0}`}</span>;
    });

    const container = await mount(<Feed />);
    expect(container.textContent).toBe("0:2");
    expect(fetch).toHaveBeenCalledOnce();

    await act(async () => bump(1));

    expect(container.textContent).toBe("1:2");
    expect(fetch).toHaveBeenCalledOnce();
  });

  test("a deps change builds a new list from page one", async () => {
    const fetch = api(20);
    let setPost!: (id: string) => void;

    const Feed = observer(() => {
      const [postId, set] = useState("a");
      setPost = set;
      const feed = useLazyPages(fetch, [postId], { pageSize: 2 });
      return <span>{`${postId}:${feed.value?.length ?? 0}:${feed.pages}`}</span>;
    });

    const container = await mount(<Feed />);
    expect(container.textContent).toBe("a:2:1");

    await act(async () => setPost("b"));

    // a different list: page one again, not the page after the previous post's rows
    expect(container.textContent).toBe("b:2:1");
    expect(fetch.mock.calls.at(-1)![0]).toMatchObject({ cursor: undefined, page: 0 });
  });

  test("unmounting drops the pages and aborts the request in flight", async () => {
    const signals: AbortSignal[] = [];
    const fetch = vi.fn(({ signal }: LazyPageRequest<any>): Promise<LazyPageResult<Comment>> => {
      signals.push(signal);
      return new Promise(() => {});
    });

    const Feed = observer(() => {
      const feed = useLazyPages(fetch, [], { pageSize: 2 });
      return <span>{feed.loaded ? "rows" : "loading"}</span>;
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);
    await act(async () => root.render(<Feed />));

    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);

    await act(async () => root.unmount());

    expect(signals[0]!.aborted).toBe(true);
  });
});
