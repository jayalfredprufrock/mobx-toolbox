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

| Value                                         | Meaning                                                    |
| --------------------------------------------- | ---------------------------------------------------------- |
| `Component`                                   | Renders at that path                                       |
| `() => import('./Page')`                      | Lazy-loaded component (code split)                         |
| `{ [PAGE]: Component \| LazyComponent, ... }` | Page with metadata (guard, loader, layout, loading, error) |
| `{ [REDIRECT]: '/path' \| NavigateOptions }`  | Static redirect                                            |
| `{ key: ... }`                                | Nested route definition                                    |

### Dynamic segments

Use `$paramName` as the route key for URL parameters. The `$` spelling exists only because `:paramName` would need quoting as an object key — in every _path string_ (`navigate`, `<Link to>`, `doesPathMatch`, typed `RoutePath`s) the same segment is written backend-style as `:paramName`, like Express or React Router (and like Remix, which uses `$` in file names but `:` in paths). If you prefer strict backend parity, a quoted `":paramName"` route key works too and behaves identically.

```tsx
const routes = makeRoutes()({
  users: {
    index: UsersPage, // "/users"
    $id: UserDetailPage, // "/users/42" → route.params.id === "42"
  },
});

router.navigate({ to: "/users/:id", params: { id: "42" } }); // typed path is "/users/:id"
```

The param value is available on `route.params` (and `router.pathParams`) without any prefix. Only one dynamic segment is allowed per nesting level.

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

## Eager components — pass the component directly

For already-imported components, pass the component itself. React Refresh handles it: it swaps implementations through its family map, which resolves the _registered_ function even when something is holding an older reference to it.

```tsx
import { DashboardPage } from "./DashboardPage";

const routes = makeRoutes()({
  dashboard: { [PAGE]: DashboardPage }, // ✓
  reports: ReportsPage, // ✓ also fine as a bare leaf
});
```

Verified against Chrome with `@vitejs/plugin-react`: editing a page updates it in place with component state preserved, for direct references, bare leaf components, and `observer()`-wrapped versions of both.

**Prefer this over a thunk.** `[PAGE]: () => <DashboardPage />` works too, but the arrow function swallows the props the outlet passes — the router renders `[PAGE]` with `route`, and the thunk drops it, so the page receives nothing. Use a direct reference and `route` arrives as a prop; use a thunk and you must read loader data via `useRouter().activeRoute?.data` or forward explicitly with `(props) => <DashboardPage {...props} />`.

**The real constraint on hot updates is the module, not the route definition.** React Refresh can only self-accept a module whose exports are all components. A page module that also exports its loader, a constant, or a helper can't self-accept, so editing it invalidates whichever module imported it and Vite falls back to a full page reload. No route-definition form changes that — split non-component exports into their own module if you want hot updates.

> **Note:** this holds for the standard Babel-based `@vitejs/plugin-react`. If you use a different refresh transform (SWC, or an oxc-based one), the component-detection heuristics differ and are worth re-checking.

None of this applies to lazy components — they are detected and handled separately.

## `[PAGE]` — page definitions

Use `[PAGE]` when a route needs more than just a component — guard, loader, or layout:

```tsx
import { makeRoutes, PAGE, GUARD, LOAD, LAYOUT } from "@mobx-toolbox/router";

const routes = makeRoutes()({
  dashboard: {
    [LAYOUT]: DashboardLayout,
    [GUARD]: requireAuth,
    [LOAD]: loadDashboardData,
    [PAGE]: DashboardPage,
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
import type { Loader, Route } from "@mobx-toolbox/router";

const loadUser: Loader = async (route) => {
  return fetchUser(route.params.id);
};

const routes = makeRoutes()({
  users: {
    $id: {
      [LOAD]: loadUser,
      [PAGE]: UserDetailPage,
    },
  },
});

// In UserDetailPage — `route` arrives as a prop:
function UserDetailPage({ route }: { route: Route }) {
  const user = route.data.user;
  // ...
}
```

When multiple loaders exist in the outlet chain, their results are shallow-merged. Last writer wins on key conflicts. Loaders run in parallel (`Promise.all`) — and for a lazy page, the loader runs concurrently with the chunk import, so data fetching and code splitting overlap instead of queueing.

