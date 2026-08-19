# @mobx-toolbox/lazy-observable

Lazy-loading MobX observables that fetch their value on first observation and drop it automatically when they go unobserved.

## `lazyObservable`

```ts
import { lazyObservable } from "@jayalfredprufrock/mobx-toolbox/lazy-observable";

const currentUser = lazyObservable(() => api.fetchCurrentUser());
```

The fetch function runs the first time the observable is accessed inside a reactive context (observer component, autorun, reaction, etc.). It does **not** run on direct access outside a reactive context.

### Properties

| Property   | Type                                         | Description                                                         |
| ---------- | -------------------------------------------- | ------------------------------------------------------------------- |
| `value`    | `T \| TInitialValue`                         | Current value (`undefined` until loaded)                            |
| `status`   | `"init" \| "loading" \| "loaded" \| "error"` | What is currently _held_ (not what is happening)                    |
| `loading`  | `boolean`                                    | `true` when there is nothing to show yet and a request is in flight |
| `fetching` | `boolean`                                    | `true` whenever a request is in flight, refreshes included          |
| `loaded`   | `boolean`                                    | `true` when status is `"loaded"`                                    |
| `error`    | `unknown`                                    | Last fetch error                                                    |
| `observed` | `boolean`                                    | `true` while something is observing this lazy                       |

### Methods

```ts
lazy.getOrLoad(); // → Promise<T> — resolve with the value, loading first if needed
lazy.reload(); // → Promise<T> — always fetch fresh, abandoning anything in flight
lazy.set(value); // → void — write the value directly and mark it loaded (no fetch)
lazy.invalidate(); // → void — mark stale, keeping the current value: reload if observed
lazy.invalidate({ discard: true }); // → void — same, but clear the value first
```

#### Refreshing without blanking

`status` describes what the lazy _holds_; `fetching` describes whether a request is in flight. A
refresh that already has a value stays `"loaded"` and merely flips `fetching`, so the data keeps
rendering instead of flashing empty between a mutation and its refetch:

```tsx
const SurveyList = observer(() => {
  const surveys = surveyStore.all;
  if (surveys.error) return <Error />;
  if (!surveys.loaded) return <Spinner />; // first load only
  return <List items={surveys.value} dimmed={surveys.fetching} />;
});
```

| situation                  | `status`    | `loaded` | `loading` | `fetching` |
| -------------------------- | ----------- | -------- | --------- | ---------- |
| first load                 | `"loading"` | `false`  | `true`    | `true`     |
| loaded, idle               | `"loaded"`  | `true`   | `false`   | `false`    |
| refreshing (default)       | `"loaded"`  | `true`   | `false`   | `true`     |
| refreshing after `discard` | `"loading"` | `false`  | `true`    | `true`     |
| refresh failed             | `"error"`   | `false`  | `false`   | `false`    |

A failed refresh reports the error but leaves the previous value readable on `value`. Pass
`{ discard: true }` when stale data would be misleading rather than helpful — a filter change, or
switching to a different record.

#### Demand vs. staleness

The two halves of the API answer different questions, and mixing them up is the usual source of
confusion:

- **Demand** — `getOrLoad()` and `reload()` mean _"I want the value now."_ They fetch regardless of
  whether anything is observing, because awaiting a value outside a reactive context is a
  first-class use (`await store.list.getOrLoad()` in an event handler).
- **Staleness** — `invalidate()` means _"what I have is no longer valid."_ It only fetches if
  something is watching. That is not a special case: it is the same rule that governs the very
  first load, applied to a value that already existed.

```ts
const surveys = lazyObservableArray(() => api.getSurveys());

await surveys.getOrLoad(); // demand: fetches, nothing observing
surveys.invalidate(); // staleness: nothing observing → drops the value, no fetch
// ...next time a component renders it, it loads.
```

#### Automatic refreshing

`reloadEvery` refreshes the value on an interval — for data that shouldn't go stale on screen:

