import { createBrowserHistory, type History, type Location } from "history";
import { makeAutoObservable, runInAction } from "mobx";
import { matchRoute } from "./make-routes";
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
    const params = {} as Record<string, string>;

    const paramSegments = this.activeSegments.filter((segment) => segment.startsWith("$"));
    const pathValues = this.location.pathname.split("/").slice(1);

    paramSegments.forEach((segment, index) => {
      const value = pathValues[index + 1];
      if (value) {
        params[segment] = value;
      }
    });

    return params as Record<string, string>;
  }

  get activeSegments(): string[] {
    return this.activeRoute?.path.split("/") ?? [];
  }

  constructor(config?: MobxRouterConfig) {
    makeAutoObservable({
      history: false,
      routesDef: false,
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
      (segment, i) => segment === this.activeSegments[i] || segment.startsWith("$"),
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
    this.search.set(param, value);
    this.history.replace({ search: this.search.toString() });
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

    try {
      const matchedRoute = matchRoute(location.pathname, this.routesDef);

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
      throw e;
    }
  }
}
