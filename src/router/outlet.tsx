import { makeAutoObservable, observable, runInAction } from "mobx";
import type { Route } from "./route";
import type { Component, LazyComponent, Loader } from "./types";
import { isLazyComponent } from "./util";

export interface OutletConfig {
  component?: Component | LazyComponent;
  loader?: Loader;
}

export type RouteSegmentState = "preloading" | "loading" | "error" | "ready";

export const DefaultOutlet: Component = ({ children }) => children;

export class Outlet {
  state: RouteSegmentState = "preloading";
  promise: Promise<unknown> | undefined;
  data: unknown;
  component: Component | undefined;

  get Component(): Component | undefined {
    switch (this.state) {
      case "loading":
        return function Loading() {
          return <p>Loading...</p>;
        };

      case "ready":
        return this.component ?? DefaultOutlet;

      default:
        return undefined;
    }
  }

  constructor(readonly config: OutletConfig) {
    if (config.component && !isLazyComponent(config.component) && !config.loader) {
      this.state = "ready";
      this.component = config.component;
    }

    makeAutoObservable(this, {
      promise: observable.ref,
      data: observable.ref,
      component: observable.ref,
    });
  }

  async load(route: Route): Promise<void> {
    const promises: Promise<void>[] = [];

    if (isLazyComponent(this.config.component)) {
      promises.push(this.loadComponent());
    } else {
      this.component = this.config.component;
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

  private async loadComponent(): Promise<void> {
    if (this.component || !this.config.component) {
      return;
    }

    if (isLazyComponent(this.config.component)) {
      const importResult = await this.config.component();
      runInAction(() => {
        for (const exportName in importResult) {
          if (exportName === "default" || exportName.endsWith("Page")) {
            this.component = importResult[exportName];
          }
        }
      });
    } else {
      this.component = this.config.component;
    }
  }
}
