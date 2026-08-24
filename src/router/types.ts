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
 *
 * Name the path it sits on to get `route` typed — see {@link PageProps}. A wrapper's path
 * is a {@link RoutePrefix} rather than a `RoutePath`, because the level it wraps often addresses no
 * page of its own.
 */
export interface WrapperProps<P extends RoutePrefix | undefined = undefined> {
  route: [P] extends [undefined] ? Route : RouteAtPrefix<P & string>;
  level: RouteLevel;
  children?: React.ReactNode;
}

/**
 * The props every `[PAGE]` component receives.
 *
 * Name the path the page sits on and `route` is typed against the route tree — `params` from the
 * path, `data` from every `[LOAD]` at or above it, `context` from every `[CONTEXT]`:
 *
 * ```tsx
 * export const StudyPage: FC<PageProps<"/org/:orgId/studies/:studyId">> = ({ route }) => {
 *   route.params.studyId; // string
 *   route.data.study; // whatever that level's [LOAD] resolves to
 *   route.data.org; // ...and the ancestor's, merged in
 * };
 * ```
 *
 * The path is given rather than inferred because the component cannot import the route tree that
 * imports it. A mistyped one is a compile error; leaving it off keeps the untyped `Route`.
 *
 * **Annotate the const, not the parameter.** `({ route }: PageProps<…>) => …` puts the component's
 * *inferred* type on the path that resolves through `MobxRouter["routes"]` and closes the cycle —
 * the route tree imports the component, the component's type reads the route tree. It can compile
 * in isolation and collapse the whole tree to `any` (TS7022) once several components use it.
 */
export interface PageProps<P extends RoutePath | undefined = undefined> {
  route: [P] extends [undefined] ? Route : RouteAt<P & string>;
  level: RouteLevel;
}

