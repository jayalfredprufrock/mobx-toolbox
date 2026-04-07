import { computed } from "mobx";
import type { Outlet } from "./outlet";
import type { Component, Guard, Obj } from "./types";

export interface RouteConfig {
  path: string;
  outlets: Outlet[];
  guards: Guard[];
  context?: Obj;
  layout?: Component;
  params: Obj;
}

export class Route {
  readonly path: string;
  readonly outlets: Outlet[];
  readonly guards: Guard[];
  readonly context: Obj;
  readonly params: Obj;

  @computed get data(): Obj {
    return Object.assign({}, ...this.outlets.map((o) => o.data));
  }

  constructor(def: RouteConfig) {
    this.path = def.path;
    this.guards = def.guards;
    this.context = def.context ?? {};
    this.outlets = def.outlets;
    this.params = def.params;
  }

  async guard(): Promise<void> {
    for (const guard of this.guards) {
      await guard(this);
    }
  }

  async load(): Promise<void> {
    await Promise.all(this.outlets.map((outlet) => outlet.load(this)));
  }
}
