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

/**
 * Where a component sits in the matched route tree. Every component the
 * router renders in an outlet — `[WRAPPER]`, `[PAGE]`, `[LOADING]`,
 * `[ERROR]` — receives its own level alongside `route`, so route-level
 * metadata (breadcrumbs, sub-navigation, per-level analytics) can live in
 * the component rather than being hardcoded against a path the route tree
 * already knows.
 */
export interface RouteLevel {
  /** 0-based index of this level in the matched chain. */
  index: number;
  /**
   * The route-definition key for this level, with a dynamic segment
   * normalized to its path spelling (`$orgId` and `":orgId"` both read as
   * `:orgId`). `"index"` for an index page, `""` for the root level.
   *
   * A definition key, not necessarily a URL segment: on a group's level this
   * is the group key (`_list`), which appears in no path.
   */
  segment: string;
  /**
   * This level's own route pattern, e.g. `/org/:orgId/surveys` — ready to
   * hand to `to=` or `router.navigate()` once its params are filled in.
   *
   * `undefined` when the level does not address a page of its own: a
   * nesting level with no `index` key is not navigable, and deriving a
   * pattern for it would produce a path that 404s.
   */
  pattern?: RoutePath;
}

/**
 * The props every `[WRAPPER]` component receives. Unlike `[LOADING]` and
 * `[ERROR]`, a wrapper does receive `children` — it wraps the rest of the
 * chain below it.
 */
export interface WrapperComponentProps {
  route: Route;
  level: RouteLevel;
  children?: React.ReactNode;
}

/** The props every `[PAGE]` component receives. */
export interface PageComponentProps {
  route: Route;
  level: RouteLevel;
}

/** The props every `[ERROR]` component receives. */
export interface ErrorComponentProps {
  route: Route;
  error: RouterError;
  /**
   * Absent only on a synthetic error route that never matched a level —
   * a `NOT_FOUND` on the very first segment, say. Present for in-slot
   * loader errors and anywhere a prefix of the tree did match.
   */
  level?: RouteLevel;
}

/**
 * The props every `[LOADING]` component receives. Note the absence of
 * `children`: outlets in a chain load in parallel, so a descendant can
 * be ready while this slot is still loading — rendering it would paint
 * a page with incomplete `route.data`.
 */
export interface LoadingComponentProps {
  route: Route;
  level: RouteLevel;
}

/**
 * A matched view of where navigation is headed, published the moment the
 * matcher resolves a URL — before guards and loaders run. See
 * {@link MobxRouterConfig} consumers via `RouterStore.target`.
 *
 * Deliberately a plain value rather than the matched `Route`: at this point
 * the route's outlets have not loaded, so handing it out would invite reading
 * `route.data` before the loaders ran, and would keep outlets alive for a
 * navigation that may yet be abandoned.
 */
export interface RouteTarget {
  /** The destination URL's pathname. */
  pathname: string;
  /**
   * The matched pattern, e.g. `/org/:orgId/surveys`. Compare against this
   * instead of interpolating params into a path — that comparison is where
   * the two clocks get mixed.
   *
   * `undefined` only when carried over from a route that never matched a
   * pattern; see `RouterStore.target`.
   */
  pattern?: RoutePath;
  params: Record<string, string>;
  /**
   * The matched nesting levels — the same ones `[WRAPPER]`s render at. A
   * wrapper can compare its own `level` against these to ask whether the
   * destination is still inside it, without waiting for the swap.
   */
  levels: RouteLevel[];
}

/** @internal a guard together with the route level that declared it */
export interface GuardEntry {
  guard: Guard;
  depth: number;
}

/** @internal per-level snapshot used to build synthetic error routes */
export interface MatchLevel {
  level: RouteLevel;
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

/**
 * Navigation options for a `[REDIRECT]`.
 *
 * Deliberately path-agnostic: `to` is a plain `string` and `params` is
 * always optional, so a dynamic target types the same as a static one.
 * See the note on {@link RedirectTarget} for why this cannot be `RoutePath`.
 */
export type RedirectOptions = Omit<NavigateOptions<string>, "params"> & { params?: Obj<string> };

/**
 * What `[REDIRECT]` accepts: a path, full navigation options, or a function
 * of the route the redirect matched.
 *
 * The function form is how a redirect reaches a dynamic path — it can read
 * `route.params` rather than borrowing a `[GUARD]` to do the same job. It
 * runs during matching, before guards and loaders, so `route.data` is empty;
 * `params`, `context` and `path` are what it has to work with. Throwing from
 * it fails the navigation as a `RouterError` of type `"REDIRECT"`.
 *
 * **Nothing reachable from `Routes` may reference `RoutePath`.** `RoutePath`
 * is derived from `MobxRouter["routes"]`, which is the very object being
 * inferred — so naming it here makes `makeRoutes()`'s `R extends Routes`
 * constraint depend on `typeof routes` while inferring `typeof routes`. The
 * route object then collapses to `any` with TS7022 in every app that
 * augments `MobxRouter`. That is why targets are checked structurally, and
 * why an unresolvable `to` is a runtime `RouterError` rather than a type
 * error. See `makeRoutes`' note on the same constraint.
 */
export type RedirectTarget =
  | string
  | RedirectOptions
  | ((route: Route) => string | RedirectOptions);

export interface Redirector {
  [REDIRECT]: RedirectTarget;
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
  /**
   * Replace the current history entry instead of pushing a new one.
   *
   * Defaults to `false` for a direct `navigate()` or `<Link>`, and to `true`
   * everywhere the navigation is a *redirect* — a `[REDIRECT]` leaf or a
   * `redirect()` thrown from a guard or loader — where the origin URL
   * renders nothing and would trap Back if it stayed in history.
   */
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
  ExtractPaths<MobxRouterRoutes> extends undefined
    ? string
    : NormalizeRootPath<ExtractPaths<MobxRouterRoutes>>;

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

// An `index` key addresses its parent's path, so it contributes no segment of
// its own: `{ account: { index: Page } }` is `/account`, not `/account/`. At
// the root that leaves the empty string, which `NormalizeRootPath` turns back
// into `/` — the one path with no segments at all.
// A `_`-prefixed key is a group: config-only, contributing no segment, so it
// recurses without joining anything. Without this branch its children would
// come out as `/surveys/_list/published`.
export type ExtractPaths<R> = {
  [S in keyof R]: S extends `_${string}`
    ? ExtractPaths<R[S]>
    : S extends string
      ? S extends "index"
        ? ""
        : R[S] extends Leaf
          ? `/${SegmentName<S> extends string ? SegmentName<S> : ""}`
          : JoinSegments<SegmentName<S>, ExtractPaths<R[S]>>
      : never;
}[keyof R];

export type NormalizeRootPath<P> = P extends "" ? "/" : P;
