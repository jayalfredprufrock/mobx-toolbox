import { DefaultErrorPage } from "./components/error";
import { redirectFailed, RouterError } from "./errors";
import { Outlet } from "./outlet";
import { Redirect } from "./redirect";
import { Route } from "./route";
import { CONTEXT, ERROR, GUARD, LAYOUT, LOAD, LOADING, PAGE, REDIRECT, WRAPPER } from "./symbols";
import type {
  Component,
  GuardEntry,
  Leaf,
  MatchLevel,
  Obj,
  RedirectOptions,
  RedirectTarget,
  RouteLevel,
  RoutePath,
  Routes,
} from "./types";
import { isComponent, isLazyComponent, isLeaf, isPage, isRedirect, resolvePath } from "./util";

const pathToSegments = (path: string): string[] => {
  return path.replace(/^\/+|\/+$/g, "").split("/");
};

export interface MatchState {
  segments: string[];
  patternSegments: string[];
  context: Obj;
  params: Obj;
  outlets: (Outlet | undefined)[];
  guards: GuardEntry[];
  levels: MatchLevel[];
  layout?: Component;
  errorComponent?: Component;
  loadingComponent?: Component;
}

/**
 * A level's pattern is the definition keys that led to it, dynamic segments
 * in their `:param` path spelling. No segments at all is the root, `/`.
 */
const toPattern = (patternSegments: string[]): RoutePath =>
  `/${patternSegments.join("/")}` as RoutePath;

/** `$orgId` and `":orgId"` are the same segment; paths spell it `:orgId`. */
const toPatternSegment = (defKey: string): string =>
  defKey.startsWith("$") ? `:${defKey.slice(1)}` : defKey;

export const makeRoute = (matchState: MatchState): Route => {
  const outlets = matchState.outlets.filter((o) => o !== undefined);

  return new Route({ ...matchState, outlets, path: matchState.segments.join("/") });
};

/**
 * Builds the synthetic route rendered when navigation fails. Bubbles
 * from the failing level (`error.depth`, defaulting to the deepest
 * matched level) to the nearest `[ERROR]` component, preserving the
 * `[LAYOUT]` and `[WRAPPER]`s accumulated up to that level. Ancestor
 * `[LOAD]` loaders are intentionally not run — error routes never
 * fetch data.
 */
export const makeErrorRoute = (
  error: RouterError,
  pathname: string,
  source?: { levels: MatchLevel[]; params: Obj; context: Obj },
): Route => {
  const levels = error.state?.levels ?? source?.levels ?? [];
  const depth = Math.min(error.depth ?? levels.length - 1, levels.length - 1);
  const matched = depth >= 0 ? levels[depth] : undefined;

  const ErrorComponent = matched?.errorComponent ?? DefaultErrorPage;
  const outlets = levels
    .slice(0, depth + 1)
    .flatMap((l) => (l.wrapper ? [new Outlet({ component: l.wrapper, level: l.level })] : []));
  // no children — `[ERROR]` components never receive them, on the
  // synthetic-route path or the in-slot one. `level` is whatever level
  // failed; absent when nothing matched at all.
  outlets.push(
    new Outlet({
      component: ({ route, level }: Obj) => (
        <ErrorComponent route={route} level={level} error={error} />
      ),
      level: matched?.level,
    }),
  );

  return new Route({
    path: pathname.replace(/^\/+/, ""),
    outlets,
    guards: [],
    levels: [],
    params: error.state?.params ?? source?.params ?? {},
    context: error.state?.context ?? source?.context ?? {},
    layout: matched?.layout,
    error,
  });
};

/** A bare path is the one-field spelling of the options object. */
const toRedirectOptions = (target: string | RedirectOptions): RedirectOptions =>
  typeof target === "string" ? { to: target } : target;

