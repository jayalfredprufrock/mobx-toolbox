// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { observer } from "mobx-react-lite";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import * as T from "typebox";
import { makeModel } from "./make-model";
import { createStore } from "./make-store";
import { usePagedCollection } from "./use-collection";
import type { LazyPageRequest, LazyPageResult } from "../lazy/lazy";

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
  return { container, root };
};

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });

const CommentSchema = T.Object({ id: T.Number(), postId: T.String(), body: T.String() });
type CommentPayload = T.Static<typeof CommentSchema>;

const CommentModel = makeModel(CommentSchema, {
  keys: ["id"],
  create: (body: Partial<CommentPayload>) =>
    Promise.resolve({ id: 9999, postId: "a", body: "new", ...body }),
});

const api = (total: number) =>
  vi.fn(
    ({
      postId,
      cursor,
      limit,
    }: { postId: string } & LazyPageRequest<any>): Promise<LazyPageResult<CommentPayload>> => {
      const start = cursor === undefined ? 0 : Number(cursor);
      const items = Array.from({ length: Math.min(limit, total - start) }, (_, i) => ({
        id: start + i,
        postId,
        body: `${postId}-${start + i}`,
      }));
      const next = start + items.length;
      return Promise.resolve({ items, cursor: next < total ? String(next) : null, total });
    },
  );

describe("usePagedCollection", () => {
  test("renders a load-more feed of models with no wiring of its own", async () => {
    const fetch = api(5);
    let more!: () => void;

    const Feed = observer(() => {
      const feed = usePagedCollection(CommentModel, (request) =>
        fetch({ postId: "a", ...request }),
      );
      more = () => void feed.loadMore();
      if (!feed.loaded) return <span>loading</span>;
      return (
        <div>
          <ul>
            {feed.value.map((c) => (
              <li key={c.id}>{c.body}</li>
            ))}
          </ul>
          <footer>{feed.hasMore ? `more of ${feed.total}` : "end"}</footer>
        </div>
      );
    });

    const { container } = await mount(<Feed />);
    await settle();

    expect(container.querySelectorAll("li")).toHaveLength(5);
    expect(container.querySelector("footer")?.textContent).toBe("end");
    // real model instances, identity-mapped
    expect(CommentModel.peek({ id: 0 })).toBeInstanceOf(CommentModel);

    await act(async () => more());
    expect(container.querySelectorAll("li")).toHaveLength(5); // nothing more to ask for
  });

  test("params restart the list, leaving the previous rows readable until page one lands", async () => {
    const fetch = api(30);
    let setPost!: (id: string) => void;

    const Feed = observer(() => {
      const [postId, set] = useState("a");
      setPost = set;
      const feed = usePagedCollection(
        CommentModel,
        ({ postId }, request) => fetch({ postId, ...request }),
        { params: { postId }, pageSize: 5 },
      );
      return <span data-pages={feed.pages}>{feed.value?.map((c) => c.body).join(",") ?? "—"}</span>;
    });

    const { container } = await mount(<Feed />);
    await settle();
    const row = () => container.querySelector("span")!;

    expect(row().textContent).toBe("a-0,a-1,a-2,a-3,a-4");

    await act(async () => setPost("b"));
    await settle();

    expect(row().textContent).toBe("b-0,b-1,b-2,b-3,b-4");
    expect(row().dataset.pages).toBe("1"); // page one of the new list, not page two of the old
  });

  test("re-rendering neither rebuilds the list nor refetches", async () => {
    const fetch = api(30);
    let bump!: (n: number) => void;

    const Feed = observer(() => {
      const [n, setN] = useState(0);
      bump = setN;
      const feed = usePagedCollection(CommentModel, (r) => fetch({ postId: "a", ...r }), {
        pageSize: 5,
      });
      return <span>{`${n}:${feed.value?.length ?? 0}`}</span>;
    });

    const { container } = await mount(<Feed />);
    await settle();
    expect(container.textContent).toBe("0:5");
    expect(fetch).toHaveBeenCalledOnce();

    await act(async () => bump(1));
    expect(container.textContent).toBe("1:5");
    expect(fetch).toHaveBeenCalledOnce();
  });

  test("shares identity and mutations with an app-wide store over the same model", async () => {
    const fetch = api(10);
    const appStore = createStore(CommentModel, {
      collections: { all: () => Promise.resolve([{ id: 0, postId: "a", body: "from store" }]) },
    });

    let feedRows: readonly { id: number; body: string }[] = [];
    const Feed = observer(() => {
      const feed = usePagedCollection(CommentModel, (r) => fetch({ postId: "a", ...r }), {
        pageSize: 5,
      });
      feedRows = feed.value?.slice() ?? [];
      return <span>{feed.value?.length ?? 0}</span>;
    });

    await mount(<Feed />);
    await settle();
    await appStore.all.getOrLoad();

    // one instance per record, whichever list loaded it
    expect(appStore.all.value?.[0]).toBe(CommentModel.peek({ id: 0 }));
    expect(feedRows[0]).toBe(CommentModel.peek({ id: 0 }));

    // an edit through one is visible through the other
    await act(async () => {
      appStore.all.value![0]!.updateData({ body: "edited" });
    });
    expect(feedRows[0]!.body).toBe("edited");
  });

  test("unmounting drops the pages and aborts what is in flight", async () => {
    const signals: AbortSignal[] = [];
    const fetch = vi.fn(({ signal }: LazyPageRequest<any>) => {
      signals.push(signal);
      return new Promise<LazyPageResult<CommentPayload>>(() => {});
    });

    const Feed = observer(() => {
      const feed = usePagedCollection(CommentModel, fetch, { pageSize: 5 });
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
