import { Outlet } from "./outlet";
import { Redirect } from "./redirect";
import { Route } from "./route";
import { CONTEXT, GUARD, LAYOUT, LOAD, PAGE, REDIRECT, WRAPPER } from "./symbols";
import type { Component, Guard, Obj, Routes } from "./types";
import { isComponent, isLazyComponent, isLeaf, isPage, isRedirect } from "./util";

const pathToSegments = (path: string): string[] => {
  return path.replace(/^\/+|\/+$/g, "").split("/");
};

export interface MatchState {
  segments: string[];
  context: Obj;
  params: Obj;
  outlets: (Outlet | undefined)[];
  guards: (Guard | undefined)[];
  layout?: Component;
}

export const makeRoute = (matchState: MatchState): Route => {
  const outlets = matchState.outlets.filter((o) => o !== undefined);
  const guards = matchState.guards.filter((g) => g !== undefined);

  return new Route({ ...matchState, outlets, guards, path: matchState.segments.join("/") });
};

export const matchRoute = (path: string, routeDef: Routes, matchState?: MatchState): Route => {
  const state: MatchState = {
    segments: [],
    params: {},
    ...matchState,
    layout: routeDef[LAYOUT] ?? matchState?.layout,
    context: { ...matchState?.context, ...routeDef[CONTEXT] },
    guards: [...(matchState?.guards ?? []), routeDef[GUARD]],
    outlets: [
      ...(matchState?.outlets ?? []),
      routeDef[WRAPPER] ? new Outlet({ component: routeDef[WRAPPER] }) : undefined,
      routeDef[LOAD] ? new Outlet({ loader: routeDef[LOAD] }) : undefined,
    ],
  };

  const [segment, ...remainingSegments] = pathToSegments(path);
  const remainingPath = remainingSegments.join("/");

  let defAtSegment = routeDef[segment || "index"];

  if (!defAtSegment) {
    const matchedSegment = Object.keys(routeDef).find((segment) => segment.startsWith("$"));
    if (matchedSegment) {
      defAtSegment = routeDef[matchedSegment];
      state.params[matchedSegment.slice(1)] = segment;
    }
  }

  if (!defAtSegment) {
    throw new Error("Not Found.");
  }

  state.segments.push(segment ?? "index");

  if (isLeaf(defAtSegment)) {
    if (remainingPath) {
      throw new Error("Not Found.");
    }

    if (isRedirect(defAtSegment)) {
      const redirect =
        typeof defAtSegment[REDIRECT] === "string"
          ? { to: defAtSegment[REDIRECT] }
          : defAtSegment[REDIRECT];
      throw new Redirect(redirect as any);
    }

    if (isComponent(defAtSegment) || isLazyComponent(defAtSegment)) {
      state.outlets.push(new Outlet({ component: defAtSegment }));
      return makeRoute(state);
    }
  }

  // at this point we have a nested route or a [Page] definition

  if (isPage(defAtSegment)) {
    state.layout = defAtSegment[LAYOUT] ?? state.layout;
    Object.assign(state.context, defAtSegment[CONTEXT]);
    state.guards.push(defAtSegment[GUARD]);
    state.outlets.push(
      new Outlet({
        component: defAtSegment[PAGE],
        loader: defAtSegment[LOAD],
      }),
    );

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
    // - paths/variables cannot contain $ that aren't at the beginning
    // - path variables must be unique across a path

    return routes;
  };
