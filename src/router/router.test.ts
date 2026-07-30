import { describe, expect, test, vi, beforeEach, afterEach } from "vite-plus/test";
import { createMemoryHistory } from "history";
import { DefaultErrorPage, RouteErrorBoundary } from "./components/error";
import { RouterError } from "./errors";
import { makeRoutes, matchRoute } from "./make-routes";
import { DefaultLoadingPage, Outlet } from "./outlet";
import { redirect, Redirect } from "./redirect";
import type { Route } from "./route";
import { RouterStore } from "./router.store";
import { ERROR, GUARD, LAYOUT, LOAD, LOADING, PAGE, REDIRECT, WRAPPER } from "./symbols";
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

    test("navigating to the current URL is a no-op", async () => {
      const { router, history } = await makeRouter("/about");
      const before = router.activeRoute;
      router.navigate({ to: "/about" });
      expect(history.index).toBe(0);
      expect(router.activeRoute).toBe(before);
    });

    test("the no-op comparison includes search params", async () => {
      const { router, history } = await makeRouter("/about?q=1");
      router.navigate({ to: "/about", search: { q: "1" } });
      expect(history.index).toBe(0);

      router.navigate({ to: "/about", search: { q: "2" } });
      expect(history.index).toBe(1);
      expect(history.location.search).toBe("?q=2");
    });

    test("navigating to the current URL with state still navigates", async () => {
      const { router, history } = await makeRouter("/about");
      router.navigate({ to: "/about", state: { fromMenu: true } });
      expect(history.index).toBe(1);
    });
  });

  describe("same-pathname location changes", () => {
    test("query-param changes do not rebuild the route or re-run loaders", async () => {
      let loads = 0;
      const loaderRoutes = makeRoutes()({
        dashboard: {
          [LOAD]: async () => {
            loads++;
            return {};
          },
          [PAGE]: PageA,
        },
      });
      const history = createMemoryHistory({ initialEntries: ["/dashboard"] });
      const router = new RouterStore({ history });
      router.initialize(loaderRoutes);
      await vi.waitFor(() => expect(router.activeRoute).toBeDefined());
      await vi.waitFor(() => expect(loads).toBe(1));
      const route = router.activeRoute;

      router.setQueryParam("page", "2");
      await vi.waitFor(() => expect(router.location.search).toBe("?page=2"));

      expect(router.activeRoute).toBe(route);
      expect(loads).toBe(1);
      expect(router.query).toEqual({ page: "2" });
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

    test("resets its captured error when a new route is rendered", () => {
      const routeA = {} as Route;
      const routeB = {} as Route;

      // simulate React's lifecycle: mount, crash, re-render, navigate
      let state = {
        ...RouteErrorBoundary.getDerivedStateFromProps(
          { route: routeA, fallback: RootErrorPage },
          {},
        ),
      };
      state = { ...state, ...RouteErrorBoundary.getDerivedStateFromError(new Error("boom")) };
      expect(state.error).toBeDefined();

      // re-render with the same route keeps the error (no reset loop)
      expect(
        RouteErrorBoundary.getDerivedStateFromProps(
          { route: routeA, fallback: RootErrorPage },
          state,
        ),
      ).toBeNull();

      // a new Route object (navigation) clears the error without a remount
      const next = RouteErrorBoundary.getDerivedStateFromProps(
        { route: routeB, fallback: RootErrorPage },
        state,
      );
      expect(next?.error).toBeUndefined();
      expect(next?.route).toBe(routeB);
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

  describe("in-slot errors drop children", () => {
    test("a failing loader's [ERROR] does not render the outlets below it", async () => {
      const routes = makeRoutes()({
        [ERROR]: RootErrorPage,
        dashboard: {
          [LOAD]: async () => {
            throw new Error("fetch failed");
          },
          users: PageA,
        },
      });
      const { router } = await makeRouter(routes, "/dashboard/users");

      // the load outlet failed while the page outlet below it went ready;
      // forwarding children would paint PageA without route.data
      const loadOutlet = router.activeRoute?.outlets[0];
      expect(loadOutlet?.state).toBe("error");
      const element = (loadOutlet?.Component as any)?.({
        route: router.activeRoute,
        children: "BELOW",
      });
      expect(element.type).toBe(RootErrorPage);
      expect(element.props.children).toBeUndefined();
    });
  });
});

describe("loading states", () => {
  const RootLoadingPage = () => null;
  const AdminLoadingPage = () => null;
  const PageLoadingPage = () => null;

  const deferred = () => {
    let resolve!: (value?: unknown) => void;
    const promise = new Promise((res) => {
      resolve = res as any;
    });
    return { promise, resolve };
  };

  // start a navigation without awaiting it, advancing just far enough for
  // the router to set pendingRoute and begin loading its outlets
  const startNavigation = async (routes: any, initialPath: string) => {
    const history = createMemoryHistory({ initialEntries: [initialPath] });
    const router = new RouterStore({ history });
    router.routesDef = routes;
    const navigation = router.setLocation(history.location);
    await vi.advanceTimersByTimeAsync(0);
    return { router, navigation };
  };

  const renderOutlet = (outlet: Outlet | undefined, route?: Route): any =>
    (outlet?.Component as any)?.({ route });

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("a pending outlet renders nothing during the debounce window", async () => {
    const load = deferred();
    const routes = makeRoutes()({
      [LOADING]: RootLoadingPage,
      dashboard: { [LOAD]: () => load.promise, [PAGE]: PageA },
    });
    const { router } = await startNavigation(routes, "/dashboard");

    const route = router.pendingRoute;
    const pageOutlet = route?.outlets.at(-1);
    expect(pageOutlet?.state).toBe("preloading");
    expect(pageOutlet?.Component).toBeUndefined();

    // in flight, but not long enough to show an indicator
    expect(route?.isPending).toBe(true);
    expect(route?.isLoading).toBe(false);
  });

  test("crossing the debounce window renders the nearest [LOADING]", async () => {
    const load = deferred();
    const routes = makeRoutes()({
      [LOADING]: RootLoadingPage,
      dashboard: { [LOAD]: () => load.promise, [PAGE]: PageA },
    });
    const { router } = await startNavigation(routes, "/dashboard");

    await vi.advanceTimersByTimeAsync(300);

    const route = router.pendingRoute;
    const pageOutlet = route?.outlets.at(-1);
    expect(pageOutlet?.state).toBe("loading");
    expect(route?.isLoading).toBe(true);
    expect(route?.isPending).toBe(true);
    expect(renderOutlet(pageOutlet, route).type).toBe(RootLoadingPage);
  });

  test("falls back to DefaultLoadingPage when no [LOADING] is defined", async () => {
    const load = deferred();
    const routes = makeRoutes()({
      dashboard: { [LOAD]: () => load.promise, [PAGE]: PageA },
    });
    const { router } = await startNavigation(routes, "/dashboard");
    await vi.advanceTimersByTimeAsync(300);

    const pageOutlet = router.pendingRoute?.outlets.at(-1);
    expect(renderOutlet(pageOutlet, router.pendingRoute).type).toBe(DefaultLoadingPage);
  });

  test("[LOADING] inherits down the tree and a nested one overrides it", async () => {
    const load = deferred();
    const routes = makeRoutes()({
      [LOADING]: RootLoadingPage,
      admin: {
        [LOADING]: AdminLoadingPage,
        [LOAD]: () => load.promise,
        users: PageA,
      },
    });
    const { router } = await startNavigation(routes, "/admin/users");
    await vi.advanceTimersByTimeAsync(300);

    const loadOutlet = router.pendingRoute?.outlets[0];
    expect(loadOutlet?.state).toBe("loading");
    expect(renderOutlet(loadOutlet, router.pendingRoute).type).toBe(AdminLoadingPage);
  });

  test("[LOADING] on a [PAGE] applies to that page's outlet", async () => {
    const load = deferred();
    const routes = makeRoutes()({
      [LOADING]: RootLoadingPage,
      dashboard: {
        [LOADING]: PageLoadingPage,
        [LOAD]: () => load.promise,
        [PAGE]: PageA,
      },
    });
    const { router } = await startNavigation(routes, "/dashboard");
    await vi.advanceTimersByTimeAsync(300);

    const pageOutlet = router.pendingRoute?.outlets.at(-1);
    expect(renderOutlet(pageOutlet, router.pendingRoute).type).toBe(PageLoadingPage);
  });

  test("the [LOADING] component receives route and never children", async () => {
    const load = deferred();
    const routes = makeRoutes()({
      [LOADING]: RootLoadingPage,
      dashboard: { [LOAD]: () => load.promise, users: PageA },
    });
    const { router } = await startNavigation(routes, "/dashboard/users");
    await vi.advanceTimersByTimeAsync(300);

    const route = router.pendingRoute;
    const loadOutlet = route?.outlets[0];
    const element = (loadOutlet?.Component as any)?.({ route, children: "BELOW" });
    expect(element.props.route).toBe(route);
    expect(element.props.children).toBeUndefined();
  });

  test("a fast loader never leaves the quiet window", async () => {
    const routes = makeRoutes()({
      [LOADING]: RootLoadingPage,
      dashboard: { [LOAD]: async () => ({ a: 1 }), [PAGE]: PageA },
    });
    const { router, navigation } = await startNavigation(routes, "/dashboard");
    await navigation;

    const route = router.activeRoute;
    const pageOutlet = route?.outlets.at(-1);
    expect(pageOutlet?.state).toBe("ready");
    expect(route?.isLoading).toBe(false);
    expect(route?.isPending).toBe(false);
  });

  test("a slow loader holds the indicator for the minimum duration after resolving", async () => {
    const load = deferred();
    const routes = makeRoutes()({
      [LOADING]: RootLoadingPage,
      dashboard: { [LOAD]: () => load.promise, [PAGE]: PageA },
    });
    const { router, navigation } = await startNavigation(routes, "/dashboard");
    await vi.advanceTimersByTimeAsync(300);

    const route = router.pendingRoute;
    const pageOutlet = route?.outlets.at(-1);
    expect(pageOutlet?.state).toBe("loading");

    load.resolve({ a: 1 });
    await navigation;

    // data is in, but the indicator is held back to avoid a flicker
    expect(pageOutlet?.state).toBe("loading");
    expect(route?.isLoading).toBe(true);

    await vi.advanceTimersByTimeAsync(300);
    expect(pageOutlet?.state).toBe("ready");
    expect(route?.isLoading).toBe(false);
  });

  test("isLoading is false on a route whose outlets have no work to do", async () => {
    const routes = makeRoutes()({ dashboard: PageA });
    const { router, navigation } = await startNavigation(routes, "/dashboard");
    await navigation;

    expect(router.activeRoute?.isPending).toBe(false);
    expect(router.activeRoute?.isLoading).toBe(false);
  });
});

describe("deferred route swap", () => {
  const deferred = () => {
    let resolve!: (value?: unknown) => void;
    const promise = new Promise((res) => {
      resolve = res as any;
    });
    return { promise, resolve };
  };

  // a warm router: already showing a page, with the history listener wired
  // so navigate() drives setLocation the way it does in an app
  const makeWarmRouter = async (routes: any) => {
    const history = createMemoryHistory({ initialEntries: ["/"] });
    const router = new RouterStore({ history });
    router.initialize(routes);
    await vi.advanceTimersByTimeAsync(0);
    expect(router.activeRoute?.path).toBe("");
    return { router, history };
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("the previous page stays active until the pending route has loaded", async () => {
    const load = deferred();
    const { router } = await makeWarmRouter(
      makeRoutes()({
        index: PageA,
        slow: { [LOAD]: () => load.promise, [PAGE]: PageB },
      }),
    );

    router.navigate({ to: "/slow" } as any);
    await vi.advanceTimersByTimeAsync(0);

    // the old page is still on screen; the new one is only pending
    expect(router.activeRoute?.path).toBe("");
    expect(router.pendingRoute?.path).toBe("slow");
    expect(router.isNavigating).toBe(true);
    expect(router.isLoading).toBe(false);

    // still holding the old page once the indicator threshold passes
    await vi.advanceTimersByTimeAsync(300);
    expect(router.isLoading).toBe(true);
    expect(router.activeRoute?.path).toBe("");

    load.resolve({ a: 1 });
    await vi.advanceTimersByTimeAsync(0);

    expect(router.activeRoute?.path).toBe("slow");
    expect(router.pendingRoute).toBeUndefined();
    expect(router.isNavigating).toBe(false);
    expect(router.isLoading).toBe(false);
  });

  test("a warm navigation does not hold content back once the data arrives", async () => {
    const load = deferred();
    const { router } = await makeWarmRouter(
      makeRoutes()({
        index: PageA,
        slow: { [LOAD]: () => load.promise, [PAGE]: PageB },
      }),
    );

    router.navigate({ to: "/slow" } as any);
    await vi.advanceTimersByTimeAsync(300); // long enough to cross the debounce

    load.resolve({ a: 1 });
    await vi.advanceTimersByTimeAsync(0);

    // no minimum-duration hold: the previous page was on screen, not an
    // indicator, so there is nothing to keep from flashing
    expect(router.activeRoute?.outlets.at(-1)?.state).toBe("ready");
    expect(router.isLoading).toBe(false);
  });

  test("a cold load does hold, so the [LOADING] component can't flash", async () => {
    const load = deferred();
    const routes = makeRoutes()({ slow: { [LOAD]: () => load.promise, [PAGE]: PageB } });
    const history = createMemoryHistory({ initialEntries: ["/slow"] });
    const router = new RouterStore({ history });
    router.initialize(routes);

    await vi.advanceTimersByTimeAsync(300);
    const pending = router.pendingRoute;
    expect(pending?.isLoading).toBe(true);

    load.resolve({ a: 1 });
    await vi.advanceTimersByTimeAsync(0);

    // data is in and the route has landed, but the indicator is held
    expect(router.activeRoute?.path).toBe("slow");
    expect(pending?.outlets.at(-1)?.state).toBe("loading");
    expect(router.isLoading).toBe(true);

    await vi.advanceTimersByTimeAsync(300);
    expect(pending?.outlets.at(-1)?.state).toBe("ready");
    expect(router.isLoading).toBe(false);
  });

  test("a second navigation wins and the first no longer swaps", async () => {
    const slowLoad = deferred();
    const { router } = await makeWarmRouter(
      makeRoutes()({
        index: PageA,
        slow: { [LOAD]: () => slowLoad.promise, [PAGE]: PageB },
        other: PageC,
      }),
    );

    router.navigate({ to: "/slow" } as any);
    await vi.advanceTimersByTimeAsync(0);
    expect(router.pendingRoute?.path).toBe("slow");

    router.navigate({ to: "/other" } as any);
    await vi.advanceTimersByTimeAsync(0);
    expect(router.activeRoute?.path).toBe("other");
    expect(router.pendingRoute).toBeUndefined();

    // the abandoned navigation finishes late and must not clobber the URL
    slowLoad.resolve({ a: 1 });
    await vi.advanceTimersByTimeAsync(400);
    expect(router.activeRoute?.path).toBe("other");
    expect(router.pendingRoute).toBeUndefined();
  });

  test("a query-param change during a pending navigation does not cancel it", async () => {
    const load = deferred();
    const { router } = await makeWarmRouter(
      makeRoutes()({
        index: PageA,
        slow: { [LOAD]: () => load.promise, [PAGE]: PageB },
      }),
    );

    router.navigate({ to: "/slow" } as any);
    await vi.advanceTimersByTimeAsync(0);
    expect(router.pendingRoute?.path).toBe("slow");

    // same pathname, so this must not re-match or invalidate the in-flight
    // navigation — staleness is compared by pathname, not Location identity
    router.setQueryParam("q", "x");
    await vi.advanceTimersByTimeAsync(0);
    expect(router.isNavigating).toBe(true);

    load.resolve({ a: 1 });
    await vi.advanceTimersByTimeAsync(0);

    expect(router.activeRoute?.path).toBe("slow");
    expect(router.query).toEqual({ q: "x" });
  });

  test("a guard failure replaces the pending route with the error route", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { router } = await makeWarmRouter(
      makeRoutes()({
        index: PageA,
        secret: {
          [GUARD]: async () => {
            throw new Error("denied");
          },
          [PAGE]: PageB,
        },
      }),
    );

    router.navigate({ to: "/secret" } as any);
    await vi.advanceTimersByTimeAsync(0);

    expect(router.activeRoute?.error?.type).toBe("GUARD");
    expect(router.pendingRoute).toBeUndefined();
    expect(router.isNavigating).toBe(false);
    vi.restoreAllMocks();
  });
});

describe("view transitions", () => {
  const deferred = () => {
    let resolve!: (value?: unknown) => void;
    const promise = new Promise((res) => {
      resolve = res as any;
    });
    return { promise, resolve };
  };

  // Models the real API: the browser captures the old snapshot, then calls
  // the update callback asynchronously, then animates.
  const stubViewTransitions = (opts: { readyRejects?: boolean } = {}) => {
    const startViewTransition = vi.fn((cb: () => void) => ({
      ready: opts.readyRejects ? Promise.reject(new Error("skipped")) : Promise.resolve(),
      updateCallbackDone: Promise.resolve().then(() => {
        cb();
      }),
      finished: Promise.resolve(),
      skipTransition: () => {},
    }));
    vi.stubGlobal("document", { startViewTransition, activeElement: null });
    return startViewTransition;
  };

  const routesWithSlowPage = (load: Promise<unknown>) =>
    makeRoutes()({
      index: PageA,
      slow: { [LOAD]: () => load, [PAGE]: PageB },
    });

  const warmRouter = async (routes: any, config: any = {}) => {
    const history = createMemoryHistory({ initialEntries: ["/"] });
    const router = new RouterStore({ history, ...config });
    router.initialize(routes);
    await vi.advanceTimersByTimeAsync(0);
    expect(router.activeRoute?.path).toBe("");
    return { router, history };
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("wraps the route swap and not the load phase", async () => {
    const startViewTransition = stubViewTransitions();
    const load = deferred();
    const { router } = await warmRouter(routesWithSlowPage(load.promise));

    router.navigate({ to: "/slow" } as any);
    await vi.advanceTimersByTimeAsync(400);

    // still loading: starting the transition here would freeze the page on
    // its old snapshot for the whole fetch
    expect(startViewTransition).not.toHaveBeenCalled();
    expect(router.isLoading).toBe(true);

    load.resolve({ a: 1 });
    await vi.advanceTimersByTimeAsync(0);

    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(router.activeRoute?.path).toBe("slow");
  });

  test("the swap happens inside the update callback, not before it", async () => {
    let capturedCallback: (() => void) | undefined;
    const startViewTransition = vi.fn((cb: () => void) => {
      capturedCallback = cb;
      return {
        ready: Promise.resolve(),
        updateCallbackDone: Promise.resolve(),
        finished: Promise.resolve(),
        skipTransition: () => {},
      };
    });
    vi.stubGlobal("document", { startViewTransition, activeElement: null });

    const { router } = await warmRouter(makeRoutes()({ index: PageA, other: PageC }));

    router.navigate({ to: "/other" } as any);
    await vi.advanceTimersByTimeAsync(0);

    // the callback was handed over but never invoked by this stub, so the
    // old route must still be active — proving the swap is inside it
    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(router.activeRoute?.path).toBe("");

    capturedCallback?.();
    expect(router.activeRoute?.path).toBe("other");
  });

  test("does not transition on a cold load", async () => {
    const startViewTransition = stubViewTransitions();
    const history = createMemoryHistory({ initialEntries: ["/"] });
    const router = new RouterStore({ history });
    router.initialize(makeRoutes()({ index: PageA }));
    await vi.advanceTimersByTimeAsync(0);

    expect(router.activeRoute?.path).toBe("");
    expect(startViewTransition).not.toHaveBeenCalled();
  });

  test("swaps directly when the browser has no support", async () => {
    // the outer beforeEach stubs startViewTransition as undefined
    const { router } = await warmRouter(makeRoutes()({ index: PageA, other: PageC }));

    router.navigate({ to: "/other" } as any);
    await vi.advanceTimersByTimeAsync(0);

    expect(router.activeRoute?.path).toBe("other");
  });

  test("a skipped transition does not break the navigation", async () => {
    const startViewTransition = stubViewTransitions({ readyRejects: true });
    const { router } = await warmRouter(makeRoutes()({ index: PageA, other: PageC }));

    router.navigate({ to: "/other" } as any);
    await vi.advanceTimersByTimeAsync(0);

    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(router.activeRoute?.path).toBe("other");
  });

  test("viewTransitions: false opts out entirely", async () => {
    const startViewTransition = stubViewTransitions();
    const { router } = await warmRouter(makeRoutes()({ index: PageA, other: PageC }), {
      viewTransitions: false,
    });

    router.navigate({ to: "/other" } as any);
    await vi.advanceTimersByTimeAsync(0);

    expect(startViewTransition).not.toHaveBeenCalled();
    expect(router.activeRoute?.path).toBe("other");
  });
});

describe("React Refresh invariants", () => {
  test("an outlet holds the page component by plain reference, unwrapped by MobX", () => {
    const outlet = new Outlet({ component: PageA });

    // React Refresh swaps implementations by looking up the *registered*
    // function in its family map. If MobX wrapped this field (as
    // makeAutoObservable does for function values by default) the identity
    // reaching React would be an action wrapper that belongs to no family,
    // and edits to a page would stop hot-updating. `component: false` in
    // the annotations is what prevents that — this asserts it stays.
    expect(outlet.component).toBe(PageA);
    outlet.setState("ready");
    expect(outlet.Component).toBe(PageA);
  });

  test("a directly referenced component reaches React through the route chain", async () => {
    const routes = makeRoutes()({ dashboard: { [PAGE]: PageA }, plain: PageB });
    const history = createMemoryHistory({ initialEntries: ["/dashboard"] });
    const router = new RouterStore({ history });
    router.routesDef = routes;

    await router.setLocation(history.location);
    expect(router.activeRoute?.outlets.at(-1)?.Component).toBe(PageA);

    await router.setLocation({ ...history.location, pathname: "/plain" } as any);
    expect(router.activeRoute?.outlets.at(-1)?.Component).toBe(PageB);
  });
});

describe("loading signals for indicator UI", () => {
  const deferred = () => {
    let resolve!: (value?: unknown) => void;
    const promise = new Promise((res) => {
      resolve = res as any;
    });
    return { promise, resolve };
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("a cold load shows [LOADING] but never the progress bar", async () => {
    const load = deferred();
    const routes = makeRoutes()({ slow: { [LOAD]: () => load.promise, [PAGE]: PageB } });
    const history = createMemoryHistory({ initialEntries: ["/slow"] });
    const router = new RouterStore({ history });
    router.initialize(routes as any);

    // skeleton on screen: isLoading is set, but there is no previous page,
    // so a bar would be redundant with the skeleton
    await vi.advanceTimersByTimeAsync(300);
    expect(router.isLoading).toBe(true);
    expect(router.isSlowNavigation).toBe(false);

    // the hold window after data arrives — isLoading is still true because
    // the skeleton is still up, and activeRoute is now set, so a naive
    // `isLoading && activeRoute` check would flash a bar here
    load.resolve({ a: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(router.isLoading).toBe(true);
    expect(router.activeRoute).toBeDefined();
    expect(router.isSlowNavigation).toBe(false);

    await vi.advanceTimersByTimeAsync(300);
    expect(router.isLoading).toBe(false);
    expect(router.isSlowNavigation).toBe(false);
  });

  test("a warm navigation shows the progress bar and never [LOADING]", async () => {
    const load = deferred();
    const routes = makeRoutes()({
      index: PageA,
      slow: { [LOAD]: () => load.promise, [PAGE]: PageB },
    });
    const history = createMemoryHistory({ initialEntries: ["/"] });
    const router = new RouterStore({ history });
    router.initialize(routes as any);
    await vi.advanceTimersByTimeAsync(0);

    // inside the debounce: in flight, but nothing shown yet
    router.navigate({ to: "/slow" } as any);
    await vi.advanceTimersByTimeAsync(100);
    expect(router.isNavigating).toBe(true);
    expect(router.isSlowNavigation).toBe(false);

    // past the debounce: bar over the still-rendered previous page. The
    // pending route's outlets are not rendered, so [LOADING] cannot appear.
    await vi.advanceTimersByTimeAsync(300);
    expect(router.isSlowNavigation).toBe(true);
    expect(router.activeRoute?.path).toBe("");

    load.resolve({ a: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(router.isSlowNavigation).toBe(false);
    expect(router.activeRoute?.path).toBe("slow");
  });
});

describe("isSlowNavigation spans the guard phase", () => {
  const deferred = () => {
    let resolve!: (value?: unknown) => void;
    const promise = new Promise((res) => {
      resolve = res as any;
    });
    return { promise, resolve };
  };

  const warmRouter = async (routes: any) => {
    const history = createMemoryHistory({ initialEntries: ["/"] });
    const router = new RouterStore({ history });
    router.initialize(routes);
    await vi.advanceTimersByTimeAsync(0);
    expect(router.activeRoute?.path).toBe("");
    return router;
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("a slow guard trips the signal even though no outlet is loading", async () => {
    const gate = deferred();
    const router = await warmRouter(
      makeRoutes()({
        index: PageA,
        secret: { [GUARD]: async () => void (await gate.promise), [PAGE]: PageB },
      }),
    );

    router.navigate({ to: "/secret" } as any);
    await vi.advanceTimersByTimeAsync(100);
    expect(router.isSlowNavigation).toBe(false);

    // past the debounce while still inside the guard: no pendingRoute yet,
    // so an outlet-derived signal could not see this
    await vi.advanceTimersByTimeAsync(250);
    expect(router.pendingRoute).toBeUndefined();
    expect(router.isSlowNavigation).toBe(true);
    expect(router.isLoading).toBe(true);
    expect(router.activeRoute?.path).toBe("");

    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(router.activeRoute?.path).toBe("secret");
    expect(router.isSlowNavigation).toBe(false);
  });

  test("a fast guard never trips it", async () => {
    const router = await warmRouter(
      makeRoutes()({
        index: PageA,
        secret: { [GUARD]: async () => {}, [PAGE]: PageB },
      }),
    );

    router.navigate({ to: "/secret" } as any);
    await vi.advanceTimersByTimeAsync(0);
    expect(router.activeRoute?.path).toBe("secret");
    expect(router.isSlowNavigation).toBe(false);

    // the timer must not fire after the navigation has landed
    await vi.advanceTimersByTimeAsync(400);
    expect(router.isSlowNavigation).toBe(false);
  });

  test("guard and load time accumulate: neither phase alone crosses the threshold", async () => {
    const guardGate = deferred();
    const loadGate = deferred();
    const router = await warmRouter(
      makeRoutes()({
        index: PageA,
        slow: {
          [GUARD]: async () => void (await guardGate.promise),
          [LOAD]: () => loadGate.promise,
          [PAGE]: PageB,
        },
      }),
    );

    router.navigate({ to: "/slow" } as any);

    // 200ms of guard — under the 300ms threshold on its own
    await vi.advanceTimersByTimeAsync(200);
    expect(router.isSlowNavigation).toBe(false);
    guardGate.resolve();
    await vi.advanceTimersByTimeAsync(0);

    // 150ms of loading — also under the threshold on its own, and the
    // outlet's own clock has only just started. The navigation-level clock
    // is at 350ms, which is what the user has actually waited.
    await vi.advanceTimersByTimeAsync(150);
    expect(router.pendingRoute?.isLoading).toBe(false);
    expect(router.isSlowNavigation).toBe(true);

    loadGate.resolve({});
    await vi.advanceTimersByTimeAsync(0);
    expect(router.activeRoute?.path).toBe("slow");
    expect(router.isSlowNavigation).toBe(false);
  });

  test("a superseding navigation does not blink an already-visible indicator", async () => {
    const gate = deferred();
    const router = await warmRouter(
      makeRoutes()({
        index: PageA,
        first: { [GUARD]: async () => void (await gate.promise), [PAGE]: PageB },
        second: { [LOAD]: () => new Promise(() => {}), [PAGE]: PageC },
      }),
    );

    router.navigate({ to: "/first" } as any);
    await vi.advanceTimersByTimeAsync(350);
    expect(router.isSlowNavigation).toBe(true);

    // redirecting attention to another slow route mid-flight: the bar stays
    // up rather than dropping out and fading back in
    router.navigate({ to: "/second" } as any);
    await vi.advanceTimersByTimeAsync(0);
    expect(router.isSlowNavigation).toBe(true);

    // the abandoned navigation finishing must not clear the live one's clock
    gate.resolve();
    await vi.advanceTimersByTimeAsync(50);
    expect(router.isSlowNavigation).toBe(true);
  });
});

describe("isNavigating spans the guard phase", () => {
  const deferred = () => {
    let resolve!: (value?: unknown) => void;
    const promise = new Promise((res) => {
      resolve = res as any;
    });
    return { promise, resolve };
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("true while a guard runs, before any pendingRoute exists", async () => {
    const gate = deferred();
    const history = createMemoryHistory({ initialEntries: ["/"] });
    const router = new RouterStore({ history });
    router.initialize(
      makeRoutes()({
        index: PageA,
        secret: { [GUARD]: async () => void (await gate.promise), [PAGE]: PageB },
      }) as any,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(router.isNavigating).toBe(false);

    router.navigate({ to: "/secret" } as any);
    await vi.advanceTimersByTimeAsync(10);

    // in flight, but no route is loading yet — the distinction the old
    // pendingRoute-derived definition could not express
    expect(router.isNavigating).toBe(true);
    expect(router.pendingRoute).toBeUndefined();

    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(router.isNavigating).toBe(false);
    expect(router.activeRoute?.path).toBe("secret");
  });

  test("false again after a guard failure lands an error route", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const history = createMemoryHistory({ initialEntries: ["/"] });
    const router = new RouterStore({ history });
    router.initialize(
      makeRoutes()({
        index: PageA,
        secret: {
          [GUARD]: async () => {
            throw new Error("denied");
          },
          [PAGE]: PageB,
        },
      }) as any,
    );
    await vi.advanceTimersByTimeAsync(0);

    router.navigate({ to: "/secret" } as any);
    await vi.advanceTimersByTimeAsync(0);

    expect(router.activeRoute?.error?.type).toBe("GUARD");
    expect(router.isNavigating).toBe(false);
    vi.restoreAllMocks();
  });
});
