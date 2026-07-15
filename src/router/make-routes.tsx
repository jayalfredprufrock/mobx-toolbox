import { DefaultErrorPage } from "./components/error";
import { RouterError } from "./errors";
import { Outlet } from "./outlet";
import { Redirect } from "./redirect";
import { Route } from "./route";
import { CONTEXT, ERROR, GUARD, LAYOUT, LOAD, PAGE, REDIRECT, WRAPPER } from "./symbols";
import type { Component, GuardEntry, MatchLevel, Obj, Routes } from "./types";
import { isComponent, isLazyComponent, isLeaf, isPage, isRedirect } from "./util";

const pathToSegments = (path: string): string[] => {
  return path.replace(/^\/+|\/+$/g, "").split("/");
};

export interface MatchState {
  segments: string[];
  context: Obj;
  params: Obj;
  outlets: (Outlet | undefined)[];
  guards: GuardEntry[];
  levels: MatchLevel[];
  layout?: Component;
  errorComponent?: Component;
}

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
  const level = depth >= 0 ? levels[depth] : undefined;

  const ErrorComponent = level?.errorComponent ?? DefaultErrorPage;
  const outlets = levels
    .slice(0, depth + 1)
    .flatMap((l) => (l.wrapper ? [new Outlet({ component: l.wrapper })] : []));
  outlets.push(
    new Outlet({ component: (props: Obj) => <ErrorComponent {...props} error={error} /> }),
  );

  return new Route({
    path: pathname.replace(/^\/+/, ""),
    outlets,
    guards: [],
    levels: [],
    params: error.state?.params ?? source?.params ?? {},
    context: error.state?.context ?? source?.context ?? {},
    layout: level?.layout,
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

  const state: MatchState = {
    segments: [],
    params: {},
    ...matchState,
    layout,
    errorComponent,
    context: { ...matchState?.context, ...routeDef[CONTEXT] },
    guards: [
      ...(matchState?.guards ?? []),
      ...(routeDef[GUARD] ? [{ guard: routeDef[GUARD], depth }] : []),
    ],
    outlets: [
      ...(matchState?.outlets ?? []),
      routeDef[WRAPPER] ? new Outlet({ component: routeDef[WRAPPER], errorComponent }) : undefined,
      routeDef[LOAD] ? new Outlet({ loader: routeDef[LOAD], errorComponent }) : undefined,
    ],
    levels: [...(matchState?.levels ?? []), { wrapper: routeDef[WRAPPER], layout, errorComponent }],
  };

  const [segment, ...remainingSegments] = pathToSegments(path);
  const remainingPath = remainingSegments.join("/");

  let defAtSegment = routeDef[segment || "index"];

  if (!defAtSegment) {
    const matchedSegment = Object.keys(routeDef).find(
      (segment) => segment.startsWith("$") || segment.startsWith(":"),
    );
    if (matchedSegment) {
      defAtSegment = routeDef[matchedSegment];
      state.params[matchedSegment.slice(1)] = segment;
    }
  }

  if (!defAtSegment) {
    throw notFound(state, [...state.segments, segment ?? "", ...remainingSegments]);
  }

  state.segments.push(segment ?? "index");

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
      state.outlets.push(new Outlet({ component: defAtSegment, errorComponent }));
      return makeRoute(state);
    }
  }

  // at this point we have a nested route or a [Page] definition

  if (isPage(defAtSegment)) {
    state.layout = defAtSegment[LAYOUT] ?? state.layout;
    state.errorComponent = defAtSegment[ERROR] ?? state.errorComponent;
    Object.assign(state.context, defAtSegment[CONTEXT]);
    if (defAtSegment[GUARD]) {
      state.guards.push({ guard: defAtSegment[GUARD], depth });
    }
    state.outlets.push(
      new Outlet({
        component: defAtSegment[PAGE],
        loader: defAtSegment[LOAD],
        errorComponent: state.errorComponent,
      }),
    );
    state.levels[state.levels.length - 1] = {
      ...state.levels[state.levels.length - 1],
      layout: state.layout,
      errorComponent: state.errorComponent,
    };

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
