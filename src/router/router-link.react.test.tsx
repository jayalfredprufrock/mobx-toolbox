// @vitest-environment happy-dom
import { createMemoryHistory } from "history";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { makeLinkComponent } from "./components/link";
import { routerContext } from "./components/router";
import { makeRoutes } from "./make-routes";
import { RouterStore } from "./router.store";

const PageA = () => null;

const routes = makeRoutes()({
  index: PageA,
  about: PageA,
  users: {
    index: PageA,
    $id: PageA,
  },
});

const containers: HTMLElement[] = [];

afterEach(() => {
  for (const c of containers.splice(0)) c.remove();
});

const Link = makeLinkComponent("a");

// Without a MobxRouter augmentation `DynamicRoutePath` is `never`, so a
// `:param` path (and any prop the element type doesn't declare, like
// `disabled`) has to come in untyped here — the same `as any` the store
// tests use for dynamic paths.
const LooseLink = Link as React.FC<any>;

const mount = async (node: (router: RouterStore) => React.ReactNode, initialPath = "/") => {
  const history = createMemoryHistory({ initialEntries: [initialPath] });
  const router = new RouterStore({ history });
  router.initialize(routes);
  await act(async () => {});

  const container = document.createElement("div");
  document.body.appendChild(container);
  containers.push(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<routerContext.Provider value={router}>{node(router)}</routerContext.Provider>);
  });

  const anchor = container.querySelector("a") as HTMLAnchorElement;
  return { router, history, container, anchor };
};

/** Dispatch a click the way a browser would, and report whether it was cancelled. */
const click = async (el: Element, init: MouseEventInit = {}) => {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  await act(async () => {
    el.dispatchEvent(event);
  });
  return event;
};

describe("makeLinkComponent", () => {
  test("sets href and navigates on a plain click", async () => {
    const { anchor, history } = await mount(() => <Link to="/about">About</Link>);
    expect(anchor.getAttribute("href")).toBe("/about");

    const event = await click(anchor);
    expect(event.defaultPrevented).toBe(true);
    expect(history.location.pathname).toBe("/about");
  });

  test("resolves :params into href", async () => {
    const { anchor, history } = await mount(() => (
      <LooseLink to="/users/:id" params={{ id: "42" }}>
        User
      </LooseLink>
    ));
    expect(anchor.getAttribute("href")).toBe("/users/42");

    await click(anchor);
    expect(history.location.pathname).toBe("/users/42");
  });

  test("sets aria-current on the active path", async () => {
    const { anchor } = await mount(() => <Link to="/about">About</Link>, "/about");
    expect(anchor.getAttribute("aria-current")).toBe("page");
  });

  // The point of the whole exercise: the href is already correct, so the
  // browser opens the new tab/window itself as long as we don't cancel.
  for (const [name, init] of [
    ["cmd-click", { metaKey: true }],
    ["ctrl-click", { ctrlKey: true }],
    ["shift-click", { shiftKey: true }],
    ["alt-click", { altKey: true }],
    ["middle-click", { button: 1 }],
  ] as const) {
    test(`${name} leaves the event alone and does not navigate in place`, async () => {
      const { anchor, history } = await mount(() => <Link to="/about">About</Link>);

      const event = await click(anchor, init);
      expect(event.defaultPrevented).toBe(false);
      expect(history.location.pathname).toBe("/");
    });
  }

  test("a modifier click still navigates when there is no href to follow", async () => {
    // role="link" suppresses href — the browser has nothing to open, so
    // deferring to it would make the click do nothing at all
    const { anchor, history } = await mount(() => (
      <Link to="/about" role="link">
        About
      </Link>
    ));
    expect(anchor.getAttribute("href")).toBeNull();

    await click(anchor, { metaKey: true });
    expect(history.location.pathname).toBe("/about");
  });

  test("chains the caller's onClick instead of replacing it", async () => {
    const seen: string[] = [];
    const { anchor, history } = await mount(() => (
      <Link to="/about" onClick={() => seen.push("caller")}>
        About
      </Link>
    ));

    await click(anchor);
    expect(seen).toEqual(["caller"]);
    expect(history.location.pathname).toBe("/about");
  });

  test("a caller's preventDefault cancels the navigation", async () => {
    const { anchor, history } = await mount(() => (
      <Link to="/about" onClick={(e) => e.preventDefault()}>
        About
      </Link>
    ));

    const event = await click(anchor);
    expect(event.defaultPrevented).toBe(true);
    expect(history.location.pathname).toBe("/");
  });

  test("chains an onClick passed as a base prop", async () => {
    const seen: string[] = [];
    const BaseLink = makeLinkComponent("a", { onClick: () => seen.push("base") });
    const { anchor, history } = await mount(() => <BaseLink to="/about">About</BaseLink>);

    await click(anchor);
    expect(seen).toEqual(["base"]);
    expect(history.location.pathname).toBe("/about");
  });

  test("a disabled link is inert — no navigation, no href, no handler", async () => {
    const seen: string[] = [];
    const { anchor, history } = await mount(() => (
      <LooseLink to="/about" disabled onClick={() => seen.push("caller")}>
        About
      </LooseLink>
    ));

    const event = await click(anchor);
    expect(event.defaultPrevented).toBe(true);
    expect(history.location.pathname).toBe("/");
    expect(seen).toEqual([]);

    // including under a modifier, which would otherwise open a new tab
    const modified = await click(anchor, { metaKey: true });
    expect(modified.defaultPrevented).toBe(true);
    expect(history.location.pathname).toBe("/");
  });
});
