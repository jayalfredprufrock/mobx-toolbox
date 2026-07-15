import { computed, makeObservable } from "mobx";
import { RouterError } from "./errors";
import type { Outlet } from "./outlet";
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
    });
  }

  async guard(): Promise<void> {
    for (const { guard, depth } of this.guardEntries) {
      try {
        await guard(this);
      } catch (e) {
        if (e instanceof Redirect) throw e;
        const error = e instanceof RouterError ? e : new RouterError("GUARD", { cause: e });
        error.depth ??= depth;
        throw error;
      }
    }
  }

  async load(): Promise<void> {
    await Promise.all(this.outlets.map((outlet) => outlet.load(this)));
  }
}