/**
 * Resolves a `[REDIRECT]` to the navigation it names.
 *
 * The function form is called with the route the redirect matched — the
 * whole point being that a redirect to a dynamic path can read
 * `route.params` itself. It may return either spelling: a path it has
 * already substituted, or options for the router to substitute. A throw from
 * it fails the navigation as a redirect rather than as a generic render
 * error, and carries the matched prefix along so the nearest `[ERROR]`
 * renders inside its layout and wrappers.
 */
const makeRedirect = (target: RedirectTarget, state: MatchState): Redirect => {
  let options: RedirectOptions;

  if (typeof target === "function") {
    try {
      options = toRedirectOptions(target(makeRoute(state)));
    } catch (cause) {
      throw redirectFailed(cause, `/${state.segments.join("/")}`, { state });
    }
  } else {
    options = toRedirectOptions(target);
  }

  const redirect = new Redirect(options as any);
  redirect.state = state;
  return redirect;
};

const notFound = (state: MatchState, attemptedSegments: string[]): RouterError => {
  const error = new RouterError("NOT_FOUND", {
    path: `/${attemptedSegments.filter((s) => s !== "").join("/")}`,
  });
  error.state = state;
  return error;
};

export const matchRoute = (path: string, routeDef: Routes, matchState?: MatchState): Route => {
  const depth = matchState?.levels.length ?? 0;
  const layout = routeDef[LAYOUT] ?? matchState?.layout;
  const errorComponent = routeDef[ERROR] ?? matchState?.errorComponent;
  const loadingComponent = routeDef[LOADING] ?? matchState?.loadingComponent;

  const patternSegments = matchState?.patternSegments ?? [];

  // This level's own address. Only navigable when it has an `index` child —
  // a nesting level without one has no page of its own, and handing out a
  // pattern for it would produce a path that 404s on navigation.
  const level: RouteLevel = {
    index: depth,
    segment: patternSegments.at(-1) ?? "",
    pattern: routeDef.index === undefined ? undefined : toPattern(patternSegments),
  };

  const state: MatchState = {
    segments: [],
    patternSegments: [],
    params: {},
    ...matchState,
    layout,
    errorComponent,
    loadingComponent,
    context: { ...matchState?.context, ...routeDef[CONTEXT] },
    guards: [
      ...(matchState?.guards ?? []),
      ...(routeDef[GUARD] ? [{ guard: routeDef[GUARD], depth }] : []),
    ],
    outlets: [
      ...(matchState?.outlets ?? []),
      routeDef[WRAPPER]
        ? new Outlet({ component: routeDef[WRAPPER], errorComponent, loadingComponent, level })
        : undefined,
      routeDef[LOAD]
        ? new Outlet({ loader: routeDef[LOAD], errorComponent, loadingComponent, level })
        : undefined,
    ],
    levels: [
      ...(matchState?.levels ?? []),
      { level, wrapper: routeDef[WRAPPER], layout, errorComponent },
    ],
  };

  const [segment, ...remainingSegments] = pathToSegments(path);
  const remainingPath = remainingSegments.join("/");

  // an empty segment addresses this level itself, which is what `index`
  // names — so it consumes no segment of the path or the pattern
  const isIndex = !segment;
  let defKey = isIndex ? "index" : segment;
  let defAtSegment = routeDef[defKey];

  if (!defAtSegment && !isIndex) {
    const matchedSegment = Object.keys(routeDef).find(
      (key) => key.startsWith("$") || key.startsWith(":"),
    );
    if (matchedSegment) {
      defKey = matchedSegment;
      defAtSegment = routeDef[matchedSegment];
      state.params[matchedSegment.slice(1)] = segment;
    }
  }

  if (!defAtSegment) {
    throw notFound(state, [...state.segments, segment ?? "", ...remainingSegments]);
  }

  if (!isIndex) {
    state.segments.push(segment);
    state.patternSegments.push(toPatternSegment(defKey));
  }

  // the level a leaf or [PAGE] renders at — one below the nesting level
  // that contains it, and always navigable: it *is* a page
  const leafLevel: RouteLevel = {
    index: state.levels.length,
    segment: isIndex ? "index" : toPatternSegment(defKey),
    pattern: toPattern(state.patternSegments),
  };

  if (isLeaf(defAtSegment)) {
    if (remainingPath) {
      throw notFound(state, [...state.segments, ...remainingSegments]);
    }

    if (isRedirect(defAtSegment)) {
      throw makeRedirect(defAtSegment[REDIRECT], state);
    }

    if (isComponent(defAtSegment) || isLazyComponent(defAtSegment)) {
      state.outlets.push(
        new Outlet({ component: defAtSegment, errorComponent, loadingComponent, level: leafLevel }),
      );
      return makeRoute(state);
    }
  }

  // at this point we have a nested route or a [Page] definition

  if (isPage(defAtSegment)) {
    state.layout = defAtSegment[LAYOUT] ?? state.layout;
    state.errorComponent = defAtSegment[ERROR] ?? state.errorComponent;
    state.loadingComponent = defAtSegment[LOADING] ?? state.loadingComponent;
    Object.assign(state.context, defAtSegment[CONTEXT]);
    if (defAtSegment[GUARD]) {
      state.guards.push({ guard: defAtSegment[GUARD], depth });
    }
    state.outlets.push(
      new Outlet({
        component: defAtSegment[PAGE],
        loader: defAtSegment[LOAD],
        errorComponent: state.errorComponent,
        loadingComponent: state.loadingComponent,
        level: leafLevel,
      }),
    );
    // a [PAGE] refines the level it sits in rather than adding one of its
    // own — that is what makes a page's [ERROR] catch its own [GUARD],
    // which resolves through `levels[depth]`
    const pageLevel = state.levels[state.levels.length - 1];
    if (pageLevel) {
      state.levels[state.levels.length - 1] = {
        ...pageLevel,
        layout: state.layout,
        errorComponent: state.errorComponent,
      };
    }

    return makeRoute(state);
  }

  // now we know we have a nested route
  return matchRoute(remainingPath, defAtSegment, state);
};

