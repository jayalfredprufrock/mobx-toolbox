import type { History } from "history";
import type { RouterError } from "./errors";
import type { Route } from "./route";
import {
  CONTEXT,
  ERROR,
  GUARD,
  LAYOUT,
  LOAD,
  LOADING,
  PAGE,
  REDIRECT,
  SPLASH,
  WRAPPER,
} from "./symbols";

export type Component = React.FC<any>;
export type LazyComponent = () => Promise<any>;
export type Obj<T = any> = Record<string, T>;
export type Loader = (route: Route) => Promise<any>;
export type Guard = (route: Route) => Promise<void>;

/** The props every `[ERROR]` component receives. */
export interface ErrorComponentProps {
  route: Route;
  error: RouterError;
}

/**
 * The props every `[LOADING]` component receives. Note the absence of
 * `children`: outlets in a chain load in parallel, so a descendant can
 * be ready while this slot is still loading — rendering it would paint
 * a page with incomplete `route.data`.
 */
export interface LoadingComponentProps {
  route: Route;
}

/** @internal a guard together with the route level that declared it */
export interface GuardEntry {
  guard: Guard;
  depth: number;
}

/** @internal per-level snapshot used to build synthetic error routes */
export interface MatchLevel {
  wrapper?: Component;
  layout?: Component;
  errorComponent?: Component;
}

export interface RouteConfig {
  [CONTEXT]?: Obj;
  [LAYOUT]?: Component;
  [WRAPPER]?: Component;
  [GUARD]?: Guard;
  [LOAD]?: Loader;
  [ERROR]?: Component;
  [LOADING]?: Component;
}

/**
 * A route page definition.
 *
 * For eager (non-lazy) pages, pass the component directly:
 *
 * ```tsx
 * import { DashboardPage } from './routes/dashboard';
 *
 * const routes = makeRoutes()({
 *   dashboard: { [PAGE]: DashboardPage },
 * });
 * ```
 *
 * Holding the reference across an HMR update is fine: React Refresh
 * resolves a component through its family map, so an element created
 * from an older reference still renders the current implementation.
 * What this depends on is `Outlet` keeping `component` as a plain
 * field — a MobX-wrapped identity belongs to no family and would stop
 * resolving. See the note on `Outlet.component`.
 *
 * A thunk (`[PAGE]: () => <DashboardPage />`) also works but drops the
 * props the outlet passes, so the page will not receive `route`.
 *
 * Lazy pages use the `() => import('./Page')` form (detected by the
 * library) and follow the normal code-splitting flow.
 */
export interface Page extends Omit<RouteConfig, typeof WRAPPER> {
  [PAGE]: Component | LazyComponent;
}

export interface Redirector {
  [REDIRECT]: string | NavigateOptions;
}

export type Leaf = Page | Redirector | Component | LazyComponent;

export interface Routes extends RouteConfig {
  /**
   * Rendered while the very first navigation is still resolving — before
   * any route has matched, so before `[LAYOUT]`, `[LOADING]` and the outlet
   * chain exist. Covers app boot, most visibly when a root `[GUARD]` has to
   * await an auth check.
   *
   * Read from the **root** of the route definition only; the type permits
   * it on nested objects, where it is ignored. Receives no props — there is
   * no route yet to describe.
   */
  [SPLASH]?: Component;
  [segment: string]: Leaf | Routes;
}

export type HasParam<T> = T extends `${string}:${string}` ? true : false;

export type WithToAndParams<P extends RoutePath, T = {}> =
  {} extends ExtractParams<P>
    ? { to: P; params?: undefined } & Omit<T, "to" | "params">
    : { to: P; params: ExtractParams<P> } & Omit<T, "to" | "params">;

export type NavigateOptions<P = string> = {
  to: P;
  replace?: boolean;
  state?: unknown;
  search?: Record<string, string> | URLSearchParams;
  preserveSearch?: boolean;
} & (HasParam<P> extends true ? { params: ExtractParams<P> } : { params?: undefined });

/* Finalized Types */
/********************************************************************************* */

// biome-ignore lint/suspicious/noEmptyInterface: open for extension
export interface MobxRouter {}

export type MobxRouterRoutes = MobxRouter extends { routes: infer R } ? R : Routes;

export interface MobxRouterConfig {
  history?: History;
  /**
   * Wrap route swaps in `document.startViewTransition` where the browser
   * supports it. Defaults to `true`; set `false` to opt out globally.
   */
  viewTransitions?: boolean;
}

export type RoutePath =
  ExtractPaths<MobxRouterRoutes> extends undefined ? string : ExtractPaths<MobxRouterRoutes>;

export type DynamicRoutePath = Extract<RoutePath, `${string}:${string}`>;
export type StaticRoutePath = Exclude<RoutePath, `${string}:${string}`>;

/* Generic Utilities */
/********************************************************************************* */

export type JoinSegments<S1, S2> = `/${S1 extends string ? S1 : ""}${S2 extends string ? S2 : ""}`;

// Route keys use `$param` (valid unquoted object key) or quoted `":param"`;
// path strings always use backend-style `:param`. This rewrites the `$` key
// spelling to the path spelling; `:` keys pass through unchanged.
export type SegmentName<S> = S extends `$${infer Param}` ? `:${Param}` : S;

export type ExtractParam<P, NextPart> = P extends `:${infer Param}`
  ? Record<Param, string> & NextPart
  : NextPart;
export type ExtractParams<P> = P extends `${infer S1}/${infer Rest}`
  ? ExtractParam<S1, ExtractParams<Rest>>
  : ExtractParam<P, {}>;

export type ExtractPaths<R> = {
  [S in keyof R]: S extends string
    ? S extends "index"
      ? "/"
      : R[S] extends Leaf
        ? `/${SegmentName<S> extends string ? SegmentName<S> : ""}`
        : JoinSegments<SegmentName<S>, ExtractPaths<R[S]>>
    : never;
}[keyof R];
