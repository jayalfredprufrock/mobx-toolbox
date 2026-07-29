// @vitest-environment happy-dom
import { createMemoryHistory } from "history";
import { configure } from "mobx";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { Router } from "./components/router";
import { makeRoutes } from "./make-routes";
import { RouterStore } from "./router.store";
import { LOAD, LOADING, PAGE } from "./symbols";

// the outlet state machine mutates from timer callbacks — enforceActions
// catches any transition that escapes an action
configure({ enforceActions: "always" });

const deferred = () => {
  let resolve!: (value?: unknown) => void;
  const promise = new Promise((res) => {
    resolve = res as any;
  });
  return { promise, resolve };
};

const Skeleton = () => <div>SKELETON</div>;
const HomePage = () => <div>HOME</div>;
const SlowPage = () => <div>SLOW</div>;

const containers: HTMLElement[] = [];

afterEach(() => {
  for (const c of containers.splice(0)) c.remove();
});

const mount = () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  containers.push(container);
  const root = createRoot(container);
  return { container, root };
};

// real timers: React's scheduler and the outlet debounce both run on them,
// and the waits here are short enough not to matter
const wait = async (ms: number) => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
};

describe("router loading UI", () => {
  it("renders [LOADING] on a cold load, then the page", async () => {
    const load = deferred();
    const routes = makeRoutes()({
      [LOADING]: Skeleton,
      slow: { [LOAD]: () => load.promise, [PAGE]: () => <SlowPage /> },
    });

    const history = createMemoryHistory({ initialEntries: ["/slow"] });
    const store = new RouterStore({ history });
    store.initialize(routes as any);

    const { container, root } = mount();
    await act(async () => {
      root.render(<Router store={store} />);
    });

    // inside the debounce window nothing is shown — not even the skeleton
    expect(container.textContent).toBe("");

    await wait(350);
    // the pending route renders on a cold load, so [LOADING] is on screen
    expect(container.textContent).toBe("SKELETON");
    expect(store.activeRoute).toBeUndefined();
    expect(store.isLoading).toBe(true);

    load.resolve({ a: 1 });
    await wait(350); // data lands, then the minimum-duration hold expires

    expect(container.textContent).toBe("SLOW");
    expect(store.isLoading).toBe(false);
  });

  it("keeps the previous page on screen through a warm navigation", async () => {
    const load = deferred();
    const routes = makeRoutes()({
      [LOADING]: Skeleton,
      index: () => <HomePage />,
      slow: { [LOAD]: () => load.promise, [PAGE]: () => <SlowPage /> },
    });

    const history = createMemoryHistory({ initialEntries: ["/"] });
    const store = new RouterStore({ history });
    store.initialize(routes as any);

    const { container, root } = mount();
    await act(async () => {
      root.render(<Router store={store} />);
    });
    await wait(20);
    expect(container.textContent).toBe("HOME");

    await act(async () => {
      store.navigate({ to: "/slow" } as any);
    });
    await wait(350);

    // the old page is still rendered — no skeleton, no blank frame — even
    // though the debounce has elapsed and isLoading is set
    expect(container.textContent).toBe("HOME");
    expect(store.isLoading).toBe(true);
    expect(store.pendingRoute?.path).toBe("slow");

    load.resolve({ a: 1 });
    await wait(20);

    // no hold on a warm navigation: content appears as soon as data lands
    expect(container.textContent).toBe("SLOW");
    expect(store.isNavigating).toBe(false);
  });
});
