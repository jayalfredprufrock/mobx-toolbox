import { describe, expect, test, vi, beforeEach, afterEach } from "vite-plus/test";
import { createMemoryHistory } from "history";
import { DefaultErrorPage, RouteErrorBoundary } from "./components/error";
import { RouterError } from "./errors";
import { makeRoutes, matchRoute } from "./make-routes";
import type { Outlet } from "./outlet";
import { redirect, Redirect } from "./redirect";
import type { Route } from "./route";
import { RouterStore } from "./router.store";
import { ERROR, GUARD, LAYOUT, LOAD, PAGE, REDIRECT, WRAPPER } from "./symbols";
import type { ExtractPaths, Guard } from "./types";

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

  test("$param route keys surface as :param typed paths", () => {
    const dynamicPath = "/users/:id" satisfies ExtractPaths<typeof routes>;
    expect(dynamicPath).toBe("/users/:id");
  });

  test("supports quoted :param route keys", () => {
    const r = makeRoutes()({
      posts: {
        ":slug": PageA,
      },
    });
    const route = matchRoute("/posts/hello-world", r);
    expect(route.params).toEqual({ slug: "hello-world" });

    const typedPath = "/posts/:slug" satisfies ExtractPaths<typeof r>;
    expect(typedPath).toBe("/posts/:slug");
  });

  test("throws RouterError NOT_FOUND on unknown path", () => {
    expect(() => matchRoute("/nonexistent", routes)).toThrow(RouterError);
    try {
      matchRoute("/nonexistent", routes);
      expect.unreachable();
    } catch (e) {
      const error = e as RouterError;
      expect(error.type).toBe("NOT_FOUND");
      expect(error.path).toBe("/nonexistent");
    }
  });

  test("throws RouterError NOT_FOUND on extra segments after a leaf", () => {
    try {
      matchRoute("/users/42/extra", routes);
      expect.unreachable();
    } catch (e) {
      const error = e as RouterError;
      expect(error.type).toBe("NOT_FOUND");
      expect(error.path).toBe("/users/42/extra");
    }
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
    teams: {
      $teamId: {
        users: {
          $userId: PageA,
        },
      },
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

    test("matches dynamic segment with :param pattern", async () => {
      const { router } = await makeRouter("/users/42");
      expect(router.doesPathMatch("/users/:id")).toBe(true);
    });

    test("does not treat $param as a wildcard in path strings", async () => {
      const { router } = await makeRouter("/users/42");
      expect(router.doesPathMatch("/users/$id")).toBe(false);
    });
  });

  describe("pathParams", () => {
    test("returns params without the $ prefix", async () => {
      const { router } = await makeRouter("/users/42");
      expect(router.pathParams).toEqual({ id: "42" });
    });

    test("captures params from non-consecutive dynamic segments", async () => {
      const { router } = await makeRouter("/teams/7/users/42");
      expect(router.pathParams).toEqual({ teamId: "7", userId: "42" });
    });

    test("is empty for static routes", async () => {
      const { router } = await makeRouter("/about");
      expect(router.pathParams).toEqual({});
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

    test("resolves :params into the pathname", async () => {
      const { router, history } = await makeRouter("/");
      router.navigate({ to: "/users/:id", params: { id: "42" } });
      expect(history.location.pathname).toBe("/users/42");
    });

    test("requires params for dynamic paths at both type and runtime level", async () => {
      const { router } = await makeRouter("/");
      // @ts-expect-error — "/users/:id" requires params
      expect(() => router.navigate({ to: "/users/:id" })).toThrow("Parameter ':id' not specified");
      // @ts-expect-error — params must not be passed for static paths
      router.navigate({ to: "/about", params: { id: "42" } });
      // @ts-expect-error — redirect enforces params the same way
      expect(redirect({ to: "/users/:id" })).toBeInstanceOf(Redirect);
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

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("error handling", () => {
  const AppShell = ({ children }: any) => children;
  const AdminLayout = ({ children }: any) => children;
  const AdminWrapper = ({ children }: any) => children;
  const RootErrorPage = () => null;
  const AdminErrorPage = () => null;

  class AccessDeniedError extends Error {}

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const makeRouter = async (routes: any, initialPath: string) => {
    const history = createMemoryHistory({ initialEntries: [initialPath] });
    const router = new RouterStore({ history });
    router.routesDef = routes;
    await router.setLocation(history.location);
    return { router, history };
  };

  // invoke an outlet's Component the way RouterOutlet would and return the element
  const renderOutlet = (outlet: Outlet | undefined, route?: Route): any =>
    (outlet?.Component as any)?.({ route });

  describe("unknown URLs (404)", () => {
    test("renders the DefaultErrorPage when no [ERROR] is defined", async () => {
      const routes = makeRoutes()({ about: PageB });
      const { router } = await makeRouter(routes, "/nope");

      const route = router.activeRoute;
      expect(route?.error?.type).toBe("NOT_FOUND");
      expect(renderOutlet(route?.outlets.at(-1), route).type).toBe(DefaultErrorPage);
    });

    test("uses the root [ERROR] when defined", async () => {
      const routes = makeRoutes()({ [ERROR]: RootErrorPage, about: PageB });
      const { router } = await makeRouter(routes, "/nope");

      const element = renderOutlet(router.activeRoute?.outlets.at(-1), router.activeRoute);
      expect(element.type).toBe(RootErrorPage);
      expect(element.props.error.type).toBe("NOT_FOUND");
      expect(element.props.error.path).toBe("/nope");
    });

    test("keeps layout and wrappers of the matched prefix and uses the nearest [ERROR]", async () => {
      const routes = makeRoutes()({
        [LAYOUT]: AppShell,
        [ERROR]: RootErrorPage,
        admin: {
          [WRAPPER]: AdminWrapper,
          [ERROR]: AdminErrorPage,
          users: PageA,
        },
      });
      const { router } = await makeRouter(routes, "/admin/nope");

      const route = router.activeRoute;
      expect(route?.error?.type).toBe("NOT_FOUND");
      expect(route?.layout).toBe(AppShell);
      // admin's wrapper is preserved, followed by the error outlet
      expect(route?.outlets).toHaveLength(2);
      expect(route?.outlets[0]?.Component).toBe(AdminWrapper);
      expect(renderOutlet(route?.outlets.at(-1), route).type).toBe(AdminErrorPage);
    });
  });

  describe("guard failures", () => {
    test("an app-level error renders the nearest [ERROR] with type GUARD and preserves the URL", async () => {
      const denied = new AccessDeniedError("missing role");
      const routes = makeRoutes()({
        [LAYOUT]: AppShell,
        [ERROR]: RootErrorPage,
        admin: {
          [LAYOUT]: AdminLayout,
          [GUARD]: async () => {
            throw denied;
          },
          [ERROR]: AdminErrorPage,
          users: PageA,
        },
      });
      const { router, history } = await makeRouter(routes, "/admin/users");

      const route = router.activeRoute;
      expect(route?.error?.type).toBe("GUARD");
      expect(route?.error?.cause).toBe(denied);
      expect(renderOutlet(route?.outlets.at(-1), route).type).toBe(AdminErrorPage);
      // the failing level's own [LAYOUT] override applies — that level did match
      expect(route?.layout).toBe(AdminLayout);
      expect(history.location.pathname).toBe("/admin/users");
    });

    test("a root-level guard failure bubbles to the root [ERROR], not a nested one", async () => {
      const routes = makeRoutes()({
        [LAYOUT]: AppShell,
        [ERROR]: RootErrorPage,
        [GUARD]: async () => {
          throw new Error("nope");
        },
        admin: { [LAYOUT]: AdminLayout, [ERROR]: AdminErrorPage, users: PageA },
      });
      const { router } = await makeRouter(routes, "/admin/users");

      expect(router.activeRoute?.error?.type).toBe("GUARD");
      const element = renderOutlet(router.activeRoute?.outlets.at(-1), router.activeRoute);
      expect(element.type).toBe(RootErrorPage);
      // a [LAYOUT] override deeper than the throwing guard does not apply
      expect(router.activeRoute?.layout).toBe(AppShell);
    });

    test("a guard throwing RouterError passes it through unwrapped", async () => {
      const routes = makeRoutes()({
        [ERROR]: RootErrorPage,
        secret: {
          [GUARD]: async () => {
            throw new RouterError("NOT_FOUND");
          },
          [PAGE]: PageA,
        },
      });
      const { router } = await makeRouter(routes, "/secret");

      expect(router.activeRoute?.error?.type).toBe("NOT_FOUND");
      expect(router.activeRoute?.error?.cause).toBeUndefined();
    });
  });

  describe("loader failures", () => {
    test("a failing loader renders the nearest [ERROR] in its own outlet slot", async () => {
      const cause = new Error("fetch failed");
      const routes = makeRoutes()({
        [ERROR]: RootErrorPage,
        dashboard: {
          [LOAD]: async () => {
            throw cause;
          },
          [PAGE]: PageA,
        },
      });
      const { router } = await makeRouter(routes, "/dashboard");

      const route = router.activeRoute;
      // navigation itself succeeded — this is not a synthetic error route
      expect(route?.error).toBeUndefined();

      const pageOutlet = route?.outlets.at(-1);
      expect(pageOutlet?.state).toBe("error");
      expect(pageOutlet?.error?.type).toBe("LOAD");
      expect(pageOutlet?.error?.cause).toBe(cause);
      expect(renderOutlet(pageOutlet, route).type).toBe(RootErrorPage);
    });

    test("a loader throwing Redirect navigates", async () => {
      const routes = makeRoutes()({
        about: PageB,
        dashboard: {
          [LOAD]: async () => {
            throw redirect({ to: "/about" });
          },
          [PAGE]: PageA,
        },
      });
      const { history } = await makeRouter(routes, "/dashboard");

      expect(history.location.pathname).toBe("/about");
    });

    test("a loader throwing RouterError('NOT_FOUND') keeps the type", async () => {
      const routes = makeRoutes()({
        dashboard: {
          [LOAD]: async () => {
            throw new RouterError("NOT_FOUND");
          },
          [PAGE]: PageA,
        },
      });
      const { router } = await makeRouter(routes, "/dashboard");

      const pageOutlet = router.activeRoute?.outlets.at(-1);
      expect(pageOutlet?.error?.type).toBe("NOT_FOUND");
      expect(renderOutlet(pageOutlet, router.activeRoute).type).toBe(DefaultErrorPage);
    });
  });

  describe("RouteErrorBoundary", () => {
    test("wraps render crashes as RouterError('RENDER') and passes RouterError through", () => {
      const boom = new Error("boom");
      const state = RouteErrorBoundary.getDerivedStateFromError(boom);
      expect(state.error).toBeInstanceOf(RouterError);
      expect(state.error?.type).toBe("RENDER");
      expect(state.error?.cause).toBe(boom);

      const passthrough = RouteErrorBoundary.getDerivedStateFromError(new RouterError("LOAD"));
      expect(passthrough.error?.type).toBe("LOAD");
    });

    test("renders children without an error and the fallback with one", () => {
      const route = {} as Route;
      const boundary = new RouteErrorBoundary({
        route,
        fallback: RootErrorPage,
        children: "content",
      });

      expect(boundary.render()).toBe("content");

      boundary.state = { error: new RouterError("RENDER") };
      const element = boundary.render() as any;
      expect(element.type).toBe(RootErrorPage);
      expect(element.props.error.type).toBe("RENDER");
      expect(element.props.route).toBe(route);
    });
  });
});
