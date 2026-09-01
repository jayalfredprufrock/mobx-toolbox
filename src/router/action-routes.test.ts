import { createMemoryHistory } from "history";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { makeRoutes } from "./make-routes";
import { redirect } from "./redirect";
import { RouterStore } from "./router.store";
import { GUARD, PAGE, REDIRECT } from "./symbols";

/**
 * A URL that does some work and sends the user elsewhere — logout, an email confirmation link, an
 * OAuth callback. It has no UI of its own, which is awkward here because every navigable path
 * addresses a page. These pin the three shapes the README recommends, so the advice stays true.
 */

const Page = () => null;

beforeEach(() => {
  vi.stubGlobal("document", { startViewTransition: undefined, activeElement: null });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const settle = () => new Promise((r) => setTimeout(r, 30));

const drive = async (routes: Parameters<RouterStore["initialize"]>[0], to: string) => {
  const history = createMemoryHistory({ initialEntries: ["/"] });
  const router = new RouterStore({ history });
  await router.initialize(routes);
  history.push(to);
  await settle();
  return { router, history };
};

describe("URLs that do something and leave", () => {
  test("a node with only a [GUARD] is not addressable, and its guard never runs", async () => {
    const ran = { count: 0 };
    const routes = makeRoutes()({
      index: { [PAGE]: Page },
      login: { [PAGE]: Page },
      logout: {
        [GUARD]: async () => {
          ran.count++;
        },
      },
    });

    // console.error is the router reporting the navigation failure
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { router, history } = await drive(routes, "/logout");
    logged.mockRestore();

    expect(ran.count).toBe(0);
    expect(router.activeRoute?.error?.type).toBe("NOT_FOUND");
    expect(history.location.pathname).toBe("/logout");
  });

  test("a [REDIRECT] function can do the work on the way past", async () => {
    const ran = { count: 0 };
    const routes = makeRoutes()({
      index: { [PAGE]: Page },
      login: { [PAGE]: Page },
      logout: {
        [REDIRECT]: () => {
          ran.count++;
          return "/login";
        },
      },
    });

    const { router, history } = await drive(routes, "/logout");

    expect(ran.count).toBe(1);
    expect(history.location.pathname).toBe("/login");
    expect(router.activeRoute?.error).toBeUndefined();
    // a redirect replaces, so Back does not land on the logout URL and run it again
    expect(history.index).toBe(1);
  });

  test("a [GUARD] with a page that renders nothing awaits the work first", async () => {
    const order: string[] = [];
    const routes = makeRoutes()({
      index: { [PAGE]: Page },
      login: { [PAGE]: Page },
      logout: {
        [PAGE]: () => null,
        [GUARD]: async () => {
          await Promise.resolve();
          order.push("logged out");
          throw redirect({ to: "/login" } as never);
        },
      },
    });

    const { history } = await drive(routes, "/logout");
    order.push(`landed on ${history.location.pathname}`);

    expect(order).toEqual(["logged out", "landed on /login"]);
  });

  test("the page the user came from stays on screen while the guard runs", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const routes = makeRoutes()({
      index: { [PAGE]: Page },
      login: { [PAGE]: Page },
      logout: {
        [PAGE]: () => null,
        [GUARD]: async () => {
          await gate;
          throw redirect({ to: "/login" } as never);
        },
      },
    });

    const history = createMemoryHistory({ initialEntries: ["/"] });
    const router = new RouterStore({ history });
    await router.initialize(routes);
    expect(router.activeRoute?.path).toBe("");

    history.push("/logout");
    await new Promise((r) => setTimeout(r, 10));

    // this is what makes `[PAGE]: () => null` harmless: it is never rendered, because the swap
    // waits for the guard and the guard redirects away
    expect(router.activeRoute?.path).toBe("");
    expect(router.pendingRoute).toBeUndefined();

    release();
    await settle();
    expect(router.activeRoute?.path).toBe("login");
  });

  test("a function [REDIRECT] is not invoked by boot validation", async () => {
    // it would fire the side effect on import, which is the reason validation skips function targets
    const ran = { count: 0 };
    makeRoutes()({
      index: { [PAGE]: Page },
      login: { [PAGE]: Page },
      logout: {
        [REDIRECT]: () => {
          ran.count++;
          return "/login";
        },
      },
    });

    expect(ran.count).toBe(0);
  });
});
