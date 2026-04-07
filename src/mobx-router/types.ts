import type { History } from "history";
import type { Route } from "./route";
import { CONTEXT, GUARD, LAYOUT, LOAD, PAGE, REDIRECT, WRAPPER } from "./symbols";

export type Component = React.FC<any>;
export type LazyComponent = () => Promise<any>;
export type Obj<T = any> = Record<string, T>;
export type Loader = (route: Route) => Promise<any>;
export type Guard = (route: Route) => Promise<void>;

export interface RouteConfig {
  [CONTEXT]?: Obj;
  [LAYOUT]?: Component;
  [WRAPPER]?: Component;
  [GUARD]?: Guard;
  [LOAD]?: Loader;
}

export interface Page extends Omit<RouteConfig, typeof WRAPPER> {
  [PAGE]: Component | LazyComponent;
}

export interface Redirector {
  [REDIRECT]: string | NavigateOptions;
}

export type Leaf = Page | Redirector | Component | LazyComponent;

export interface Routes extends RouteConfig {
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
}

export type RoutePath =
  ExtractPaths<MobxRouterRoutes> extends undefined ? string : ExtractPaths<MobxRouterRoutes>;

export type DynamicRoutePath = Extract<RoutePath, `${string}:${string}`>;
export type StaticRoutePath = Exclude<RoutePath, `${string}:${string}`>;

/* Generic Utilities */
/********************************************************************************* */

export type JoinSegments<S1, S2> = `/${S1 extends string ? S1 : ""}${S2 extends string ? S2 : ""}`;

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
        ? `/${S}`
        : JoinSegments<S, ExtractPaths<R[S]>>
    : never;
}[keyof R];
