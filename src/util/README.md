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

## `useObservableBox`

Mirrors a plain React value into an observable box, so MobX code can react to it.

React state isn't observable, which leaves a gap wherever the two meet: a `reaction`, an `autorun`, a
`computed`, or a lazy observable's `trackDependencies` can't see a value that lives in `useState` or
arrives as a prop.

```tsx
import { useObservableBox, useAutorun } from "@jayalfredprufrock/mobx-toolbox/util";

function Surveys({ orgId }: { orgId: string }) {
  const [query, setQuery] = useState("");
  const params = useObservableBox({ orgId, query });

  useAutorun(() => console.log(params.get().query));
  return null;
}
```

The box is created once and kept for the component's lifetime, so a reaction holding it stays valid
across renders. Two details it settles that are easy to get wrong by hand:

- **The write happens in an effect**, not during render, so the render itself stays free of side
  effects.
- **Values are compared, not assigned blindly**, so the object literal you rebuild every render
  doesn't retrigger every reaction reading it. The default is `comparer.shallow`, which is what makes
  `{ orgId, query }` count as unchanged while its fields are. Pass `comparer.structural` for values
  nested deeper than a field, or `comparer.default` for plain referential equality:

```ts
const filter = useObservableBox(value, { equals: comparer.structural });
```

The flow is one-way: the box mirrors the value, so writing to it from MobX's side holds only until
the next render whose value disagrees. Keep the value where React already keeps it.

## `WeakRefMap`

A map with strong keys and weak values: entries disappear on their own once nothing else references
the value. Used by `@mobx-toolbox/model` as the identity registry behind `Model.instantiate`.

```ts
import { WeakRefMap } from "@jayalfredprufrock/mobx-toolbox/util";

const cache = new WeakRefMap<number, UserModel>();
cache.add(user.id, user); // returns the value
cache.get(user.id); // the same instance, while something still holds it
cache.has(user.id);
cache.delete(user.id); // drop immediately rather than waiting for collection
cache.clear();
```

Identity therefore lasts exactly as long as someone holds the value — it is a liveness guarantee,
not global uniqueness. Once the last reference goes, a lookup misses and the caller builds a fresh
value, which is unobservable since nothing was holding the old one.

Two things to know:

- **Keys must not reference their values.** The key is retained by the `FinalizationRegistry`, so a
  key holding a back-reference to its value would keep it alive and quietly defeat the point.
  Primitive keys (an id, a composite string) are the intended use.
- **`get` is the only honest read of liveness.** Between a value being collected and its finalizer
  running, a dead entry can still sit in the underlying map; `get` returns `undefined` for it.
