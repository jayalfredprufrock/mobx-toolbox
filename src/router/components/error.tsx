import React from "react";
import { RouterError } from "../errors";
import type { Route } from "../route";
import type { Component, ErrorComponentProps } from "../types";

/**
 * Rendered when an error occurs and no `[ERROR]` component is defined
 * on the matched prefix. Deliberately minimal and dependency-free —
 * define a root-level `[ERROR]` to replace it.
 */
export const DefaultErrorPage: Component = ({ error }: ErrorComponentProps) => (
  <div role="alert">
    <h1>{error.type === "NOT_FOUND" ? "Page Not Found" : "Something Went Wrong"}</h1>
    <p>{error.message}</p>
  </div>
);

export interface RouteErrorBoundaryProps {
  route: Route;
  fallback: Component;
  children?: React.ReactNode;
}

interface RouteErrorBoundaryState {
  error?: RouterError;
  route?: Route;
}

/**
 * Catches render-time crashes in page and `[WRAPPER]` components and
 * renders the nearest `[ERROR]` component with `type: "RENDER"`. Mounted
 * inside the `[LAYOUT]` so the layout survives page crashes; crashes in
 * the layout itself (or in the fallback) propagate out of `<Router>` by
 * design — those are developer bugs that should stay loud.
 *
 * Deliberately NOT keyed by location: the boundary must be transparent
 * to reconciliation (a key would remount the entire subtree and re-fire
 * every effect on each navigation). Instead, a captured error is cleared
 * when a new Route object arrives.
 */
export class RouteErrorBoundary extends React.Component<
  RouteErrorBoundaryProps,
  RouteErrorBoundaryState
> {
  override state: RouteErrorBoundaryState = {};

  static getDerivedStateFromError(cause: unknown): RouteErrorBoundaryState {
    return { error: cause instanceof RouterError ? cause : new RouterError("RENDER", { cause }) };
  }

  static getDerivedStateFromProps(
    props: RouteErrorBoundaryProps,
    state: RouteErrorBoundaryState,
  ): Partial<RouteErrorBoundaryState> | null {
    if (state.route === props.route) return null;
    // a new Route object means a navigation occurred — clear any
    // captured error so the boundary doesn't keep a stale fallback
    return { route: props.route, error: undefined };
  }

  override render(): React.ReactNode {
    if (!this.state.error) return this.props.children;

    const Fallback = this.props.fallback;
    return <Fallback route={this.props.route} error={this.state.error} />;
  }
}
