# @mobx-toolbox/lazy-observable

Lazy-loading MobX observables that fetch their value on first observation and reset automatically when they go unobserved.

## `lazyObservable`

```ts
import { lazyObservable } from "@jayalfredprufrock/mobx-toolbox/lazy-observable";

const currentUser = lazyObservable(() => api.fetchCurrentUser());
```

The fetch function runs the first time the observable is accessed inside a reactive context (observer component, autorun, reaction, etc.). It does **not** run on direct access outside a reactive context.

### Properties

| Property  | Type                                         | Description                              |
| --------- | -------------------------------------------- | ---------------------------------------- |
| `value`   | `T \| TInitialValue`                         | Current value (`undefined` until loaded) |
| `status`  | `"init" \| "loading" \| "loaded" \| "error"` | Lifecycle state                          |
| `loading` | `boolean`                                    | `true` when status is `"loading"`        |
| `loaded`  | `boolean`                                    | `true` when status is `"loaded"`         |
| `error`   | `unknown`                                    | Last fetch error                         |

### Methods

```ts
lazy.getOrLoad(); // → Promise<T> — start loading if not loaded; resolve when done
lazy.reload(); // → Promise<T> — force a fresh fetch regardless of current state
lazy.set(value); // → void — set value directly and mark as loaded (no fetch)
lazy.reset(); // → TInitialValue — revert to initial state (discards cached value)
```

### Options

```ts
lazyObservable(fetch, {
  initialValue: [],          // default value before loading (also typed as TInitialValue)
  shallow: true,             // use observable.ref for value (no deep observation)
  resetOnUnobserved: "never" // "never" | "always" | number (ms) — default: reset immediately
  debugName: "myObs",        // label for MobX DevTools
});
```

`resetOnUnobserved` controls what happens when the last observer disconnects:

- `"always"` (default) — reset immediately; next observation re-fetches
- `"never"` — keep the cached value forever once loaded
- `number` — delay reset by N milliseconds (useful for preventing flicker on quick unmount/remount)

Error state always resets on unobserve (never cached), regardless of this setting.

### In React

```tsx
import { observer } from "mobx-react-lite";

const userStore = {
  user: lazyObservable(() => api.getUser()),
};

const UserCard = observer(() => {
  if (userStore.user.loading) return <Spinner />;
  if (userStore.user.error) return <Error />;
  return <div>{userStore.user.value?.name}</div>;
});
// Accessing `user.loading` inside observer triggers the fetch automatically.
```

## `lazyObservableArray`

A variant that initializes with `[]` so you never have to handle an undefined array.

```ts
import { lazyObservableArray } from "@jayalfredprufrock/mobx-toolbox/lazy-observable";

const users = lazyObservableArray(() => api.getUsers());

// value is always IObservableArray<User>, never undefined
users.value.map((u) => u.name);
```

`set(items: T[])` replaces the array contents (rather than the whole array reference).

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
  InferLazyObservable, // InferLazyObservable<typeof obs> → T
} from "@jayalfredprufrock/mobx-toolbox/lazy-observable";
```
