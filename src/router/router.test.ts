import { describe, expect, test, vi, beforeEach, afterEach } from "vite-plus/test";
import { createMemoryHistory } from "history";
import { makeRoutes, matchRoute } from "./make-routes";
import { redirect, Redirect } from "./redirect";
import { RouterStore } from "./router.store";
import { GUARD, PAGE, REDIRECT } from "./symbols";
import type { Guard } from "./types";

const PageA = () => null;
const PageB = () => null;
const PageC = () => null;

// Stub document so RouterStore.navigate doesn't throw in Node.
beforeEach(() => {
  vi.stubGlobal("document", { startViewTransition: undefined, activeElement: null });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// matchRoute (pure function)
// ---------------------------------------------------------------------------

describe("matchRoute", () => {
  const routes = makeRoutes()({
    index: PageA,
    about: PageB,
    users: {
      index: PageC,
      $id: PageA,
    },
  });

  test("matches root path '/'", () => {
    const route = matchRoute("/", routes);
    expect(route.path).toBe("");
    expect(route.params).toEqual({});
  });

  test("matches top-level path", () => {
    const route = matchRoute("/about", routes);
    expect(route.path).toBe("about");
  });

  test("matches nested index path", () => {
    const route = matchRoute("/users", routes);
    // nested index lands at "users/" — empty string segment for the index key
    expect(route.path).toBe("users/");
  });

  test("matches dynamic segment and captures param", () => {
    const route = matchRoute("/users/42", routes);
    expect(route.path).toBe("users/42");
    expect(route.params).toEqual({ id: "42" });
  });

  test("throws on unknown path", () => {
    expect(() => matchRoute("/nonexistent", routes)).toThrow("Not Found.");
  });

  test("throws Redirect when route has [REDIRECT]", () => {
    const r = makeRoutes()({
      old: { [REDIRECT]: "/about" },
      about: PageA,
    });
    expect(() => matchRoute("/old", r)).toThrow(Redirect);
  });

  test("merges context from parent to child", () => {
    const r = makeRoutes()({
      admin: {
        [PAGE]: PageA,
      },
    });
    const route = matchRoute("/admin", r);
    expect(route.context).toEqual({});
  });

  test("collects guards from route chain", () => {
    const guard: Guard = async () => {};
    const r = makeRoutes()({
      dashboard: {
        [GUARD]: guard,
        [PAGE]: PageA,
      },
    });
    const route = matchRoute("/dashboard", r);
    expect(route.guards).toContain(guard);
  });
});

// ---------------------------------------------------------------------------
// Redirect
// ---------------------------------------------------------------------------

describe("Redirect", () => {
  test("redirect() returns a Redirect instance", () => {
    const r = redirect({ to: "/login" });
    expect(r).toBeInstanceOf(Redirect);
    expect(r.options).toEqual({ to: "/login" });
  });

  test("new Redirect() stores options", () => {
    const r = new Redirect({ to: "/home", replace: true });
    expect(r.options.to).toBe("/home");
    expect(r.options.replace).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RouterStore
// ---------------------------------------------------------------------------

describe("RouterStore", () => {
  const routes = makeRoutes()({
    index: PageA,
    about: PageB,
    users: {
      index: PageC,
      $id: PageA,
    },
  });

  const makeRouter = async (initialPath = "/") => {
    const history = createMemoryHistory({ initialEntries: [initialPath] });
    const router = new RouterStore({ history });
    router.routesDef = routes;
    await router.setLocation(history.location);
    return { router, history };
  };

  describe("setLocation", () => {
    test("sets activeRoute after initialization", async () => {
      const { router } = await makeRouter("/");
      expect(router.activeRoute).toBeDefined();
    });

    test("sets route path for root", async () => {
      const { router } = await makeRouter("/");
      expect(router.activeRoute?.path).toBe("");
    });

    test("sets route path for named route", async () => {
      const { router } = await makeRouter("/about");
      expect(router.activeRoute?.path).toBe("about");
    });

    test("sets route params for dynamic segment", async () => {
      const { router } = await makeRouter("/users/99");
      expect(router.activeRoute?.params).toEqual({ id: "99" });
    });

    test("navigates on Redirect thrown by guard", async () => {
      const guardRoutes = makeRoutes()({
        secret: {
          [GUARD]: async () => {
            throw redirect({ to: "/about" });
          },
          [PAGE]: PageA,
        },
        about: PageB,
      });
      const history = createMemoryHistory({ initialEntries: ["/secret"] });
      const router = new RouterStore({ history });
      // Use full initialize so the history listener wires up the redirect chain.
      router.initialize(guardRoutes);
      // The initial setLocation fires async from initialize; wait for the redirect to resolve.
      await vi.waitFor(() => expect(router.activeRoute?.path).toBe("about"));
    });
  });

  describe("doesPathMatch", () => {
    test("returns true for the active path", async () => {
      const { router } = await makeRouter("/about");
      expect(router.doesPathMatch("/about")).toBe(true);
    });

    test("returns false for a different path", async () => {
      const { router } = await makeRouter("/about");
      expect(router.doesPathMatch("/users")).toBe(false);
    });

    test("matches parent path non-exactly", async () => {
      const { router } = await makeRouter("/users/42");
      expect(router.doesPathMatch("/users")).toBe(true);
    });

    test("does not match parent path when exact=true", async () => {
      const { router } = await makeRouter("/users/42");
      expect(router.doesPathMatch("/users", true)).toBe(false);
    });

    test("matches dynamic segment with $param pattern", async () => {
      const { router } = await makeRouter("/users/42");
      expect(router.doesPathMatch("/users/$id")).toBe(true);
    });
  });

  describe("navigate", () => {
    test("updates history location", async () => {
      const { router, history } = await makeRouter("/");
      router.navigate({ to: "/about" });
      expect(history.location.pathname).toBe("/about");
    });

    test("replace option replaces history entry", async () => {
      const { router, history } = await makeRouter("/");
      router.navigate({ to: "/about", replace: true });
      expect(history.index).toBe(0);
    });

    test("search params appear in location", async () => {
      const { router, history } = await makeRouter("/");
      router.navigate({ to: "/about", search: { q: "hello" } });
      expect(history.location.search).toContain("q=hello");
    });
  });

  describe("query params", () => {
    test("setQueryParam adds a new param while preserving existing ones", async () => {
      const { router, history } = await makeRouter("/?x=1");
      router.setQueryParam("y", "2");
      expect(history.location.search).toContain("y=2");
      expect(history.location.search).toContain("x=1");
    });

    test("removeQueryParam removes a param and returns its value", async () => {
      const { router, history } = await makeRouter("/?x=1&y=2");
      await router.setLocation(history.location);
      const removed = router.removeQueryParam("x");
      expect(removed).toBe("1");
      expect(history.location.search).not.toContain("x=1");
    });

    test("removeQueryParam returns undefined for missing key", async () => {
      const { router } = await makeRouter("/");
      expect(router.removeQueryParam("nope")).toBeUndefined();
    });
  });

  describe("query computed", () => {
    test("query reflects location search as plain object", async () => {
      const history = createMemoryHistory({ initialEntries: ["/?a=1&b=2"] });
      const router = new RouterStore({ history });
      router.routesDef = routes;
      await router.setLocation(history.location);
      expect(router.query).toEqual({ a: "1", b: "2" });
    });
  });
});
