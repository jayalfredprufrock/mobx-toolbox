import { describe, expect, test, vi, beforeEach, afterEach } from "vite-plus/test";
import { createMemoryHistory } from "history";
import { autorun } from "mobx";
import { DefaultErrorPage, RouteErrorBoundary } from "./components/error";
import { RouterError } from "./errors";
import { makeErrorRoute, makeRoutes, matchRoute } from "./make-routes";
import { DefaultLoadingPage, Outlet } from "./outlet";
import { redirect, Redirect } from "./redirect";
import type { Route } from "./route";
import { RouterStore } from "./router.store";
import { CONTEXT, ERROR, GUARD, LAYOUT, LOAD, LOADING, PAGE, REDIRECT, WRAPPER } from "./symbols";
import type { ExtractPaths, Guard, NormalizeRootPath, RedirectTarget, RouteLevel } from "./types";
import { resolvePath, tryResolvePath } from "./util";

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
    // an index key addresses its parent's path and contributes no segment
    expect(route.path).toBe("users");
  });

  test("matches a nested index path written with a trailing slash", () => {
    expect(matchRoute("/users/", routes).path).toBe("users");
  });

  test("typed index paths carry no trailing slash; the root normalizes to '/'", () => {
    const indexPath = "/users" satisfies ExtractPaths<typeof routes>;
    const rootPath = "/" satisfies NormalizeRootPath<ExtractPaths<typeof routes>>;
    expect([indexPath, rootPath]).toEqual(["/users", "/"]);
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

  test("[REDIRECT] accepts full navigation options", () => {
    const r = makeRoutes()({
      old: { [REDIRECT]: { to: "/about", replace: true } },
      about: PageA,
    });
    try {
      matchRoute("/old", r);
      expect.unreachable();
    } catch (e) {
      expect((e as Redirect).options).toEqual({ to: "/about", replace: true });
    }
  });

  test("[REDIRECT] as a function receives the route it matched", () => {
    const r = makeRoutes()({
      org: {
        $orgId: {
          index: {
            [REDIRECT]: (route) => ({
              to: "/org/:orgId/home",
              params: { orgId: route.params.orgId },
            }),
          },
          home: PageA,
        },
      },
    });

    try {
      matchRoute("/org/7", r);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(Redirect);
      expect((e as Redirect).options).toEqual({
        to: "/org/:orgId/home",
        params: { orgId: "7" },
      });
    }
  });

  test("[REDIRECT] as a function may return a bare path", () => {
    const r = makeRoutes()({
      org: {
        $orgId: {
          index: { [REDIRECT]: (route) => `/org/${route.params.orgId}/home` },
          home: PageA,
        },
      },
    });

    try {
      matchRoute("/org/7", r);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(Redirect);
      // already substituted, so it needs no params of its own
      expect((e as Redirect).options).toEqual({ to: "/org/7/home" });
    }
  });

  test("[REDIRECT] as a function sees context and path, but no data", () => {
    const seen: any[] = [];
    const r = makeRoutes()({
      [CONTEXT]: { tier: "root" },
      org: {
        [CONTEXT]: { tier: "org" },
        old: {
          [REDIRECT]: (route) => {
            seen.push({ path: route.path, context: route.context, data: route.data });
            return { to: "/about" };
          },
        },
      },
      about: PageA,
    });

    expect(() => matchRoute("/org/old", r)).toThrow(Redirect);
    expect(seen).toEqual([{ path: "org/old", context: { tier: "org" }, data: {} }]);
  });

  test("a throwing [REDIRECT] function becomes a RouterError, not a raw throw", () => {
    const cause = new Error("no org in scope");
    const r = makeRoutes()({
      org: {
        old: {
          [REDIRECT]: () => {
            throw cause;
          },
        },
      },
    });

    try {
      matchRoute("/org/old", r);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(RouterError);
      const error = e as RouterError;
      expect(error.type).toBe("REDIRECT");
      expect(error.cause).toBe(cause);
      expect(error.path).toBe("/org/old");
    }
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
// route groups (`_`-prefixed keys)
// ---------------------------------------------------------------------------

describe("route groups", () => {
  const SurveysWrapper = () => null;
  const SurveyScope = () => null;
  const ListError = () => null;
  const ListLoading = () => null;

  // the motivating shape: tab routes share chrome, the sibling $surveyId
  // must not inherit it
  const routes = makeRoutes()({
    org: {
      $orgId: {
        surveys: {
          _list: {
            [WRAPPER]: SurveysWrapper,
            [CONTEXT]: { section: "list" },
            index: { [REDIRECT]: (route) => `/org/${route.params.orgId}/surveys/published` },
            published: PageA,
            draft: PageB,
          },
          $surveyId: {
            [WRAPPER]: SurveyScope,
            index: PageC,
          },
        },
      },
    },
  });

  const wrappers = (route: Route) => route.outlets.map((o) => o.component).filter(Boolean);

  test("a group contributes no URL segment", () => {
    const route = matchRoute("/org/7/surveys/published", routes);
    expect(route.path).toBe("org/7/surveys/published");
    expect(route.pattern).toBe("/org/:orgId/surveys/published");
    expect(route.params).toEqual({ orgId: "7" });
  });

  test("the group's [WRAPPER] applies to its own children", () => {
    expect(wrappers(matchRoute("/org/7/surveys/published", routes))).toContain(SurveysWrapper);
    expect(wrappers(matchRoute("/org/7/surveys/draft", routes))).toContain(SurveysWrapper);
  });

  test("a sibling outside the group does not inherit it", () => {
    // the entire point of the feature — no render-time conditional needed
    const route = matchRoute("/org/7/surveys/42", routes);
    expect(wrappers(route)).toContain(SurveyScope);
    expect(wrappers(route)).not.toContain(SurveysWrapper);
    expect(route.params).toEqual({ orgId: "7", surveyId: "42" });
  });

  test("the group's [CONTEXT] is scoped to it", () => {
    expect(matchRoute("/org/7/surveys/published", routes).context).toEqual({ section: "list" });
    expect(matchRoute("/org/7/surveys/42", routes).context).toEqual({});
  });

  test("an index inside a group keeps the parent level navigable", () => {
    // without traversing groups for `index`, the surveys level reports itself
    // non-navigable and any breadcrumb deriving `to` from it renders unlinked
    const route = matchRoute("/org/7/surveys/published", routes);
    const surveysLevel = route.levels.map((l) => l.level).find((l) => l.segment === "surveys");
    expect(surveysLevel?.pattern).toBe("/org/:orgId/surveys");
  });

  test("a nesting level with no index anywhere stays non-navigable", () => {
    const r = makeRoutes()({
      section: { _tabs: { published: PageA } },
    });
    const sectionLevel = matchRoute("/section/published", r)
      .levels.map((l) => l.level)
      .find((l) => l.segment === "section");
    expect(sectionLevel?.pattern).toBeUndefined();
  });

  test("the group gets a level of its own, keyed by the group name", () => {
    const route = matchRoute("/org/7/surveys/published", routes);
    const level = route.outlets.find((o) => o.component === SurveysWrapper)?.level;
    expect(level?.segment).toBe("_list");
    // no segment of its own, so it addresses the parent's path
    expect(level?.pattern).toBe("/org/:orgId/surveys");
  });

  test("a group's [LOAD] runs for its children only", async () => {
    const loaded = makeRoutes()({
      section: {
        _tabs: { [LOAD]: async () => ({ tabs: 1 }), a: PageA },
        b: PageB,
      },
    });

    const inside = matchRoute("/section/a", loaded);
    await inside.load();
    expect(inside.data).toEqual({ tabs: 1 });

    const outside = matchRoute("/section/b", loaded);
    await outside.load();
    expect(outside.data).toEqual({});
  });

  test("a group's [GUARD] runs for its children only", async () => {
    const calls: string[] = [];
    const guarded = makeRoutes()({
      section: {
        _tabs: {
          [GUARD]: async () => {
            calls.push("tabs");
          },
          a: PageA,
        },
        b: PageB,
      },
    });

    await matchRoute("/section/a", guarded).guard();
    expect(calls).toEqual(["tabs"]);

    await matchRoute("/section/b", guarded).guard();
    expect(calls).toEqual(["tabs"]);
  });

  test("a group's [ERROR] and [LOADING] reach its children", () => {
    const scoped = makeRoutes()({
      section: {
        _tabs: {
          [ERROR]: ListError,
          [LOADING]: ListLoading,
          a: { [LOAD]: async () => ({}), [PAGE]: PageA },
        },
        b: { [LOAD]: async () => ({}), [PAGE]: PageB },
      },
    });

    const inside = matchRoute("/section/a", scoped).outlets.at(-1);
    expect(inside?.config.errorComponent).toBe(ListError);
    expect(inside?.config.loadingComponent).toBe(ListLoading);

    const outside = matchRoute("/section/b", scoped).outlets.at(-1);
    expect(outside?.config.errorComponent).toBeUndefined();
  });

  test("groups may nest", () => {
    const nested = makeRoutes()({
      section: {
        _outer: {
          [WRAPPER]: SurveysWrapper,
          _inner: { [WRAPPER]: SurveyScope, deep: PageA },
        },
      },
    });

    const route = matchRoute("/section/deep", nested);
    expect(route.pattern).toBe("/section/deep");
    expect(wrappers(route)).toEqual([SurveysWrapper, SurveyScope, PageA]);
  });

  test("a `_` key never matches a literal URL segment", () => {
    expect(() => matchRoute("/org/7/surveys/_list", routes)).toThrow(RouterError);
    expect(() =>
      matchRoute("/section/_tabs", makeRoutes()({ section: { _tabs: { a: PageA } } })),
    ).toThrow(RouterError);
  });

  test("an inherited property name is not a route", () => {
    // `hasOwn` rather than a property read
    expect(() => matchRoute("/constructor", makeRoutes()({ about: PageA }))).toThrow(RouterError);
  });

  describe("precedence", () => {
    test("a static key on the parent wins over the same key in a group", () => {
      const r = makeRoutes()({
        section: {
          own: PageA,
          _group: { other: PageB },
        },
      });
      expect(wrappers(matchRoute("/section/own", r))).toContain(PageA);
    });

    test("a static key in a group wins over the parent's dynamic key", () => {
      const r = makeRoutes()({
        section: {
          _group: { published: PageA },
          $id: PageB,
        },
      });
      const route = matchRoute("/section/published", r);
      expect(wrappers(route)).toContain(PageA);
      expect(route.params).toEqual({});
    });

    test("groups are searched in declaration order", () => {
      const r = makeRoutes()({
        section: {
          _first: { [WRAPPER]: SurveysWrapper, $id: PageA },
          _second: { [WRAPPER]: SurveyScope, other: PageB },
        },
      });
      // both groups hold a dynamic candidate path; the first declared wins
      expect(wrappers(matchRoute("/section/anything", r))).toContain(SurveysWrapper);
    });

    test("a dynamic key on the parent wins over one in a group", () => {
      const r = makeRoutes()({
        section: {
          $own: PageA,
          _group: { $other: PageB },
        },
      });
      const route = matchRoute("/section/42", r);
      expect(wrappers(route)).toContain(PageA);
      expect(route.params).toEqual({ own: "42" });
    });
  });

  describe("validation", () => {
    test("rejects a group holding a leaf", () => {
      expect(() => makeRoutes()({ section: { _tabs: PageA } })).toThrow(
        "Route group 'section._tabs' holds a leaf",
      );
    });

    test("rejects a key reachable both on the parent and inside its group", () => {
      expect(() =>
        makeRoutes()({
          section: {
            published: PageA,
            _tabs: { published: PageB },
          },
        }),
      ).toThrow("both address '/section/published'");
    });

    test("rejects the same key in two sibling groups", () => {
      expect(() =>
        makeRoutes()({
          section: {
            _a: { published: PageA },
            _b: { published: PageB },
          },
        }),
      ).toThrow("both address '/section/published'");
    });

    test("rejects an index colliding with a group's index", () => {
      expect(() =>
        makeRoutes()({
          section: {
            index: PageA,
            _tabs: { index: PageB },
          },
        }),
      ).toThrow("both address '/section'");
    });

    test("validates redirect targets through group transparency", () => {
      // the target lives inside a group, so it must still be addressable
      expect(() =>
        makeRoutes()({
          section: {
            _tabs: { published: PageA },
          },
          old: { [REDIRECT]: "/section/published" },
        }),
      ).not.toThrow();

      expect(() =>
        makeRoutes()({
          section: { _tabs: { published: PageA } },
          old: { [REDIRECT]: "/section/_tabs/published" },
        }),
      ).toThrow("which no route in this tree addresses");
    });
  });

  test("group keys contribute no segment to the typed path union", () => {
    const r = makeRoutes()({
      section: {
        _tabs: { index: PageA, published: PageB },
        $id: PageC,
      },
    });

    const published = "/section/published" satisfies ExtractPaths<typeof r>;
    const index = "/section" satisfies ExtractPaths<typeof r>;
    const dynamic = "/section/:id" satisfies ExtractPaths<typeof r>;
    // @ts-expect-error — the group key appears in no path
    const grouped = "/section/_tabs/published" satisfies ExtractPaths<typeof r>;

    expect([published, index, dynamic, grouped]).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// makeRoutes — boot-time validation
// ---------------------------------------------------------------------------

describe("makeRoutes redirect validation", () => {
  test("rejects a target no route addresses", () => {
    expect(() =>
      makeRoutes()({
        auth: { login: PageA },
        old: { [REDIRECT]: "/auth/lgoin" },
      }),
    ).toThrow("targets '/auth/lgoin', which no route in this tree addresses");
  });

  test("names the route key trail so the culprit is findable", () => {
    expect(() =>
      makeRoutes()({
        admin: { legacy: { billing: { [REDIRECT]: "/nowhere" } } },
      }),
    ).toThrow("[REDIRECT] at 'admin.legacy.billing'");
  });

  test("rejects a static target with an unfilled :param", () => {
    expect(() =>
      makeRoutes()({
        users: { $id: PageA },
        old: { [REDIRECT]: { to: "/users/:id" } },
      }),
    ).toThrow("but ':id' has no value");
  });

  test("accepts a dynamic target once params are supplied", () => {
    expect(() =>
      makeRoutes()({
        users: { $id: PageA },
        old: { [REDIRECT]: { to: "/users/:id", params: { id: "42" } } },
      }),
    ).not.toThrow();
  });

  test("accepts a concrete value in place of a dynamic segment", () => {
    expect(() =>
      makeRoutes()({
        users: { $id: PageA },
        old: { [REDIRECT]: "/users/42" },
      }),
    ).not.toThrow();
  });

  test("accepts index and root targets", () => {
    expect(() =>
      makeRoutes()({
        index: PageA,
        users: { index: PageB },
        toRoot: { [REDIRECT]: "/" },
        toUsers: { [REDIRECT]: "/users" },
      }),
    ).not.toThrow();
  });

  test("rejects a target addressing a nesting level with no index", () => {
    // matchRoute would 404 on it — the level has no page of its own
    expect(() =>
      makeRoutes()({
        users: { $id: PageA },
        old: { [REDIRECT]: "/users" },
      }),
    ).toThrow("which no route in this tree addresses");
  });

  test("rejects a redirect to itself", () => {
    expect(() =>
      makeRoutes()({
        loop: { [REDIRECT]: "/loop" },
      }),
    ).toThrow("never lands — it loops: /loop → /loop");
  });

  test("rejects a two-hop loop", () => {
    expect(() =>
      makeRoutes()({
        a: { [REDIRECT]: "/b" },
        b: { [REDIRECT]: "/a" },
      }),
    ).toThrow("it loops: /a → /b → /a");
  });

  test("rejects a loop entered partway down a longer chain", () => {
    expect(
      () =>
        makeRoutes()({
          start: { [REDIRECT]: "/a" },
          a: { [REDIRECT]: "/b" },
          b: { [REDIRECT]: "/c" },
          c: { [REDIRECT]: "/a" },
        }),
      // reported as the cycle itself, not the /start approach to it
    ).toThrow("it loops: /a → /b → /c → /a");
  });

  test("rejects a loop through a dynamic segment", () => {
    // /users/9 → /users/5, which matches $id again and redirects to /users/5…
    expect(() =>
      makeRoutes()({
        users: { $id: { [REDIRECT]: "/users/5" } },
      }),
    ).toThrow("it loops: /users/:id → /users/:id");
  });

  test("accepts a chain that lands on a page", () => {
    expect(() =>
      makeRoutes()({
        a: { [REDIRECT]: "/b" },
        b: { [REDIRECT]: "/c" },
        c: PageA,
      }),
    ).not.toThrow();
  });

  test("accepts two redirects onto the same page", () => {
    // converging is not looping
    expect(() =>
      makeRoutes()({
        a: { [REDIRECT]: "/c" },
        b: { [REDIRECT]: "/c" },
        c: PageA,
      }),
    ).not.toThrow();
  });

  test("stops the loop walk at a function target rather than guessing", () => {
    expect(() =>
      makeRoutes()({
        a: { [REDIRECT]: "/b" },
        b: { [REDIRECT]: () => "/a" },
      }),
    ).not.toThrow();
  });

  test("skips function targets, whose result depends on the matched route", () => {
    expect(() =>
      makeRoutes()({
        users: { $id: PageA },
        // unresolvable if taken literally, but the function is free to
        // return something else entirely — nothing to check at boot
        old: { [REDIRECT]: () => ({ to: "/users/:id" }) },
      }),
    ).not.toThrow();
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

  test("[REDIRECT] targets are typed structurally, not against RoutePath", () => {
    // `[REDIRECT]` is reachable from `Routes`, so naming `RoutePath` in its
    // type makes the route tree self-referential — see the note on
    // `RedirectTarget` and the augmented-program tests in
    // router.types.test.ts. `params` is therefore optional and an
    // unresolvable `to` is caught at runtime, as a REDIRECT RouterError.
    const staticPath = { to: "/about" } satisfies RedirectTarget;
    const dynamicPath = { to: "/users/:id", params: { id: "7" } } satisfies RedirectTarget;
    const unresolvable = { to: "/users/:id" } satisfies RedirectTarget;

    expect([staticPath, dynamicPath, unresolvable]).toHaveLength(3);
  });

  test("a [REDIRECT] function's parameter is contextually typed as Route", () => {
    const r = makeRoutes()({
      org: {
        old: {
          // `Leaf` also admits a bare Component, whose props are `any` — if
          // the arrow were typed against that instead of `Redirector`, this
          // would silently pass and the form would lose all inference
          // @ts-expect-error — `nope` is not on Route
          [REDIRECT]: (route) => ({ to: `/org/${route.nope}` }),
        },
      },
    });
    expect(r).toBeDefined();
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
      await router.initialize(guardRoutes);
      expect(router.activeRoute?.path).toBe("about");
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

    test("matches an index route exactly", async () => {
      const { router } = await makeRouter("/users");
      // the index path is "/users", so exact matching lines up with it —
      // with a trailing slash it never could, the empty segment made the
      // pattern one segment longer than the route
      expect(router.doesPathMatch("/users")).toBe(true);
      expect(router.doesPathMatch("/users", true)).toBe(true);
    });

    test("matches the root index exactly", async () => {
      const { router } = await makeRouter("/");
      expect(router.doesPathMatch("/", true)).toBe(true);
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
      void router.navigate({ to: "/about" });
      expect(history.location.pathname).toBe("/about");
    });

    test("replace option replaces history entry", async () => {
      const { router, history } = await makeRouter("/");
      void router.navigate({ to: "/about", replace: true });
      expect(history.index).toBe(0);
    });

    test("search params appear in location", async () => {
      const { router, history } = await makeRouter("/");
      void router.navigate({ to: "/about", search: { q: "hello" } });
      expect(history.location.search).toContain("q=hello");
    });

    test("resolves :params into the pathname", async () => {
      const { router, history } = await makeRouter("/");
      void router.navigate({ to: "/users/:id", params: { id: "42" } });
      expect(history.location.pathname).toBe("/users/42");
    });

    test("requires params for dynamic paths at both type and runtime level", async () => {
      const { router } = await makeRouter("/");
      // @ts-expect-error — "/users/:id" requires params
      expect(() => router.navigate({ to: "/users/:id" })).toThrow("Parameter ':id' not specified");
      // @ts-expect-error — params must not be passed for static paths
      void router.navigate({ to: "/about", params: { id: "42" } });
      // @ts-expect-error — redirect enforces params the same way
      expect(redirect({ to: "/users/:id" })).toBeInstanceOf(Redirect);
    });

    test("navigating to the current URL is a no-op", async () => {
      const { router, history } = await makeRouter("/about");
      const before = router.activeRoute;
      void router.navigate({ to: "/about" });
      expect(history.index).toBe(0);
      expect(router.activeRoute).toBe(before);
    });

    test("the no-op comparison includes search params", async () => {
      const { router, history } = await makeRouter("/about?q=1");
      void router.navigate({ to: "/about", search: { q: "1" } });
      expect(history.index).toBe(0);

      void router.navigate({ to: "/about", search: { q: "2" } });
      expect(history.index).toBe(1);
      expect(history.location.search).toBe("?q=2");
    });

    test("navigating to the current URL with state still navigates", async () => {
      const { router, history } = await makeRouter("/about");
      void router.navigate({ to: "/about", state: { fromMenu: true } });
      expect(history.index).toBe(1);
    });

    test("an index path resolves to the URL it matches, and re-navigating is a no-op", async () => {
      const { router, history } = await makeRouter("/users");
      expect(history.location.pathname).toBe("/users");

      // with a trailing-slash index path this pushed "/users/" and relied on
      // setLocation replacing it back, so the no-op check never fired
      const before = router.activeRoute;
      void router.navigate({ to: "/users" });
      expect(history.index).toBe(0);
      expect(router.activeRoute).toBe(before);
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
      await router.initialize(loaderRoutes);
      expect(loads).toBe(1);
      const route = router.activeRoute;

      router.setQueryParam("page", "2");
      expect(router.location.search).toBe("?page=2");

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

  describe("failed redirects", () => {
    test("a [REDIRECT] function returning an unresolvable path renders [ERROR] instead of escaping", async () => {
      // the static spelling of this is rejected at boot (see the
      // makeRoutes validation tests), so the function form is the only way
      // an unresolvable target still reaches the router
      const routes = makeRoutes()({
        [LAYOUT]: AppShell,
        [ERROR]: RootErrorPage,
        old: { [REDIRECT]: () => ({ to: "/users/:id" }) },
        users: { $id: PageA },
      });
      const { router, history } = await makeRouter(routes, "/old");

      const route = router.activeRoute;
      expect(route?.error?.type).toBe("REDIRECT");
      expect(route?.error?.cause).toBeInstanceOf(Error);
      expect((route?.error?.cause as Error | undefined)?.message).toContain(
        "Parameter ':id' not specified",
      );
      expect(route?.layout).toBe(AppShell);
      expect(renderOutlet(route?.outlets.at(-1), route).type).toBe(RootErrorPage);
      // the URL stays put, like every other navigation failure
      expect(history.location.pathname).toBe("/old");
    });

    test("a throwing [REDIRECT] function keeps the matched prefix's layout and nearest [ERROR]", async () => {
      const cause = new Error("no org in scope");
      const routes = makeRoutes()({
        [LAYOUT]: AppShell,
        [ERROR]: RootErrorPage,
        admin: {
          [LAYOUT]: AdminLayout,
          [WRAPPER]: AdminWrapper,
          [ERROR]: AdminErrorPage,
          old: {
            [REDIRECT]: () => {
              throw cause;
            },
          },
        },
      });
      const { router } = await makeRouter(routes, "/admin/old");

      const route = router.activeRoute;
      expect(route?.error?.type).toBe("REDIRECT");
      expect(route?.error?.cause).toBe(cause);
      expect(route?.layout).toBe(AdminLayout);
      expect(route?.outlets[0]?.Component).toBe(AdminWrapper);
      expect(renderOutlet(route?.outlets.at(-1), route).type).toBe(AdminErrorPage);
    });

    test("a guard's unresolvable redirect bubbles to that guard's level, not the deepest one", async () => {
      const routes = makeRoutes()({
        [LAYOUT]: AppShell,
        [ERROR]: RootErrorPage,
        [GUARD]: async () => {
          // @ts-expect-error — redirect enforces params; this is the runtime failure
          throw redirect({ to: "/users/:id" });
        },
        admin: { [LAYOUT]: AdminLayout, [ERROR]: AdminErrorPage, users: PageA },
        users: { $id: PageA },
      });
      const { router, history } = await makeRouter(routes, "/admin/users");

      const route = router.activeRoute;
      expect(route?.error?.type).toBe("REDIRECT");
      expect(route?.layout).toBe(AppShell);
      expect(renderOutlet(route?.outlets.at(-1), route).type).toBe(RootErrorPage);
      expect(history.location.pathname).toBe("/admin/users");
    });

    test("a successful [REDIRECT] still navigates", async () => {
      const routes = makeRoutes()({
        [ERROR]: RootErrorPage,
        org: {
          $orgId: {
            index: {
              [REDIRECT]: (route) => ({
                to: "/org/:orgId/home",
                params: { orgId: route.params.orgId },
              }),
            },
            home: PageA,
          },
        },
      });
      const history = createMemoryHistory({ initialEntries: ["/org/7"] });
      const router = new RouterStore({ history });
      await router.initialize(routes);

      expect(router.activeRoute?.path).toBe("org/7/home");
      expect(history.location.pathname).toBe("/org/7/home");
      expect(router.activeRoute?.error).toBeUndefined();
    });

    test("a [REDIRECT] replaces its own entry, so Back leaves the redirect behind", async () => {
      const routes = makeRoutes()({
        about: PageB,
        org: {
          $orgId: {
            index: {
              [REDIRECT]: (route) => ({
                to: "/org/:orgId/home",
                params: { orgId: route.params.orgId },
              }),
            },
            home: PageA,
          },
        },
      });
      const history = createMemoryHistory({ initialEntries: ["/about"] });
      const router = new RouterStore({ history });
      await router.initialize(routes);
      expect(router.activeRoute?.path).toBe("about");

      await router.navigate({ to: "/org/:orgId" as any, params: { orgId: "7" } } as any);
      expect(router.activeRoute?.path).toBe("org/7/home");

      // /org/7 renders nothing of its own — it must not hold an entry, or
      // Back would land on it and be thrown forward to /org/7/home again
      expect(history.index).toBe(1);
      history.back();
      await vi.waitFor(() => expect(router.activeRoute?.path).toBe("about"));
    });

    test("a redirect thrown from a guard replaces its entry too", async () => {
      const routes = makeRoutes()({
        about: PageB,
        admin: {
          [GUARD]: () => {
            throw redirect({ to: "/login" as any });
          },
          index: PageA,
        },
        login: PageC,
      });
      const history = createMemoryHistory({ initialEntries: ["/about"] });
      const router = new RouterStore({ history });
      await router.initialize(routes);
      expect(router.activeRoute?.path).toBe("about");

      await router.navigate({ to: "/admin" as any });
      expect(router.activeRoute?.path).toBe("login");

      expect(history.index).toBe(1);
      history.back();
      await vi.waitFor(() => expect(router.activeRoute?.path).toBe("about"));
    });

    test("a redirect thrown from a loader never marks the outlet errored", async () => {
      // the outlet used to flip to `error` on its way out, so the generic
      // load-failure text flashed with no error recorded to explain it
      const seen: (string | undefined)[] = [];
      const routes = makeRoutes()({
        [ERROR]: RootErrorPage,
        surveys: PageB,
        survey: {
          [LOAD]: async () => {
            throw redirect({ to: "/surveys" as any });
          },
          index: PageA,
        },
      });
      const history = createMemoryHistory({ initialEntries: ["/"] });
      const router = new RouterStore({ history });
      // awaited, so the autorun below records only the /survey navigation
      await router.initialize(routes);

      // the outlet that loads belongs to pendingRoute — activeRoute still
      // holds the previous page until the swap
      const stop = autorun(() => {
        for (const route of [router.pendingRoute, router.activeRoute]) {
          for (const outlet of route?.outlets ?? []) seen.push(outlet.state);
        }
      });
      await router.navigate({ to: "/survey" as any });
      stop();

      expect(seen).not.toContain("error");
      expect(router.activeRoute?.error).toBeUndefined();
      // and it replaced the entry it was navigated to, like any other
      // redirect — /survey is gone, so Back reaches / rather than bouncing
      expect(history.index).toBe(1);
      history.back();
      await vi.waitFor(() => expect(history.location.pathname).toBe("/"));
    });

    test("an explicit `replace: false` still pushes", async () => {
      const routes = makeRoutes()({
        about: PageB,
        old: { [REDIRECT]: { to: "/about", replace: false } },
      });
      const history = createMemoryHistory({ initialEntries: ["/"] });
      const router = new RouterStore({ history });
      await router.initialize(routes);

      await router.navigate({ to: "/old" as any });
      expect(router.activeRoute?.path).toBe("about");

      // one entry for /old, one for /about
      expect(history.index).toBe(2);
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
    await router.initialize(routes);
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

    void router.navigate({ to: "/slow" } as any);
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

    void router.navigate({ to: "/slow" } as any);
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
    void router.initialize(routes);

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

    void router.navigate({ to: "/slow" } as any);
    await vi.advanceTimersByTimeAsync(0);
    expect(router.pendingRoute?.path).toBe("slow");

    void router.navigate({ to: "/other" } as any);
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

    void router.navigate({ to: "/slow" } as any);
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

    void router.navigate({ to: "/secret" } as any);
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
    await router.initialize(routes);
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

    void router.navigate({ to: "/slow" } as any);
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

    void router.navigate({ to: "/other" } as any);
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
    await router.initialize(makeRoutes()({ index: PageA }));

    expect(router.activeRoute?.path).toBe("");
    expect(startViewTransition).not.toHaveBeenCalled();
  });

  test("swaps directly when the browser has no support", async () => {
    // the outer beforeEach stubs startViewTransition as undefined
    const { router } = await warmRouter(makeRoutes()({ index: PageA, other: PageC }));

    void router.navigate({ to: "/other" } as any);
    await vi.advanceTimersByTimeAsync(0);

    expect(router.activeRoute?.path).toBe("other");
  });

  test("a skipped transition does not break the navigation", async () => {
    const startViewTransition = stubViewTransitions({ readyRejects: true });
    const { router } = await warmRouter(makeRoutes()({ index: PageA, other: PageC }));

    void router.navigate({ to: "/other" } as any);
    await vi.advanceTimersByTimeAsync(0);

    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(router.activeRoute?.path).toBe("other");
  });

  test("viewTransitions: false opts out entirely", async () => {
    const startViewTransition = stubViewTransitions();
    const { router } = await warmRouter(makeRoutes()({ index: PageA, other: PageC }), {
      viewTransitions: false,
    });

    void router.navigate({ to: "/other" } as any);
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
    void router.initialize(routes as any);

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
    await router.initialize(routes as any);

    // inside the debounce: in flight, but nothing shown yet
    void router.navigate({ to: "/slow" } as any);
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
    await router.initialize(routes);
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

    void router.navigate({ to: "/secret" } as any);
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

    void router.navigate({ to: "/secret" } as any);
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

    void router.navigate({ to: "/slow" } as any);

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

    void router.navigate({ to: "/first" } as any);
    await vi.advanceTimersByTimeAsync(350);
    expect(router.isSlowNavigation).toBe(true);

    // redirecting attention to another slow route mid-flight: the bar stays
    // up rather than dropping out and fading back in
    void router.navigate({ to: "/second" } as any);
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
    await router.initialize(
      makeRoutes()({
        index: PageA,
        secret: { [GUARD]: async () => void (await gate.promise), [PAGE]: PageB },
      }) as any,
    );
    expect(router.isNavigating).toBe(false);

    void router.navigate({ to: "/secret" } as any);
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
    await router.initialize(
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

    await router.navigate({ to: "/secret" } as any);

    expect(router.activeRoute?.error?.type).toBe("GUARD");
    expect(router.isNavigating).toBe(false);
    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// Route levels
// ---------------------------------------------------------------------------

describe("route levels", () => {
  const RootScope = ({ children }: any) => children;
  const OrgsScope = ({ children }: any) => children;
  const OrgScope = ({ children }: any) => children;
  const SurveysScope = ({ children }: any) => children;

  const routes = makeRoutes()({
    [WRAPPER]: RootScope,
    index: PageA,
    org: {
      // no index — /org addresses no page of its own
      [WRAPPER]: OrgsScope,
      $orgId: {
        [WRAPPER]: OrgScope,
        index: PageB,
        surveys: {
          [WRAPPER]: SurveysScope,
          index: PageC,
          $surveyId: {
            index: PageA,
            responses: PageB,
          },
        },
      },
    },
  });

  const levelsOf = (path: string): (RouteLevel | undefined)[] =>
    matchRoute(path, routes).outlets.map((o) => o.level);

  test("each wrapper and page gets the level it renders at", () => {
    expect(levelsOf("/org/7/surveys")).toEqual([
      { index: 0, segment: "", pattern: "/" },
      // a nesting level with no index child is not navigable
      { index: 1, segment: "org", pattern: undefined },
      { index: 2, segment: ":orgId", pattern: "/org/:orgId" },
      { index: 3, segment: "surveys", pattern: "/org/:orgId/surveys" },
      // the index page addresses its parent's path
      { index: 4, segment: "index", pattern: "/org/:orgId/surveys" },
    ]);
  });

  test("a leaf page's level names the leaf, not its parent", () => {
    expect(levelsOf("/org/7/surveys/3/responses").at(-1)).toEqual({
      index: 5,
      segment: "responses",
      pattern: "/org/:orgId/surveys/:surveyId/responses",
    });
  });

  test("every pattern resolves back to the URL that produced it", () => {
    const route = matchRoute("/org/7/surveys/3/responses", routes);
    const resolved = route.outlets
      .map((o) => o.level?.pattern)
      .filter((p) => p !== undefined)
      .map((p) => resolvePath(p, route.params));

    // each level addresses a prefix of the URL — so a wrapper can hand its
    // own pattern straight to `to=` without knowing where it sits. Only
    // levels that render something appear here: $surveyId declares no
    // [WRAPPER], so nothing carries its level.
    expect(resolved).toEqual(["/", "/org/7", "/org/7/surveys", "/org/7/surveys/3/responses"]);
  });

  test("a quoted :param key normalizes to the same pattern as $param", () => {
    const r = makeRoutes()({
      posts: {
        ":slug": { [WRAPPER]: RootScope, index: PageA },
      },
    });
    expect(matchRoute("/posts/hello", r).outlets[0]?.level).toEqual({
      index: 2,
      segment: ":slug",
      pattern: "/posts/:slug",
    });
  });

  test("a dynamic segment does not match the parent's own path", () => {
    // "/org" has no index, and matching $orgId here would capture an empty
    // param — the same level whose `pattern` is undefined for that reason
    expect(() => matchRoute("/org", routes)).toThrow(RouterError);
  });

  test("[LOAD] and [WRAPPER] at one level share that level", () => {
    const r = makeRoutes()({
      admin: {
        [WRAPPER]: RootScope,
        [LOAD]: async () => ({}),
        index: PageA,
      },
    });
    const [wrapper, loader] = matchRoute("/admin", r).outlets;
    expect(wrapper?.level).toEqual({ index: 1, segment: "admin", pattern: "/admin" });
    expect(loader?.level).toBe(wrapper?.level);
  });

  test("a synthetic error route keeps the levels of the prefix that matched", () => {
    try {
      matchRoute("/org/7/nope", routes);
      expect.unreachable();
    } catch (e) {
      const route = makeErrorRoute(e as RouterError, "/org/7/nope");
      // the wrappers up to the failure, then the error outlet at that level
      expect(route.outlets.map((o) => o.level?.pattern)).toEqual([
        "/",
        undefined,
        "/org/:orgId",
        "/org/:orgId",
      ]);
    }
  });
});

// ---------------------------------------------------------------------------
// resolvePath / tryResolvePath
// ---------------------------------------------------------------------------

describe("Route.pattern", () => {
  const routes = makeRoutes()({
    index: PageA,
    about: PageB,
    org: {
      $orgId: {
        index: PageA,
        surveys: { published: PageB },
      },
    },
  });

  test("is the path with its dynamic segments left unsubstituted", () => {
    const route = matchRoute("/org/7/surveys/published", routes);
    expect(route.path).toBe("org/7/surveys/published");
    expect(route.pattern).toBe("/org/:orgId/surveys/published");
  });

  test("is the parent's pattern for an index route", () => {
    expect(matchRoute("/org/7", routes).pattern).toBe("/org/:orgId");
  });

  test("is '/' at the root", () => {
    expect(matchRoute("/", routes).pattern).toBe("/");
  });

  test("has no params to substitute on a static route", () => {
    expect(matchRoute("/about", routes).pattern).toBe("/about");
  });

  test("agrees with the level pattern the page renders at", () => {
    const route = matchRoute("/org/7/surveys/published", routes);
    const pageLevel = route.outlets.at(-1)?.level;
    expect(route.pattern).toBe(pageLevel?.pattern);
  });

  test("resolves back to the concrete path with the route's own params", () => {
    const route = matchRoute("/org/7/surveys/published", routes);
    expect(resolvePath(route.pattern ?? "", route.params)).toBe(`/${route.path}`);
  });

  test("is absent on a synthetic error route", () => {
    try {
      matchRoute("/org/7/nope", routes);
      expect.unreachable();
    } catch (e) {
      expect(makeErrorRoute(e as RouterError, "/org/7/nope").pattern).toBeUndefined();
    }
  });
});

describe("router.target", () => {
  const deferred = () => {
    let resolve!: (value?: unknown) => void;
    const promise = new Promise((res) => {
      resolve = res as any;
    });
    return { promise, resolve };
  };

  const routes = makeRoutes()({
    index: PageA,
    about: PageB,
    org: {
      $orgId: {
        index: { [REDIRECT]: (route) => `/org/${route.params.orgId}/surveys/published` },
        surveys: { published: PageA, drafts: PageB },
      },
    },
  });

  const makeRouter = (initialPath: string) => {
    const history = createMemoryHistory({ initialEntries: [initialPath] });
    const router = new RouterStore({ history });
    router.routesDef = routes;
    return { router, history };
  };

  test("is undefined before the first match", () => {
    const { router } = makeRouter("/about");
    expect(router.target).toBeUndefined();
  });

  test("equals the active route once a navigation lands", async () => {
    const { router, history } = makeRouter("/about");
    await router.setLocation(history.location);

    expect(router.target?.pathname).toBe("/about");
    expect(router.target?.pattern).toBe("/about");
    expect(router.target?.pattern).toBe(router.activeRoute?.pattern);
  });

  test("names the destination while a guard is still pending", async () => {
    const gate = deferred();
    const guarded = makeRoutes()({
      about: PageB,
      org: {
        $orgId: {
          [GUARD]: async () => {
            await gate.promise;
          },
          surveys: { published: PageA },
        },
      },
    });
    const history = createMemoryHistory({ initialEntries: ["/about"] });
    const router = new RouterStore({ history });
    router.routesDef = guarded;
    await router.setLocation(history.location);

    // second navigation, deliberately not awaited: its guard is blocked
    history.push("/org/7/surveys/published");
    const navigation = router.setLocation(history.location);

    // activeRoute still shows the old page — but target already knows
    expect(router.activeRoute?.pattern).toBe("/about");
    expect(router.pendingRoute).toBeUndefined();
    expect(router.target?.pattern).toBe("/org/:orgId/surveys/published");
    expect(router.target?.params).toEqual({ orgId: "7" });

    gate.resolve();
    await navigation;
    expect(router.activeRoute?.pattern).toBe("/org/:orgId/surveys/published");
  });

  test("never mixes clocks: params and pathname come from the same match", async () => {
    // the original bug — pathname held the new org while params held the old
    const gate = deferred();
    const guarded = makeRoutes()({
      org: {
        $orgId: {
          [GUARD]: async () => {
            await gate.promise;
          },
          surveys: PageA,
        },
      },
    });
    const history = createMemoryHistory({ initialEntries: ["/org/old/surveys"] });
    const router = new RouterStore({ history });
    router.routesDef = guarded;
    gate.resolve();
    await router.setLocation(history.location);

    const blocked = deferred();
    const nextGuarded = makeRoutes()({
      org: {
        $orgId: {
          [GUARD]: async () => {
            await blocked.promise;
          },
          surveys: PageA,
        },
      },
    });
    router.routesDef = nextGuarded;
    history.push("/org/new/surveys");
    const navigation = router.setLocation(history.location);

    // pathParams still reads the old org, straight off activeRoute
    expect(router.pathParams).toEqual({ orgId: "old" });
    // target is internally consistent — both halves are the new org
    expect(router.target?.pathname).toBe("/org/new/surveys");
    expect(router.target?.params).toEqual({ orgId: "new" });

    blocked.resolve();
    await navigation;
  });

  test("holds its value across a [REDIRECT] hop instead of blanking", async () => {
    const { router, history } = makeRouter("/org/7/surveys/drafts");
    await router.initialize(routes);
    expect(router.activeRoute?.path).toBe("org/7/surveys/drafts");

    const seen: (string | undefined)[] = [];
    const stop = autorun(() => seen.push(router.target?.pattern));

    // /org/9 is a [REDIRECT] leaf: it throws rather than matching, so the
    // hop through it must not clear target
    history.push("/org/9");
    await vi.waitFor(() => expect(router.activeRoute?.params).toEqual({ orgId: "9" }));
    stop();

    expect(router.target?.pattern).toBe("/org/:orgId/surveys/published");
    // never blanked on the way through
    expect(seen).not.toContain(undefined);
  });

  test("keeps the last matched route when a URL doesn't match at all", async () => {
    const { router, history } = makeRouter("/about");
    await router.setLocation(history.location);

    vi.spyOn(console, "error").mockImplementation(() => {});
    history.push("/nope");
    await router.setLocation(history.location);

    expect(router.activeRoute?.error?.type).toBe("NOT_FOUND");
    expect(router.target?.pattern).toBe("/about");
    vi.restoreAllMocks();
  });

  test("names the blocked destination when a guard rejects", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const guarded = makeRoutes()({
      about: PageB,
      admin: {
        [GUARD]: async () => {
          throw new Error("denied");
        },
        users: PageA,
      },
    });
    const history = createMemoryHistory({ initialEntries: ["/admin/users"] });
    const router = new RouterStore({ history });
    router.routesDef = guarded;
    await router.setLocation(history.location);

    expect(router.activeRoute?.error?.type).toBe("GUARD");
    // the guard ran after the match, so target names where we were headed
    expect(router.target?.pattern).toBe("/admin/users");
    vi.restoreAllMocks();
  });

  test("exposes the matched levels a wrapper can test itself against", async () => {
    const { router, history } = makeRouter("/org/7/surveys/published");
    await router.setLocation(history.location);

    expect(router.target?.levels.map((l) => l.segment)).toEqual(["", "org", ":orgId", "surveys"]);
  });

  test("a superseded navigation does not clobber a newer target", async () => {
    const slow = deferred();
    const guarded = makeRoutes()({
      index: PageA,
      slowRoute: {
        [GUARD]: async () => {
          await slow.promise;
        },
        [PAGE]: PageA,
      },
      fast: PageB,
    });
    const history = createMemoryHistory({ initialEntries: ["/"] });
    const router = new RouterStore({ history });
    router.routesDef = guarded;
    await router.setLocation(history.location);

    history.push("/slowRoute");
    const first = router.setLocation(history.location);
    expect(router.target?.pattern).toBe("/slowRoute");

    history.push("/fast");
    await router.setLocation(history.location);
    expect(router.target?.pattern).toBe("/fast");

    // the abandoned navigation resolves last and must not reinstate itself
    slow.resolve();
    await first;
    expect(router.target?.pattern).toBe("/fast");
    expect(router.activeRoute?.pattern).toBe("/fast");
  });
});

describe("doesTargetMatch", () => {
  const deferred = () => {
    let resolve!: (value?: unknown) => void;
    const promise = new Promise((res) => {
      resolve = res as any;
    });
    return { promise, resolve };
  };

  const routes = makeRoutes()({
    index: PageA,
    about: PageB,
    org: { $orgId: { index: PageA, surveys: PageB } },
  });

  test("answers for the destination while doesPathMatch still lags", async () => {
    const gate = deferred();
    const guarded = makeRoutes()({
      about: PageB,
      org: {
        $orgId: {
          [GUARD]: async () => {
            await gate.promise;
          },
          surveys: PageA,
        },
      },
    });
    const history = createMemoryHistory({ initialEntries: ["/about"] });
    const router = new RouterStore({ history });
    router.routesDef = guarded;
    await router.setLocation(history.location);

    history.push("/org/7/surveys");
    const navigation = router.setLocation(history.location);

    expect(router.doesPathMatch("/org/:orgId")).toBe(false);
    expect(router.doesTargetMatch("/org/:orgId")).toBe(true);

    gate.resolve();
    await navigation;
    expect(router.doesPathMatch("/org/:orgId")).toBe(true);
  });

  test("matches prefixes non-exactly and honours exact", async () => {
    const history = createMemoryHistory({ initialEntries: ["/org/7/surveys"] });
    const router = new RouterStore({ history });
    router.routesDef = routes;
    await router.setLocation(history.location);

    expect(router.doesTargetMatch("/org/:orgId")).toBe(true);
    expect(router.doesTargetMatch("/org/:orgId", true)).toBe(false);
    expect(router.doesTargetMatch("/org/:orgId/surveys", true)).toBe(true);
    expect(router.doesTargetMatch("/about")).toBe(false);
  });

  test("agrees with doesPathMatch once a navigation has landed", async () => {
    const history = createMemoryHistory({ initialEntries: ["/org/7/surveys"] });
    const router = new RouterStore({ history });
    router.routesDef = routes;
    await router.setLocation(history.location);

    for (const path of ["/", "/about", "/org/:orgId", "/org/:orgId/surveys"] as const) {
      expect(router.doesTargetMatch(path)).toBe(router.doesPathMatch(path));
      expect(router.doesTargetMatch(path, true)).toBe(router.doesPathMatch(path, true));
    }
  });
});

describe("tryResolvePath", () => {
  test("substitutes params like resolvePath", () => {
    expect(tryResolvePath("/users/:id", { id: "42" })).toBe("/users/42");
    expect(tryResolvePath("/about")).toBe("/about");
  });

  test("returns undefined instead of throwing on a missing param", () => {
    expect(tryResolvePath("/users/:id")).toBeUndefined();
    expect(tryResolvePath("/teams/:teamId/users/:userId", { teamId: "7" })).toBeUndefined();
    expect(() => resolvePath("/users/:id")).toThrow("Parameter ':id' not specified");
  });
});

// ---------------------------------------------------------------------------
// awaiting navigate()
// ---------------------------------------------------------------------------

describe("navigate() resolution", () => {
  const PageD = () => null;
  const ErrorPage = () => null;

  const makeRouter = async (routes: any, initialPath = "/") => {
    const history = createMemoryHistory({ initialEntries: [initialPath] });
    const router = new RouterStore({ history });
    await router.initialize(routes);
    return { router, history };
  };

  test("resolves only once loaders have run and the route has swapped", async () => {
    let resolveLoader: (value: { name: string }) => void = () => {};
    const routes = makeRoutes()({
      index: PageA,
      profile: {
        [LOAD]: () => new Promise<{ name: string }>((resolve) => (resolveLoader = resolve)),
        index: PageB,
      },
    });
    const { router } = await makeRouter(routes);

    let landed = false;
    const navigation = router.navigate({ to: "/profile" as any }).then(() => (landed = true));

    // the loader is still in flight — the previous page is on screen and
    // nothing has resolved
    await Promise.resolve();
    expect(landed).toBe(false);
    expect(router.activeRoute?.path).toBe("");

    resolveLoader({ name: "ada" });
    await navigation;

    expect(landed).toBe(true);
    expect(router.activeRoute?.path).toBe("profile");
    expect(router.activeRoute?.data).toEqual({ name: "ada" });
    expect(router.isNavigating).toBe(false);
  });

  test("resolves at the end of a redirect chain, not the first hop", async () => {
    const routes = makeRoutes()({
      index: PageA,
      old: { [REDIRECT]: "/older" },
      older: { [REDIRECT]: "/current" },
      current: PageB,
    });
    const { router, history } = await makeRouter(routes);

    await router.navigate({ to: "/old" as any });

    expect(router.activeRoute?.path).toBe("current");
    expect(history.location.pathname).toBe("/current");
    expect(router.isNavigating).toBe(false);
  });

  test("resolves after a redirect thrown from a guard has landed", async () => {
    const routes = makeRoutes()({
      index: PageA,
      admin: {
        [GUARD]: async () => {
          throw redirect({ to: "/login" as any });
        },
        index: PageB,
      },
      login: PageC,
    });
    const { router } = await makeRouter(routes);

    await router.navigate({ to: "/admin" as any });

    expect(router.activeRoute?.path).toBe("login");
  });

  test("resolves after a guard that navigates rather than redirecting", async () => {
    // navigating inside a guard supersedes the navigation in flight; the
    // caller wants the view it ends on, not the hop it abandoned
    let router!: RouterStore;
    const routes = makeRoutes()({
      index: PageA,
      admin: {
        [GUARD]: async () => {
          void router.navigate({ to: "/login" as any });
        },
        index: PageB,
      },
      login: PageC,
    });
    ({ router } = await makeRouter(routes));

    await router.navigate({ to: "/admin" as any });

    expect(router.activeRoute?.path).toBe("login");
    expect(router.isNavigating).toBe(false);
  });

  test("resolves with the [ERROR] route committed rather than rejecting", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const routes = makeRoutes()({
      [ERROR]: ErrorPage,
      index: PageA,
      admin: {
        [GUARD]: async () => {
          throw new Error("nope");
        },
        index: PageB,
      },
    });
    const { router } = await makeRouter(routes);

    await expect(router.navigate({ to: "/admin" as any })).resolves.toBeUndefined();

    expect(router.activeRoute?.error?.type).toBe("GUARD");
  });

  test("resolves immediately for a navigation skipped as redundant", async () => {
    const routes = makeRoutes()({ index: PageA, about: PageD });
    const { router } = await makeRouter(routes, "/about");

    await expect(router.navigate({ to: "/about" as any })).resolves.toBeUndefined();
    expect(router.activeRoute?.path).toBe("about");
  });

  test("still throws synchronously for an unresolvable path", () => {
    const history = createMemoryHistory({ initialEntries: ["/"] });
    const router = new RouterStore({ history });
    void router.initialize(makeRoutes()({ index: PageA, users: { $id: PageB } }));

    // a rejected promise here would escape the try/catch that renders a
    // failed redirect as [ERROR]
    expect(() => router.navigate({ to: "/users/:id" } as any)).toThrow(
      "Parameter ':id' not specified",
    );
  });

  test("a query-param-only navigation resolves without re-matching the route", async () => {
    let loads = 0;
    const routes = makeRoutes()({
      index: PageA,
      search: {
        [LOAD]: async () => {
          loads++;
          return "results";
        },
        index: PageB,
      },
    });
    const { router } = await makeRouter(routes);
    await router.navigate({ to: "/search" as any });
    const active = router.activeRoute;

    await router.navigate({ to: "/search" as any, search: { q: "hello" } });

    expect(router.location.search).toBe("?q=hello");
    expect(router.activeRoute).toBe(active);
    expect(loads).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// redirect loops that only exist at runtime
// ---------------------------------------------------------------------------

describe("runtime redirect loops", () => {
  const LoopErrorPage = () => null;

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const makeRouter = async (routes: any, initialPath = "/") => {
    const history = createMemoryHistory({ initialEntries: [initialPath] });
    const router = new RouterStore({ history });
    await router.initialize(routes);
    return { router, history };
  };

  test("two guards redirecting at each other land an [ERROR] instead of spinning", async () => {
    // makeRoutes() rejects a static [REDIRECT] cycle at build time; a
    // redirect thrown from a guard is invisible to it, so the loop can only
    // be caught by running
    const routes = makeRoutes()({
      [ERROR]: LoopErrorPage,
      index: PageA,
      a: {
        [GUARD]: async () => {
          throw redirect({ to: "/b" as any });
        },
        index: PageB,
      },
      b: {
        [GUARD]: async () => {
          throw redirect({ to: "/a" as any });
        },
        index: PageC,
      },
    });
    const { router } = await makeRouter(routes);

    // the promise resolving at all is the assertion: before the chain was
    // bounded this never settled, so an `await router.navigate(...)` inside
    // an async caller silently dropped everything after it
    await router.navigate({ to: "/a" as any });

    expect(router.isNavigating).toBe(false);
    expect(router.activeRoute?.error?.type).toBe("REDIRECT");
    expect(router.activeRoute?.error?.message).toContain("10 redirects without landing");
  });

  test("a [REDIRECT] function cycle is caught the same way", async () => {
    // the build-time check gives up on the function form, since it cannot
    // evaluate it without a matched route
    const routes = makeRoutes()({
      [ERROR]: LoopErrorPage,
      index: PageA,
      one: { [REDIRECT]: () => "/two" },
      two: { [REDIRECT]: () => "/one" },
    });
    const { router } = await makeRouter(routes);

    await router.navigate({ to: "/one" as any });

    expect(router.activeRoute?.error?.type).toBe("REDIRECT");
    expect(router.activeRoute?.error?.message).toContain("10 redirects without landing");
  });

  test("a chain that keeps inventing pathnames is bounded too", async () => {
    // nothing repeats, so there is no cycle to spot even in principle —
    // the count is the only thing that can end this one
    const routes = makeRoutes()({
      [ERROR]: LoopErrorPage,
      index: PageA,
      page: {
        $n: {
          [GUARD]: async (route: any) => {
            throw redirect({ to: "/page/:n", params: { n: String(Number(route.params.n) + 1) } });
          },
          index: PageB,
        },
      },
    });
    const { router } = await makeRouter(routes);

    await router.navigate({ to: "/page/:n" as any, params: { n: "0" } } as any);

    expect(router.isNavigating).toBe(false);
    expect(router.activeRoute?.error?.type).toBe("REDIRECT");
    expect(router.activeRoute?.error?.message).toContain("10 redirects without landing");
  });

  test("a long chain that lands is not mistaken for a loop", async () => {
    const routes = makeRoutes()({
      [ERROR]: LoopErrorPage,
      index: PageA,
      one: { [REDIRECT]: "/two" },
      two: { [REDIRECT]: "/three" },
      three: { [REDIRECT]: "/four" },
      four: PageB,
    });
    const { router } = await makeRouter(routes);

    await router.navigate({ to: "/one" as any });

    expect(router.activeRoute?.path).toBe("four");
    expect(router.activeRoute?.error).toBeUndefined();
  });

  test("the count resets on landing, so redirects don't accumulate", async () => {
    // /gate redirects to /home the first time and /away the second. Without
    // a reset, enough separate redirecting navigations would eventually trip
    // the cap on a session that never actually looped
    let hop = 0;
    const routes = makeRoutes()({
      [ERROR]: LoopErrorPage,
      index: PageA,
      gate: { [REDIRECT]: () => (hop++ === 0 ? "/home" : "/away") },
      home: PageB,
      away: PageC,
    });
    const { router } = await makeRouter(routes);

    await router.navigate({ to: "/gate" as any });
    expect(router.activeRoute?.path).toBe("home");

    await router.navigate({ to: "/gate" as any });
    expect(router.activeRoute?.path).toBe("away");
    expect(router.activeRoute?.error).toBeUndefined();
  });
});
