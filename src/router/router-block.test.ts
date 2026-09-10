import { createMemoryHistory } from "history";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { makeRoutes } from "./make-routes";
import { redirect } from "./redirect";
import { RouterStore } from "./router.store";
import { GUARD, PAGE } from "./symbols";

const PageA = () => null;
const PageB = () => null;

// Stub document so RouterStore.navigate doesn't throw in Node.
beforeEach(() => {
  vi.stubGlobal("document", { startViewTransition: undefined, activeElement: null });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const routes = makeRoutes()({
  index: PageA,
  about: PageB,
  users: {
    index: PageA,
    $id: PageB,
  },
});

const makeRouter = async (initialPath = "/") => {
  const history = createMemoryHistory({ initialEntries: [initialPath] });
  const router = new RouterStore({ history });
  await router.initialize(routes as any);
  return { router, history };
};

const go = (router: RouterStore, to: string) => router.navigate({ to: to as any });

describe("router.block", () => {
  test("declines a navigation and reports it", async () => {
    const { router } = await makeRouter();
    router.block(
      () => true,
      () => false,
    );

    await expect(go(router, "/about")).resolves.toBe(false);
    expect(router.location.pathname).toBe("/");
    expect(router.activeRoute?.path).toBe("");
  });

  test("navigates when the blocker returns true", async () => {
    const { router } = await makeRouter();
    router.block(
      () => true,
      () => true,
    );

    await expect(go(router, "/about")).resolves.toBe(true);
    expect(router.activeRoute?.path).toBe("about");
  });

  test("waits for an async blocker, and lands after the work it does", async () => {
    const { router } = await makeRouter();
    const saved: string[] = [];
    router.block(
      () => true,
      async () => {
        await Promise.resolve();
        saved.push("saved");
        return true;
      },
    );

    await expect(go(router, "/about")).resolves.toBe(true);
    // the save ran, and the navigation landed after it
    expect(saved).toEqual(["saved"]);
    expect(router.activeRoute?.path).toBe("about");
  });

  test("only `true` proceeds — a handler that owns the UI and returns nothing stays put", async () => {
    const { router } = await makeRouter();
    const shown: string[] = [];
    router.block(
      () => true,
      ({ href }) => {
        shown.push(href);
      },
    );

    await expect(go(router, "/about")).resolves.toBe(false);
    expect(shown).toEqual(["/about"]);
    expect(router.location.pathname).toBe("/");
  });

  test("does nothing while `when` is false", async () => {
    const { router } = await makeRouter();
    let dirty = false;
    const blocker = vi.fn(() => false);
    router.block(() => dirty, blocker);

    await expect(go(router, "/about")).resolves.toBe(true);
    expect(blocker).not.toHaveBeenCalled();

    dirty = true;
    await expect(go(router, "/users")).resolves.toBe(false);
    expect(blocker).toHaveBeenCalledTimes(1);
  });

  test("describes the navigation it is asking about", async () => {
    const { router } = await makeRouter();
    const seen: any[] = [];
    router.block(
      () => true,
      (navigation) => {
        seen.push(navigation);
        return false;
      },
    );

    await go(router, "/about");
    await router.navigate({ to: "/users" as any, replace: true, search: { tab: "all" } });

    expect(seen).toEqual([
      { action: "PUSH", pathname: "/about", search: "", href: "/about" },
      { action: "REPLACE", pathname: "/users", search: "?tab=all", href: "/users?tab=all" },
    ]);
  });

  test("stops blocking once disposed", async () => {
    const { router } = await makeRouter();
    const dispose = router.block(
      () => true,
      () => false,
    );

    await expect(go(router, "/about")).resolves.toBe(false);

    dispose();
    dispose(); // idempotent — StrictMode and careless callers land in the same place

    await expect(go(router, "/about")).resolves.toBe(true);
  });

  test("consults blockers in registration order, stopping at the first refusal", async () => {
    const { router } = await makeRouter();
    const asked: string[] = [];
    router.block(
      () => true,
      () => {
        asked.push("first");
        return true;
      },
    );
    router.block(
      () => true,
      () => {
        asked.push("second");
        return false;
      },
    );
    router.block(
      () => true,
      () => {
        asked.push("third");
        return true;
      },
    );

    await expect(go(router, "/about")).resolves.toBe(false);
    expect(asked).toEqual(["first", "second"]);
  });

  test("a blocker that throws is logged and stays put", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { router } = await makeRouter();
    router.block(
      () => true,
      () => {
        throw new Error("dialog crashed");
      },
    );

    await expect(go(router, "/about")).resolves.toBe(false);
    expect(router.location.pathname).toBe("/");
    expect(error).toHaveBeenCalledOnce();
  });

  test("a throwing predicate is a caller bug and propagates", async () => {
    const { router } = await makeRouter();
    router.block(
      () => {
        throw new Error("bad predicate");
      },
      () => false,
    );

    expect(() => go(router, "/about")).toThrow("bad predicate");
  });

  test("still throws synchronously for an unresolvable path", async () => {
    const { router } = await makeRouter();
    const blocker = vi.fn(() => false);
    router.block(() => true, blocker);

    // resolving the destination happens before the blocker is consulted, so
    // a caller bug stays a synchronous throw rather than becoming a rejection
    // behind the handler's await
    expect(() => router.navigate({ to: "/users/:id" as any })).toThrow();
    expect(blocker).not.toHaveBeenCalled();
  });
});

describe("what router.block deliberately does not block", () => {
  test("a navigation that keeps the same pathname", async () => {
    const { router } = await makeRouter("/users");
    const blocker = vi.fn(() => false);
    router.block(() => true, blocker);

    await expect(router.navigate({ to: "/users" as any, search: { tab: "all" } })).resolves.toBe(
      true,
    );
    expect(router.location.search).toBe("?tab=all");
    expect(blocker).not.toHaveBeenCalled();
  });

  test("navigating to the current URL", async () => {
    const { router } = await makeRouter("/about");
    const blocker = vi.fn(() => false);
    router.block(() => true, blocker);

    await expect(go(router, "/about")).resolves.toBe(true);
    expect(blocker).not.toHaveBeenCalled();
  });

  test("the query-param helpers", async () => {
    const { router } = await makeRouter("/users");
    const blocker = vi.fn(() => false);
    router.block(() => true, blocker);

    router.setQueryParam("tab", "all");
    expect(router.query.tab).toBe("all");
    expect(router.removeQueryParam("tab")).toBe("all");
    expect(router.location.search).toBe("");
    expect(blocker).not.toHaveBeenCalled();
  });

  test("the trailing-slash normalization", async () => {
    const { router, history } = await makeRouter();
    const blocker = vi.fn(() => false);
    router.block(() => true, blocker);

    // arrives through history rather than `navigate`, the way a pasted URL
    // would; the router's own bookkeeping must not be answerable to a blocker
    history.push("/users/");
    await vi.waitFor(() => expect(router.activeRoute?.path).toBe("users"));
    expect(router.location.pathname).toBe("/users");
    expect(blocker).not.toHaveBeenCalled();
  });

  test("a redirect thrown by a guard", async () => {
    const guarded = makeRoutes()({
      index: PageA,
      about: PageB,
      admin: {
        [GUARD]: async () => {
          throw redirect({ to: "/about" });
        },
        index: { [PAGE]: PageA },
      },
    });
    const history = createMemoryHistory({ initialEntries: ["/"] });
    const router = new RouterStore({ history });
    await router.initialize(guarded as any);

    // the push into /admin is the user's, and is blocked
    const dispose = router.block(
      () => true,
      () => false,
    );
    await expect(go(router, "/admin")).resolves.toBe(false);
    dispose();

    // ...but where a guard's redirect sends that navigation is the app's own
    // decision, not a page the user chose to leave
    const asked: string[] = [];
    router.block(
      () => true,
      ({ pathname }) => {
        asked.push(pathname);
        return true;
      },
    );

    await expect(go(router, "/admin")).resolves.toBe(true);
    expect(router.activeRoute?.path).toBe("about");
    expect(asked).toEqual(["/admin"]);
  });

  test("a write straight to router.history", async () => {
    const { router, history } = await makeRouter();
    const blocker = vi.fn(() => false);
    router.block(() => true, blocker);

    history.push("/about");
    await vi.waitFor(() => expect(router.activeRoute?.path).toBe("about"));
    expect(blocker).not.toHaveBeenCalled();
  });
});
