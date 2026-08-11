import { PAGE, REDIRECT } from "./symbols";
import type { Component, LazyComponent, Leaf, Obj, Page, Redirector } from "./types";

/**
 * Substitute a path pattern's `:params`. Throws when one has no value —
 * the right default for `navigate()` and `href`, where an unresolved path
 * is a bug rather than a state to render.
 *
 * Use {@link tryResolvePath} for a path you did not construct — resolving a
 * `level.pattern` against params that may not reach that deep, say.
 */
export const resolvePath = (to: string, params?: Obj): string => {
  return to.replaceAll(/:[^/]*/g, (segment) => {
    const value = params?.[segment.slice(1)];
    if (!value)
      throw new Error(`Unable to resolve route '${to}'. Parameter '${segment}' not specified.`);
    return value;
  });
};

/**
 * {@link resolvePath} without the throw: `undefined` when any `:param` has
 * no value. The idiom for "link it if we can address it, otherwise render
 * it as plain text".
 */
export const tryResolvePath = (to: string, params?: Obj): string | undefined => {
  let resolved = true;
  const path = to.replaceAll(/:[^/]*/g, (segment) => {
    const value = params?.[segment.slice(1)];
    if (!value) {
      resolved = false;
      return segment;
    }
    return value;
  });
  return resolved ? path : undefined;
};

export const isComponent = (data: any): data is Component => {
  if (!data) return false;
  return (
    typeof data === "function" ||
    (typeof data === "object" && data["$$typeof"] === Symbol.for("react.memo"))
  );
};

export const isPage = (data: any): data is Page => {
  if (typeof data !== "object") return false;
  const symbols = Object.getOwnPropertySymbols(data);
  return symbols.includes(PAGE);
};

export const isRedirect = (data: any): data is Redirector => {
  if (typeof data !== "object") return false;
  const symbols = Object.getOwnPropertySymbols(data);
  return symbols.includes(REDIRECT);
};

export const isLeaf = (data: any): data is Leaf => {
  return isComponent(data) || isPage(data) || isRedirect(data);
};

export const isLazyComponent = (data: any): data is LazyComponent => {
  return typeof data === "function" && data.toString().startsWith("() => import(");
};
