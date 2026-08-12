import { computed, makeObservable } from "mobx";
import { RouterError } from "./errors";
import type { LoadOptions, Outlet } from "./outlet";
import { Redirect } from "./redirect";
import type { Component, Guard, GuardEntry, MatchLevel, Obj } from "./types";

export interface RouteConfig {
  path: string;
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
