# @mobx-toolbox/router

A MobX-based client-side router for React. Routes are plain objects; symbol-keyed metadata (`[GUARD]`, `[LOAD]`, `[LAYOUT]`, etc.) controls access, data loading, and layout. Path-type safety is driven by module augmentation.

## Setup

```tsx
import { RouterStore, Router } from "@mobx-toolbox/router";

const router = new RouterStore();
router.initialize(routes); // pass your route definitions (see below)

function App() {
  return <Router store={router} />;
}
```

## Defining routes

`makeRoutes()` infers the route tree type for typed path checking.

```tsx
import { makeRoutes, PAGE, GUARD, LOAD, LAYOUT, REDIRECT } from "@mobx-toolbox/router";

const routes = makeRoutes()({
  index: HomePage, // renders at "/"
  about: AboutPage, // renders at "/about"

  dashboard: {
    // nested — renders at "/dashboard"
    index: DashboardPage, // renders at "/dashboard"
    settings: SettingsPage, // renders at "/dashboard/settings"
  },
});
```

The string key `"index"` maps to the parent path (e.g., `dashboard.index` renders at `/dashboard`). A nested object without an `index` key has no component at its own path.

### Route value types

| Value                                         | Meaning                                    |
| --------------------------------------------- | ------------------------------------------ |
| `Component`                                   | Renders at that path                       |
| `() => import('./Page')`                      | Lazy-loaded component (code split)         |
| `{ [PAGE]: Component \| LazyComponent, ... }` | Page with metadata (guard, loader, layout) |
| `{ [REDIRECT]: '/path' \| NavigateOptions }`  | Static redirect                            |
| `{ key: ... }`                                | Nested route definition                    |

### Dynamic segments

Use `$paramName` as the route key for URL parameters. The value is available on `route.params` without the `$`.

```tsx
const routes = makeRoutes()({
  users: {
    index: UsersPage, // "/users"
    $id: UserDetailPage, // "/users/42" → route.params.id === "42"
  },
});
```

Only one dynamic segment is allowed per nesting level.

## Type-safe paths

Augment `MobxRouter` with your routes type so `RoutePath` resolves to the exact union of your app's paths:

```ts
// Typically in the same file as makeRoutes()
declare module "@mobx-toolbox/router" {
  interface MobxRouter {
    routes: typeof routes;
  }
}
```

After augmentation, `navigate({ to: '/nonexistent' })`, `<Navigate to="..." />`, and link components all produce type errors for unknown paths. Without augmentation, `RoutePath` is `string`.

## Lazy components

Write lazy routes as bare arrow functions starting with `() => import(...)`. The router detects laziness by checking the function's source string.

```tsx
const routes = makeRoutes()({
  dashboard: () => import("./DashboardPage"), // ✓ detected as lazy
});
```

> **Agent note:** The detection is `fn.toString().startsWith("() => import(")`. Any minification, transpilation, or wrapper around the function will break detection, causing the component to be treated as eager. Always write lazy routes as inline arrow functions.

The imported module must export `default` or a named export ending in `Page`. If neither is found, the router throws at load time.

## Eager components — use a thunk

For already-imported components, pass a thunk instead of a direct reference so React Refresh can swap the component without a full remount:

```tsx
import { DashboardPage } from "./DashboardPage";

const routes = makeRoutes()({
  dashboard: {
    [PAGE]: () => <DashboardPage />, // ✓ thunk — HMR works
    // [PAGE]: DashboardPage          // ✗ direct ref — stale after HMR
  },
});
```

This does not apply to lazy components (they are detected and handled separately).

## `[PAGE]` — page definitions

Use `[PAGE]` when a route needs more than just a component — guard, loader, or layout:

```tsx
import { makeRoutes, PAGE, GUARD, LOAD, LAYOUT } from "@mobx-toolbox/router";

const routes = makeRoutes()({
  dashboard: {
    [LAYOUT]: DashboardLayout,
    [GUARD]: requireAuth,
    [LOAD]: loadDashboardData,
    [PAGE]: () => <DashboardPage />,
  },
});
```

`[PAGE]` accepts both a component and a lazy component (`() => import(...)`).

## `[GUARD]` — access control

A guard is `(route: Route) => Promise<void>`. Throw a `Redirect` to redirect; return normally to allow navigation.

```tsx
import { GUARD, redirect } from "@mobx-toolbox/router";
import type { Guard } from "@mobx-toolbox/router";

const requireAuth: Guard = async (route) => {
  if (!authStore.isLoggedIn) {
    throw redirect({ to: "/login" });
  }
};

const routes = makeRoutes()({
  [GUARD]: requireAuth, // applies to all routes
  dashboard: DashboardPage,
  settings: SettingsPage,
});
```

Guards on parent route objects run before child guards. All matching guards in the chain execute in order; the first that throws stops the rest.

