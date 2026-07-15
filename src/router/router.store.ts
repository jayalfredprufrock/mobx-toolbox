import { createBrowserHistory, type History, type Location } from "history";
import { action, computed, makeObservable, observable, runInAction } from "mobx";
import { RouterError } from "./errors";
import { makeErrorRoute, matchRoute } from "./make-routes";
import { Redirect } from "./redirect";
import type { Route } from "./route";
import type { Component, MobxRouterConfig, NavigateOptions, Obj, RoutePath, Routes } from "./types";
import { resolvePath } from "./util";

export interface MobxRenderSegment {
  segment: string;
  component: Component;
  props?: Obj;
}

export class RouterStore {
  readonly history: History;

  routesDef?: Routes;

  location!: Location;
  activeRoute: Route | undefined;

  get search(): URLSearchParams {
    return new URLSearchParams(this.location?.search);
  }

  get query(): Record<string, string> {
    return Object.fromEntries(this.search);
  }

  get pathParams(): Record<string, string> {
    return { ...this.activeRoute?.params };
  }

  get activeSegments(): string[] {
    return this.activeRoute?.path.split("/") ?? [];
  }

  constructor(config?: MobxRouterConfig) {
    makeObservable(this, {
      location: observable.ref,
      activeRoute: observable.ref,

      search: computed,
      pathParams: computed,
      activeSegments: computed,

      setLocation: action,
    });

    this.history = config?.history ?? createBrowserHistory();
  }

  initialize(routesDef: Routes): void {
    this.routesDef = routesDef;
    this.history.listen((data) => {
      void this.setLocation(data.location);
    });

    void this.setLocation(this.history.location);
  }

  doesPathMatch<P extends RoutePath>(path: P, exact?: boolean): boolean {
    const segments = path.slice(1).split("/");
    const segmentsMatch = segments.every(
      (segment, i) => segment === this.activeSegments[i] || segment.startsWith(":"),
    );

    return (
      segmentsMatch &&
      this.activeSegments.length >= segments.length &&
      (!exact || segments.length === this.activeSegments.length)
    );
  }

  navigate<P extends RoutePath>(options: NavigateOptions<P>): void {
    if (!document.startViewTransition) {
      this._navigate(options);
    } else {
      const transition = document.startViewTransition(() => this._navigate(options));
      transition.ready.catch((e) => console.log(e, typeof e));
    }
  }

  _navigate<P extends RoutePath>(options: NavigateOptions<P>): void {
    const { to, replace, state, search = {}, preserveSearch, params } = options;

    const searchParams = search instanceof URLSearchParams ? search : new URLSearchParams(search);

    if (preserveSearch) {
      for (const [name, value] of this.search) {
        if (!searchParams.has(name)) {
          searchParams.set(name, value);
        }
      }
    }

    const location = {
      pathname: resolvePath(to, params),
      search: searchParams.size ? `?${searchParams.toString()}` : undefined,
    };

    if (replace) {
      this.history.replace(location, state);
    } else {
      this.history.push(location, state);
    }
  }

  setQueryParam(param: string, value: string): void {
    const params = new URLSearchParams(this.location.search);
    params.set(param, value);
    this.history.replace({ search: params.toString() });
  }

  removeQueryParam(param: string): string | undefined {
    const params = new URLSearchParams(this.location.search);
    const value = params.get(param) ?? undefined;
    if (value !== undefined) {
      params.delete(param);
      this.history.replace({ search: params.toString() });
    }
    return value;
  }

  async setLocation(location: Location): Promise<void> {
    if (!this.routesDef) return;

    // TODO: this should not be the responsibility of mobx-router
    // and should really be handled server-side
    if (location.pathname !== "/" && location.pathname.endsWith("/")) {
      this.history.replace({ ...location, pathname: location.pathname.slice(0, -1) });
      return;
    }

    this.location = location;

    let matchedRoute: Route | undefined;
    try {
      matchedRoute = matchRoute(location.pathname, this.routesDef);

      await matchedRoute.guard();

      // navigating within a guard function
      // is essentially a redirect
      if (this.location !== location) {
        return;
      }

      runInAction(() => {
        this.activeRoute = matchedRoute;
      });

      await this.activeRoute?.load();
    } catch (e) {
      if (e instanceof Redirect) {
        this.navigate(e.options);
        return;
      }

      // navigating within a guard before it threw — treat as a redirect
      if (this.location !== location) {
        return;
      }

      const error =
        e instanceof RouterError
          ? e
          : new RouterError("RENDER", { cause: e, path: location.pathname });
      console.error(error);

      const errorRoute = makeErrorRoute(error, location.pathname, matchedRoute);
      runInAction(() => {
        this.activeRoute = errorRoute;
      });
      await errorRoute.load();
    }
  }
}
