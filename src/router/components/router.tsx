import { observer } from "mobx-react-lite";
import { createContext, Suspense, useContext } from "react";
import type { Outlet } from "../outlet";
import type { Route } from "../route";
import type { RouterStore } from "../router.store";
import type { Component } from "../types";

export const PassThrough: Component = ({ children }) => children;

export const RouterOutlet: React.FC<{ route: Route; outlets: Outlet[] }> = observer(
  ({ route, outlets }) => {
    const [outlet, ...remainingOutlets] = outlets;

    if (!outlet) return null;

    const C = outlet.Component;

    if (!C) return null;

    return (
      <C route={route}>
        {remainingOutlets.length > 0 && <RouterOutlet route={route} outlets={remainingOutlets} />}
      </C>
    );
  },
);

export const routerContext = createContext<RouterStore>(null as any);
export const useRouter = () => useContext(routerContext);

export interface RouterProps {
  store: RouterStore;
}

export const Router = observer(({ store }: RouterProps) => {
  if (!store.activeRoute) {
    return null;
  }

  const Layout = store.activeRoute.layout ?? PassThrough;

  return (
    <routerContext.Provider value={store}>
      <Layout route={store.activeRoute}>
        <Suspense fallback={null}>
          <RouterOutlet route={store.activeRoute} outlets={store.activeRoute.outlets} />
        </Suspense>
      </Layout>
    </routerContext.Provider>
  );
});