## `[LOAD]` — data loading

A loader is `(route: Route) => Promise<unknown>`. Its resolved value is merged into `route.data`.

```tsx
import { LOAD, PAGE } from "@mobx-toolbox/router";
import type { Loader } from "@mobx-toolbox/router";

const loadUser: Loader = async (route) => {
  return fetchUser(route.params.id);
};

const routes = makeRoutes()({
  users: {
    $id: {
      [LOAD]: loadUser,
      [PAGE]: () => <UserDetailPage />,
    },
  },
});

// In UserDetailPage:
function UserDetailPage() {
  const router = useRouter();
  const user = router.activeRoute?.data?.user;
  // ...
}
```

When multiple loaders exist in the outlet chain, their results are shallow-merged. Last writer wins on key conflicts. Loaders run in parallel (`Promise.all`).

## `[LAYOUT]` — page layout

`[LAYOUT]` sets a component that wraps the entire rendered page. It receives `route` and `children` as props. A layout set on a parent applies to all descendants unless overridden.

```tsx
const routes = makeRoutes()({
  [LAYOUT]: AppShell, // applies to all routes below

  dashboard: DashboardPage, // rendered inside AppShell
  settings: SettingsPage, // rendered inside AppShell
  login: {
    [LAYOUT]: BlankLayout, // overrides AppShell for /login
    [PAGE]: () => <LoginPage />,
  },
});

function AppShell({ route, children }) {
  return (
    <div>
      <Nav />
      <main>{children}</main>
    </div>
  );
}
```

## `[WRAPPER]` — per-segment wrapper

`[WRAPPER]` is a component that wraps only the outlet content at its own nesting level, not the entire page. Useful for animated transitions or section-scoped providers.

```tsx
const routes = makeRoutes()({
  admin: {
    [WRAPPER]: AdminProvider, // wraps admin/* content only
    users: AdminUsersPage,
    roles: AdminRolesPage,
  },
});
```

`[LAYOUT]` replaces the top-level page wrapper and inherits down the tree. `[WRAPPER]` wraps only the subtree where it appears and does not affect the layout.

## `[REDIRECT]` — static redirect

```tsx
import { REDIRECT } from '@mobx-toolbox/router';

const routes = makeRoutes()({
  old-path: { [REDIRECT]: '/new-path' },
  new-path: NewPage,
});
```

Pass a `NavigateOptions` object instead of a string to include search params, replace mode, or state.

## `[CONTEXT]` — static route data

`[CONTEXT]` attaches a plain object to a route subtree. It merges down through nesting and is accessible on `route.context` in guards and loaders. Useful for role tags, feature flags, or section metadata.

```tsx
import { CONTEXT, GUARD } from "@mobx-toolbox/router";
import type { Guard } from "@mobx-toolbox/router";

const checkRole: Guard = async (route) => {
  if (!currentUser.hasRole(route.context.requiredRole)) {
    throw redirect({ to: "/403" });
  }
};

const routes = makeRoutes()({
  admin: {
    [CONTEXT]: { requiredRole: "admin" },
    [GUARD]: checkRole,
    users: AdminUsersPage,
    roles: AdminRolesPage,
  },
});
```

## Navigation

### Programmatic

```tsx
const router = useRouter(); // inside a component

router.navigate({ to: "/dashboard" });
router.navigate({ to: "/users/:id", params: { id: "42" } });
router.navigate({ to: "/search", search: { q: "hello" } });
router.navigate({ to: "/search", search: { q: "hello" }, preserveSearch: true }); // merge existing params
router.navigate({ to: "/login", replace: true }); // replace history entry
```

### `<Navigate>` component

```tsx
import { Navigate } from "@mobx-toolbox/router";

// Triggers navigation in useLayoutEffect — useful for conditional redirects in render
function RequireAuth({ children }) {
  const auth = useAuthStore();
  if (!auth.isLoggedIn) return <Navigate to="/login" />;
  return children;
}
```

### Links — `makeLinkComponent`

There is no built-in `Link` component yet. Use `makeLinkComponent` to create one from any element type:

```tsx
import { makeLinkComponent } from '@mobx-toolbox/router';

// Create once, use everywhere
export const Link = makeLinkComponent('a');
export const ButtonLink = makeLinkComponent('button');

// Usage — `to` is typed as RoutePath after MobxRouter augmentation
<Link to="/dashboard">Dashboard</Link>
<Link to="/users/:id" params={{ id: "42" }}>User profile</Link>
<Link to="/about" exact>About</Link>  // exact=true for strict active matching
```

`makeLinkComponent` automatically:

- Sets `href` on the rendered element
- Calls `event.preventDefault()` and delegates to `router.navigate()`
- Sets `aria-current="page"` when the route is active (uses `doesPathMatch`)

