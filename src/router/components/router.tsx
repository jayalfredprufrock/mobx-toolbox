import { observer } from "mobx-react-lite";
import { createContext, useContext } from "react";
import type { Route } from "../route";
import type { RouterStore } from "../router.store";
import type { Component } from "../types";
import { DefaultErrorPage, RouteErrorBoundary } from "./error";

export const PassThrough: Component = ({ children }) => children;

// Plain (non-observer) renderer. State observation lives one level up
// in `Router`, so the page component renders as a child of a plain
// FunctionComponent — no memo wrapper in the parent chain to interact
// with React Refresh's family-update propagation.
export const RouterOutlet: React.FC<{ route: Route; components: (Component | undefined)[] }> = ({
  route,
  components,
}) => {
  const [C, ...remaining] = components;

  if (!C) return null;

  return (
    <C route={route}>
      {remaining.length > 0 && <RouterOutlet route={route} components={remaining} />}
    </C>
  );
};

export const routerContext = createContext<RouterStore>(null as any);
export const useRouter = () => useContext(routerContext);

export interface RouterProps {
  store: RouterStore;
}

export const Router = observer(({ store }: RouterProps) => {
  const route = store.activeRoute;
  if (!route) {
    return null;
  }

  const Layout = route.layout ?? PassThrough;
  const components = route.outlets.map((o) => o.Component);
  const outlet = <RouterOutlet route={route} components={components} />;

  // Render crashes in pages/wrappers funnel to the nearest [ERROR]
  // component; the layout survives. On synthetic error routes the
  // boundary is omitted so a crashing [ERROR] component propagates
  // out of <Router> — a developer bug that should stay loud. Layout
  // crashes propagate for the same reason.
  const fallback = route.levels.at(-1)?.errorComponent ?? DefaultErrorPage;

  return (
    <routerContext.Provider value={store}>
      <Layout route={route}>
        {route.error ? (
          outlet
        ) : (
          <RouteErrorBoundary key={store.location.key} route={route} fallback={fallback}>
            {outlet}
          </RouteErrorBoundary>
        )}
      </Layout>
    </routerContext.Provider>
  );
});