/** The props every `[ERROR]` component receives. */
export interface ErrorProps {
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
export interface LoadingProps {
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

/**
 * The shape of `route.context`, for an app that wants one. Augment it the way you augment
 * `MobxRouter`:
 *
 * ```ts
 * declare module "@jayalfredprufrock/mobx-toolbox/router" {
 *   interface MobxRouterContext {
 *     public: boolean;
 *   }
 * }
 * ```
 *
 * This exists because a `[GUARD]` or `[LOAD]` **cannot** name a path-derived type. Both live inside
 * the object `makeRoutes()` is inferring, and `RouteAt<P>` derives from `MobxRouter["routes"]` —
 * that same object. Annotating one collapses the whole route tree to `any` (TS7022), the same
 * self-reference {@link RedirectTarget} documents.
 *
 * A standalone interface has no such dependency, so it reaches the one place the computed types
 * can't. The trade is that it describes the context of the app rather than of a path: it is the
 * union of what any level may contribute, so declare a key optional if only some branches set it.
 *
 * Components outside the route tree don't need this — `PageProps<"/path">` computes the exact
 * context in force at that path, which is strictly more precise.
 */
// biome-ignore lint/suspicious/noEmptyInterface: open for extension
export interface MobxRouterContext {}

/**
 * What `route.context` is typed as: the augmented shape if there is one, and the untyped `Obj` it
 * has always been if not — so an app that never augments is unaffected.
 */
export type RouteContext = keyof MobxRouterContext extends never ? Obj : MobxRouterContext;

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

/* Typed route props */
/********************************************************************************* */

/**
 * Whether the app has augmented `MobxRouter` with its route tree. Without it there is nothing to
 * resolve against, so the typed props degrade to the untyped ones rather than producing nonsense
 * out of `Routes`' index signature.
 */
type HasRoutes = MobxRouter extends { routes: any } ? true : false;

/**
 * Merge two loader payloads with the **deeper one winning**, which is what happens at runtime:
 * `route.data` is `Object.assign({}, ...outlets)`, so a key a child loader also returns overwrites
 * its ancestor's. An intersection would type such a key as `A & B`, which nothing ever holds.
 */
type MergeDeeper<A, B> = keyof A extends never
  ? B
  : keyof B extends never
    ? A
    : Omit<A, keyof B> & B;

type LoadData<N> = N extends { [LOAD]: (...args: any[]) => Promise<infer D> }
  ? D extends object
    ? D
    : {}
  : {};

type ContextData<N> = N extends { [CONTEXT]: infer C } ? (C extends object ? C : {}) : {};

/** Group keys (`_list`) contribute no path segment, so the walk passes through them. */
type GroupKeys<N> = Extract<keyof N, `_${string}`>;

/**
 * The definition key that spells path segment `S`. A `:param` segment is written `$param` as an
 * object key, or quoted as `":param"` — the second spelling is `S` itself, so it needs no branch.
 */
type SegmentKey<N, S extends string> = S extends keyof N
  ? S
  : S extends `:${infer Param}`
    ? `$${Param}` extends keyof N
      ? `$${Param}`
      : never
    : never;

/** `/org/:orgId/studies` → `["org", ":orgId", "studies"]`; `/` → `[]`. */
type Segments<P extends string> = P extends `/${infer Rest}`
  ? Segments<Rest>
  : P extends `${infer Head}/${infer Tail}`
    ? [Head, ...Segments<Tail>]
    : P extends ""
      ? []
      : [P];

/** An `index` key addresses its parent's path, so it is part of that path's chain. */
type IndexTail<N> = N extends { index: infer I } ? [I] : [];

/** Guards the spread: a failed branch is `never`, which must not be spread into a tuple. */
type Prepend<H, T> = T extends readonly unknown[] ? [H, ...T] : never;

/**
 * Every definition node passed through on the way to path `P`, in order — which is exactly the set
 * whose `[LOAD]` and `[CONTEXT]` are in force there.
 *
 * Branches that cannot consume the next segment resolve to `never` and drop out of the union, so a
 * well-formed tree leaves exactly one chain.
 */
type Chain<N, Segs extends readonly string[]> = Segs extends readonly [
  infer S extends string,
  ...infer Rest extends readonly string[],
]
  ? Prepend<N, Step<N, S, Rest>>
  : [N, ...IndexTail<N>];

type Step<N, S extends string, Rest extends readonly string[]> =
  | (SegmentKey<N, S> extends infer K ? (K extends keyof N ? Chain<N[K], Rest> : never) : never)
  // descending into a group consumes no segment, but does pick up its config
  | { [G in GroupKeys<N>]: Chain<N[G], [S, ...Rest]> }[GroupKeys<N>];

type FoldData<C> = C extends readonly [infer H, ...infer T]
  ? MergeDeeper<LoadData<H>, FoldData<T>>
  : {};

type FoldContext<C> = C extends readonly [infer H, ...infer T]
  ? MergeDeeper<ContextData<H>, FoldContext<T>>
  : {};

/**
 * What `route.data` holds at path `P`: every `[LOAD]` at that path and above it, merged, with the
 * deeper one winning.
 *
 * Ancestors are included because `route.data` is chain-wide at runtime. Descendants are not — which
 * of them matched is not knowable from `P`, so only what is *guaranteed* present is typed. That is
 * also why this is correct for a `[WRAPPER]`, which renders for many descendant paths.
 */
export type RouteDataAt<P extends string> = HasRoutes extends true
  ? FoldData<Chain<MobxRouterRoutes, Segments<P>>>
  : Obj;

/** What `route.context` holds at path `P` — every `[CONTEXT]` at or above it, deeper winning. */
export type RouteContextAt<P extends string> = HasRoutes extends true
  ? FoldContext<Chain<MobxRouterRoutes, Segments<P>>>
  : Obj;

/**
 * The definition node addressed by `P` — the same walk as {@link Chain}, but returning where it
 * lands rather than everything passed through, and without following `index`: what is wanted here
 * is the level itself, so its children are still reachable.
 */
type NodeAt<N, Segs extends readonly string[]> = Segs extends readonly [
  infer S extends string,
  ...infer Rest extends readonly string[],
]
  ?
      | (SegmentKey<N, S> extends infer K
          ? K extends keyof N
            ? NodeAt<N[K], Rest>
            : never
          : never)
      | { [G in GroupKeys<N>]: NodeAt<N[G], [S, ...Rest]> }[GroupKeys<N>]
  : N;

/**
 * Every `:param` name anywhere in the subtree below a node, in either key spelling.
 *
 * Components are skipped rather than recursed into: a function type's own keys (`call`, `apply`,
 * `prototype`) are not route segments, and walking them would be both wrong and unbounded.
 */
type ParamNamesIn<N> = N extends (...args: any[]) => any
  ? never
  : {
      [K in Extract<keyof N, string>]: K extends `$${infer Param}`
        ? Param | ParamNamesIn<N[K]>
        : K extends `:${infer Param}`
          ? Param | ParamNamesIn<N[K]>
          : ParamNamesIn<N[K]>;
    }[Extract<keyof N, string>];

/**
 * The `Route` a component at path `P` receives, with `params`, `data` and `context` resolved
 * against the route tree instead of left as `Obj`.
 */
export type RouteAt<P extends string> = Omit<Route, "params" | "data" | "context"> & {
  params: ExtractParams<P>;
  data: RouteDataAt<P>;
  context: RouteContextAt<P>;
};

/**
 * {@link RouteAt} for a level that renders over its descendants — a `[WRAPPER]` or `[LAYOUT]`.
 *
 * Identical except for `params`, which also carries every `:param` a descendant could contribute,
 * as optional. That is sound where the same treatment of `data` would not be: params are strings
 * and the set of them is knowable from the tree, so `string | undefined` is exactly true at this
 * level — whereas two sibling loaders can both define `data.thing` with different types, and no
 * merge of them describes what actually arrives.
 *
 * It is also what a wrapper needs in practice: a shell on `/org/:orgId/segments` that renders over
 * `:segmentId` and reads it to highlight a row would otherwise have to assert the type by hand.
 */
export type RouteAtPrefix<P extends string> = Omit<Route, "params" | "data" | "context"> & {
  params: ExtractParams<P> & {
    [K in Exclude<
      ParamNamesIn<NodeAt<MobxRouterRoutes, Segments<P>>>,
      keyof ExtractParams<P>
    >]?: string;
  };
  data: RouteDataAt<P>;
  context: RouteContextAt<P>;
};

/**
 * Every prefix of every route path, including the ones that address no page of their own.
 *
 * The leading empty segment is normalized here rather than excluded afterwards, so the root comes
 * out as `/` and the union needs no second pass.
 */
type PrefixesOf<P extends string> = P extends `${infer Head}/${infer Tail}`
  ? NormalizeRootPath<Head> | `${Head}/${PrefixesOf<Tail>}`
  : P;

/**
 * Where a `[WRAPPER]` or `[LAYOUT]` can sit: any *prefix* of a route path, not just the navigable
 * ones. A nesting level with no `index` addresses no page, so it never appears in `RoutePath` — but
 * it is exactly where wrappers live.
 */
export type RoutePrefix = string extends RoutePath ? string : PrefixesOf<RoutePath>;
