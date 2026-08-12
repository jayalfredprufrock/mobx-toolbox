import { computed, makeObservable } from "mobx";
import { RouterError } from "./errors";
import type { LoadOptions, Outlet } from "./outlet";
import { Redirect } from "./redirect";
import type { Component, Guard, GuardEntry, MatchLevel, Obj, RoutePath } from "./types";

export interface RouteConfig {
  path: string;
  pattern?: RoutePath;
  outlets: Outlet[];
  guards: GuardEntry[];
  levels: MatchLevel[];
  context?: Obj;
  layout?: Component;
  params: Obj;
  error?: RouterError;
}

export class Route {
  readonly path: string;
  /**
   * This route's pattern, e.g. `/org/:orgId/surveys` — `path` with its
   * dynamic segments left unsubstituted. Ready to hand to `to=` or
   * `router.navigate()` alongside `params`.
   *
   * Comparing patterns is how you ask "which route is this" without
   * interpolating params into a path and matching strings. `RouteLevel.pattern`
   * is the same idea per level; this is the whole route's.
   *
   * `undefined` only on a synthetic error route, which by definition has no
   * matched pattern — nothing matched, or matching is what failed.
   */
  readonly pattern?: RoutePath;
  readonly outlets: Outlet[];
  readonly guards: Guard[];
  readonly context: Obj;
  readonly params: Obj;
  readonly layout?: Component;
  /** set on synthetic error routes; the error being rendered */
  readonly error?: RouterError;
  /** @internal */
  readonly guardEntries: GuardEntry[];
  /** @internal */
  readonly levels: MatchLevel[];

  get data(): Obj {
    return Object.assign({}, ...this.outlets.map((o) => o.data));
  }

  /**
   * `true` once a pending outlet has crossed the debounce threshold and
   * its `[LOADING]` component is on screen. This is the signal to drive
   * layout-level indicators (a top progress bar, a dimmed shell) — it
   * stays `false` through the quiet window, so navigations that resolve
   * quickly never flash an indicator.
   */
  get isLoading(): boolean {
    return this.outlets.some((o) => o.state === "loading");
  }

  /**
   * `true` whenever any outlet is still resolving, including the quiet
   * window before `isLoading` flips. Use this to reason about whether
   * navigation has settled (tests, effects) — not to render indicators.
   */
  get isPending(): boolean {
    return this.outlets.some((o) => o.state === "preloading" || o.state === "loading");
  }

  constructor(def: RouteConfig) {
    this.path = def.path;
    this.pattern = def.pattern;
    this.guardEntries = def.guards;
    this.guards = def.guards.map((entry) => entry.guard);
    this.levels = def.levels;
    this.context = def.context ?? {};
    this.outlets = def.outlets;
    this.params = def.params;
    this.layout = def.layout;
    this.error = def.error;

    makeObservable(this, {
      data: computed,
      isLoading: computed,
      isPending: computed,
    });
  }

  async guard(): Promise<void> {
    for (const { guard, depth } of this.guardEntries) {
      try {
        await guard(this);
      } catch (e) {
        // depth rides along so a redirect that later fails to resolve
        // bubbles to the same [ERROR] this guard's own failure would have
        if (e instanceof Redirect) {
          e.depth ??= depth;
          throw e;
        }
        const error = e instanceof RouterError ? e : new RouterError("GUARD", { cause: e });
        error.depth ??= depth;
        throw error;
      }
    }
  }

  async load(options?: LoadOptions): Promise<void> {
    await Promise.all(this.outlets.map((outlet) => outlet.load(this, options)));
  }
}
