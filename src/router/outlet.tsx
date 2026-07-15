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
}

export type RouteSegmentState = "preloading" | "loading" | "error" | "ready";

export const DefaultOutlet: Component = ({ children }) => children;

const LoadingPlaceholder: Component = () => <p>Loading...</p>;

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

  get Component(): Component | undefined {
    switch (this.state) {
      case "loading":
        return LoadingPlaceholder;
      case "ready":
        return this.component ?? DefaultOutlet;
      case "error": {
        // render the nearest [ERROR] component in this outlet's slot,
        // leaving the rest of the page intact
        const ErrorComponent = this.config.errorComponent ?? DefaultErrorPage;
        const error = this.error ?? new RouterError("LOAD");
        return (props: Obj) => <ErrorComponent {...props} error={error} />;
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

  async load(route: Route): Promise<void> {
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
    }, 300);

    this.promise = Promise.all(promises)
      .then(() => {
        clearTimeout(preloadingTimer);
        if (this.state === "loading") {
          // if we had to transition to regular loading because
          // the loader was taking too long, force an additional
          // timeout to prevent a loading flash
          setTimeout(() => {
            this.setState("ready");
          }, 300);
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
