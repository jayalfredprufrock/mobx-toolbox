// @vitest-environment happy-dom
import { createMemoryHistory } from "history";
import { configure } from "mobx";
import { observer } from "mobx-react-lite";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { lazyObservable, lazyObservableArray } from "../lazy-observable/lazy-observable";
import { Router } from "./components/router";
import { makeRoutes } from "./make-routes";
import { RouterStore } from "./router.store";
import { LOAD } from "./symbols";

// Mirrors panelpro client-app: enforceActions + observer() page gated on two
// lazyObservables, rendered through the full Router -> outlet -> page chain,
// with the model provided via a [LOAD] loader (route.data).
configure({ enforceActions: "always" });

afterEach(() => {
  vi.unstubAllGlobals();
});

const flush = async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
};

describe("Router + observer() page + lazyObservable", () => {
  it("triggers gated lazy loaders through the full router chain", async () => {
    const fetchA = vi.fn(async () => "versionA");
    const fetchB = vi.fn(async () => "versionB");
    const fetchItems = vi.fn(async () => [1, 2, 3]);

    const survey = {
      latestVersion: lazyObservable(fetchA),
      publishedVersion: lazyObservable(fetchB),
      distributions: lazyObservableArray(fetchItems),
    };

    const Table = observer(() => <div>{survey.distributions.value.length}</div>);

    const DistributionsPage = observer(({ route }: { route: any }) => {
      const { survey: s } = route.data;
      if (!s?.latestVersion.loaded || !s?.publishedVersion.loaded) return null;
      return <Table />;
    });

    const routes = makeRoutes()({
      distributions: {
        [LOAD]: async () => ({ survey }),
        index: DistributionsPage,
      },
    });

    const history = createMemoryHistory({ initialEntries: ["/distributions"] });
    const store = new RouterStore({ history });
    store.initialize(routes as any);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<Router store={store} />);
    });

    await flush();
    await flush();
    await flush();

    expect(fetchA).toHaveBeenCalledTimes(1);
    expect(fetchB).toHaveBeenCalledTimes(1);
    expect(fetchItems).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("3");
  });
});
