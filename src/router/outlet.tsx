import { makeAutoObservable, observable } from "mobx";
import { lazy, type LazyExoticComponent } from "react";
import type { Route } from "./route";
import type { Component, LazyComponent, Loader } from "./types";
import { isLazyComponent } from "./util";

export interface OutletConfig {
  component?: Component | LazyComponent;
  loader?: Loader;
}

export type RouteSegmentState = "preloading" | "loading" | "error" | "ready";

export const DefaultOutlet: Component = ({ children }) => children;

const LoadingPlaceholder: Component = () => <p>Loading...</p>;

export class Outlet {
  state: RouteSegmentState = "preloading";
  promise: Promise<unknown> | undefined;
  data: unknown;

  // React.lazy wrapper for lazy page modules. Holding the resolved
  // component reference inside React (rather than as a captured value
  // on the Outlet) is what lets React Refresh swap the implementation
  // in place when a page module is edited — Fast Refresh walks React
  // fibers, not MobX state.
  private readonly lazyComponent?: LazyExoticComponent<Component>;

  get Component(): Component | undefined {
    switch (this.state) {
      case "loading":
        return LoadingPlaceholder;

      case "ready":
        if (this.lazyComponent) return this.lazyComponent;
        return (this.config.component as Component | undefined) ?? DefaultOutlet;

      default:
        return undefined;
    }
  }

  constructor(readonly config: OutletConfig) {
    if (isLazyComponent(config.component)) {
      const importer = config.component;
      this.lazyComponent = lazy(async () => {
        const importResult = await importer();
        for (const exportName in importResult) {
          if (exportName === "default" || exportName.endsWith("Page")) {
            return { default: importResult[exportName] as Component };
          }
        }
        throw new Error(
          "Lazy route component module did not export `default` or a `*Page` named export",
        );
      });
    }

    makeAutoObservable<Outlet, "lazyComponent">(this, {
      promise: observable.ref,
      data: observable.ref,
      lazyComponent: false,
    });
  }

  async load(route: Route): Promise<void> {
    const promises: Promise<void>[] = [];

    if (isLazyComponent(this.config.component)) {
      // pre-warm the dynamic import so the module is in the bundler's
      // cache by the time React.lazy resolves it — avoids a Suspense
      // fallback flash on navigation
      promises.push(this.config.component().then(() => undefined));
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
      .catch(() => {
        clearTimeout(preloadingTimer);
        // TODO: check for type of error
        // handle access denied and redirects
        this.setState("error");
      });

    await this.promise;
  }

  setData(data: unknown) {
    this.data = data;
  }

  setState(state: RouteSegmentState) {
    this.state = state;
  }

  private async loadData(route: Route): Promise<void> {
    await this.config.loader?.(route).then((data) => this.setData(data));
  }
}
