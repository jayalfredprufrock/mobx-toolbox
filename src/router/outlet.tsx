import { makeAutoObservable, observable } from "mobx";
import { DefaultErrorPage } from "./components/error";
import { RouterError } from "./errors";
import { Redirect } from "./redirect";
import type { Route } from "./route";
import type { Component, LazyComponent, Loader, Obj } from "./types";
import { isLazyComponent } from "./util";

export interface OutletConfig {
  component?: Component | LazyComponent;
  loader?: Loader;
  errorComponent?: Component;
  loadingComponent?: Component;
}

export type RouteSegmentState = "preloading" | "loading" | "error" | "ready";

export interface LoadOptions {
  /**
   * Hold the `[LOADING]` component on screen for
   * `LOADING_MIN_DURATION_MS` after the data arrives, so a just-shown
   * indicator can't vanish a frame later. Only worth paying for when the
   * indicator is actually rendered — i.e. a cold load. During a warm
   * navigation the previous page is still on screen and the pending
   * route's outlets aren't rendered at all, so holding would delay
   * content to hide an indicator nobody saw.
   */
  hold?: boolean;
}

/**
 * How long an outlet stays `"preloading"` — rendering nothing — before
 * it shows its `[LOADING]` component. Loads that finish inside this
 * window never render an indicator at all.
 */
export const LOADING_DELAY_MS = 300;

/**
 * Once the `[LOADING]` component is on screen, how long it is held there
 * even if the data has already arrived. Only applies to loads that
 * already exceeded `LOADING_DELAY_MS`, and exists solely to keep a
 * just-shown indicator from vanishing a frame later.
 */
export const LOADING_MIN_DURATION_MS = 300;

export const DefaultOutlet: Component = ({ children }) => children;

/**
 * Rendered in a pending outlet's slot when no `[LOADING]` component is
 * defined at or above that level. Deliberately minimal — define a
 * root-level `[LOADING]` to replace it.
 */
export const DefaultLoadingPage: Component = () => <p>Loading...</p>;

export class Outlet {
  state: RouteSegmentState = "preloading";
  promise: Promise<unknown> | undefined;
  data: unknown;
  error: RouterError | undefined;

  // Plain (non-observable) reference. The page component must reach
  // React unmediated by MobX — once MobX deep-observes the holder,
  // React Refresh can no longer swap the page identity via family
  // lookup on the original function. This mirrors how Route holds
  // `layout` as a plain field under makeObservable.
  component: Component | undefined;

  // The pending and failed slots render without `children` on purpose:
  // outlets in a chain resolve in parallel, so a descendant can already
  // be "ready" while this slot waits or fails. Forwarding children would
  // paint that descendant with incomplete (or missing) `route.data`.
  get Component(): Component | undefined {
    switch (this.state) {
      case "loading": {
        // render the nearest [LOADING] component in this outlet's slot
        const LoadingComponent = this.config.loadingComponent ?? DefaultLoadingPage;
        return ({ route }: Obj) => <LoadingComponent route={route} />;
      }
      case "ready":
        return this.component ?? DefaultOutlet;
      case "error": {
        // render the nearest [ERROR] component in this outlet's slot,
        // leaving the rest of the page intact
        const ErrorComponent = this.config.errorComponent ?? DefaultErrorPage;
        const error = this.error ?? new RouterError("LOAD");
        return ({ route }: Obj) => <ErrorComponent route={route} error={error} />;
      }
      default:
        return undefined;
    }
  }

  constructor(readonly config: OutletConfig) {
    if (!isLazyComponent(config.component)) {
      this.component = config.component;
    }

    makeAutoObservable<Outlet, "component" | "config">(this, {
      promise: observable.ref,
      data: observable.ref,
      error: observable.ref,
      component: false,
      config: false,
    });
  }

  async load(route: Route, options?: LoadOptions): Promise<void> {
    const promises: Promise<void>[] = [];

    if (isLazyComponent(this.config.component) && !this.component) {
      promises.push(this.loadComponent());
    }

    if (this.config.loader) {
      promises.push(this.loadData(route));
    }

    if (!promises.length) {
      this.setState("ready");
      return;
    }

    // wait to transition to loading to avoid
    // screen flashes when the loader function
    // executes quickly
    const preloadingTimer = setTimeout(() => {
      if (this.state === "preloading") {
        this.setState("loading");
      }
    }, LOADING_DELAY_MS);

    this.promise = Promise.all(promises)
      .then(() => {
        clearTimeout(preloadingTimer);
        if (options?.hold && this.state === "loading") {
          // the [LOADING] component is on screen and the loader was slow
          // enough to have shown it — keep it there briefly so it doesn't
          // flash out the moment the data lands
          setTimeout(() => {
            this.setState("ready");
          }, LOADING_MIN_DURATION_MS);
        } else {
          this.setState("ready");
        }
      })
      .catch((e) => {
        clearTimeout(preloadingTimer);
        this.setState("error");
        // a Redirect thrown by a loader propagates so the router
        // navigates; everything else renders in-slot error UI
        if (e instanceof Redirect) throw e;
        this.setError(e instanceof RouterError ? e : new RouterError("LOAD", { cause: e }));
      });

    await this.promise;
  }

  setData(data: unknown) {
    this.data = data;
  }

  setError(error: RouterError) {
    this.error = error;
  }

  setState(state: RouteSegmentState) {
    this.state = state;
  }

  private async loadData(route: Route): Promise<void> {
    await this.config.loader?.(route).then((data) => this.setData(data));
  }

  private async loadComponent(): Promise<void> {
    if (!isLazyComponent(this.config.component)) return;
    const module = await this.config.component();
    for (const exportName in module) {
      if (exportName === "default" || exportName.endsWith("Page")) {
        this.component = module[exportName];
        return;
      }
    }
    throw new Error(
      "Lazy route component module did not export `default` or a `*Page` named export",
    );
  }
}