```ts
const queue = lazyObservableArray(() => api.getQueue(), { reloadEvery: 30_000 });
```

It only runs **while something is observing**, so an unobserved lazy never polls in the background,
and it uses the preserving refresh: the current rows stay on screen while each reload is in flight
(watch `fetching` if you want to show that). The interval is measured from the last completed request
rather than a fixed clock, so a slow response pushes the next reload out instead of stacking
requests, and a manual `reload()`/`invalidate()` resets the clock rather than adding to it.

Coming back into observation after longer than the interval refreshes immediately, which covers the
case `keepOnUnobserved` cannot: that option measures _idle time_, not _data age_, so a user bouncing
between tabs every few seconds keeps clearing its timer and the data is retained indefinitely however
old it gets.

A failed reload reports its error and is retried on the next interval — a transient failure won't
leave a dashboard frozen.

If you'd rather decide when to refresh yourself, `loadedAt` records when the current value landed:

```tsx
useEffect(() => {
  if (surveys.loadedAt && Date.now() - surveys.loadedAt > 300_000) surveys.invalidate();
}, []);
```

`invalidate()` replaces the old `reset()`. `reset()` promised inertness but had to reload when
observed — otherwise a mounted component sat at its initial value forever, with no spinner, no
error, and no request.

Going unobserved always discards the value regardless of `keepOnUnobserved` timing, since nothing
can be showing it.

`getOrLoad()` joins a load already in flight; `reload()` deliberately starts another and discards
the earlier result. `set()` also abandons anything in flight, so a slow fetch can never overwrite
an explicit write.

### Options

```ts
lazyObservable(fetch, {
  initialValue: [], // default value before loading (also typed as TInitialValue)
  deep: false, // convert the value's contents to observables? — default: true
  keepOnUnobserved: true, // false | true | { for: ms } — default: false
  trackDependencies: true, // false | true | { throttle: ms } — default: false
  reloadEvery: 60_000, // auto-refresh interval while observed — default: off
  debugName: "myObs", // label for MobX DevTools
});
```

`keepOnUnobserved` controls how long a loaded value outlives its last observer:

- `false` (default) — drop it immediately; next observation re-fetches
- `true` — keep the loaded value forever
- `{ for: ms }` — keep it that long, then drop (prevents refetch flicker on a quick
  unmount/remount)

Error state is never kept, regardless of this setting.

### Aborting superseded requests

`fetch` receives `{ signal }` — an object rather than a bare signal, so more can be added later
without breaking every fetcher, and so a client whose own first parameter is an options bag can be
**attached directly**:

```ts
const surveys = lazyObservableArray(api.getSurveys); // if its first param is `{ signal? }`
```

The signal aborts the moment its request is superseded — by `reload()`, `set()`, `invalidate()`,
going unobserved, or a dependency change. Taking the argument is optional, so zero-argument fetchers
keep working:

```ts
const surveys = lazyObservableArray(({ signal }) => api.getSurveys({ signal }));
```

A superseded result is discarded whether or not you use the signal; passing it through is what
stops the work from happening at all. An aborted request never writes `error` — it is abandoned,
not failed — so there is nothing to filter out in your fetcher.

This matters most for `reload()`, which deliberately starts a fresh request rather than joining one
in flight. That is what makes "refetch after a mutation" correct: joining the in-flight request
would resolve with a response to a query issued _before_ the mutation, showing stale data with no
error and no indication anything is wrong. Use `getOrLoad()` when joining an in-flight load is what
you actually want.

### Dependency-driven refetching

Off by default. `fetch` is called exactly once per load, so an observable it happens to touch can
never trigger a request you didn't ask for:

```ts
// no refetch when session.orgId changes
const surveys = lazyObservableArray(() => api.getSurveys({ orgId: session.orgId }));
```

Opt in with `trackDependencies` when the refetch is the point:

```ts
const surveys = lazyObservableArray(() => api.getSurveys({ orgId: session.orgId }), {
  trackDependencies: true,
});
```