/** @internal a leaf together with the path it answers to */
interface Addressable {
  /** this leaf's own pattern, e.g. `/org/:orgId/overview` */
  pattern: string;
  /** dotted route-key trail, so validation errors can name the culprit */
  at: string;
  def: Leaf;
}

/**
 * Every path the tree can address, in `:param` pattern spelling. Mirrors how
 * `matchRoute` walks it: an `index` key addresses its parent's path and adds
 * no segment, a leaf adds its own, and a nesting level without an `index` is
 * not addressable at all — so it is correctly absent here.
 */
const collectAddressable = (
  routeDef: Routes,
  prefix: string[] = [],
  trail: string[] = [],
  out: Addressable[] = [],
): Addressable[] => {
  for (const key of Object.keys(routeDef)) {
    const def = routeDef[key];
    if (def === undefined) continue;

    const segments = key === "index" ? prefix : [...prefix, toPatternSegment(key)];
    const keys = [...trail, key];
    if (isLeaf(def)) {
      out.push({ pattern: `/${segments.join("/")}`, at: keys.join("."), def });
    } else {
      collectAddressable(def, segments, keys, out);
    }
  }
  return out;
};

/** Whether `path` addresses `pattern`, a `:param` segment matching anything. */
const matchesPattern = (path: string, pattern: string): boolean => {
  const pathSegments = path.split("/");
  const patternSegments = pattern.split("/");

  return (
    pathSegments.length === patternSegments.length &&
    patternSegments.every((segment, i) =>
      segment.startsWith(":") ? !!pathSegments[i] : segment === pathSegments[i],
    )
  );
};

/** The first `:param` in `to` that `params` has no value for. */
const unresolvedParam = (to: string, params?: Obj<string>): string | undefined =>
  to.split("/").find((segment) => segment.startsWith(":") && !params?.[segment.slice(1)]);

/**
 * The leaf a concrete path lands on. Exact patterns win over dynamic ones, the
 * way `matchRoute` prefers a literal key over the level's `$param` key.
 */
const findAddressable = (path: string, entries: Addressable[]): Addressable | undefined =>
  entries.find((entry) => entry.pattern === path) ??
  entries.find((entry) => matchesPattern(path, entry.pattern));

