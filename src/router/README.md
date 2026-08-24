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

An index key contributes no segment of its own, so paths never carry a trailing slash: `dashboard.index` is `/dashboard`, exactly like the leaf `about` is `/about`. The one path with no segments at all is the root, `/`. That uniformity is what lets paths be compared and prefix-matched without normalizing first — `doesPathMatch("/dashboard", true)` matches the index route, and `navigate({ to: "/dashboard" })` from `/dashboard` is correctly a no-op.

### Route value types

| Value                                                   | Meaning                                                               |
| ------------------------------------------------------- | --------------------------------------------------------------------- |
| `Component`                                             | Renders at that path                                                  |
| `() => import('./Page')`                                | Lazy-loaded component (code split)                                    |
| `{ [PAGE]: Component \| LazyComponent, ... }`           | Page with metadata (guard, loader, layout, loading, error)            |
| `{ [REDIRECT]: path \| options \| (route) => options }` | Redirect, static or derived from the matched route (not path-checked) |
| `{ key: ... }`                                          | Nested route definition                                               |
| `{ _name: { ... } }`                                    | [Group](#_groups--config-without-a-segment) — config, no URL segment  |

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

### `_groups` — config without a segment

A key beginning with `_` is a **group**. Its children are matched as if they were siblings of the group's parent, so it contributes no URL segment — but its `[WRAPPER]`, `[LOAD]`, `[GUARD]`, `[CONTEXT]`, `[ERROR]` and `[LOADING]` apply only within it. The name after the `_` is for humans.

This is how a subset of siblings share config:

```tsx
surveys: {
  _list: {
    [WRAPPER]: SurveysChrome,     // the tabs, and only the tabs
    [LOAD]: loadSurveys,
    index: { [REDIRECT]: (route) => `/org/${route.params.orgId}/surveys/published` },
    published: SurveysListPage,   // → /org/:orgId/surveys/published
    draft: SurveysListPage,
    archived: SurveysListPage,
  },
  $surveyId: {                    // outside the group — no SurveysChrome
    [WRAPPER]: SurveyScope,
    index: SurveyPage,
  },
}
```

Without groups, `[WRAPPER]` applies to a whole subtree, so sharing chrome between some siblings but not others means a conditional inside the wrapper — which mounts and unmounts the chrome as a side effect of navigation. A group makes the wrapper genuinely absent from the sibling's chain instead.

Two sigils, one rule each: `$param` contributes a **dynamic** segment, `_name` contributes **none**. `_`-prefixed keys are reserved — they never match a literal URL segment, and they don't appear in `RoutePath`.

**A group is a level.** It carries a wrapper, so it gets its own `RouteLevel`, with `segment` set to the group key (`_list`) and `pattern` set to the parent's — a definition key, not a URL segment, and the one place `level.segment` is not part of any path. An `index` inside a group still makes the _parent_ level navigable, so breadcrumbs deriving `to` from `level.pattern` work unchanged.

**Precedence**, when a segment could resolve more than one way:

1. a static key on the node
2. static keys in its groups, in declaration order
3. the dynamic (`$`/`:`) key on the node
4. dynamic keys in its groups, in declaration order

Groups may nest, and resolution recurses through them. An `index` never falls back to a dynamic key.

**Collisions are rejected at boot.** Because a group's children are matched as siblings of its parent, a key present both on the parent and inside one of its groups would silently shadow — one of them simply never matches. `makeRoutes()` throws instead:

```
'section.published' and 'section._tabs.published' both address '/section/published'.
```

The same check catches two groups defining the same child, and a group `index` colliding with its parent's. A group holding a leaf rather than a route object is rejected too — it would address nothing.

Like the rest of `makeRoutes()`'s validation, this is [development only](#redirect-targets-are-validated-at-boot-not-by-the-compiler). In production a shadowed key silently loses to whichever definition precedence picks first, so keep these errors in CI.

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

## `level` — where a component sits in the tree

Every component the router renders in an outlet — `[WRAPPER]`, `[PAGE]`, `[LOADING]`, `[ERROR]` — receives a `level` prop alongside `route`, describing its own place in the matched chain:

```ts
interface RouteLevel {
  index: number; // 0-based position in the matched chain
  segment: string; // this level's route key: ":orgId", "surveys", "index", "" at the root
  pattern?: RoutePath; // this level's own path, e.g. "/org/:orgId/surveys"
}
```

This is what lets route-level metadata — breadcrumbs, sub-navigation, per-level analytics — live in the wrapper instead of in the route file, without hardcoding a path the route tree already knows:

```tsx
const OrgScope = observer(({ route, level, children }: WrapperComponentProps) => (
  <CrumbScope crumb={{ to: level.pattern, label: route.data.organization?.name }}>
    {children}
  </CrumbScope>
));
```

`level.pattern` is typed `RoutePath`, so it goes straight into `to=` or `router.navigate()` with no cast — and reorganizing the route tree updates it instead of silently pointing somewhere wrong.

**`pattern` is `undefined` when the level addresses no page of its own.** A nesting level with no `index` child isn't navigable, and deriving a path for it would produce one that 404s. The optionality is the check — if `pattern` is there, it's a real destination:

```tsx
const Crumb = ({ level, children }: WrapperComponentProps) =>
  level.pattern ? <Link to={level.pattern}>{children}</Link> : <span>{children}</span>;
```

Resolve a pattern that may reach past the params you have with [`tryResolvePath`](#resolvepath--tryresolvepath).

Two things to know about the mapping between levels and components:

- **A page's level is its own, not its parent's.** `responses: ResponsesPage` gets `/…/:surveyId/responses`, while the `[WRAPPER]` above it gets `/…/:surveyId`. An `index` page shares its parent's pattern, because that is the path it renders at.
- **Levels and outlets do not line up one-to-one.** A level declaring both `[WRAPPER]` and `[LOAD]` produces two outlets that share one level; a level with neither produces none. So `level.index` counts levels, not rendered slots — don't use it to index into `route.outlets`.

On a synthetic error route (see [`[ERROR]`](#error--error-handling)) the surviving wrappers keep their levels, and the `[ERROR]` component receives the level that failed. It is the one place `level` may be absent — hence `ErrorComponentProps.level?` — when nothing matched at all.

## `[REDIRECT]` — redirects

```tsx
import { REDIRECT } from '@mobx-toolbox/router';

const routes = makeRoutes()({
  old-path: { [REDIRECT]: '/new-path' },
  new-path: NewPage,
});
```

Pass a `NavigateOptions` object instead of a string to include search params, replace mode, or state.

### Redirecting to a dynamic path

A bare string can only name a static path — a `:param` in it has nothing to resolve against. When the target depends on the URL that matched, pass a function of the matched route:

```tsx
const routes = makeRoutes()({
  org: {
    $orgId: {
      // "/org/7" → "/org/7/overview"
      index: { [REDIRECT]: (route) => `/org/${route.params.orgId}/overview` },
      overview: OverviewPage,
      settings: SettingsPage,
    },
  },
});
```

Return either spelling — a path you have already substituted, as above, or a `NavigateOptions` object for the router to substitute:

```tsx
[REDIRECT]: (route) => ({
  to: "/org/:orgId/overview",
  params: { orgId: route.params.orgId },
  search: { from: "org" },
}),
```

The options form is what you want when the redirect needs `search`, `state` or an explicit `replace`; otherwise the bare path reads better.

**A redirect replaces by default.** Every redirect — a `[REDIRECT]` leaf and a `redirect()` thrown from a guard or loader — replaces the history entry instead of pushing one, so `replace` is a thing you turn _off_, not on. The URL that redirected renders nothing of its own: leaving it in history traps Back, because going back re-matches the redirect and throws the user forward again. Pass `replace: false` for the rare redirect that should stay in history.

`route` is the route the redirect itself matched. It runs during matching — before guards and loaders — so `route.data` is empty; `params`, `context` and `path` are what it has to work with. Anything needing loaded data or an async check is a `[GUARD]`, not a redirect.

A `[GUARD]` that does nothing but `throw redirect(...)` is the older spelling of this and still works, but the function form says what it means and keeps the route table readable.

### Redirect targets are validated at boot, not by the compiler

Unlike `navigate()`, `<Link to>` and `redirect()`, a `[REDIRECT]` target is **not** path-checked by TypeScript: `to` is a plain `string` and `params` is optional, even after you augment `MobxRouter`.

This is a hard constraint, not an oversight. `RoutePath` is derived from `MobxRouter["routes"]` — the same object `makeRoutes()` is inferring — so a `RoutePath` reference anywhere inside the `Routes` type makes the `R extends Routes` constraint depend on the route tree while inferring it. TypeScript gives up, reports TS7022, and types the whole tree `any`, taking every path in the app with it. Nothing reachable from `Routes` may name `RoutePath`; `router.types.test.ts` compiles an augmented fixture to keep it that way.

So `makeRoutes()` checks them itself, when the tree is defined:

```tsx
makeRoutes()({
  auth: { login: LoginPage },
  old: { [REDIRECT]: "/auth/lgoin" },
  // Error: [REDIRECT] at 'old' targets '/auth/lgoin', which no route in this tree addresses.

  users: { $id: UserPage },
  legacy: { [REDIRECT]: "/users/:id" },
  // Error: [REDIRECT] at 'legacy' targets '/users/:id', but ':id' has no value.
  //        Supply it in `params`, or use the function form…

  a: { [REDIRECT]: "/b" },
  b: { [REDIRECT]: "/a" },
  // Error: [REDIRECT] at 'a' never lands — it loops: /a → /b → /a.
});
```

It rejects a target no route addresses, a `:param` with nothing to fill it, and a chain that loops instead of landing on a page. The check is deterministic and runs on first import, so a broken redirect fails the same way on every run — it cannot get past a single dev or CI run, which is why throwing is safe here.

**Development only.** All of `makeRoutes()`'s validation — redirect targets, loops, and [group collisions](#_groups--config-without-a-segment) — sits behind `process.env.NODE_ENV !== "production"`, the same guard mobx uses. Because every check is deterministic, production has nothing left to learn from them, and skipping keeps ~1.7 kB gzipped out of your production bundle: nothing else in the module references the validation code, so your bundler drops all of it. In production a mistyped redirect degrades to what it was before the check existed — a `NOT_FOUND` on the navigation after the redirect.

Loop detection follows the chain hop by hop, so it catches a cycle anywhere downstream, not just an immediate `a ⇄ b`. Two redirects converging on the same page is not a loop. A cycle through a dynamic segment counts — `users: { $id: { [REDIRECT]: '/users/5' } }` sends `/users/9` to `/users/5`, which matches `$id` again and redirects to itself forever.

Two things it can't cover:

- **Function targets are skipped** — what they return depends on the route they matched, which doesn't exist yet. A chain reaching one ends the loop walk there rather than being guessed at, so `a → b → (route) => '/a'` is not reported.
- **`redirect()` thrown from a guard or loader** is an ordinary runtime value, so it isn't visible to the tree walk at all.

### When a redirect fails

A redirect that can't be carried out — a function that throws or returns an unresolvable path, or a `redirect()` thrown by a guard whose `:params` don't resolve — is a navigation failure like any other: it renders the nearest `[ERROR]` with `type: "REDIRECT"` and the underlying error on `cause`, keeping the matched prefix's `[LAYOUT]` and `[WRAPPER]`s and leaving the URL where it was. It does not escape as an unhandled rejection.

Static targets never reach this path — boot validation rejects them first. It covers exactly the two cases that validation can't see: function targets and thrown `redirect()`s.

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

| `type`        | Fires when                                                                                           | `cause`          |
| ------------- | ---------------------------------------------------------------------------------------------------- | ---------------- |
| `"NOT_FOUND"` | No route matches the URL                                                                             | —                |
| `"GUARD"`     | A guard throws anything other than `Redirect` or `RouterError`                                       | The thrown value |
| `"LOAD"`      | A loader or lazy component import fails                                                              | The thrown value |
| `"RENDER"`    | A page or `[WRAPPER]` component crashes during render                                                | The thrown value |
| `"REDIRECT"`  | A redirect can't be carried out — a `[REDIRECT]` function throws, or a `to` has unresolved `:params` | The thrown value |

Guards and loaders may also throw `RouterError` directly and it passes through unwrapped — `throw new RouterError("NOT_FOUND")` from a loader is the idiom for "entity doesn't exist, show a 404 in this slot".

### How each failure renders

- **Unknown URL** — the nearest `[ERROR]` along the _matched prefix_ renders, keeping that prefix's layout and wrappers. With no `[ERROR]` anywhere, a minimal built-in `DefaultErrorPage` renders instead — no blank screens.
- **Guard failure** — bubbling is depth-aware: the error resolves from the level whose guard threw, so a root guard failing on `/admin/users` renders the root `[ERROR]`, not admin's. Ancestor guards run before child guards, and the URL stays put.
- **Loader failure** — the error renders **in that outlet's slot only**; the rest of the page (and any sibling loaders' content) stays intact.
- **Render crash** — an internal error boundary inside the layout catches page/wrapper crashes and renders the nearest `[ERROR]` with `type: "RENDER"`. The layout survives, so navigation remains usable.
- **Failed redirect** — bubbling is depth-aware like a guard failure: a `[REDIRECT]` resolves from its own level, and a redirect thrown by a guard resolves from that guard's. The URL stays put.

Error routes never run ancestor `[LOAD]` loaders — wrappers render without `route.data` on an error route.

### Redirect on unknown routes

Prefer redirecting over a 404 page? `[ERROR]` components render with full router context, so:

```tsx
const RedirectHome = () => {
  const router = useRouter();
  // an error route has already committed, so no guard or loader will run
  // again — this is the one redirect that has to happen from render.
  // `useMountEffect` keeps it to once, and redirects replace by default.
  useMountEffect(() => router.navigate({ to: "/" }));
  return null;
};

const AppError = ({ error }: ErrorComponentProps) =>
  error.type === "NOT_FOUND" ? <RedirectHome /> : <SomethingWentWrong error={error} />;
```

This is the only place a render-time redirect is the right tool. Everywhere else the route table
gets there first — see [Redirecting](#redirecting).

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

**A redirect thrown from a loader is control flow, not a failure.** The slot stays in its loading state and the `[LOADING]` component stays on screen until the new route lands — no error UI flashes in between. Use a loader redirect when the decision needs loaded data, and a `[GUARD]` when it doesn't; neither has a flash window.

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

A `[LOADING]` component receives `{ route, level }` and **never `children`**. Outlets in a chain resolve in parallel, so a descendant can be ready while this slot is still waiting; rendering it would paint a page with incomplete `route.data`. `[ERROR]` components follow the same rule. The `level` is the slot's own — see [`level`](#level--where-a-component-sits-in-the-tree) — so a skeleton can shape itself to the section it stands in.

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

### The two clocks — and how to avoid mixing them

The store carries two views of "where we are", and they disagree for the whole duration of a navigation:

| Signal                                                              | Updates                                  |
| ------------------------------------------------------------------- | ---------------------------------------- |
| `location`                                                          | the instant a navigation starts          |
| `activeRoute` — and `pathParams`, `activeSegments`, `doesPathMatch` | only once guards **and** loaders resolve |

Reading either alone is fine. **Combining them is the bug**, and it is easy to write by accident:

```tsx
// ✗ orgId comes from activeRoute (old); pathname already holds the new org
const active = tabs.find((t) => pathname.startsWith(t.to.replace(":orgId", orgId)));
```

For the duration of every org switch that test fails, so a section looks un-entered and a wrapper can unmount its own chrome mid-navigation.

`router.target` closes the gap. The matcher runs synchronously, before guards, so the destination is already known — `target` publishes it:

```tsx
// ✓ one clock, no interpolation
const active = tabs.find((tab) => tab.to === router.target?.pattern)?.value;
```

```ts
interface RouteTarget {
  pathname: string;
  pattern?: RoutePath; // e.g. "/org/:orgId/surveys/published"
  params: Record<string, string>;
  levels: RouteLevel[]; // the matched nesting levels — the ones [WRAPPER]s render at
}
```

Comparing `pattern`s is the point: there is no param to interpolate, so the mistake above becomes unwriteable. `levels` lets a `[WRAPPER]` ask whether the destination is still inside it without waiting for the swap.

`target` is not only set mid-navigation — when nothing is in flight it names the active route, so a tab strip expresses "the tab that is or will be selected" without branching on navigation state.

`doesTargetMatch(path, exact?)` is the pending-aware sibling of `doesPathMatch`. Same signature and semantics, different clock — a separate method so the call site says which one it means.

**What holds `target` steady.** A URL that produces no match leaves it alone rather than blanking. A `[REDIRECT]` leaf throws instead of matching, so clearing would flicker for exactly the one hop before the redirect's own match lands — which is where section chrome disappears. `NOT_FOUND` and rejected guards behave the same way: the error route commits through `activeRoute`, and `target` keeps naming the last route that matched. So `target` is not "the route on screen" — after a failed navigation the two differ until the next successful match. It is `undefined` only before the first match of the session.

**Active links still lag, deliberately.** `makeLinkComponent` sets `aria-current` off `doesPathMatch`, so it stays on the old link until the new route lands — the destination isn't showing yet. For a pending affordance, use `doesTargetMatch` alongside it.

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
import { useLazy, LazyObserver } from "@jayalfredprufrock/mobx-toolbox/lazy-observable";

const UserDetailPage = observer(() => {
  const { id } = useRouter().pathParams;
  const user = useLazy((options) => api.getUser(id, options), [id]);

  return (
    <UserLayout>
      <LazyObserver observe={user} placeholder={<UserSkeleton />}>
        {(user) => <UserProfile user={user} />}
      </LazyObserver>
    </UserLayout>
  );
});
```

`LazyObserver` re-throws load failures that leave nothing to render, so they hit the router's error boundary and render your nearest `[ERROR]` with `type: "RENDER"` — you keep `[ERROR]` either way. The trade-off is a serial waterfall on lazy routes: the chunk must download and mount before the fetch starts, where `[LOAD]` overlaps the two. Reach for it when you want progressive rendering, not as the default.

## Typed props from a path

If you do keep loading in the route file, name the path a component sits on and its `route` is typed
against the route tree:

```tsx
import type { PageComponentProps } from "@jayalfredprufrock/mobx-toolbox/router";

const StudyPage = ({ route }: PageComponentProps<"/org/:orgId/studies/:studyId">) => {
  route.params.studyId; // string — from the path
  route.data.study; // whatever that level's [LOAD] resolves to
  route.data.org; // ...and every ancestor's, merged in
  route.context.tenant; // from [CONTEXT] at or above this path
};
```

The path is written out rather than inferred because the component cannot import the route tree that
imports it. A mistyped path is a compile error, and the path argument autocompletes.

**Omitting it changes nothing.** `PageComponentProps` with no argument is the untyped `Route` it has
always been, so existing components need no edit and pay nothing — an app that never names a path
costs about a dozen extra type instantiations for the feature existing at all.

### What `data` resolves to

Every `[LOAD]` **at that path and above it**, merged, with the deeper one winning — which is what
`route.data` actually holds at runtime (`Object.assign` over the outlet chain). Descendants are
excluded: which of them matched is not knowable from the path, so only what is _guaranteed_ present
is typed.

`[CONTEXT]` accumulates the same way. Groups (`_list`) contribute their config without contributing a
segment, exactly as they do at runtime.

### Wrappers sit on prefixes

A `[WRAPPER]` usually lives on a nesting level that addresses no page of its own, so its path is not
in `RoutePath`. `WrapperComponentProps` takes a `RoutePrefix` instead — any prefix of any route path:

```tsx
const OrgShell = ({ route, children }: WrapperComponentProps<"/org/:orgId">) => {
  route.data.org; // guaranteed here
  // route.data.studies — not typed: a descendant's loader, and this wrapper renders for siblings too
};
```

That asymmetry is the point: `PageComponentProps` rejects a path with no page, `WrapperComponentProps`
accepts the levels wrappers actually live on.

### Why `[ERROR]` and `[LOADING]` are not path-typed

Neither is guaranteed the data a path implies. **Error routes never run ancestor `[LOAD]` loaders**,
so a typed `route.data` on an `[ERROR]` component would name fields that are reliably absent — and a
`[LOADING]` component renders precisely while the loaders it would describe are still in flight.
Typing them would be a lie in both cases, so `ErrorComponentProps` and `LoadingComponentProps` keep
the untyped `Route`.

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

### Redirecting

There is no redirect _component_. A redirect belongs to the route, not to the render, and the route
table has three spellings depending on what the decision needs to read:

| The decision needs                      | Use                                              |
| --------------------------------------- | ------------------------------------------------ |
| Nothing — the path always moves         | `[REDIRECT]` (see [below](#redirect--redirects)) |
| Params, context, or a synchronous check | `[REDIRECT]` as a function, or a `[GUARD]`       |
| Loaded data                             | `throw redirect(...)` from a `[LOAD]`            |

```tsx
// decided from loaded data — the loader is the only place that has it
survey: {
  [LOAD]: async (route) => {
    const survey = await api.getSurvey(route.params.id);
    if (survey.status === "draft") throw redirect({ to: "/surveys" });
    return survey;
  },
  index: SurveyPage,
}
```

All three replace the history entry rather than pushing one — see
[a redirect replaces by default](#redirecting-to-a-dynamic-path).

For the rare case where a redirect is driven by store state changing _while the page is already on
screen_ — no guard or loader re-runs at that point — reach for an autorun rather than a render-time
navigation:

```tsx
useAutorun(() => {
  if (!auth.isLoggedIn) router.navigate({ to: "/login" });
});
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
- Calls `event.preventDefault()` and delegates to `router.navigate()` — on an unmodified primary click
- Sets `aria-current="page"` when the route is active (uses `doesPathMatch`)

### Navigation options as props

Everything `navigate()` takes beyond the destination is a prop, with the same meaning:

```tsx
<Link to="/login" replace>Sign in</Link>                         // replace the history entry
<Link to="/search" search={{ q: "hello" }}>Results</Link>        // query string
<Link to="/search" search={{ q: "hello" }} preserveSearch>…</Link> // merge the current query
<Link to="/checkout" state={{ from: "cart" }}>Checkout</Link>    // history state
```

`search` and `preserveSearch` are reflected in the `href`, so a cmd-click opens the same URL a plain click would have navigated to. `replace` and `state` are not — a new tab starts its own history — and never reach the DOM as attributes.

These names are reserved on link components: a wrapped component's own `replace`/`state`/`search`/`preserveSearch` props are shadowed, as `to`, `params` and `exact` already are.

You can wrap an existing component (e.g., a UI library button) and pass default props:

```tsx
export const NavLink = makeLinkComponent(MyButton, { variant: "ghost" });
```

### What the browser still handles

Cmd/ctrl-click, shift-click, alt-click and middle-click are **left alone**: the `href` is already correct, so the browser opens the new tab or window itself. Cancelling those was the only thing stopping it.

This defers to the browser only when there is an `href` to follow. A link rendered with `role="link"` has none, so a modifier-click there navigates in place rather than doing nothing at all. If you build a link on a non-anchor element (`makeLinkComponent("button")`), the browser has nothing to open — prefer an anchor for anything a user might want to open in a new tab.

Middle-click reaches the handler only where the element emits `click` for it; `onAuxClick` is deliberately left untouched.

### `onClick` and `disabled`

A caller's `onClick` runs **before** the navigation and can cancel it with `preventDefault()` — the "confirm before leaving" case. It cancels the `href` along with it. An `onClick` passed as a base prop is used the same way; a per-call `onClick` replaces it, as with any other prop.

```tsx
<Link to="/settings" onClick={(e) => !confirm("Discard draft?") && e.preventDefault()}>
  Settings
</Link>
```

A `disabled` link is inert: no navigation, no `href`, and no `onClick` — modifiers included.

## `RouterStore` API

```ts
const router = new RouterStore(config?: MobxRouterConfig);
router.initialize(routes);             // call once with route definitions

// Observable state
router.location                        // History Location — updates as soon as navigation starts
router.activeRoute                     // Route | undefined — the page currently rendered
router.pendingRoute                    // Route | undefined — the route being guarded/loaded
router.target                          // RouteTarget | undefined — the destination, known immediately
router.isNavigating                    // boolean — a navigation is in flight, guards included
router.isLoading                       // boolean — any loading indicator is warranted
router.isSlowNavigation                // boolean — slow nav (guards included) with a page on screen
router.search                          // URLSearchParams (reactive)
router.query                           // Record<string, string> — parsed search params
router.pathParams                      // Record<string, string> — URL params

// Navigation
router.navigate(options)               // programmatic navigation
router.resolveHref(options)            // string — the URL those options address, for `href`
router.doesPathMatch(path, exact?)     // boolean — active-link detection (lags a navigation)
router.doesTargetMatch(path, exact?)   // boolean — same, against the destination

// Query param helpers
router.setQueryParam(key, value)       // update one param, replaces current entry
router.removeQueryParam(key)           // remove one param, returns previous value
```

`RouterStore` uses `createBrowserHistory()` by default. Pass `{ history }` in `MobxRouterConfig` for hash routing or testing, and `{ viewTransitions: false }` to opt out of [view transitions](#view-transitions).

## `Route` object

The `Route` instance passed to guards and loaders; also `router.activeRoute`:

```ts
route.path; // "dashboard/settings" — matched segments joined by "/" ("" at the root)
route.pattern; // "/org/:orgId/surveys" — path with :params unsubstituted; undefined on error routes
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

## `resolvePath` / `tryResolvePath`

```ts
import { resolvePath, tryResolvePath } from "@mobx-toolbox/router";

resolvePath("/users/:id", { id: "42" }); // "/users/42"
resolvePath("/users/:id"); // throws — a path you built and can't fill is a bug
tryResolvePath("/users/:id"); // undefined
```

`navigate()` and `<Link>` use the throwing form, which is the right default for a path you constructed. Use `tryResolvePath` for one you didn't — resolving a `level.pattern` against params that may not reach that deep, which is the "link it if we can address it, otherwise render plain text" case:

```tsx
const to = level.pattern && tryResolvePath(level.pattern, route.params);
return to ? <a href={to}>{label}</a> : <span>{label}</span>;
```

## `redirect` / `Redirect`

```ts
import { redirect, Redirect } from "@mobx-toolbox/router";

// Functional shorthand (preferred)
throw redirect({ to: "/login" });

// Class form — equivalent
throw new Redirect({ to: "/login" });
```

Both forms are caught by the router after a guard throws; the router then calls `navigate()` with the provided options, defaulting `replace` to `true` — see [redirects replace by default](#redirecting-to-a-dynamic-path). Pass `replace: false` to push instead.

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
  RouterErrorType, // "NOT_FOUND" | "GUARD" | "LOAD" | "RENDER" | "REDIRECT"
  RedirectTarget, // what [REDIRECT] accepts: path | options | (route) => path | options
  RouteLevel, // { index, segment, pattern? } — where a component sits
  RouteTarget, // { pathname, pattern?, params, levels } — router.target
  WrapperComponentProps, // { route: Route; level: RouteLevel; children? }
  PageComponentProps, // { route: Route; level: RouteLevel }
  ErrorComponentProps, // { route: Route; error: RouterError; level?: RouteLevel }
  LoadingComponentProps, // { route: Route; level: RouteLevel }
  RouteSegmentState, // "preloading" | "loading" | "error" | "ready"
} from "@mobx-toolbox/router";
```

---

## Agent notes

**`_`-prefixed keys are groups, not segments.** A `_name` key applies its config to its children while contributing nothing to the URL, and can never match a literal `_name` segment. Its children resolve as siblings of its parent, so a key defined both places is a boot-time error. See [`_groups`](#_groups--config-without-a-segment).

**`$` is for route keys only; `:` is for path strings.** Dynamic segments are declared as `$id` keys in the routes object, but every path string in the API (`navigate({ to })`, `<Link to>`, `doesPathMatch`, `resolvePath`, the `RoutePath` union) spells that segment `:id`. A `$id` spelling inside a path string is treated as a literal segment and will not match or resolve.

**Symbol keys must be imported.** `PAGE`, `GUARD`, `LOAD`, `LAYOUT`, `WRAPPER`, `CONTEXT`, `REDIRECT`, `ERROR`, `LOADING`, `SPLASH` are `unique symbol` values exported from `@mobx-toolbox/router`. They must be used as computed keys `[PAGE]: ...`. String keys like `"guard"` are treated as path segments, not metadata.

**Errors produce synthetic routes — except loader errors.** When matching, a guard, or a render fails, `router.activeRoute` is set to a synthetic route with `route.error: RouterError` and an outlet chain ending in the nearest `[ERROR]` component (or `DefaultErrorPage`). A **rejected loader does not**: navigation succeeds, `route.error` stays `undefined`, and the error lives on the failing outlet, which renders `[ERROR]` in its own slot. So `route.error` alone will not tell you a loader failed. Layout and error-component render crashes are deliberately NOT caught by the router — wrap `<Router>` in an app-level ErrorBoundary for last-resort protection.

**`[ERROR]` and `[LOADING]` components never receive `children`.** Both render mid-chain, and outlets resolve in parallel, so a descendant may already be ready; forwarding children would paint it without the data it expects. Only `route` and `level` (plus `error`) are passed.

**Every outlet-rendered component receives `level`.** `[WRAPPER]`, `[PAGE]`, `[LOADING]` and `[ERROR]` each get their own `RouteLevel` — `{ index, segment, pattern? }` — so route-level metadata belongs in the component rather than being hardcoded against a duplicated path string. `level.pattern` is `undefined` for a nesting level with no `index` child, which is precisely the level that has no page to navigate to. Levels are not one-to-one with outlets: one level declaring both `[WRAPPER]` and `[LOAD]` produces two outlets sharing a level, so never index `route.outlets` by `level.index`. `Route.levels` remains internal and is not the same list.

**The route swap is deferred.** `activeRoute` keeps rendering the previous page until the pending route's guards and loaders finish; the in-flight route is `router.pendingRoute`. So during a navigation `router.location` already points at the destination while `activeRoute`, `pathParams`, `activeSegments` and `doesPathMatch` still describe the page on screen. Staleness is compared by pathname, so a query-param change mid-navigation does not cancel the navigation in flight.

**Never combine `location` with anything derived from `activeRoute`.** They are different clocks (see [The two clocks](#the-two-clocks--and-how-to-avoid-mixing-them)). Interpolating `pathParams` into a test against `location.pathname` is wrong for exactly as long as the navigation takes, and the failure is invisible when navigations are fast. Use `router.target` — one clock, and `target.pattern` needs no interpolation at all. `doesTargetMatch` is the destination-aware `doesPathMatch`.

**Lazy component detection is source-string based.** `isLazyComponent` checks `fn.toString().startsWith("() => import(")`. Minified, transpiled, or wrapped functions will fail this check and be treated as eager. Always write lazy routes as inline `() => import('./Module')` arrow functions — not `async () =>`, not assigned to an intermediate variable.

**Pass eager page components directly, not as thunks.** `[PAGE]: DashboardPage` is correct and hot-reloads properly — React Refresh resolves stale references through its family map. A thunk (`[PAGE]: () => <DashboardPage />`) also renders, but silently drops the `route` prop the outlet passes, which is a common source of `route is undefined` crashes. This depends on `Outlet` holding `component` as a plain, non-MobX-observed field; there are tests pinning that invariant.

**Module augmentation is required for typed paths.** Without augmenting `MobxRouter`, `RoutePath` is `string` and no path checking occurs. The augmentation must be in a file included in the TypeScript compilation.

**`"index"` is the root key for a path level.** To render at `/dashboard`, the route tree needs either `dashboard: Component` (leaf) or `dashboard: { index: Component, ... }` (nested). A nested object without `index` produces a `NOT_FOUND` error route when navigating to the parent path — including when that level has a dynamic child, which does not match the parent's own path.

**Index paths carry no trailing slash.** `dashboard: { index: Page }` is `/dashboard`, not `/dashboard/`; the root is `/`. `route.path` matches (`"dashboard"`, `""` at the root), so paths compare and prefix-match without normalizing. A URL typed with a trailing slash still matches — the store redirects it to the canonical form.

**Guard execution order.** Guards are collected from outermost to innermost route level and run in that order. A thrown `Redirect` stops the chain immediately. Navigating inside a guard via `router.navigate()` also terminates the remaining chain because the router checks `this.location !== location` after each guard.

**`route.data` is a shallow merge.** Each `[LOAD]` function's resolved value is spread into a single object. If two loaders return `{ user: ... }`, the inner one overwrites the outer. Loaders for a given route all run concurrently via `Promise.all`.

**`[LAYOUT]` is inherited and overridable; `[WRAPPER]` is not inherited.** A `[LAYOUT]` set at any ancestor level applies to all descendants unless a descendant sets its own. `[WRAPPER]` only wraps the route subtree at the level it is defined and does not propagate.

**`router.activeRoute` is `undefined` until the first navigation resolves.** During that cold load `<Router>` renders `pendingRoute` instead, so pending outlets show their `[LOADING]` components. While both are undefined — before the first route matches, guards included — it renders the root `[SPLASH]`, or `null` if none is defined.

**`Route` and `Outlet` are exported for type annotation.** When writing guard or loader functions that are defined outside the routes object, import `Route` for the parameter type. `Outlet` and `OutletConfig` are exported but are primarily internal — avoid constructing them directly.

**Links leave modifier clicks to the browser.** `makeLinkComponent` only calls `preventDefault()` for an unmodified primary click, so cmd/ctrl/shift/alt- and middle-clicks follow the `href` and open a tab or window as the user expects. It defers only when an `href` exists — with `role="link"` (or a non-anchor element) there is nothing to follow, so those clicks navigate in place. A caller's `onClick` is chained, not replaced, and runs first: `preventDefault()` there cancels both the navigation and the `href`.