Now every observable `fetch` reads _while running_ becomes a refetch trigger. That includes reads
you didn't intend — `toJS(this.filters)` touches every field, so any filter edit refetches — which
is why this isn't the default. Each re-run supersedes the previous request and aborts its signal.

For an observable that changes rapidly, throttle the refetching:

```ts
const results = lazyObservableArray(({ signal }) => api.search({ q: query.get(), signal }), {
  trackDependencies: { throttle: 300 },
});
```

At most one refetch happens per window, so a burst of keystrokes costs one request rather than one
each. The **first** load is never throttled (this rides on mobx `reaction`, which always runs its
first tracking pass synchronously).

This throttles rather than debounces, which is a real difference under sustained input: the window
opens at the first change and is **not** pushed back by later ones, so continuous typing refreshes
once per window instead of waiting for a pause. That keeps results moving rather than showing nothing
until the user stops. A request already in flight when a change arrives keeps running, and its result
still applies if it lands first. A request already in flight when a change arrives keeps running, and its
result still applies if it lands first — normal progressive-search behaviour.

If you'd rather keep tracking off and refetch explicitly, a plain reaction is often clearer:

```ts
reaction(
  () => filters.status,
  () => surveys.invalidate(),
);
```

## `lazyObservableArray`

A variant that initializes with `[]` so you never have to handle an undefined array.

```ts
import { lazyObservableArray } from "@jayalfredprufrock/mobx-toolbox/lazy-observable";

const users = lazyObservableArray(() => api.getUsers());

// value is always IObservableArray<User>, never undefined
users.value.map((u) => u.name);
```

**The lazy owns one observable array for its lifetime.** `value` is always the same
`IObservableArray`: loads, `set(items)`, and discards all replace its _contents_ in place. So a
reference you hold stays valid, and `value.unshift(...)` / `value.remove(...)` operate on the live
collection.

It is owned directly rather than wrapped in a box, and that matters for _when loading starts_: any
read of the array's contents — `.slice()`, `.length`, iterating it — both tracks the data and marks
the lazy observed, so it fetches. A boxed array would have split those two jobs across two layers.

```ts
autorun(() => render(users.value.slice())); // tracks contents *and* triggers the load
```

`deep` applies to the array's items. Pass `deep: false` for rows that are already observable, such
as models, so nothing is converted on the way in.

The trade for a stable reference: **the identity is no longer a signal that data arrived.** Observe
the contents, or observe `loadedAt`:

```ts
// ✅ a load landed
reaction(
  () => users.loadedAt,
  () => persist(users.value),
);
// ❌ never fires again — the reference never changes
reaction(
  () => users.value,
  (items) => persist(items),
);
```

## `LazyObserver` component

Renders nothing (or a `placeholder`) while observables are loading, and renders children once all are loaded. Re-throws any observable error so it propagates to an error boundary.

```tsx
import { LazyObserver } from "@jayalfredprufrock/mobx-toolbox/lazy-observable";

// Single observable
<LazyObserver observe={users} placeholder={<Spinner />}>
  {(userList) => userList.map(u => <UserCard key={u.id} user={u} />)}
</LazyObserver>

// Multiple observables — all must be loaded before children render
<LazyObserver observe={[users, roles]} placeholder={<Spinner />}>
  {(userList, roleList) => (
    <UserRoleTable users={userList} roles={roleList} />
  )}
</LazyObserver>
```

## Key types

```ts
import type {
  LazyObservable, // the object returned by lazyObservable()
  LazyObservableArray, // the object returned by lazyObservableArray()
  LazyObservableOptions, // options for lazyObservable()
  LazyInvalidateOptions, // options for invalidate()
  LazyFetch, // ({ signal }: LazyFetchOptions) => Promise<T>
  LazyFetchOptions, // what a fetch is handed — currently { signal }
  InferLazyObservable, // InferLazyObservable<typeof obs> → T
} from "@jayalfredprufrock/mobx-toolbox/lazy-observable";
```