Where `[LOAD]` sits decides what it blocks:

- **Inside a `[PAGE]` object** — the loader shares the page's outlet, so only that page waits.
- **On a nesting-level route object** (`dashboard: { [LOAD]: ..., index: ... }`) — the loader gets its own outlet, and everything below it in the chain waits on it.

**Loaders do not re-run on search-param changes.** A navigation that changes only the query string (or history state) updates `router.location` and leaves the route — and therefore every loader and guard — alone. This is deliberate: loaders can't observe search params, so re-running them would be wasted work. Data that depends on `?page=2` or `?q=foo` belongs in a store computed off `router.query`, not in `[LOAD]`.

See [`[LOADING]`](#loading--loading-states) for what the user sees while a loader runs.

## `[LAYOUT]` — page layout

`[LAYOUT]` sets a component that wraps the entire rendered page. It receives `route` and `children` as props. A layout set on a parent applies to all descendants unless overridden.

```tsx
const routes = makeRoutes()({
  [LAYOUT]: AppShell, // applies to all routes below

  dashboard: DashboardPage, // rendered inside AppShell
  settings: SettingsPage, // rendered inside AppShell
  login: {
    [LAYOUT]: BlankLayout, // overrides AppShell for /login
    [PAGE]: LoginPage,
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

## `[ERROR]` — error handling

`[ERROR]` sets the component rendered when navigation or loading fails at or below that level. Like `[LAYOUT]`, it inherits down the tree and can be overridden. The error UI renders **inside** the `[LAYOUT]` and `[WRAPPER]`s of the matched route prefix — an access-denied message shows up within the current app shell, not on a bare page. The attempted URL is preserved (no redirect).

```tsx
import { ERROR, RouterError } from "@mobx-toolbox/router";
import type { ErrorComponentProps } from "@mobx-toolbox/router";

const routes = makeRoutes()({
  [LAYOUT]: AppShell,
  [ERROR]: AppError, // catches anything at or below the root

  admin: {
    [GUARD]: requireAdmin,
    [ERROR]: AdminError, // overrides AppError for admin/*; renders inside AppShell
    users: AdminUsersPage,
  },
});

function AppError({ error, route }: ErrorComponentProps) {
  if (error.type === "NOT_FOUND") return <NotFound404 path={error.path} />;
  if (error.cause instanceof AccessDeniedError) return <AccessDenied />;
  return <SomethingWentWrong error={error} />;
}
```

### `RouterError`

Every `[ERROR]` component receives `{ route, error }` where `error` is a `RouterError`. The `type` field discriminates the failure source; when the router wraps an application-level error (thrown by a guard or loader), the original is preserved on the standard `error.cause`.

| `type`        | Fires when                                                     | `cause`          |
| ------------- | -------------------------------------------------------------- | ---------------- |
| `"NOT_FOUND"` | No route matches the URL                                       | —                |
| `"GUARD"`     | A guard throws anything other than `Redirect` or `RouterError` | The thrown value |
| `"LOAD"`      | A loader or lazy component import fails                        | The thrown value |
| `"RENDER"`    | A page or `[WRAPPER]` component crashes during render          | The thrown value |

Guards and loaders may also throw `RouterError` directly and it passes through unwrapped — `throw new RouterError("NOT_FOUND")` from a loader is the idiom for "entity doesn't exist, show a 404 in this slot".

### How each failure renders

- **Unknown URL** — the nearest `[ERROR]` along the _matched prefix_ renders, keeping that prefix's layout and wrappers. With no `[ERROR]` anywhere, a minimal built-in `DefaultErrorPage` renders instead — no blank screens.
- **Guard failure** — bubbling is depth-aware: the error resolves from the level whose guard threw, so a root guard failing on `/admin/users` renders the root `[ERROR]`, not admin's. Ancestor guards run before child guards, and the URL stays put.
- **Loader failure** — the error renders **in that outlet's slot only**; the rest of the page (and any sibling loaders' content) stays intact.
- **Render crash** — an internal error boundary inside the layout catches page/wrapper crashes and renders the nearest `[ERROR]` with `type: "RENDER"`. The layout survives, so navigation remains usable.

Error routes never run ancestor `[LOAD]` loaders — wrappers render without `route.data` on an error route.

### Redirect on unknown routes

Prefer redirecting over a 404 page? `[ERROR]` components render with full router context, so:

```tsx
const AppError = ({ error }: ErrorComponentProps) =>
  error.type === "NOT_FOUND" ? <Navigate to="/" replace /> : <SomethingWentWrong error={error} />;
```

### Errors thrown by a loader

A rejected loader is contained: it never becomes a synthetic error route. `router.activeRoute.error` stays `undefined`, the failure lives on the outlet, and the nearest `[ERROR]` renders **in that outlet's slot** with `type: "LOAD"` and the thrown value on `cause`. Sibling outlets and the rest of the page are untouched.

Two consequences worth knowing:

- **Checking `route.error` is not enough to detect "this page failed."** It's set for match, guard and render failures, not loader failures. To catch everything, report from inside your `[ERROR]` component — it renders for both kinds.
- **Loader failures are not logged.** Navigation-level failures go through `console.error`; loader failures only render. Add your own reporting in the `[ERROR]` component or wrap the loader body.

Choose where to throw based on the UI you want:

| Want                                                                     | Throw from |
| ------------------------------------------------------------------------ | ---------- |
| Error confined to one slot, rest of the page intact                      | `[LOAD]`   |
| A full-page error route, with `route.error` set and depth-aware bubbling | `[GUARD]`  |

So `throw new RouterError("NOT_FOUND")` from a loader gives you a 404 _in the slot_; move the existence check into a guard if you want the whole page replaced.

**Prefer guards for redirects.** `throw redirect(...)` from a loader does navigate, but the outlet is marked `error` before the redirect resolves — with no error recorded, so a generic "A route loader or lazy component failed." message can flash before the new route lands. Guards have no such window.

### What is deliberately NOT caught

A crash in the `[LAYOUT]` component itself — or in an `[ERROR]` component — propagates out of `<Router>`. These are developer bugs, not runtime states: in development you get the error overlay and a real stack trace instead of a masking error page. For last-resort production protection, wrap the router in your own boundary:

```tsx
<MyAppErrorBoundary>
  <Router store={router} />
</MyAppErrorBoundary>
```

## `[LOADING]` — loading states

Navigation does not blank the screen. When you navigate, the router matches, runs guards, and loads the new route **while the current page stays on screen**; `activeRoute` is only swapped once the new route is ready. The route being worked on is `router.pendingRoute`.

| Phase                          | `activeRoute`  | `pendingRoute` | On screen                   |
| ------------------------------ | -------------- | -------------- | --------------------------- |
| `[GUARD]`s running             | previous route | —              | the previous page           |
| `[LOAD]` / lazy import running | previous route | the new route  | the previous page           |
| resolved                       | the new route  | —              | the new page                |
| cold load (no previous page)   | `undefined`    | the new route  | the new route's `[LOADING]` |

That splits loading UI into two cases, and they want different things:

**Warm navigation — a progress bar in the layout.** The old page is intact, so the right UI is an unobtrusive progress cue, not a placeholder. Put it in the `[LAYOUT]`, which stays mounted across navigation:

```tsx
import { observer } from "mobx-react-lite";

const AppShell = observer(({ children }) => {
  const router = useRouter();
  return (
    <div>
      <Nav />
      {router.isSlowNavigation && <div className="progress-bar" />}
      <main data-busy={router.isSlowNavigation}>{children}</main>
    </div>
  );
});
```

The bar needs no JS state or timers. Conditionally rendering it means each slow navigation mounts a fresh element whose CSS animation starts from zero:

```css
.progress-bar {
  position: fixed;
  inset: 0 auto auto 0;
  height: 3px;
  background: hsl(220 90% 55%);
  /* Long duration + heavy ease-out: creeps toward 100% and decelerates, so
     it never visibly completes before the route lands. This is a cue that
     something is happening, not real progress — loaders report none. */
  animation: progress-creep 6s cubic-bezier(0, 0.6, 0.2, 1) forwards;
}

@keyframes progress-creep {
  from {
    width: 0;
  }
  to {
    width: 100%;
  }
}
```

### Choosing the signal: should the bar coexist with `[LOADING]`?

Both are legitimate designs, and the choice is one computed either way:

| You want                                                  | Use                       |
| --------------------------------------------------------- | ------------------------- |
| Bar on warm navigations only; skeleton owns the cold load | `router.isSlowNavigation` |
| Bar whenever anything is loading, skeleton included       | `router.isLoading`        |

`isSlowNavigation` makes the two **mutually exclusive**. It is true only when a navigation has passed the debounce _and_ a page is already on screen, so the cold load — where `[LOADING]` renders instead — is excluded.

Both signals are debounced from the **start of the navigation**, not from the start of loading, so:

- a slow `[GUARD]` trips them even though no outlet is loading yet;
- guard and load time **accumulate** — a 200ms guard followed by a 150ms loader trips them at 350ms, even though neither phase alone reaches the threshold.

`isLoading` makes the bar a superset: true whenever an indicator is warranted anywhere, which includes the whole cold-load skeleton phase. The `[LAYOUT]` renders during a cold load (from `pendingRoute`), so a bar inside it appears above the skeleton, and it stays continuously visible from the skeleton through to the finished page with no gap.

Here is what each is true for:

| Phase                         | `isNavigating` | `isLoading` | `isSlowNavigation` | `[LOADING]` on screen  |
| ----------------------------- | -------------- | ----------- | ------------------ | ---------------------- |
| cold load, inside debounce    | —              | —           | —                  | no                     |
| cold load, slow guard         | —              | ✓           | —                  | no (blank — see below) |
| cold load, skeleton up        | ✓              | ✓           | —                  | yes                    |
| cold load, hold after data    | —              | ✓           | —                  | yes                    |
| cold load, settled            | —              | —           | —                  | no                     |
| warm nav, inside the debounce | —              | —           | —                  | no                     |
| warm nav, slow guard          | —              | ✓           | ✓                  | no                     |
| warm nav, slow load           | ✓              | ✓           | ✓                  | no                     |
| warm nav, settled             | —              | —           | —                  | no                     |

All three signals span the guard phase. If you need the narrower "a route is currently loading" — true only once guards have resolved — check `router.pendingRoute` directly.

Two traps in that table. `isNavigating` is false during the cold-load hold (the route has landed; the skeleton is still held) _and_ during the guard phase, so `isLoading && isNavigating` blinks the bar out in both. If you want the always-visible bar, use `isLoading` alone.

**A cold load with a slow guard needs `[SPLASH]`.** `<Router>` renders `activeRoute ?? pendingRoute`, and during guards on the very first navigation both are undefined — no route means no layout, so there is nowhere to host a bar, and no outlets, so no `[LOADING]`. `[SPLASH]` fills exactly that window; see below.

`router.isNavigating` is the undebounced "something is in flight" — accurate, but it flips for every navigation however fast, so a bar driven off it flickers. Use it for logic, not pixels.

**Cold load — `[LOADING]` renders.** On the first navigation there's no previous page to preserve, so the pending route renders and each pending outlet shows the nearest `[LOADING]` component. It inherits down the tree and can be overridden exactly like `[ERROR]`:

````tsx
import { LOADING, ERROR } from "@mobx-toolbox/router";

const routes = makeRoutes()({
  [LAYOUT]: AppShell,
  [LOADING]: AppSkeleton, // shown at or below the root during a cold load
  [ERROR]: AppError,

  reports: {

**Cold load — `[LOADING]` renders.** On the first navigation there's no previous page to preserve, so the pending route renders and each pending outlet shows the nearest `[LOADING]` component. It inherits down the tree and can be overridden exactly like `[ERROR]`:

```tsx
import { LOADING, ERROR } from "@mobx-toolbox/router";

const routes = makeRoutes()({
  [LAYOUT]: AppShell,
  [LOADING]: AppSkeleton, // shown at or below the root during a cold load
  [ERROR]: AppError,

  reports: {
    [LOADING]: ReportsSkeleton, // overrides AppSkeleton for reports/*
    [LOAD]: loadReportIndex,
    $id: ReportPage,
  },
});

function AppSkeleton({ route }: LoadingComponentProps) {
  return <SkeletonGrid />;
}
````

`[LOADING]` renders inside the `[LAYOUT]` and any wrappers ahead of it, so your app shell is present around the skeleton. With no `[LOADING]` anywhere, a minimal built-in `DefaultLoadingPage` (`<p>Loading...</p>`) renders — define a root-level `[LOADING]` to replace it.

A `[LOADING]` component receives `{ route }` and **never `children`**. Outlets in a chain resolve in parallel, so a descendant can be ready while this slot is still waiting; rendering it would paint a page with incomplete `route.data`. `[ERROR]` components follow the same rule.

### `[SPLASH]` — the pre-match window

`[LOADING]` needs a matched route: it lives on an outlet, inside the layout. On the very first navigation neither exists yet, so from the moment the app starts until the first route resolves, `<Router>` has nothing to render. That window is normally a microtask and invisible — but a root `[GUARD]` awaiting an auth check stretches it into a blank screen for as long as the check takes.

`[SPLASH]` is read from the **root** of the route definition and rendered in exactly that window:

```tsx
import { SPLASH, GUARD, LAYOUT } from "@mobx-toolbox/router";

const routes = makeRoutes()({
  [SPLASH]: BootScreen, // until the first route resolves
  [LAYOUT]: AppShell,
  [LOADING]: AppSkeleton, // once a route has matched
  [GUARD]: restoreSession, // the slow step that makes [SPLASH] visible

  index: HomePage,
});
```

The three hand off in sequence, and never overlap:

| Window                                         | Renders                           |
| ---------------------------------------------- | --------------------------------- |
| app start → first route matched (incl. guards) | `[SPLASH]`                        |
| route matched → its outlets resolved           | `[LOADING]`                       |
| any later navigation                           | previous page + your progress bar |

It receives no props — there is no route yet to describe — and needs no debounce: it is only reachable while nothing has matched, so an app whose first navigation resolves promptly never paints it. It is also never shown on later navigations, since by then a page is already on screen.

The type allows `[SPLASH]` on nested route objects, where it is ignored. Only the root is read.

### Timings

| Constant                  | Default | Effect                                                                                                                |
| ------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------- |
| `LOADING_DELAY_MS`        | 300ms   | Debounce before an indicator appears. Applied both per-outlet and per-navigation (the latter starting before guards). |
| `LOADING_MIN_DURATION_MS` | 300ms   | How long a shown `[LOADING]` is held after data arrives, so it can't flash. **Cold load only.**                       |

The delay costs nothing during a warm navigation — the previous page fills the window — so a quick navigation shows no indicator and no layout shift. The minimum-duration hold applies only when a `[LOADING]` component is actually on screen; a warm navigation renders content the moment its data lands and is never held back.

### Outlet states

For finer-grained work, each outlet in the chain tracks its own state. `route.isLoading` and `route.isPending` are the aggregates the store's computeds are built from.

| `state`        | What renders in that slot                          |
| -------------- | -------------------------------------------------- |
| `"preloading"` | nothing — the chain truncates here                 |
| `"loading"`    | the nearest `[LOADING]` component                  |
| `"ready"`      | the outlet's component                             |
| `"error"`      | the nearest `[ERROR]` component, in this slot only |

### Active links lag during navigation

`router.location` updates as soon as a navigation starts, but `doesPathMatch` reads the _active_ route, which is still the previous one. So `aria-current` stays on the old link until the new route lands — correct behavior (the destination isn't showing yet), but if you want a pending affordance, read `router.pendingRoute?.path` alongside it.

### View transitions

Where the browser supports it, route swaps are wrapped in `document.startViewTransition`, so the default cross-fade works with no setup. Add `view-transition-name` to the elements you want paired and style the pseudo-elements as usual:

```css
main {
  view-transition-name: page;
}
nav {
  view-transition-name: nav;
} /* named = excluded from the page animation */

@keyframes slide-in {
  from {
    transform: translateX(40px);
    opacity: 0;
  }
}
::view-transition-new(page) {
  animation: 300ms both slide-in;
}
```

The transition wraps **only the swap**, never the guard and load phases. That distinction matters: a transition freezes the page on its old snapshot until the update callback settles, so wrapping the whole navigation would leave the UI unresponsive for the length of a fetch, with the progress bar unable to animate. Instead the previous page stays live and interactive while loading, and the transition covers the instant the new page replaces it.

Disable globally with `new RouterStore({ viewTransitions: false })`. Skipped transitions — a second navigation interrupting one, a backgrounded tab, duplicate `view-transition-name`s — are handled internally; the DOM update always lands.

Cold loads don't transition: there's no previous page to animate away from, and the visible change happens when outlets resolve rather than at the swap.

### Loading data inside the page instead

`[LOAD]` blocks the swap until data is in, which is what makes pages render complete. When you'd rather paint the shell immediately and fill regions in — per-section skeletons, independently refreshing panels — skip `[LOAD]` and drive it from an observable:

```tsx
import { lazyObservable, LazyObserver } from "@jayalfredprufrock/mobx-toolbox/lazy-observable";

const UserDetailPage = observer(() => {
  const { id } = useRouter().pathParams;
  const user = useMemo(() => lazyObservable(() => api.getUser(id)), [id]);

  return (
    <UserLayout>
      <LazyObserver observe={user} placeholder={<UserSkeleton />}>
        {(user) => <UserProfile user={user} />}
      </LazyObserver>
    </UserLayout>
  );
});
```

`LazyObserver` re-throws load failures, so they hit the router's error boundary and render your nearest `[ERROR]` with `type: "RENDER"` — you keep `[ERROR]` either way. The trade-off is a serial waterfall on lazy routes: the chunk must download and mount before the fetch starts, where `[LOAD]` overlaps the two. Reach for it when you want progressive rendering, not as the default.

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
router.location                        // History Location — updates as soon as navigation starts
router.activeRoute                     // Route | undefined — the page currently rendered
router.pendingRoute                    // Route | undefined — the route being guarded/loaded
router.isNavigating                    // boolean — a navigation is in flight, guards included
router.isLoading                       // boolean — any loading indicator is warranted
router.isSlowNavigation                // boolean — slow nav (guards included) with a page on screen
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

`RouterStore` uses `createBrowserHistory()` by default. Pass `{ history }` in `MobxRouterConfig` for hash routing or testing, and `{ viewTransitions: false }` to opt out of [view transitions](#view-transitions).

## `Route` object

The `Route` instance passed to guards and loaders; also `router.activeRoute`:

```ts
route.path; // "dashboard/settings" — matched segments joined by "/"
route.params; // Record<string, string> — URL params, e.g. { id: "42" }
route.context; // Record<string, any> — merged [CONTEXT] from ancestor routes
route.data; // Record<string, any> — merged return values of all [LOAD] functions
route.layout; // Component | undefined — resolved [LAYOUT]
route.error; // RouterError | undefined — set on synthetic error routes only
route.isLoading; // boolean — an outlet has passed LOADING_DELAY_MS
route.isPending; // boolean — an outlet is still resolving, debounce included
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
import { RouterError } from "@mobx-toolbox/router"; // class — thrown/wrapped on navigation failures
import {
  LOADING_DELAY_MS, // 300 — debounce before an indicator appears
  LOADING_MIN_DURATION_MS, // 300 — how long a shown [LOADING] is held (cold load only)
} from "@mobx-toolbox/router";

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
  MobxRouterConfig, // { history?, viewTransitions? }
  RouterErrorType, // "NOT_FOUND" | "GUARD" | "LOAD" | "RENDER"
  ErrorComponentProps, // { route: Route; error: RouterError }
  LoadingComponentProps, // { route: Route }
  RouteSegmentState, // "preloading" | "loading" | "error" | "ready"
} from "@mobx-toolbox/router";
```

---

## Agent notes

**`$` is for route keys only; `:` is for path strings.** Dynamic segments are declared as `$id` keys in the routes object, but every path string in the API (`navigate({ to })`, `<Link to>`, `doesPathMatch`, `resolvePath`, the `RoutePath` union) spells that segment `:id`. A `$id` spelling inside a path string is treated as a literal segment and will not match or resolve.

**Symbol keys must be imported.** `PAGE`, `GUARD`, `LOAD`, `LAYOUT`, `WRAPPER`, `CONTEXT`, `REDIRECT`, `ERROR`, `LOADING`, `SPLASH` are `unique symbol` values exported from `@mobx-toolbox/router`. They must be used as computed keys `[PAGE]: ...`. String keys like `"guard"` are treated as path segments, not metadata.

**Errors produce synthetic routes — except loader errors.** When matching, a guard, or a render fails, `router.activeRoute` is set to a synthetic route with `route.error: RouterError` and an outlet chain ending in the nearest `[ERROR]` component (or `DefaultErrorPage`). A **rejected loader does not**: navigation succeeds, `route.error` stays `undefined`, and the error lives on the failing outlet, which renders `[ERROR]` in its own slot. So `route.error` alone will not tell you a loader failed. Layout and error-component render crashes are deliberately NOT caught by the router — wrap `<Router>` in an app-level ErrorBoundary for last-resort protection.

**`[ERROR]` and `[LOADING]` components never receive `children`.** Both render mid-chain, and outlets resolve in parallel, so a descendant may already be ready; forwarding children would paint it without the data it expects. Only `route` (plus `error`) is passed.

**The route swap is deferred.** `activeRoute` keeps rendering the previous page until the pending route's guards and loaders finish; the in-flight route is `router.pendingRoute`. So during a navigation `router.location` already points at the destination while `activeRoute`, `pathParams`, `activeSegments` and `doesPathMatch` still describe the page on screen. Staleness is compared by pathname, so a query-param change mid-navigation does not cancel the navigation in flight.

**Lazy component detection is source-string based.** `isLazyComponent` checks `fn.toString().startsWith("() => import(")`. Minified, transpiled, or wrapped functions will fail this check and be treated as eager. Always write lazy routes as inline `() => import('./Module')` arrow functions — not `async () =>`, not assigned to an intermediate variable.

**Pass eager page components directly, not as thunks.** `[PAGE]: DashboardPage` is correct and hot-reloads properly — React Refresh resolves stale references through its family map. A thunk (`[PAGE]: () => <DashboardPage />`) also renders, but silently drops the `route` prop the outlet passes, which is a common source of `route is undefined` crashes. This depends on `Outlet` holding `component` as a plain, non-MobX-observed field; there are tests pinning that invariant.

**Module augmentation is required for typed paths.** Without augmenting `MobxRouter`, `RoutePath` is `string` and no path checking occurs. The augmentation must be in a file included in the TypeScript compilation.

**`"index"` is the root key for a path level.** To render at `/dashboard`, the route tree needs either `dashboard: Component` (leaf) or `dashboard: { index: Component, ... }` (nested). A nested object without `index` produces a `NOT_FOUND` error route when navigating to the parent path.

**Guard execution order.** Guards are collected from outermost to innermost route level and run in that order. A thrown `Redirect` stops the chain immediately. Navigating inside a guard via `router.navigate()` also terminates the remaining chain because the router checks `this.location !== location` after each guard.

**`route.data` is a shallow merge.** Each `[LOAD]` function's resolved value is spread into a single object. If two loaders return `{ user: ... }`, the inner one overwrites the outer. Loaders for a given route all run concurrently via `Promise.all`.

**`[LAYOUT]` is inherited and overridable; `[WRAPPER]` is not inherited.** A `[LAYOUT]` set at any ancestor level applies to all descendants unless a descendant sets its own. `[WRAPPER]` only wraps the route subtree at the level it is defined and does not propagate.

**`router.activeRoute` is `undefined` until the first navigation resolves.** During that cold load `<Router>` renders `pendingRoute` instead, so pending outlets show their `[LOADING]` components. While both are undefined — before the first route matches, guards included — it renders the root `[SPLASH]`, or `null` if none is defined.

**`Route` and `Outlet` are exported for type annotation.** When writing guard or loader functions that are defined outside the routes object, import `Route` for the parameter type. `Outlet` and `OutletConfig` are exported but are primarily internal — avoid constructing them directly.
