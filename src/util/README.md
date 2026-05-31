# @mobx-toolbox/util

Small MobX + React utilities.

## `mutable`

A `ClassAccessorDecorator` that boxes a class accessor field in a MobX `observable.box`, making it reactive without calling `makeObservable` / `makeAutoObservable`.

```ts
import { mutable } from "@jayalfredprufrock/mobx-toolbox/util";
import { observer } from "mobx-react-lite";

class ThemeStore {
  @mutable accessor darkMode = false;
  @mutable accessor fontSize = 14;
}

const theme = new ThemeStore();

// Reads and writes are reactive
theme.darkMode = true; // triggers any observing reactions
console.log(theme.darkMode); // true
```

Each instance gets its own `observable.box` stored in a `WeakMap`, so instances are fully independent and don't leak memory when garbage-collected.

Use `mutable` when you want a single reactive field on a class that isn't otherwise managed by MobX, or when you prefer the accessor syntax over `makeObservable`.

### With `makeAutoObservable`

`mutable` and `makeAutoObservable` can coexist. Mark the accessor field as `false` in the annotations map to prevent `makeAutoObservable` from double-wrapping it:

```ts
class Store {
  @mutable accessor count = 0;

  constructor() {
    makeAutoObservable(this, { count: false });
  }
}
```

## `useAutorun`

A `useEffect` wrapper that runs a MobX `autorun` on mount and disposes it on unmount.

```ts
import { useAutorun } from "@jayalfredprufrock/mobx-toolbox/util";

function SyncTitle() {
  useAutorun(() => {
    document.title = appStore.pageTitle; // re-runs whenever pageTitle changes
  });
  return null;
}
```

Equivalent to:

```ts
useEffect(() => autorun(func, options), []);
```
