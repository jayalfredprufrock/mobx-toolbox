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

## `useSlowLoading`

Whether a wait has gone on long enough to be worth telling the user about.

```tsx
import { useSlowLoading } from "@jayalfredprufrock/mobx-toolbox/util";

const slow = useSlowLoading(!list.loaded);

if (slow) return <Skeleton />;
if (!list.loaded) return null; // loading, but too early to say so
return <Content rows={list.value} />;
```

Loading UI flashes on fast responses: a request that resolves in 60 ms produces a 60 ms skeleton —
long enough to see, too short to read, and it happens on every navigation. This is the standard
two-part fix, in one place:

- **A threshold.** A wait shorter than `after` (default 300 ms) never surfaces at all.
- **A floor.** Once it has surfaced, it stays for `minDuration` (default 300 ms).

Both halves are needed. A threshold alone turns a 320 ms wait into a 20 ms flash, which is worse than
either extreme.

### Three states, not two

The example above has three branches on purpose. A threshold means there is a window where the wait
is real but not yet worth mentioning, so **"not slow" does not mean "ready"** — the value can still
be missing:

| value   | `slow`  | render                          |
| ------- | ------- | ------------------------------- |
| missing | `false` | nothing — inside the threshold  |
| missing | `true`  | the skeleton                    |
| present | `true`  | the skeleton, held by the floor |
| present | `false` | the content                     |

Both orderings in that snippet are load-bearing:

- **`slow` is tested first**, because the floor outlives the wait. Once up, it stays for
  `minDuration` even after the value lands — and testing the value first would swap the content in
  the moment it arrived, which is the flash the floor exists to prevent.
- **The `null` branch is what makes the threshold real.** Drop it and the first 300 ms render the
  content branch with nothing to put in it — a crash, or an empty screen that then fills in.

`LazyObserver` and `<Table.Loading>` are this same sequence already wired up. Reach for the hook
directly where a component renders its own skeleton.

```tsx
useSlowLoading(active, { after: 100, minDuration: 500 });
useSlowLoading(active, { after: 0, minDuration: 0 }); // the escape hatch: raw flag
```

With both at zero there is no threshold and no floor, so the third state collapses and two branches
are enough — which is exactly what makes it the escape hatch.

Plain boolean in, plain boolean out, so it works the same inside an `observer()` and outside one —
pass it a prop, a piece of React state, or something read off a lazy or a store.

| situation                               | result                                      |
| --------------------------------------- | ------------------------------------------- |
| true for less than `after`              | never surfaces                              |
| flickers true/false/true inside `after` | each rising edge restarts the window        |
| clears while surfaced                   | held until `minDuration` has elapsed        |
| true again before `minDuration` expires | pending hide cancelled; one continuous show |

`LazyObserver` and `<Table.Loading>` both use it, which is what keeps their timing identical to the
router's `[LOADING]`. Reach for it directly when a component renders its own skeleton.

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

---

## `flattenVariants` / `UnionVariants`

TypeBox does not normalize nested unions: `T.Union([A, T.Union([B, C])])` keeps two members in
`anyOf`, one of which is itself a union. But `T.Static` reads it as the flat `A | B | C` — so any
code that walks `anyOf` has to flatten too, or a nested member fails an `extends TObject` test and
silently collapses to `never` (on the type), or gets `.properties` read off it and throws (at
runtime).

```ts
import { flattenVariants, type UnionVariants } from "@jayalfredprufrock/mobx-toolbox/util";

const Shape = T.Union([T.Union([Circle, Square]), Triangle]);

flattenVariants(Shape); // [Circle, Square, Triangle] — every leaf, at any depth
type Leaf = UnionVariants<typeof Shape>; // Circle | Square | Triangle
```

This is what lets `makeUnionModel` and `FormModel` accept a union of unions, and it is exported
because anything else introspecting one of this library's schemas needs the same treatment.
`Value.Check` and `Value.Clean` already recurse on their own, so once the variant list is flat the
nesting makes no difference anywhere.
