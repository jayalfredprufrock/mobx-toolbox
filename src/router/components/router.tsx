import { observer } from "mobx-react-lite";
import { createContext, useContext } from "react";
import type { Route } from "../route";
import type { RouterStore } from "../router.store";
import { SPLASH } from "../symbols";
import type { Component, RouteLevel } from "../types";
import { DefaultErrorPage, RouteErrorBoundary } from "./error";

export const PassThrough: Component = ({ children }) => children;

/** One rendered slot in the outlet chain: what fills it, and where it sits. */
export interface OutletSlot {
  Component: Component | undefined;
  level: RouteLevel | undefined;
}

// Plain (non-observer) renderer. State observation lives one level up
// in `Router`, so the page component renders as a child of a plain
// FunctionComponent — no memo wrapper in the parent chain to interact
// with React Refresh's family-update propagation.
export const RouterOutlet: React.FC<{ route: Route; slots: OutletSlot[] }> = ({ route, slots }) => {
  const [slot, ...remaining] = slots;
  const C = slot?.Component;

  if (!C) return null;

  return (
    <C route={route} level={slot.level}>
      {remaining.length > 0 && <RouterOutlet route={route} slots={remaining} />}
    </C>
  );
};

export const routerContext = createContext<RouterStore>(null as any);
export const useRouter = () => useContext(routerContext);

export interface RouterProps {
  store: RouterStore;
}

export const Router = observer(({ store }: RouterProps) => {
  // On a warm navigation `activeRoute` holds the previous page on screen
  // until the pending one has loaded. On a cold load there is nothing to
  // preserve, so the pending route renders instead and its outlets surface
  // their [LOADING] components while they resolve.
  const route = store.activeRoute ?? store.pendingRoute;
  if (!route) {
    // Nothing has matched yet — the first navigation is still matching or
    // running its guards. No route means no layout and no outlets, so
    // [SPLASH] is the only thing that can be shown here.
    const Splash = store.routesDef?.[SPLASH];
    return Splash ? <Splash /> : null;
  }

  const Layout = route.layout ?? PassThrough;
  // `Component` is a computed and must be read here, inside the observer
  const slots = route.outlets.map((o) => ({ Component: o.Component, level: o.level }));
  const outlet = <RouterOutlet route={route} slots={slots} />;

  // Render crashes in pages/wrappers funnel to the nearest [ERROR]
  // component; the layout survives. On synthetic error routes the
  // boundary is omitted so a crashing [ERROR] component propagates
  // out of <Router> — a developer bug that should stay loud. Layout
  // crashes propagate for the same reason. The boundary is unkeyed on
  // purpose — it resets itself when the route changes — so navigation
  // reconciles by component type instead of remounting the subtree.
  const fallback = route.levels.at(-1)?.errorComponent ?? DefaultErrorPage;

  return (
    <routerContext.Provider value={store}>
      <Layout route={route}>
        {route.error ? (
          outlet
        ) : (
          <RouteErrorBoundary route={route} fallback={fallback}>
            {outlet}
          </RouteErrorBoundary>
        )}
      </Layout>
    </routerContext.Provider>
  );
});
