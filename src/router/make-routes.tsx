import { DefaultErrorPage } from "./components/error";
import { RouterError } from "./errors";
import { Outlet } from "./outlet";
import { Redirect } from "./redirect";
import { Route } from "./route";
import { CONTEXT, ERROR, GUARD, LAYOUT, LOAD, LOADING, PAGE, REDIRECT, WRAPPER } from "./symbols";
import type {
  Component,
  GuardEntry,
  MatchLevel,
  Obj,
  RouteLevel,
  RoutePath,
  Routes,
} from "./types";
import { isComponent, isLazyComponent, isLeaf, isPage, isRedirect } from "./util";

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
      const redirect =
        typeof defAtSegment[REDIRECT] === "string"
          ? { to: defAtSegment[REDIRECT] }
          : defAtSegment[REDIRECT];
      throw new Redirect(redirect as any);
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

// TODO: ideally this could resolve to something less than R,
// but specific enough to infer all paths as a literal union.
// As it stands, there are certain things we can't access reliably
// without the compiler complaining about circular references
// try "as const satisfies" approach which would allow us to
// exchange a less specific version of MobxRoutesRoot for this
export const makeRoutes =
  () =>
  <R extends Routes>(routes: R): R => {
    // todo: perform some validation here
    // - no forward slashes in keys
    // - at most one variable segment per level
    // - only lowercase letters (except variables)
    // - paths/variables cannot contain $ or : that aren't at the beginning
    // - path variables must be unique across a path
    return routes;
  };