/**
 * Follows a redirect's static targets and returns the cycle it falls into, if
 * any — `["/a", "/b", "/a"]` for a two-hop loop.
 *
 * Revisiting a pattern is always a real loop: a static target is the same
 * every time that leaf is matched, so a second visit resolves identically and
 * would keep doing so. A function target ends the walk instead of being
 * guessed at — where it goes depends on the route it matched.
 */
const findRedirectLoop = (start: Addressable, entries: Addressable[]): string[] | undefined => {
  const chain: string[] = [];
  let current: Addressable | undefined = start;

  while (current && isRedirect(current.def)) {
    const seen = chain.indexOf(current.pattern);
    if (seen !== -1) return [...chain.slice(seen), current.pattern];
    chain.push(current.pattern);

    const target = current.def[REDIRECT];
    if (typeof target === "function") return undefined;

    const { to, params } = toRedirectOptions(target);
    // an unresolvable or unaddressable target is reported on its own entry
    if (unresolvedParam(to, params)) return undefined;
    current = findAddressable(resolvePath(to, params), entries);
  }

  return undefined;
};

/**
 * Rejects a `[REDIRECT]` that can never work: a target no route addresses, a
 * `:param` with nothing to fill it, or a chain that loops instead of landing.
 * Runs when the route tree is defined, so it throws on first import —
 * deterministic, and therefore impossible to ship past a single dev or CI run.
 * Without it these surface late and quietly: a mistyped target is a valid path
 * string, so the redirect happens and the *next* navigation 404s, one step
 * removed from the actual mistake.
 *
 * Function targets are skipped. What they return depends on the route they
 * matched, which does not exist yet.
 */
const validateRedirects = (entries: Addressable[]): void => {
  for (const entry of entries) {
    if (!isRedirect(entry.def)) continue;

    const target = entry.def[REDIRECT];
    if (typeof target === "function") continue;

    const { to, params } = toRedirectOptions(target);
    const unresolved = unresolvedParam(to, params);
    if (unresolved) {
      throw new Error(
        `[REDIRECT] at '${entry.at}' targets '${to}', but '${unresolved}' has no value. ` +
          "Supply it in `params`, or use the function form to read it off the " +
          "matched route: [REDIRECT]: (route) => ...",
      );
    }

    if (!findAddressable(resolvePath(to, params), entries)) {
      throw new Error(
        `[REDIRECT] at '${entry.at}' targets '${to}', which no route in this tree addresses.`,
      );
    }

    const loop = findRedirectLoop(entry, entries);
    if (loop) {
      throw new Error(`[REDIRECT] at '${entry.at}' never lands — it loops: ${loop.join(" → ")}.`);
    }
  }
};

// TODO: ideally this could resolve to something less than R,
// but specific enough to infer all paths as a literal union.
// As it stands, there are certain things we can't access reliably
// without the compiler complaining about circular references
// try "as const satisfies" approach which would allow us to
// exchange a less specific version of MobxRoutesRoot for this
//
// The concrete rule that falls out of `R extends Routes`: **nothing
// reachable from `Routes` may reference `RoutePath`** (or `StaticRoutePath`,
// or anything else derived from `MobxRouter["routes"]`). `RoutePath` comes
// from the object being inferred here, so naming it inside the constraint
// makes `typeof routes` depend on itself — TS7022, and the whole tree types
// as `any` in any app that augments `MobxRouter`. Route *values* may of
// course be typed against paths at their own call sites; the route
// definition types may not. router.types.test.ts guards this.
export const makeRoutes =
  () =>
  <R extends Routes>(routes: R): R => {
    validateRedirects(collectAddressable(routes));

    // todo: perform the rest of the validation here
    // - no forward slashes in keys
    // - at most one variable segment per level
    // - only lowercase letters (except variables)
    // - paths/variables cannot contain $ or : that aren't at the beginning
    // - path variables must be unique across a path
    return routes;
  };