You can wrap an existing component (e.g., a UI library button) and pass default props:

```tsx
export const NavLink = makeLinkComponent(MyButton, { variant: "ghost" });
```

## `RouterStore` API

```ts
const router = new RouterStore(config?: MobxRouterConfig);
router.initialize(routes);             // call once with route definitions

// Observable state
router.location                        // History Location
router.activeRoute                     // Route | undefined
router.search                          // URLSearchParams (reactive)
router.query                           // Record<string, string> — parsed search params
router.pathParams                      // Record<string, string> — URL params

// Navigation
router.navigate(options)               // programmatic navigation
router.doesPathMatch(path, exact?)     // boolean — active-link detection

// Query param helpers
router.setQueryParam(key, value)       // update one param, replaces current entry
router.removeQueryParam(key)           // remove one param, returns previous value
```

`RouterStore` uses `createBrowserHistory()` by default. Pass `{ history }` in `MobxRouterConfig` for hash routing or testing.

## `Route` object

The `Route` instance passed to guards and loaders; also `router.activeRoute`:

```ts
route.path; // "dashboard/settings" — matched segments joined by "/"
route.params; // Record<string, string> — URL params, e.g. { id: "42" }
route.context; // Record<string, any> — merged [CONTEXT] from ancestor routes
route.data; // Record<string, any> — merged return values of all [LOAD] functions
route.layout; // Component | undefined — resolved [LAYOUT]
route.outlets; // Outlet[] — internal; represents each rendered segment
route.guards; // Guard[] — internal; the full resolved guard chain
```

## `redirect` / `Redirect`

```ts
import { redirect, Redirect } from "@mobx-toolbox/router";

// Functional shorthand (preferred)
throw redirect({ to: "/login" });

// Class form — equivalent
throw new Redirect({ to: "/login" });
```

Both forms are caught by the router after a guard throws; the router then calls `navigate()` with the provided options.

## Key types

```ts
import type {
  Guard, // (route: Route) => Promise<void>
  Loader, // (route: Route) => Promise<unknown>
  Component, // React.FC<any>
  LazyComponent, // () => Promise<any>
  Routes, // root route definition object type
  RoutePath, // union of all app paths (after MobxRouter augmentation)
  StaticRoutePath, // paths without :params
  DynamicRoutePath, // paths with :params
  NavigateOptions, // { to, params?, replace?, search?, preserveSearch?, state? }
  MobxRouterConfig, // { history? }
} from "@mobx-toolbox/router";
```

---

## Agent notes

**Symbol keys must be imported.** `PAGE`, `GUARD`, `LOAD`, `LAYOUT`, `WRAPPER`, `CONTEXT`, `REDIRECT` are `unique symbol` values exported from `@mobx-toolbox/router`. They must be used as computed keys `[PAGE]: ...`. String keys like `"guard"` are treated as path segments, not metadata.

**Lazy component detection is source-string based.** `isLazyComponent` checks `fn.toString().startsWith("() => import(")`. Minified, transpiled, or wrapped functions will fail this check and be treated as eager. Always write lazy routes as inline `() => import('./Module')` arrow functions — not `async () =>`, not assigned to an intermediate variable.

**Module augmentation is required for typed paths.** Without augmenting `MobxRouter`, `RoutePath` is `string` and no path checking occurs. The augmentation must be in a file included in the TypeScript compilation.

**`"index"` is the root key for a path level.** To render at `/dashboard`, the route tree needs either `dashboard: Component` (leaf) or `dashboard: { index: Component, ... }` (nested). A nested object without `index` produces a "Not Found" error when navigating to the parent path.

**Guard execution order.** Guards are collected from outermost to innermost route level and run in that order. A thrown `Redirect` stops the chain immediately. Navigating inside a guard via `router.navigate()` also terminates the remaining chain because the router checks `this.location !== location` after each guard.

**`route.data` is a shallow merge.** Each `[LOAD]` function's resolved value is spread into a single object. If two loaders return `{ user: ... }`, the inner one overwrites the outer. Loaders for a given route all run concurrently via `Promise.all`.

**`[LAYOUT]` is inherited and overridable; `[WRAPPER]` is not inherited.** A `[LAYOUT]` set at any ancestor level applies to all descendants unless a descendant sets its own. `[WRAPPER]` only wraps the route subtree at the level it is defined and does not propagate.

**`router.activeRoute` is `undefined` until the first navigation resolves.** The `Router` component renders `null` while `activeRoute` is undefined. Guards and loaders run asynchronously before `activeRoute` is set.

**`Route` and `Outlet` are exported for type annotation.** When writing guard or loader functions that are defined outside the routes object, import `Route` for the parameter type. `Outlet` and `OutletConfig` are exported but are primarily internal — avoid constructing them directly.
