import { observer } from "mobx-react-lite";
import { createContext, useContext } from "react";
import type { Route } from "../route";
import type { RouterStore } from "../router.store";
import type { Component } from "../types";

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
  if (!store.activeRoute) {
    return null;
  }

  const Layout = store.activeRoute.layout ?? PassThrough;
  const components = store.activeRoute.outlets.map((o) => o.Component);

  return (
    <routerContext.Provider value={store}>
      <Layout route={store.activeRoute}>
        <RouterOutlet route={store.activeRoute} components={components} />
      </Layout>
    </routerContext.Provider>
  );
});
