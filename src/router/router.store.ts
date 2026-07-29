import { createBrowserHistory, type History, type Location } from "history";
import { action, computed, makeObservable, observable, runInAction } from "mobx";
import { flushSync } from "react-dom";
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
  readonly viewTransitions: boolean;

  routesDef?: Routes;

  location!: Location;
  activeRoute: Route | undefined;

  /**
   * The route being matched, guarded and loaded. Set for the duration of
   * a navigation and cleared when it lands. `activeRoute` keeps rendering
   * the previous page while this is set, so navigation never blanks the
   * screen — see {@link isNavigating}.
   */
  pendingRoute: Route | undefined;

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

  /**
   * `true` from the moment a navigation starts until it lands. Covers the
   * guard phase too, so it's the honest answer to "is something in
   * flight" — but it flips for every navigation, however fast, so it will
   * flicker if you render an indicator straight off it. Use it for logic;
   * see {@link isLoading} for what to render from.
   */
  get isNavigating(): boolean {
    return this.pendingRoute !== undefined;
  }

  /**
   * `true` whenever a loading indicator is warranted *anywhere*: either a
   * pending navigation has passed `LOADING_DELAY_MS`, or a cold load's
   * `[LOADING]` component is on screen (including through the
   * minimum-duration hold). Debounced, so quick navigations never flip it.
   *
   * Use this for a layout progress bar that should stay visible alongside
   * a cold load's `[LOADING]` skeleton. For a bar that yields to the
   * skeleton instead, use {@link isSlowNavigation}.
   */
  get isLoading(): boolean {
    return this.pendingRoute?.isLoading ?? this.activeRoute?.isLoading ?? false;
  }

  /**
   * `true` when a navigation has been slow enough to be worth showing
   * *and* there is already a page on screen to show it over — the usual
   * signal for a layout-level progress bar.
   *
   * Excludes the cold load, where the pending route's `[LOADING]`
   * component is on screen instead, so a bar driven off this is mutually
   * exclusive with `[LOADING]`. Use {@link isLoading} if you want both at
   * once.
   */
  get isSlowNavigation(): boolean {
    return !!this.pendingRoute?.isLoading && this.activeRoute !== undefined;
  }

  constructor(config?: MobxRouterConfig) {
    makeObservable(this, {
      location: observable.ref,
      activeRoute: observable.ref,
      pendingRoute: observable.ref,

      search: computed,
      pathParams: computed,
      activeSegments: computed,
      isNavigating: computed,
      isLoading: computed,
      isSlowNavigation: computed,

      setLocation: action,
    });

    this.history = config?.history ?? createBrowserHistory();
    this.viewTransitions = config?.viewTransitions ?? true;
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
    // navigating to the current URL attaches no new information — skip
    // the navigation (and its view transition) entirely so redundant
    // navigations (e.g. clicking an already-active link) cause no churn
    if (!options.state && this.isCurrentLocation(options)) {
      return;
    }

    // the view transition is started around the route swap in
    // `applyRoute`, not here — see the note there
    this._navigate(options);
  }

  _navigate<P extends RoutePath>(options: NavigateOptions<P>): void {
    const location = this.resolveLocation(options);

    if (options.replace) {
      this.history.replace(location, options.state);
    } else {
      this.history.push(location, options.state);
    }
  }

  private resolveLocation<P extends RoutePath>(
    options: NavigateOptions<P>,
  ): { pathname: string; search: string | undefined } {
    const { to, search = {}, preserveSearch, params } = options;

    const searchParams = search instanceof URLSearchParams ? search : new URLSearchParams(search);

    if (preserveSearch) {
      for (const [name, value] of this.search) {
        if (!searchParams.has(name)) {
          searchParams.set(name, value);
        }
      }
    }

    return {
      pathname: resolvePath(to, params),
      search: searchParams.size ? `?${searchParams.toString()}` : undefined,
    };
  }

  private isCurrentLocation<P extends RoutePath>(options: NavigateOptions<P>): boolean {
    if (!this.location) return false;

    const target = this.resolveLocation(options);
    return (
      target.pathname === this.location.pathname && (target.search ?? "") === this.location.search
    );
  }

  setQueryParam(param: string, value: string): void {
    const params = new URLSearchParams(this.location.search);
    params.set(param, value);
    this.history.replace({ search: `?${params.toString()}` });
  }

  removeQueryParam(param: string): string | undefined {
    const params = new URLSearchParams(this.location.search);
    const value = params.get(param) ?? undefined;
    if (value !== undefined) {
      params.delete(param);
      this.history.replace({ search: params.size ? `?${params.toString()}` : "" });
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

    // a same-pathname change (query params, history state) can't affect
    // which route matches, its guards, or its loaders (none of which can
    // observe search params) — update the observable location without
    // rebuilding the route, so query-param changes don't refetch loaders
    // or replace activeRoute. Also guards against restarting a match for
    // a pathname that a still-pending navigation is already resolving.
    if ((this.activeRoute || this.pendingRoute) && this.location?.pathname === location.pathname) {
      this.location = location;
      return;
    }

    this.location = location;

    // a cold load has no previous page to preserve, so the pending route
    // renders and its [LOADING] components are on screen — the only case
    // where holding a just-shown indicator is worth delaying content for
    const cold = !this.activeRoute;

    let matchedRoute: Route | undefined;
    try {
      matchedRoute = matchRoute(location.pathname, this.routesDef);

      await matchedRoute.guard();

      // navigating within a guard function
      // is essentially a redirect
      if (this.isStale(location)) {
        return;
      }

      runInAction(() => {
        this.pendingRoute = matchedRoute;
      });

      await matchedRoute.load({ hold: cold });

      // another navigation started while this one was loading — it owns
      // the swap now, and its own pendingRoute assignment has replaced ours
      if (this.isStale(location)) {
        return;
      }

      await this.applyRoute(() => {
        this.activeRoute = matchedRoute;
        this.pendingRoute = undefined;
      });
    } catch (e) {
      if (e instanceof Redirect) {
        this.navigate(e.options);
        return;
      }

      // navigating within a guard before it threw — treat as a redirect
      if (this.isStale(location)) {
        return;
      }

      const error =
        e instanceof RouterError
          ? e
          : new RouterError("RENDER", { cause: e, path: location.pathname });
      console.error(error);

      const errorRoute = makeErrorRoute(error, location.pathname, matchedRoute);
      await this.applyRoute(() => {
        this.activeRoute = errorRoute;
        this.pendingRoute = undefined;
      });
      await errorRoute.load();
    }
  }

  /**
   * Whether another navigation has taken over since this one started.
   * Compared by pathname rather than `Location` identity: a query-param or
   * history-state change during a pending navigation replaces `location`
   * without re-matching, and must not cancel the navigation in flight.
   */
  private isStale(location: Location): boolean {
    return this.location?.pathname !== location.pathname;
  }

  /**
   * Commits a route swap, wrapped in a view transition where supported.
   *
   * The transition wraps **only** the swap. Wrapping the navigation as a
   * whole would freeze the page on its old snapshot for the entire guard
   * and load phase — a fetch's worth of unresponsive UI, with the loading
   * indicator unable to animate.
   *
   * `flushSync` removes a race rather than fixing an outright bug. The
   * browser captures the new snapshot at the first rendering opportunity
   * after the update callback settles; a bare MobX mutation schedules the
   * re-render on React's scheduler, which in practice usually lands
   * inside that window but is not guaranteed to (concurrent rendering may
   * yield). Flushing synchronously inside the callback makes the captured
   * frame deterministic.
   *
   * What the earlier implementation got wrong was placement, not
   * flushing: it wrapped `history.push`, so the callback returned before
   * guards had even run and both snapshots caught the same page. Verified
   * against real Chrome — that version animated exactly one frame.
   */
  private async applyRoute(swap: () => void): Promise<void> {
    const apply = () => runInAction(swap);
    const startViewTransition =
      typeof document !== "undefined" ? document.startViewTransition?.bind(document) : undefined;

    // A cold load has no previous page to animate away from, and its
    // visible change happens when outlets resolve rather than at the swap.
    if (!this.viewTransitions || !startViewTransition || !this.activeRoute) {
      apply();
      return;
    }

    const transition = startViewTransition(() => {
      flushSync(apply);
    });

    // `ready` rejects whenever the browser skips the animation — a second
    // navigation interrupting this one, a backgrounded tab, duplicate
    // view-transition-names. Routine, and the DOM update still happens.
    transition.ready.catch(() => {});

    // Awaited so the swap has landed before the navigation resolves.
    // Deliberately not `finished`: that waits out the animation, which
    // would make every navigation report as long as its transition.
    await transition.updateCallbackDone.catch(() => {});
  }
}
