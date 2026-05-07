import { PAGE, REDIRECT } from "./symbols";
import type { Component, LazyComponent, Leaf, Obj, Page, Redirector } from "./types";

export const resolvePath = (to: string, params?: Obj): string => {
  return to.replaceAll(/:[^/]*/g, (segment) => {
    const value = params?.[segment.slice(0)];
    if (!value)
      throw new Error(`Unable to resolve route '${to}. Paramater '${segment}' not specified.`);
    return value;
  });
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
