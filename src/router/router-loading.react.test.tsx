// @vitest-environment happy-dom
import { createMemoryHistory } from "history";
import { configure } from "mobx";
import { observer } from "mobx-react-lite";
import { act, useContext } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { Router, routerContext } from "./components/router";
import { makeRoutes } from "./make-routes";
import { RouterStore } from "./router.store";
import { GUARD, LAYOUT, LOAD, LOADING, PAGE, SPLASH } from "./symbols";

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

// Two layouts, differing only in which signal drives the bar:
//   isLoading         — bar stays visible alongside a cold-load skeleton
//   isSlowNavigation  — bar yields to the skeleton, warm navigations only
const ShellWithAlwaysBar = observer(({ children }: any) => {
  const store = useContext(routerContext);
  return (
    <div>
      {store.isLoading && <span>[BAR]</span>}
      {children}
    </div>
  );
});

const ShellWithWarmBar = observer(({ children }: any) => {
  const store = useContext(routerContext);
  return (
    <div>
      {store.isSlowNavigation && <span>[BAR]</span>}
      {children}
    </div>
  );
});
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

describe("progress bar signals against a real render", () => {
  it("isLoading keeps the layout bar visible alongside a cold-load skeleton", async () => {
    const load = deferred();
    const routes = makeRoutes()({
      [LAYOUT]: ShellWithAlwaysBar,
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
    await wait(350);

    // the [LAYOUT] renders during a cold load (from pendingRoute), which is
    // what makes a bar possible at all here — shown together with the skeleton
    expect(container.textContent).toBe("[BAR]SKELETON");

    load.resolve({ a: 1 });
    await wait(80);
    // still held, and the bar has not blinked out in between
    expect(container.textContent).toBe("[BAR]SKELETON");

    await wait(350);
    expect(container.textContent).toBe("SLOW");
  });

  it("isSlowNavigation yields to the skeleton on a cold load", async () => {
    const load = deferred();
    const routes = makeRoutes()({
      [LAYOUT]: ShellWithWarmBar,
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
    await wait(350);

    expect(container.textContent).toBe("SKELETON");

    load.resolve({ a: 1 });
    await wait(430);
    expect(container.textContent).toBe("SLOW");
  });

  it("isSlowNavigation shows the bar over the previous page on a warm nav", async () => {
    const load = deferred();
    const routes = makeRoutes()({
      [LAYOUT]: ShellWithWarmBar,
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

    // bar over the still-rendered previous page, and no skeleton
    expect(container.textContent).toBe("[BAR]HOME");

    load.resolve({ a: 1 });
    await wait(60);
    expect(container.textContent).toBe("SLOW");
  });
});

describe("[SPLASH]", () => {
  const Splash = () => <div>SPLASH</div>;

  it("covers the first navigation while a root guard runs", async () => {
    const gate = deferred();
    const routes = makeRoutes()({
      [SPLASH]: Splash,
      [LAYOUT]: ShellWithWarmBar,
      [LOADING]: Skeleton,
      [GUARD]: async () => void (await gate.promise),
      secret: { [PAGE]: () => <SlowPage /> },
    });

    const history = createMemoryHistory({ initialEntries: ["/secret"] });
    const store = new RouterStore({ history });
    store.initialize(routes as any);

    const { container, root } = mount();
    await act(async () => {
      root.render(<Router store={store} />);
    });
    await wait(400);

    // no route has matched, so no layout and no [LOADING] — without [SPLASH]
    // this window renders nothing at all
    expect(container.textContent).toBe("SPLASH");
    expect(store.activeRoute).toBeUndefined();
    expect(store.pendingRoute).toBeUndefined();
    expect(store.isNavigating).toBe(true);

    gate.resolve();
    await wait(60);
    expect(container.textContent).toBe("SLOW");
  });

  it("renders nothing in that window when no [SPLASH] is defined", async () => {
    const gate = deferred();
    const routes = makeRoutes()({
      [LAYOUT]: ShellWithWarmBar,
      [GUARD]: async () => void (await gate.promise),
      secret: { [PAGE]: () => <SlowPage /> },
    });
    const history = createMemoryHistory({ initialEntries: ["/secret"] });
    const store = new RouterStore({ history });
    store.initialize(routes as any);

    const { container, root } = mount();
    await act(async () => {
      root.render(<Router store={store} />);
    });
    await wait(400);
    expect(container.textContent).toBe("");

    gate.resolve();
    await wait(60);
    expect(container.textContent).toBe("SLOW");
  });

  it("gives way to [LOADING] once a route has matched", async () => {
    const load = deferred();
    const routes = makeRoutes()({
      [SPLASH]: Splash,
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

    // no guards, so matching completes immediately and the skeleton — not
    // the splash — owns the loading window
    await wait(350);
    expect(container.textContent).toBe("SKELETON");

    load.resolve({ a: 1 });
    await wait(400);
    expect(container.textContent).toBe("SLOW");
  });

  it("is not shown on later navigations", async () => {
    const gate = deferred();
    const routes = makeRoutes()({
      [SPLASH]: Splash,
      index: () => <HomePage />,
      secret: { [GUARD]: async () => void (await gate.promise), [PAGE]: () => <SlowPage /> },
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
      store.navigate({ to: "/secret" } as any);
    });
    await wait(400);

    // a page is already on screen, so the splash must not replace it
    expect(container.textContent).toBe("HOME");

    gate.resolve();
    await wait(60);
    expect(container.textContent).toBe("SLOW");
  });
});
