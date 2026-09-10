# Upgrade prompt: mobx-toolbox `model` / `lazy-observable` / `table` / `filter` / `util` / `router` / `react-util`

Hand this file to a coding agent working in your repository. It describes a release with
breaking changes to `@jayalfredprufrock/mobx-toolbox`, plus new capabilities that let a fair
amount of existing glue code be deleted.

---

## How to work through this

**Phase 1 — get green, mechanically.** Apply only what is needed to make the project build and its
tests pass. These are the renames and signature changes in _Breaking changes_ below. Don't
restructure anything while doing this.

**Phase 2 — review, then propose.** Everything under _Worth adopting_ and _Code that can now be
deleted_ is optional. Do **not** apply it unopposed. Instead:

1. Read the affected code first and work out what it is actually doing.
2. Write up a short list of proposed changes: file, what you'd change, why it's better, and any
   behavioural risk.
3. Wait for the maintainer to approve before touching anything.

Prefer a small number of well-understood changes over a sweeping refactor. If a piece of existing
code is doing something the new API doesn't quite cover, say so rather than forcing it.

**Watch for silent behaviour changes.** Several items below compile fine and change runtime
behaviour. They are marked ⚠️. Check each occurrence by hand — a passing test suite does not prove
these are right.

---

## Breaking changes

### filter — view props, and `filterOption` is gone

⚠️ **`filterOption` has been removed from the column def.** Whatever a filter UI needs now travels on
the filter itself, in a `props` object whose interface you augment:

```ts
// before
{ key: "category", filter: () => new SetFilter(), filterOption: (v) => <Badge value={v} /> }

// after
declare module "@jayalfredprufrock/mobx-toolbox/filter" {
  interface SetFilterProps {
    renderOption?: (value: SetFilterValue) => ReactNode;
  }
}

{ key: "category", filter: () => new SetFilter({ props: { renderOption: (v) => <Badge value={v} /> } }) }
```

Read it as `filter.props.renderOption?.(facet.value) ?? String(facet.value)` — the `String` fallback
always lived at the call site, so nothing moved there.

Each class has its own interface — `SetFilterProps`, `NumberFilterProps`, `DateFilterProps`,
`TextFilterProps`, and `BucketFilterProps` (extending `SetFilterProps`). All empty by default, so
until you augment, passing `props` is a type error. `props` defaults to `{}`, never `undefined`.

**The rule this follows**, worth knowing before asking for a new column option: the library declares
a named slot only when it _reads_ the value (`hideable` gates snapshot restore), _supplies a
non-trivial default_ (`filterable` is `!== false && filter !== undefined && !selection`), or the
concept is _universal and precisely typable_ (`multiValue`). `filterOption` was none of those —
nothing read it, its default lived at the call site, and "render a value" cannot be typed in a
package that imports nothing from React. Anything view-shaped belongs in `props`.

### table — `predicate` → `filterPredicate`, `search` → `searchFilter`

⚠️ Two renames on `TableModel`, so every member reads as part of one vocabulary:

| before                          | after                                 |
| ------------------------------- | ------------------------------------- |
| `table.predicate`               | `table.filterPredicate`               |
| `table.predicateExcluding(key)` | `table.filterPredicateExcluding(key)` |
| `table.search`                  | `table.searchFilter`                  |
| `TableSearch` (the class)       | `TableSearchFilter`                   |

The naming now says there are **two kinds of filter** — column filters and the search filter — with
the unqualified word covering both. `filterPredicate` composes them; anything spelled `column…`
(`activeColumnFilters`, `clearColumnFilters`, `TableState.columnFilters`) is the narrower half. That
makes `clearColumnFilters` leaving the search alone follow from its name instead of being an
exception to remember.

`TableConfig.search` and `TableState.search` keep their names: those hold the search's _config_ and
its _query text_, not the filter object.

### table — `config.filter` / `setFilter` / `FilterSource` are gone

⚠️ **The page-level filter-source API has been removed.** A `FilterSource` was a reactive object
holding a row `predicate`, passed as `config.filter` and replaced with `setFilter`. Everything it did
is now a column:

```ts
// before
useTable({ rows, filter: hideCompletedStore });

// after — a column that is never rendered and cannot be revealed
{
  key: "_visible",
  value: (row) => hideCompletedStore.on ? !row.done : true,
  filter: () => new SetFilter({ selected: [true] }),
  hidden: true,
  hideable: false,
  filterable: false,
  searchable: false,
  sortable: false,
}
```

A column's `value` fn receives the whole row **and is fully reactive** — it is called inside the
computeds that filter, sort and build facets, so any observable it reads is tracked. That is what
made sources redundant: external state can drive a column predicate with no second concept.

What you gain by the move: such a filter is now counted by `activeColumnFilters`, reset by
`clearColumnFilters`, persisted in `TableState.columnFilters`, and can be server-mode. A
`FilterSource` was none of those, which is why the docs carried an "except `filterSources`" caveat on
each.

What you must still avoid is filtering **upstream** — `rows: () => all.filter(pred)` — because
`setRows` intersects selection against the smaller set and drops it permanently; the table cannot
tell "filtered out" from "deleted".

### filter — `RangeFilter` is now `DateFilter`, plus two new filter types

⚠️ **`RangeFilter` is gone.** It was only ever a date range wearing a generic name, so it has been
renamed and taught to absorb the shapes a date column actually arrives in. Numeric ranges move to the
new `NumberFilter`.

```ts
// before
new RangeFilter({ min: 0, max: 100 }); // a numeric range
new RangeFilter({ min: someDate.getTime() }); // a date range, hand-coerced

// after
new NumberFilter({ op: "between", operand: [0, 100] });
new DateFilter({ min: someDate }); // Date, epoch seconds/millis, or an ISO string
```

⚠️ **Check every `RangeFilter` over a numeric column.** `DateFilter` reads a bare number as epoch
seconds or milliseconds by magnitude, so a bound of `2` becomes 2 _seconds_ after the epoch. If the
column is not a date, it wants `NumberFilter`. If it is a date and your data sits near the epoch, pin
`unit: "ms"`.

`DateFilter` keeps `min`/`max`/`setRange`/`setMin`/`setMax` and adds `range` (the bounds as `Date`s,
for a picker) and `unit`. Bounds are stored as epoch milliseconds, so persisted state stays a pair of
plain numbers.

**`NumberFilter`** carries `eq`, `neq`, `gt`, `lt`, `gte`, `lte`, `between` (inclusive) and
`betweenExclusive`. The operand's shape follows the operator — a number, or `{ min, max }` — and the
types enforce it. Changing the operator alone can leave the filter inactive by design; use
`set(op, operand)` from an operator dropdown.

Interval bounds are **independently optional**, so `{ min: 60 }` is "60 and up". Drive a two-input
range control straight off `min` / `max` / `setMin` / `setMax` — each setter leaves the other bound
alone, so there is no need to mirror the pair into component state, and therefore nothing to go stale
when something else calls `clearColumnFilters()`:

```tsx
<input value={filter.min ?? ""} onChange={(e) => filter.setMin(parse(e.target.value))} />
<input value={filter.max ?? ""} onChange={(e) => filter.setMax(parse(e.target.value))} />
```

The names and the `{ min, max }` shape match `DateFilter` deliberately, so one range control reads
both, and `setRange(min, max)` exists on both.

**`BucketFilter`** filters a numeric column by named range while the column keeps showing and sorting
the raw value — the "show the score, filter by grade" case:

```ts
{
  key: "score",
  filter: () => new BucketFilter({
    buckets: [{ label: "A", min: 90 }, { label: "B", min: 80, max: 90 }, { label: "F", max: 60 }],
  }),
}
```

It **extends `SetFilter`**, so an existing checkbox popover that narrows by `instanceof SetFilter`
renders it with no changes, and facets/counts/blanks/serialization all work as they already did.
Ranges are `[min, max)`. Its condition carries the selected **labels**, so a server needs the same
bucket definitions — map them yourself or keep bucket filters client-side.

The underlying hook is public: `SetFilter`'s new `project` option groups raw values before comparing
them, for any grouping (month-of-date, initials, case-folded). It is on the `ValueFilter` interface
because facet walking has to project identically or the list offers values that select nothing.

### router

Two signature widenings and one default change.

**`router.navigate()` and `router.initialize()` return `Promise<void>` instead of `void`.** Both
resolve once the navigation has landed — guards run, loaders resolved, redirects followed, and the
new route committed. Existing calls keep working untouched; nothing rejects, so ignoring the promise
is safe.

Two things to check by hand:

- If you lint with `no-floating-promises`, existing bare calls now warn. Add `void` to the
  fire-and-forget ones.
- ⚠️ A call used directly as a React effect callback is now a runtime warning, because the effect
  returns a promise where React expects a cleanup function or nothing:

  ```tsx
  useEffect(() => router.navigate({ to: "/" }), []); // now warns
  useEffect(() => void router.navigate({ to: "/" }), []); // fixed
  ```

This is also the cue to delete any "wait for the router to settle" helper you wrote — a polling
`waitFor` on `activeRoute`, or a `setTimeout` in tests. `await router.navigate(...)` and
`await router.initialize(...)` are exact where those were approximate.

**The route-component prop types lost their `Component` infix.** A pure rename — same shapes, same
behaviour:

| before                  | after          |
| ----------------------- | -------------- |
| `PageComponentProps`    | `PageProps`    |
| `WrapperComponentProps` | `WrapperProps` |
| `ErrorComponentProps`   | `ErrorProps`   |
| `LoadingComponentProps` | `LoadingProps` |

Find-and-replace on the type names is the whole migration. If `PageProps` collides with something in
your app — a framework generates one under that name — alias it at the import:
`import type { PageProps as RoutePageProps } from "@jayalfredprufrock/mobx-toolbox/router"`.

⚠️ **Redirects now replace the history entry instead of pushing one.** This applies to every
redirect: a `[REDIRECT]` leaf and a `redirect()` thrown from a guard or loader.
`router.navigate()` and `<Link>` are unaffected — those are ordinary navigations and still push.

The old behaviour left the redirecting URL in history, which traps the Back button: going back
re-matches the redirect and throws the user forward again, so they can never reach the page they
came from. Replacing is what you want in almost every case, which is why it is now the default.

If a specific redirect should stay in history, say so explicitly:

```ts
// route table
old: { [REDIRECT]: { to: "/new", replace: false } },

// thrown from a guard
throw redirect({ to: "/login", replace: false });

```

Existing `replace: true` on a redirect is now redundant but harmless — it can be deleted.

**`<Navigate>` is removed.** It was a fourth way to spell a redirect, and every use it had is
already covered by the route table — which is where a redirect belongs, since the router can then
see it during matching. Replace it:

| `<Navigate>` decided from | Use instead                           |
| ------------------------- | ------------------------------------- |
| nothing / params          | `[REDIRECT]` on the route             |
| a synchronous check       | `[GUARD]` that throws `redirect(...)` |
| loaded data               | `[LOAD]` that throws `redirect(...)`  |

If it was reacting to store state changing while the page was already on screen, that is an
autorun, not a render-time navigation:

```tsx
useAutorun(() => {
  if (!auth.isLoggedIn) void router.navigate({ to: "/login" });
});
```

Related fix: a `redirect()` thrown from a `[LOAD]` no longer marks the outlet `error` on its way
out, so the generic "A route loader or lazy component failed." text no longer flashes before the
new route lands. If you avoided loader redirects because of that flash, they are now clean.

### lazy-observable — the state model

> Read this before the options-and-methods section below: several of those notes describe
> behaviour in terms of the properties this section replaces.

Every change in this section is the same correction: **`status` answered three questions at once**,
and they contradict each other at the edges. A failed refresh kept its value but reported
`status: "error"` and `loaded: false` — so `LazyObserver` threw a working screen to the error
boundary, and `loaded` could never narrow `value`.

There are three independent facts, and now three properties for them:

| fact                          | property   |
| ----------------------------- | ---------- |
| is there a value?             | `loaded`   |
| is a request running?         | `fetching` |
| how did the last request end? | `error`    |

| before                      | after                                           |
| --------------------------- | ----------------------------------------------- |
| `lazy.status === "loaded"`  | `lazy.loaded`                                   |
| `lazy.status === "loading"` | `!lazy.loaded && lazy.fetching`                 |
| `lazy.status === "error"`   | `lazy.error !== undefined`                      |
| `lazy.status === "init"`    | `!lazy.loaded && !lazy.fetching && !lazy.error` |
| `lazy.loading`              | `!lazy.loaded && lazy.fetching`                 |
| `lazy.loadedAt`             | `lazy.fetchedAt`                                |

⚠️ **`lazy.loading` is removed too.** It was `!loaded && fetching`, which made it the one name here
easy to mistake for `fetching` — and the obvious use for it was wrong:

```tsx
if (list.loading) return <Spinner />;
return <List items={list.value} />; // 💥 after a failed first load
```

A failed first load is `loaded: false, fetching: false, error: set`, so `loading` is `false` and that
renders with no value. Gate on `loaded` instead, which has no such hole — and check `error` first,
which is what `LazyObserver` does for you.

For a spinner, `!list.loaded` is almost always what you meant. Where you genuinely need "nothing yet
_and_ working", spell it: `!list.loaded && list.fetching`.

`table.loading` and `table.refreshing` are **unaffected** — different object, and the table exposes no
`fetching` for them to be confused with.

`status` is **removed** rather than deprecated: it cannot be reproduced faithfully, because its
`"error"` value was the bug. Any shim would have to pick a meaning and still be wrong at the edge
that caused the failure.

⚠️ **`loaded` now means "holds a value".** It used to mean "the last request succeeded". The
difference shows up on a failed refresh, which is now `loaded: true` with an `error` — both true at
once. Anywhere you gate rendering on `loaded`, that is the behaviour you wanted; anywhere you used
it to mean "the last request was fine", check `error` instead.

⚠️ **`lazyObservableArray` starts at `undefined`, not `[]`.** `value` is `T[] | undefined`, because
"no rows yet" and "zero rows" are different answers and only one of them is a fact. This is the
change with the widest blast radius:

```ts
// before
rows.value.map(render);

// after — pick whichever fits
if (rows.loaded) rows.value.map(render); // narrows; no `!` needed
rows.value?.map(render);
```

Reading `value` still registers observation while it is `undefined`, so a `value?.map(...)` in a
component still triggers the first load. Nothing about _when_ things load has changed.

To keep the old behaviour on a specific lazy, ask for it — and note it now means what it says
("there are zero rows, and revalidate"), which is what makes it safe:

```ts
lazyObservableArray(fetch, { initialValue: [] });
```

⚠️ **`invalidate({ discard: true })` returns the value to `initialValue`, usually `undefined`.** It
used to empty the array in place. Any assertion like `expect(list.value).toHaveLength(0)` after a
discard becomes `expect(list.value).toBeUndefined()`. This applies to store collections via
`discardOnInvalidate` too.

The array _identity_ guarantee survives: `value` is the same array every time there is one, so a
reference taken before a discard is still valid when the next load fills it back in.

⚠️ **`getOrLoad()` now respects staleness.** It short-circuits on `loaded && !stale` rather than on
`loaded`, which fixes a real bug: `invalidate()` followed by `getOrLoad()` used to hand back the
value it had just been told to replace, and never refetch — but only when nothing happened to be
observing the lazy. The same call now behaves the same way either way.

If you were relying on `getOrLoad()` to be a pure cache read, use `peek`-style access instead: check
`lazy.loaded` and read `lazy.value` directly.

**`initialValue` means loaded-but-stale.** A seeded lazy renders immediately _and_ revalidates on
first observation — which makes it the right shape for hydration from SSR, storage, or a cache. It is
distinct from `set()`, which marks a value authoritative and owes no fetch:

| call                                  | state          | meaning                              |
| ------------------------------------- | -------------- | ------------------------------------ |
| `lazyObservable(f, { initialValue })` | loaded + stale | a starting point, still owed a fetch |
| `lazy.set(value)`                     | loaded + fresh | authoritative; no fetch              |

⚠️ **`getOrLoad()` and `reload()` on a list lazy now resolve with the lazy's own array.** They used
to resolve with the raw fetched payload — a different, plain array that never updated. So a
reference taken from an `await` was a detached snapshot:

```ts
const rows = await store.all.getOrLoad();
await store.create({ … });
rows.length; // before: still the old count. after: reflects the list, because it *is* the list
```

This only differs for list lazies; for a scalar the payload and the value were always the same
object. If you were relying on the snapshot, copy it explicitly: `(await lazy.getOrLoad()).slice()`.

⚠️ **`LazyObserver` no longer throws on a failed refresh.** It re-throws only when there is nothing
to render (`error` with `!loaded`). A refresh that fails while data is on screen keeps that screen —
the previous behaviour destroyed a working page over a background request. The error is still
readable on the lazy if you want to surface it.

**`LazyObserver` delays its placeholder.** It waits 300 ms before showing one and then keeps it up
for 300 ms, so a fast load renders no placeholder at all. ⚠️ The new failure mode is that a slow load
now renders **nothing** for up to 300 ms where it previously reserved space immediately — check any
`placeholder` you are using as a layout reserver rather than a spinner. `sustain={false}` restores
the old behaviour per call site.

---

### lazy-observable — options and methods

These are the API renames, separate from the state-model rework above.

| before                                        | after                                                    |
| --------------------------------------------- | -------------------------------------------------------- |
| `lazy.reset()`                                | `lazy.invalidate()`                                      |
| `resetOnUnobserved: "never"`                  | `keepOnUnobserved: true`                                 |
| `resetOnUnobserved: "always"`                 | `keepOnUnobserved: false` (the default — can be dropped) |
| `resetOnUnobserved: 30_000`                   | `keepOnUnobserved: { for: 30_000 }`                      |
| `shallow: true`                               | `deep: false`                                            |
| `fetch: (signal) => …`                        | `fetch: ({ signal }) => …`                               |
| `lazyObservableMap`, `lazyObservableArrayMap` | removed — see _Keyed collections_ below                  |

⚠️ **`invalidate()` keeps the current value by default.** `reset()` cleared it. If a call site
depended on the list going empty while it refetched, use `invalidate({ discard: true })`.

⚠️ **`invalidate()` only fetches when something is observing.** Unobserved, it drops the value and
the next observation loads. This is intended; just don't expect a request from an invalidate on an
off-screen lazy.

A caller's own demand counts as well, though: `getOrLoad()` respects staleness, so
`invalidate()` followed by an `await` fetches whether or not anything is watching. (It previously
returned the value it had just been told to replace — see the state-model section.)

⚠️ **`lazyObservableArray().value` is the same array from the first load onward** — later loads
replace its _contents_ rather than the array. Anything watching the array _identity_ as a change
signal fires once, when the first load fills it in, and never again:

```ts
// before: fired on every load, because the array was a new one each time
reaction(
  () => rows.value,
  (items) => persist(items),
);
// after: observe when data landed, or read the contents
reaction(
  () => rows.fetchedAt,
  () => persist(rows.value),
);
autorun(() => render(rows.value?.slice()));
```

Before the first load — and after an `invalidate({ discard: true })` — `value` is `undefined` rather
than the array, so read it through `?.` as above. The array itself is never replaced, so a reference
taken earlier is still valid once the next load fills it back in.

Also check React dependency arrays (`useEffect(…, [rows.value])`) and any `=== previousArray` checks.

⚠️ **`reload()` mid-flight now starts a fresh request** instead of silently joining the one in flight,
and **`set()` now beats an in-flight fetch** instead of being overwritten by it. Both are bug fixes;
code that relied on the old behaviour to deduplicate should use `getOrLoad()`, which still joins.

⚠️ **A lazy constructed inside an `observer()` render now loads.** It previously never did — the
constructor's own read of its array spent mobx's single `onBecomeObserved` transition before the
hooks were attached, so the lazy was watched, never learned it, and never loaded at all. Code
that compiled and quietly fetched nothing will start fetching. A workaround that called `getOrLoad()`
by hand is safe to leave in place: it joins the load rather than starting a second one.

**New: `refreshing`, and a warning for the gate it replaces.** `refreshing` is `loaded && fetching`
— a request in flight behind data already on screen. It exists because `fetching` alone is unsafe
to gate a render on, which is worth checking your call sites for:

```tsx
// ✗ renders and fetches forever
if (surveys.fetching) return <Skeleton />;
return <List items={surveys.value} />;

// ✓
if (surveys.refreshing) return <Skeleton />;
return <List items={surveys.value} />;
```

A lazy is observed by reads of `value`, `loaded`, `error` or `refreshing` — never by `fetching` or
`fetchedAt`, so that a header "syncing…" indicator cannot pin a value in memory or start a fetch
just by rendering. The consequence is that a placeholder branch reading _only_ `fetching` observes
nothing: the lazy is dropped, the load aborted, `fetching` cleared, the other branch rendered, and
round again. Development now warns once when it sees that happening, naming the lazy if it has a
`debugName`.

Reading `fetching` alongside something that observes is still fine — `dimmed={surveys.fetching}` on
an element that also reads `value` was never affected. Grep for renders where `fetching` or
`fetchedAt` is the _only_ thing read on a path.

This is most likely to bite where you have just added an `initialValue`: a seeded lazy is `loaded`
from construction, so `if (!loaded)` becomes dead code and `fetching` is the obvious replacement.

⚠️ **`initialValue` now narrows the result, and the unseeded overload no longer accepts it.**
A seeded lazy is `loaded` from construction and a discard restores the seed, so it can never go
back to holding nothing — the type now says so, and `value` reads without a guard:

```ts
const rows = lazyObservableArray(api.listSurveys, { initialValue: [] });
rows.value.length; // was `IObservableArray<Survey> | undefined`, now the array itself
```

Nothing needs changing for that part: the narrowed type is the `loaded: true` arm of the same
union, so every existing signature still accepts it. Redundant guards (`rows.loaded ? … : …`,
`rows.value ?? []`) are now dead code you can delete, and `useLazy` / `useLazyArray` narrow the
same way.

`useLazy` also **gains** `initialValue`, which it never accepted before.

The one thing to fix is a seed that might be `undefined` on a lazy whose type is pinned:

```ts
declare const maybe: number | undefined;

lazyObservable<number>(api.count, { initialValue: maybe });
// ✗ 'initialValue' does not exist in type 'LazyObservableOptions'
```

Nothing can tell that apart from a deliberate `undefined`, so it is rejected rather than guessed
at. Resolve it at the call site — `initialValue: maybe ?? 0`, or branch on it. Where the type is
_not_ pinned, TypeScript widens it to include `undefined` and the call keeps working; and lists
are unaffected either way, since `undefined` is never a list.

⚠️ **Seeding a scalar with `undefined` now reports `loaded`.** For a `T` that includes `undefined`,
`{ initialValue: undefined }` is a real value — the same answer a fetch resolving `undefined` has
always given. It previously read as unseeded. Presence of the option is what counts:

```ts
lazyObservable<Session | undefined>(api.getSession, { initialValue: undefined });
// before: loaded false. now: loaded true, value undefined — no spinner, still revalidates
lazyObservable<Session | undefined>(api.getSession);
// unchanged: loaded false — nothing known yet
```

If you were passing an explicit `undefined` to mean "no seed", drop the option instead. Lists are
unchanged: `{ initialValue: undefined }` on a `lazyObservableArray` still means unseeded.

**Keyed collections.** If you used `lazyObservableArrayMap` to hold one list per key over a single
resource, the replacement is `collectionMap` on a store — one list per key, built on first use, each
one an ordinary collection with the store's mutation handling:

```ts
class Surveys extends makeStore(SurveyModel) {
  byOrg = this.collectionMap(["orgId"], ({ orgId }, options) =>
    api.listSurveys({ orgId, ...options }),
  );
}
```

Where the keys were few and fixed, one named collection per list is still simpler — see _Several
lists, or several stores_. Where they were really a component's own state (a search term, a page),
drive a single collection from that state instead: `trackDependencies` on a subclass field, or
`useCollection` with `params` in the component.

### model

| before                                     | after                                                      |
| ------------------------------------------ | ---------------------------------------------------------- |
| `makeStore(Schema, …)`                     | `makeStore(Model, …)` — the schema form is gone            |
| `store.all`                                | your own collection name — see _Collections_ below         |
| config `getAll: …`                         | `collections: { <name>: ({ signal }) => … }`               |
| `await store.getAll()`                     | `await store.<name>.getOrLoad()`                           |
| config `list:` / `listOptions:`            | an entry in `collections` — there is no reserved `list`    |
| store config `get:` / `create:`            | model config `get:` / `create:` (now statics on the model) |
| model config `reload:`                     | removed — derived from `get`                               |
| `new Model(data, store)`                   | `new Model(data)`                                          |
| `Model.instantiate(data, store)`           | `Model.instantiate(data)`                                  |
| `transform: …`                             | removed — pass the subclass to the store instead           |
| `keys: ["id"] as const`                    | `keys: ["id"]` — `as const` is no longer needed            |
| `model.store`, `attachStore`, `ModelStore` | removed — see _Mutations travel by event_                  |

A model no longer references a store. `delete()` used to call `store.remove(this)` on the one store
that owned it; now it notifies every listener registered on the model class, so **every** list drops
the record. If you have code compensating for the old single-store behaviour, it can go.

⚠️ **`update()` no longer causes a refetch.** Lists holding the record already show the change,
because identity means they hold the same object. If a list's _membership_ depends on a field that
`update` can change (a status, an owner), opt in: `invalidateOn: ["created", "updated"]`.

#### Collections

Lists are named by you and declared in one place. Which place depends only on whether the store needs
behaviour of its own — never a mix of the two:

```ts
// no subclass needed: name them in the config
export const surveys = createStore(SurveyModel, {
  collections: {
    drafts: (options) => api.listSurveys({ status: "draft", ...options }),
    published: api.listPublishedSurveys,
  },
});
await surveys.drafts.getOrLoad();

// needs state or reactive parameters: subclass, and every list is a field
class SurveySearch extends makeStore(SurveyModel) {
  query = "";
  results = this.collection((options) => api.searchSurveys({ q: this.query, ...options }), {
    trackDependencies: { throttle: 300 },
  });
}
```

Two further places a list can live, for parameters the store can't know when it is written:
`collectionMap` builds one list per key on a subclass, and `useCollection` builds one that belongs to
a single component. The README's _Where a list should live_ table says which fits.

`createStore` now requires `collections`; `makeStore` takes no collections at all and every one of its
options is optional. A collection's own options go in the verbose form —
`{ fetch: api.listSurveys, reloadEvery: 30_000 }` — which is where `listOptions` went.

Four options are declared on the store and overridden per collection: `sort`, `invalidateOn`,
`optimisticCreate`, and `discardOnInvalidate` (whether a list blanks while it refetches, default
`false` — the old behaviour). `store.invalidateCollections()` marks every collection stale in one call.

Mechanically: a `list: fn` config becomes `collections: { list: fn }` if you want to keep the name.
A `makeStore(Model, { list })` whose class you instantiated once becomes `createStore`; one you
subclassed keeps `makeStore` and declares `list = this.collection(fn)` alongside its siblings.

⚠️ **A created record no longer appears in a list until the refetch confirms it.** The old config
`list` received an optimistic prepend automatically. Nothing does now: `create()` announces itself,
`invalidateOn` marks lists stale, and the row arrives with the reload. Only the server knows whether
a new record belongs in a filtered list, so opt in per list where it certainly does:
`{ fetch: api.listSurveys, optimisticCreate: true }`, or store-wide with `optimisticCreate: true`.

#### `keys` declares identity

`keys` now says what identifies a record, and answers three different ways:

| `keys`   | Params to API methods | Identity                                        |
| -------- | --------------------- | ----------------------------------------------- |
| `["id"]` | `{ id }`              | one instance per `id` — unchanged               |
| `[]`     | none                  | **singleton** — one instance, full stop         |
| `false`  | none                  | none — the identity statics aren't on the class |

`makeModel(schema)` with no config resolves to `keys: false`.

⚠️ **`keys: []` used to mean "no identity"; it now means "singleton".** If you have a keyless model
that stands for a single resource — settings, the session, the current user — this is the fix you
wanted: `Settings.get()` used to throw and now returns the same instance every time. If instead you
had `keys: []` on a multi-record resource, change it to `keys: false`.

`instantiate`, `forget` and `clearIdentity` are no longer on a model that declared no identity, so
reaching for them is a compile error rather than a runtime throw. To build a detached instance from a
model that _does_ have identity — two live copies of one record, for a before/after diff or history
rows sharing an id — use `new Model(data)`, which never touches the registry.

**The first argument of `get`, `update`, `delete` and the actions is exactly the declared keys.** A
fetcher whose params object carries more than the keys no longer attaches:

```ts
// before — compiled, and drifted on refresh
makeModel(UserSchema, { keys: ["id"], get: api.getUserScoped }); // (params: { id; orgId? })

// after — the extra identifies the record and is a field on it, so declare it
makeModel(UserSchema, { keys: ["id", "orgId"], get: api.getUserScoped });

// after — it doesn't identify anything (and isn't a resource field), so bind it in the config
makeModel(UserSchema, {
  keys: ["id"],
  get: (params) => api.getUserExpanded({ ...params, expand: "roles" }),
});
```

The reason is `reload()`. An instance rebuilds its params from `buildParams()`, which knows only the
keys, so the old form was refreshed **without** the extra — a different request than the load made,
and not necessarily from a call you wrote, since a background refresh under `optimistic` reloads on
its own. Note that promoting a value to a key requires it to be a field on the resource (`keys`
admits only schema fields), which forces the question to be answered properly: if it varies the
payload, identity has to include it, or two variants collide on one instance.

A _narrower_ first argument is still fine — a fetcher may ignore a key it doesn't need — and
`create`'s body is not params, so it carries whatever you like. A parameter typed `any` or carrying
an index signature can't be checked and is attached without judgement.

### table

⚠️ **`setRows` no longer clears selection when `getRowId` is configured.** It intersects: ids that
still resolve to a row survive, the rest drop. So a refetch, a poll, or an invalidation keeps the
user's selection. Without `getRowId`, ids are row positions and state is still cleared outright.
**If you have a table over refreshing data, add `getRowId`.**

⚠️ **`allRowsSelected` / `someRowsSelected` now reflect the _visible_ rows.** They previously compared
a whole-dataset selection count against the filtered row count, which reported "all selected" when a
filter hid every selected row. New `visibleSelectedRows` is selection ∩ filter; `selectedRows` still
spans the dataset. Check any bulk action to decide which population it should act on.

**Factory column definitions now re-derive when data arrives.** A table whose columns come from the
first row used to get none if it was constructed before its data loaded.

---

### table — the header measures itself; `--table-header-height` / `--table-header-gap` change direction

⚠️ **The library no longer reads either variable.** `<Table.Header>` now reports its own border-box
height into the new `table.headerHeight`, and `<Table.Overlay>` — and therefore `<Table.Empty>`,
`<Table.Loading>` and `<Table.Error>` — sizes itself from that instead of subtracting two variables
you had to declare. This compiles fine and changes layout at runtime. Check each table.

**What to do, per table:**

1. **Delete your `--table-header-height` declaration.** It is now an _output_: `<Table.Root>`
   publishes the measured value under the same name. If your own CSS reads it, that keeps working
   and gets more accurate. If your own CSS _sets_ it, remove that — you would be overwriting a
   measurement with a guess, and anything downstream of it will be wrong by the difference.

2. **Check how you space the header from the rows.** The measurement is a border box, so
   `padding-bottom` on `.table-header` is counted and a bottom `margin` is not. If you used a
   margin, convert it to padding:

   ```css
   /* before */
   .table-header {
     margin-block-end: var(--table-header-gap);
   }
   /* after */
   .table-header {
     padding-block-end: 8px;
   }
   ```

   A margin left in place leaves every overlay short by exactly that much — the failure is subtle,
   which is why it's worth grepping for rather than eyeballing.

3. **`--table-header-gap` is no longer part of the contract.** Nothing in the library reads it. Keep
   it if it is a useful spacing token in your own stylesheet; it is just yours now, not shared.

4. **If you render no `<Table.Header>`, your overlays get taller** — correctly. They previously
   reserved a `rowHeight` fallback for a header that wasn't there. Nothing to change; expect the
   message to sit slightly lower and be centred in the full box.

**What this buys you** beyond deleting a declaration: `--table-header-height` is now a number you can
trust in CSS, which makes it possible to line things up with where the rows actually start. The case
that motivated it is insetting a custom scrollbar so it stops at the header instead of running up
behind it — a native scrollbar can never do that, since it belongs to the scroll container and spans
its full height.

**In tests**, `headerHeight` is driven like `width` and `height` are: `ResizeObserver` reports
nothing under happy-dom, so call `table.setHeaderHeight(44)` alongside your existing
`table.setWidth(...)` / `table.setHeight(...)` in any test that asserts an overlay's height.

### table — `<Table.Scroll>`, and chrome moves outside it

⚠️ **Every table needs a new wrapper.** `<Table.Root>` used to render its children inside the
scrolling box; it is now a flex column whose children are the scrolling box _and_ whatever chrome
sits outside the scrollbars. The scrolling box is `<Table.Scroll>`.

```tsx
// before
<Table.Root table={table}>
  <Table.Header>…</Table.Header>
  <Table.Body>…</Table.Body>
  <Table.Empty>No results</Table.Empty>
  <Table.StatusBar>Showing {table.rows.length}</Table.StatusBar>
</Table.Root>

// after
<Table.Root table={table}>
  <Table.Scroll>
    <Table.Header>…</Table.Header>
    <Table.Body>…</Table.Body>
    <Table.Empty>No results</Table.Empty>
  </Table.Scroll>
  <Table.StatusBar>Showing {table.rows.length}</Table.StatusBar>
</Table.Root>
```

**You do not have to find these by hand.** Both mistakes throw in development with a message naming
the component: a part that needs the scrollport rendered outside one, and chrome rendered inside it.
Run the app, fix what throws. (The checks are behind `process.env.NODE_ENV !== "production"`, so they
cost production nothing.)

| goes inside `<Table.Scroll>`                                                                   | goes directly in `<Table.Root>`         |
| ---------------------------------------------------------------------------------------------- | --------------------------------------- |
| `Header`, `Body`, `Row`, `Cell`, `Gutter`, `Expansion`, `Overlay`, `Empty`, `Loading`, `Error` | `StatusBar`, and any chrome of your own |

**Why the bar moved.** Inside the scrolling box it was inside the box the scrollbars measure: the
vertical scrollbar ran past it no matter what, and the bar stopped short of the scrollbar gutter, so
a divider along its top edge visibly ran out into the middle of a scrollbar. There was no styling
fix. Outside, it spans the full width and the scrollbar terminates at its top edge.

**Then check these, in rough order of how quietly they fail:**

1. ⚠️ **`className` and `style` on `<Table.Root>` now land on the outer frame, not the scroll
   container.** No type error, no test failure — your styling simply applies to a different box.
   Anything cosmetic about the _frame_ (border, `border-radius`, background, padding) is now on the
   right element and probably wants nothing; anything about the _scrolling area_ moves to
   `<Table.Scroll className=… style=…>`, which takes every div prop. **Check every occurrence.**

2. ⚠️ **`<Table.StatusBar>` lost its `position: sticky`, its `z-index` and its clipped width.** It is a plain flex child now, full width. If your CSS compensated for any of that —
   an opaque background so rows didn't show through, a `z-index` to sit above the header, a
   negative margin to reach the gutter — delete it.

3. ⚠️ **The short-list behaviour changed.** `StatusBar` used to sit directly under the last row on
   a short list, as a side effect of being sticky inside the scrollport. Now the table fills its
   parent by default and the bar sits at the bottom with dead space above it — the classic shape. To
   get the old behaviour, hug the content: `<Table.Root style={{ height: "auto", minHeight: 240 }}>`.
   The `minHeight` matters if the table can be empty, since an empty box hugs to just its header and
   `<Table.Overlay>` has nowhere to put its message.

4. **`<Table.Overlay>` gained a wrapper element.** It is now an absolutely positioned anchor with
   the sized box as its sticky child, so that it contributes nothing to the scrolling box's content
   height (which is what lets a hugging root size itself from the rows rather than from the
   overlay). If you have a CSS selector or a test querying the overlay's DOM position — a
   `> div:last-child`-style selector especially — it needs one more level. `data-empty`,
   `data-loading` and `data-error` are unchanged and are the selectors to prefer.

   ⚠️ **Overlay placement no longer depends on where you wrote it, and this fixes a real
   misplacement.** The wrapper used to be sticky in normal flow, so the box's `top: headerHeight`
   was measured from wherever the overlay landed rather than from the scrollport: an empty table
   put its message a full header height too low and gained a header's worth of phantom scroll,
   and an overlay shown with rows on screen was pushed off-screen entirely. The anchor is now
   pinned to the top of the scrollport, so the message fills the viewport below the header at any
   scroll offset and in any writing order. **Delete any compensation for the old behaviour** — a
   negative `marginTop`, a `top` override, or an overlay deliberately written before
   `<Table.Header>` — since those now shift the message off its correct position. Overlays written
   before `<Table.Header>` still land correctly; only explicit offsets need removing.

5. **The `maxHeight` prop is gone — use `style={{ maxHeight }}`.** A mechanical rename, and the
   compiler finds every one:

   ```tsx
   <Table.Root table={table} maxHeight={480}>              // before
   <Table.Root table={table} style={{ maxHeight: 480 }}>   // after
   ```

   `style` used to land on the _scroll container_, which is exactly why the prop existed — it was
   the only way to cap the box that got measured. Now that both reach the same element the prop is
   just a second way to say one CSS value, and the table exposes no other style props. If you have a
   comment explaining the old hazard, it is obsolete. Note the three shapes are now all `style` on
   the root: no value fills the parent, `maxHeight` caps it, `height: "auto"` hugs the rows.

6. **`--table-viewport-width` is renamed `--table-scroll-width`.** Grep your stylesheets. The old
   name was actively misleading once there were two boxes: it is set on the _scrolling_ box and holds
   _its_ visible width, while `.table-viewport` is the outer frame. Library-set either way, so this
   only affects CSS of yours that reads it.

7. **`<Table.Scroll>` carries a `.table-scroll` class**, alongside the `.table-viewport` the root has
   always had. If you were reaching the scrolling box through `[role="table"]` or a descendant
   selector, that is what to use now.

8. **In tests**, add `<Table.Scroll>` and keep driving `table.setWidth(...)` / `table.setHeight(...)`
   directly — `ResizeObserver` still reports nothing under happy-dom. One semantic note:
   `table.height` is now the _scrolling box's_ content height rather than the outer frame's, so it
   excludes the horizontal scrollbar and any chrome. In a test that sets it by hand the number means
   the same thing it always did.

**New capability worth knowing about.** `<Table.Scroll>` takes every div prop and merges an incoming
`ref` with its own, so a scroll-area primitive that needs the scrolling element can compose onto it —
Ark UI's `<ScrollArea.Viewport asChild>`, for instance. That is what makes a fully styled custom
scrollbar possible, including insetting it below the sticky header with
`top: var(--table-header-height)`. Nested that way, `<Table.Scroll>` is no longer a direct child of
the root's flex column, so move the sizing to the wrapper and pass
`style={{ flex: "initial", height: "100%" }}`.

### react-util — `useResize` takes an options argument

`useResize(ref, onResize)` is unchanged and still reports the content box. It now accepts a third
argument, `{ box: "content" | "border" }`, for the case where padding and border are part of the
number you need. Purely additive.

---

### table — new column options

Two additions, both opt-in, both aimed at the case where you want _some_ columns configured and the
rest generated.

**`autoColumns`** decides what happens to first-row keys that `columns` doesn't cover:

```ts
useTable({
  rows,
  columns: [{ key: "name", width: 240, pinned: "left" }],
  autoColumns: (key, value) => {
    if (key.startsWith("_") || key === "id") return false;
    if (typeof value === "number") return { key, width: 100 };
    return true;
  },
});
```

It defaults to `true` when `columns` is omitted and `false` when it isn't, so **nothing changes unless
you ask for it** — but configuring one column no longer costs you generation of the rest, which it
used to.

**`order` on a def** is declarative placement, like CSS `order`: lower first, default `0`, ties keep the
def sequence (configured before auto). Useful when the column set is generated and the array order
isn't yours to choose — a curated column can sit after every auto one without enumerating them.

It decides where a column _lands_, not where it stays: a restored snapshot and anything the user has
dragged both outrank it. For keeping a column at an edge, `pinned` is still the answer — pinned columns
are anchored regardless of order.

---

## Worth adopting (Phase 2 — propose first)

### table — `ColumnPin`, and `pinned` is never `undefined`

A named `ColumnPin = false | "left" | "right"` replaces four identical inline unions, and
`ColumnModel.pinned` is now typed and initialised as that — an unpinned column is `false`, never
`undefined`. Previously the constructor overwrote the `false` default with `config.pinned`, so a def
that omitted `pinned` left the field `undefined` while the type said otherwise, and
`column.pinned === false` silently never matched.

⚠️ **`setPinned` no longer accepts `undefined`** — pass `false` to unpin. Nothing in the package did,
and every literal call site is unaffected; a caller holding a `ColumnPin | undefined` now gets a
compile error and has to decide, rather than silently unpinning.

Nothing changes at runtime: every read already used `=== "left"` / `=== "right"` / truthiness, and
`getState()` was normalising with `|| false`, which is now redundant and gone.

### table — declarative column visibility

```ts
{ key: "internalId", hidden: true, hideable: false }   // never shown, never offered
{ key: "name", hideable: false }                        // always shown, never offered
{ key: "actions", pinnable: false }
```

`hidden` is new as a **def** option — previously visibility could only be set imperatively with
`setHidden` after construction. `hideable` and `pinnable` join `sortable` / `filterable` /
`resizable` as advisory flags for pickers and header UIs; the setters are not gated, so a page's own
responsive hiding still works.

They do enforce one thing: **a persisted snapshot cannot override them.** `applyState` now skips
`hidden` for a non-`hideable` column, `pinned` for a non-`pinnable` one, and `width` for a
non-`resizable` one. If you were relying on a saved view restoring a width to a column you have since
marked `resizable: false`, that no longer happens — which is the point.

Read `hideable: false` as locking `hidden` where it starts, not "cannot be hidden". Paired with
`hidden: true` it declares a column that exists only to carry a value or a filter:

```ts
{
  key: "_invalid",
  value: (t) => t.start > t.end,   // whole row, and reactive — reads any observable
  filter: () => new SetFilter({ selected: [true] }),
  hidden: true, hideable: false, filterable: false, searchable: false, sortable: false,
}
```

That is the supported way to filter on something that isn't one field. Filtering _upstream_ instead
(`rows: () => all.filter(pred)`) drops selection permanently, because `setRows` intersects against
the smaller set and the table cannot tell "filtered out" from "deleted".

### `ColumnModel.setConfig` — change one column's options in place

```ts
table.column("amount")?.setConfig({ title: "Total", width: 320 });
```

Previously the only way to change a configured column was `removeColumn` + `addColumn`, which
destroys the `ColumnModel` and everything on it. `setColumns` never worked for this: it keeps the
model behind a key it already has, so a new def for an existing key is ignored wholesale.

`ColumnModel.config` is now an `observable.ref`, so every getter over it — `title`, `width`,
`sortable`, `filterable` — is genuinely reactive. (`title` was previously annotated `computed` over
non-observable state, so it could never actually change.) The user's `hidden`, `pinned`,
`manualWidth` and any filter selection survive a patch.

`key`, `filter` and `selection` cannot be patched, and are compile errors rather than runtime guards.

Useful mainly for driving a column option from React state or a prop, since `useTable` reads its
config once:

```tsx
useEffect(() => table.column("amount")?.setConfig({ title: label }), [label]);
```

Function-valued options (`value`, `render`, `compare`, `searchable`, `filterOption`) never needed
this — they are called fresh each time, so closing them over an observable already works.

### Column filtering, and the new `filter` subpath

**If you have a filter set declared in parallel with your columns, this is what replaces it.**

The new `@jayalfredprufrock/mobx-toolbox/filter` module exports `SetFilter`, `DateFilter`,
`TextFilter`, `BLANK`, `isBlank` and `facetValues`. A filter is a predicate over one _already
extracted value_ — `matches(value)`, not `matches(row)` — so it carries no accessor, no path string
and no row generic.

Attach instances to the column defs; the table feeds each one that column's own value accessor:

```ts
// before — keys line up by hand, and `path` is an unchecked string
const filters = makeFilters({
  category: new SetFilter({ path: "category" }),
});
const table = useTable({ rows, columns, filter: filters });
<DataTable table={table} filters={filters} renderFilterOption={...} />;

// after
const columns = [
  { key: "category", filter: () => new SetFilter(), filterOption: (v) => <Badge value={v} /> },
  // a computed column is filterable now — there was no path for this before
  { key: "name", value: (u) => `${u.first} ${u.last}`, filter: () => new TextFilter() },
];

const table = useTable({ rows, columns });
<DataTable table={table} />;
```

What you get on the model:

| Member                             | Description                                                |
| ---------------------------------- | ---------------------------------------------------------- |
| `table.filterPredicate`            | everything narrowing rows, composed; `undefined` = nothing |
| `table.activeColumnFilters(opts?)` | active filters; `{ mode }` counts one side of the split    |
| `table.clearColumnFilters()`       | reset every column filter                                  |
| `table.searchFilter`               | the search filter — one query across many columns          |
| `table.column(key)`                | the `ColumnModel` under a key                              |
| `column.filter` / `column.facets`  | the filter, and its value domain to render                 |
| `column.filterable`                | advisory header-UI flag, exactly like `sortable`           |
| `filter.multiValue`                | declares array values, so a UI can offer any/all           |

Points worth checking by hand as you port:

- ⚠️ **Use the factory form (`filter: () => new SetFilter()`) for defs hoisted out of the
  component**, which is where column defs usually live. A bare instance there is constructed once per
  module, so filter state is shared across every mount and across two tables built from the same
  defs — a stale selection after navigating away and back. Pass an instance only when you want that
  sharing or need a direct reference.

- ⚠️ **`activeFilterCount` and `clearFilters` are now `activeColumnFilters` and
  `clearColumnFilters`**, and the count is a getter returning `ColumnModel[]` rather than a number.
  The `column` qualifier is load-bearing: **search is not a column filter**, and neither are
  it holds a row `predicate`, belongs to no column, and is untouched by `clearColumnFilters`. Say
  what you mean at the call site:

  ```ts
  table.activeColumnFilters.length + (table.searchFilter.active ? 1 : 0); // everything narrowing
  table.activeClientColumnFilters.length > 0; // what Clear resets
  ```

  `activeClientColumnFilters` and `activeServerColumnFilters` are there for the two common splits.
  ic — `predicate` and
  `filterQuery` are narrowed by the search too, so a `column` prefix would be a lie there.

- ⚠️ **`filteredRows` is now `clientFilteredRows`.** Same value, clearer name: it is the half this
  table applies, since a server-mode filter was already applied to `rows` before they arrived. The
  pipeline reads `rows` → `clientFilteredRows` → `displayRows`.

  ⚠️ Previously the count _included_ search, so anything gating a "clear filters" control on it was
  over-reporting — showing for a search-only state that `clearFilters` would not then clear.

- ⚠️ **`TableState.filters` is now `TableState.columnFilters`**, for the same reason. Snapshots
  written before this release keep the old key and will be ignored; there is no automatic migration,
  so either rename the key on read or accept one reset.
- **Configured columns now exist at construction**, so `column(key)`, `activeColumnFilters`,
  `predicate` and `filterQuery` are meaningful before the first response. Previously a `RowSource`
  that started empty left the table with no columns until data landed, which meant a page fetching
  _from_ `filterQuery` sent its first request with no conditions. Factory defs and `autoColumns`
  still wait for a row, as they must.
- **`Facet.value`, `ColumnFilter.options` and `filterOption`'s parameter are `SetFilterValue`**, not
  `unknown` — a facet's value genuinely is a `string | number | boolean`, since `facetValues`
  stringifies anything else. So `filter.toggle(facet.value)` and a `filterOption: (value) => …` need
  no casts. A custom `ColumnFilter` declaring options outside that set is now a compile error, where
  before it was a facet that silently matched nothing.
- **Facet counts mean different things per match mode, and the filter decides which.** Under `"any"`
  a count is the conventional "rows carrying this value". Under `"all"` each pick narrows, so it is
  the size of the intersection with what is already picked — exactly predictive, tick it and you get
  that many rows. `SetFilter.intersecting` is what signals this; the table never interprets match
  modes itself. A custom `ColumnFilter` whose picks intersect must declare it or its counts will
  read high.
- **A value found only in rows the other filters exclude is still listed, at zero.** Do not filter
  zero counts out of a popover — that is where someone goes to undo an over-narrowed filter, and
  dropping them strands a ticked value with no checkbox to untick. A standing rail can drop them
  with `facets.filter((f) => (f.count ?? 1) > 0 || filter.has(f.value))`.
- **Facets have three cost tiers.** `new SetFilter()` discovers values with one row walk;
  `{ options: [...] }` skips the walk entirely; `{ counts: true }` adds cross-filtered counts and is
  the expensive one — O(rows × other active filters), recomputed on any toggle. Don't reach for
  `counts` by default.
- **Blanks are just a selected value.** `null`, `undefined`, `""` and `[]` all normalise to `BLANK`,
  which sits inside `selected` like anything else. If you have special-cased "no value" state in a
  filter UI, delete it. `facet.blank` is the render hint for the "(Blank)" label.
- ⚠️ **A hidden or `filterable: false` column still filters.** That is deliberate — it is how a
  sidebar-driven filter works — but if you were relying on hiding a column to disable its filter,
  it no longer does. Use `activeColumnFilters` to disclose it.
- ⚠️ **`clearColumnFilters()` does not clear the search.** Call `search.clear()` explicitly if you
  want both.
- **Search reads hidden columns** by design (`searchable` describes the data, not visibility). Set
  `searchable: false` per column to opt out, or `searchable: (row) => string` to search a projection
  — e.g. a date column as formatted text rather than epoch millis.
- **No filter UI ships.** Build the popover with your design system off `column.facets` /
  `column.filter`, the same way you already build sort controls.
- ⚠️ **`getState()` now includes `filters` and `search`, and `onStateChange` fires on every
  keystroke.** If you write to `localStorage` straight from `onStateChange`, debounce it. They are
  separate top-level keys so you can split them from the arrangement and debounce the halves apart:
  `const { filters, search, ...arrangement } = state`.
- **`filters` is a complete picture when present**, so `applyState` clears any filter it does not
  mention — restoring a view saved with nothing filtered clears filters applied since. `getState`
  always emits the key, empty included, exactly as it does `columns` and `sorts`. Snapshots written
  before this release simply have no `filters` key and still apply.
- **`setValue` now takes `unknown` and validates.** Persisted state crosses app versions and gets
  hand-edited in URLs, so a snapshot of the wrong shape resets the filter rather than corrupting it.
  If you were calling `setValue` with a typed value, nothing changes.

**Server-side filtering** is now first-class. Set `filterMode: "server"` on a column and its filter
stops narrowing rows locally, serializing into `table.filterQuery` instead:

```ts
{ key: "time", filter: new DateFilter(), filterMode: "server", field: "created_at" }

reaction(
  () => table.filterQuery,
  (query) => void refetch({ where: query?.map(toClause) }).then((r) => table.setRows(r)),
  { equals: comparer.structural },
);
```

`filterQuery` is a `FilterCondition[]` — `{ field?, op, value }`, plain JSON — not a query language.
Map it onto whatever your endpoint speaks. `search: { mode: "server" }` does the same for the
cross-column search, contributing `{ op: "search", value }` with no field.

The client and server sets are **disjoint**: a server-mode filter is never evaluated locally, so
nothing is applied twice. Client filters still narrow what the server returns, because the table
filters over `rows` without replacing them.

- ⚠️ **A server-mode column's facets never walk the rows and never carry counts.** Both would be
  computed over rows that filter already narrowed — the list would collapse to whatever is selected
  and could never be widened. Declare `options` on the filter; without one, the facet list is empty.
- **`clearColumnFilters({ mode: "client" })`** resets one side only.
- Debouncing and cursor invalidation on `filterQuery` change are yours.

**Attach API client methods directly.** Config functions pass their signatures through, so a wrapper
arrow that only forwards arguments can go:

```ts
// before
get: ({ id }) => api.getUser({ id }),
create: (body) => api.createUser(body),
list: () => api.listUsers(),
// after
get: api.getUser,
create: api.createUser,
collections: {
  all: api.listUsers,                                          // first parameter is an options bag
  drafts: (options) => api.listUsers({ status: "draft", ...options }),   // with query params
},
```

Keep the arrow where it reshapes arguments, or where the client's method is bound to `this`.

**`sort` instead of ordering at the call site.** Ordering is often the last thing keeping a client
method from being attached directly. Declare it once on the store and every collection inherits it;
it runs over model instances on each load:

```ts
createStore(SurveyModel, {
  sort: (a, b) => a.title.localeCompare(b.title),
  collections: { all: api.listSurveys, drafts: api.listDraftSurveys },
});
```

A single collection overrides it, or opts out with `sort: false` to keep server order — a
relevance-ranked search, say. Look for `.sort()` in components, in `computed` getters that exist only
to order a list, and in wrapper arrows around list endpoints.

**Identity instead of hand-rolled deduplication.** A keyed model class returns the same instance for
the same record. Any local `Map<id, model>` cache, `findById`-then-patch helper, or "refresh the
detail panel after the list reloads" workaround is likely now redundant.

**Mutation events instead of manual refetch calls.** `invalidateOn` (default `["created"]`) and the
automatic delete-sweep replace most `await store.<name>.reload()` calls after a mutation. For a
refresh no mutation describes — a tenant switch, a filter reset — `store.invalidateCollections()`
marks every collection stale in one call, so hand-rolled loops over each list can go. Anything that
isn't a store — a count, a chart, a hand-rolled feed — can implement `ModelListener` and register
with `Model.addListener(this)`; listeners are held weakly, so there's nothing to dispose.

**`reloadEvery` instead of a polling timer.** It only runs while the list is observed, measures from
the last completed request, and resets when a manual reload happens. Any `setInterval` around a
refetch is a candidate.

**`trackDependencies: { throttle }` instead of a debounced search wrapper.** Read the query inside the
fetch and it refetches on change, coalescing bursts and aborting superseded requests.

**`{ signal }` instead of manual `AbortController` plumbing.** Every fetch receives one that fires when
its request is superseded.

**`loaded` vs `fetching`.** `loaded` means "there is a value"; `fetching` means "a request is in
flight". They are independent, so a refresh keeps the old rows visible with both true, and
`if (!loaded) return <Spinner/>` no longer blanks the table on every poll.

**Several lists, or several stores.** Separate queries behave as one because identity lives on the
model — so a single store with client-side filtering, or a store with branching fetch logic, can
often become two or three named collections. Use `createStore` with `collections` for the common
case, `makeStore` + a subclass when a list needs reactive parameters or the store needs state. Split
into separate stores when the lists have genuinely different lifetimes.

**`collectionMap` instead of a map of stores.** A resource fetched per tenant, per parent record, or
per page no longer needs a `Map<id, Store>` and the bookkeeping around it. Key fields are declared
against the schema and typed from it, and each key's list joins the store's mutation handling like
any other. Unobserved keys drop their rows on their own; `forget(key)` and `clear()` cover a key that
is finished with — a logout, an organization the user left.

**`useCollection` instead of per-component fetch glue.** Where a list's parameters are a component's
own state, the old shape was `useState` plus `useEffect` plus a fetch plus more `useState` for
loading and error, with models built by hand. That is one call now: params are plain React values,
the result is a `LazyObservableArray`, and records go through the model's identity map — so an edit
made anywhere in the app shows up in it, and nothing needs disposing. Reach for it instead of putting
a component's filter state on a shared store, which is what stops the store being shared.

**Typed `route.context` in guards and loaders.** `route.context` has always been
`Record<string, any>`. Declare its shape by augmenting `MobxRouterContext`, alongside the
`MobxRouter` augmentation you already have:

```ts
declare module "@jayalfredprufrock/mobx-toolbox/router" {
  interface MobxRouterContext {
    public: boolean;
    requiredRole?: string;
  }
}
```

```tsx
[GUARD]: async (route) => {
  if (!route.context.public) throw redirect({ to: "/login" }); // boolean, not any
};
```

**Nothing to migrate** — without the augmentation `route.context` is exactly what it was.

Two things worth knowing before you reach for it. It describes the **app**, not a path: context
merges down the tree, so the interface is the union of what any level may contribute — mark a key
optional if only some branches set it. And nothing checks it against your `[CONTEXT]` declarations;
it is an assertion about them.

This exists because a guard or loader **cannot** name a path-derived type: both live inside the
object `makeRoutes()` is inferring, and the computed types resolve through that same object, so
annotating one collapses the route tree to `any`. Components outside the tree don't need it —
`PageProps<"/path">` computes the exact context in force there.

**Typed route props, if loading lives in the route file.** `PageProps` and
`WrapperProps` now take an optional path, and resolve `route` against the augmented route
tree:

```tsx
export const StudyPage: FC<PageProps<"/org/:orgId/studies/:studyId">> = ({ route }) => {
  route.params.studyId; // string
  route.data.study; // that level's [LOAD] payload
  route.data.org; // ...and every ancestor's, merged
  route.context.tenant; // [CONTEXT] at or above the path
};
```

⚠️ **Annotate the const, not the parameter.** `({ route }: PageProps<…>) => …` puts the component's
_inferred_ type on the path that resolves through `MobxRouter["routes"]`, closing a cycle: the route
tree imports the component, the component's type reads the route tree.

It can compile in isolation and then collapse once several components in one tree use it — and the
failure does not point at the cause. You get `TS7022` on components you just touched, plus a cascade
of unrelated `Type '{ orgId: string }' is not assignable to type 'undefined'` on `navigate()` calls,
because `RoutePath` has degraded to `any`. If you see that, look for a parameter annotation.

A `makePage(path, component)` helper is the obvious ergonomic fix and a dead end: `<P extends
RoutePath>` is itself a circular constraint (`TS2313`). Annotating the const is the whole answer.

`data` is every `[LOAD]` at and above the path, deeper winning — which is what `route.data` holds at
runtime. Descendant _loaders_ are excluded, since sibling branches can define the same key with
different types and which one ran isn't knowable from the path. Groups (`_list`) contribute config
without contributing a segment.

Descendant **params** are included on a wrapper, as optional — a wrapper renders over its
descendants, params are strings, and the set is knowable, so `string | undefined` is exactly true:

```tsx
export const SegmentsShell: FC<WrapperProps<"/org/:orgId/segments">> = ({ route }) => {
  route.params.orgId; // string
  route.params.segmentId; // string | undefined — from the level below
};
```

That replaces a hand-written `as string | undefined` in any shell that renders over a detail route
and reads its param. Pages are unaffected: a page at `/org/:orgId/studies` matched without
`:studyId`, so it stays exact.

Wrappers take a `RoutePrefix` rather than a `RoutePath`, because the level a wrapper sits on usually
addresses no page and so never appears in `RoutePath`:

```tsx
export const OrgShell: FC<WrapperProps<"/org/:orgId">> = ({ route }) => route.data.org;
```

**Nothing to migrate.** Both types keep working with no argument — that is still the untyped `Route`.
An app that never names a path pays about a dozen extra type instantiations for the feature existing;
each component that does costs ~460, independent of how big the route tree is.

`[ERROR]` and `[LOADING]` components deliberately have no path form: error routes never run ancestor
loaders and loading components render while loaders are still in flight, so a typed `route.data`
would name fields that aren't there.

**`useSlowLoading` instead of hand-rolled skeleton timing.** The threshold-plus-floor behaviour that
`[LOADING]` routes have always had is now public and used by `LazyObserver` and `<Table.Loading>`, so
all three surfaces agree at 300/300. Reach for it directly wherever a component renders its own
skeleton:

```tsx
const slow = useSlowLoading(!list.loaded);

if (slow) return <Skeleton />;
if (!list.loaded) return null; // loading, but too early to say so
return <Content rows={list.value} />;
```

Anything currently rendering a skeleton straight off `loading` is flashing it on fast responses.

⚠️ **Three branches, not two.** "Not slow" does not mean "ready" — during the threshold the wait is
real and the value is still missing, so a two-branch version renders the content with nothing to put
in it. And test `slow` _before_ the value: the floor deliberately outlives the wait, so checking the
value first swaps the content in the instant it lands and reintroduces the flash. See
[`useSlowLoading`](src/util/README.md#three-states-not-two).

**Hand a lazy to a table instead of `.slice()`.** `rows` now accepts a _row source_ — anything with
`value` and `fetching`, which `LazyObservableArray` satisfies:

```tsx
// before
useTable({ rows: () => store.all.value.slice(), getRowId });

// after
useTable({ rows: store.all, getRowId });
```

The table tracks contents itself, so the `.slice()` footgun is gone — and it applies the dataset
once rather than copying every row on every load.

Keeping a getter is still right when the rows are _derived_ rather than handed over, but `value` can
now be `undefined`, so it needs a guard and it carries no loading information:

```tsx
useTable({ rows: () => store.all.value?.filter(isActive) ?? [], getRowId });
```

More importantly, the row-source form can distinguish a first load from an empty result, which is
what removes this workaround:

```tsx
// before — or the table claims "no results" during the first fetch
<Table.Empty>{list.loading ? undefined : <EmptyState />}</Table.Empty>

// after — both slots gate themselves
<Table.Empty>{table.rows.length ? "No matches" : "No users yet"}</Table.Empty>
<Table.Loading><Skeleton /></Table.Loading>
```

`table.loading`, `table.refreshing` and `table.isEmpty` are available directly if you render your
own. A refresh keeps its rows on screen and interactive rather than swapping in a skeleton, so
scroll position, column arrangement and selection all survive it.

⚠️ `<Table.Empty>` now gates itself on `table.isEmpty`. An existing outer gate
(`{cond && <Table.Empty>}`) still works and is simply redundant. `table` still takes no dependency on
`lazy-observable` — `RowSource` is a structural shape it declares itself.

**`useModel` for a details page — the last place an app had to reach for `lazyObservable`.** Loading
one record in a component had no first-class shape. Both of these work; the third is the one to
write now:

```tsx
// before
const study = useMemo(() => lazyObservable(() => StudyModel.get({ id: studyId })), [studyId]);

// intermediate — correct, but the deps array restates what the fetch already closes over
const study = useLazy((o) => StudyModel.get({ id: studyId }, o), [studyId]);

// now
const study = useModel(StudyModel, { id: studyId });
```

**The params are the dependencies**, so there is no array to keep in step with them — which is a real
bug class, not just noise:

```tsx
useLazy((o) => StudyModel.get({ id, orgId }, o), [id]); // `orgId` forgotten — silently stale
useModel(StudyModel, { id, orgId }); // can't desync
```

Params are typed from the model's `keys`, compared shallowly, and key order is not a change. The
result is an ordinary `lazyObservable` over the model's `get`, so it honours the model's `cache`,
aborts superseded requests, and hands back the identity-mapped instance. A model with no key params
(`keys: []` or `keys: false`) takes no params argument at all — `useModel(SettingsModel)`, with any
options moving up into the second slot.

`useCollection` is unchanged and keeps its name — `useModel` / `useCollection` reads as singular and
plural, and both take a model as their first argument.

**It requires `get(keys, options?)`** — or `get(options?)` with no keys. The hook makes exactly that
one call, so a single fetch-options bag has to satisfy everything after the params, and a model whose
`get` wants more is rejected at the hook rather than being handed the bag in the wrong argument:

```ts
const Study = makeModel(StudySchema, {
  keys: ["id"],
  get: api.getStudy, // (params, expand: string, init?: RequestInit)
});

useModel(Study, { id }); // ✗ UseLazyInstead_GetTakesMoreThanParamsAndFetchOptions
```

Your client's own options type is fine — `RequestInit`, `{ signal?: AbortSignal }`, anything a bag
can stand in for, optional or required. What it can't be is an argument the bag isn't. Marking that
argument optional doesn't help either: arguments go by position, so the bag would arrive as the
`expand` and the request would get no signal at all.

Reach past it to `useLazy` for those, and for anything that isn't a model record — a count, a
summary, an endpoint with no model behind it:

```tsx
const study = useLazy((o) => Study.get({ id }, expand, o), [id, expand]);
```

Writing the call yourself means the dependency list is yours again, which is the trade: everything
the fetch closes over has to be listed.

**`useLazy` instead of `useMemo(() => lazyObservable(…))` for anything else.** Loading one record
in a component had no first-class shape, so the pattern was:

```tsx
// before
const study = useMemo(() => lazyObservable(() => StudyModel.get({ id: studyId })), [studyId]);

// after
const study = useLazy((options) => StudyModel.get({ id: studyId }, options), [studyId]);
```

Two things that fixes beyond the noise. `useMemo` is a performance hint React is allowed to discard
and recompute — which would rebuild the lazy and silently drop what it had loaded; `useLazy` holds it
through `useStable`, which does not. And passing the fetch options through gives you abort-on-supersede,
so navigating quickly between records cancels the request you no longer want. `useLazyArray` is the
same for a list-shaped value.

**`Model.peek` / `Model.reload`, and `cache` on a model.** Three ways to reach a record, so nothing
needs a per-call cache flag:

```ts
StudyModel.peek({ id }); // sync — the loaded record or undefined, never fetches
StudyModel.get({ id }); // honors the model's `cache` config
StudyModel.reload({ id }); // always calls the API
```

`cache: true | { for: ms }` on the model config lets `get` answer from the identity map instead of the
API — the identity map is already a cache of records, and this decides whether `get` may use it. It
defaults to `false`, so nothing changes until you opt in. `optimistic: true` additionally hands back a
stale record immediately and refreshes it in the background.

⚠️ **Only turn `cache` on where the payload is the same shape wherever it is loaded from.** If a list
endpoint returns a projection and the detail endpoint returns the whole record, those are two models,
not one cached model — `setData` is a full replace, so a cached record would serve list-shaped data to
a detail page with its extra fields permanently `undefined`. This is the existing "payload shapes must
agree" rule, and `cache` is where it starts to bite.

A failed background refresh under `optimistic` is **not** a new error source to handle: it is logged
and clears the record's load stamp, so the next `get` goes to the API and reports failure through the
normal path.

**`useStable` instead of `useMemo` for anything holding state.** Not model-specific — reach for it
wherever a `useMemo` is holding a controller, a subscription, or any object whose identity carries
state rather than caching a computation.

**`useObservableBox` instead of a hand-rolled React-to-MobX bridge.** Any `useRef(observable.box(…))`
plus an effect that writes props or `useState` into it — feeding a `reaction`, a `computed`, or
`trackDependencies` — is that hook, including the shallow comparison that stops an object rebuilt
every render retriggering everything reading it.

**Subclass statics are typed through the subclass.** `Admin.get(…)` and `Admin.create(…)` now return
`Admin`, as `Admin.instantiate(…)` already did. Any cast or `as Admin` around those results can go.

---

## Code that can now be deleted (Phase 2 — propose first)

- A parallel filter-set declaration whose keys had to match column keys by convention, and the
  plumbing that threaded it into both `useTable` and the table component.
- `path` options on filters, and any `getPath`-style resolver behind them — the column's own accessor
  replaces both, including for computed columns that never had a path.
- A `renderFilterOption` prop plus the `column.key === "..."` switch inside it — that is
  `filterOption` on the column def now.
- Hand-rolled "contains" search predicates across columns — `table.searchFilter` covers them.
- Separate blank/"(No value)" filter state — `BLANK` is an ordinary selected value.

- `Map`/`WeakMap` model caches, and any `instantiate`-like helper of your own.
- `Map<key, Store>` or `Map<key, lazy>` caches keyed by tenant or parent id — `collectionMap` covers them.
- Per-component `useState`/`useEffect` fetch blocks, their loading and error flags, and the model
  instances built by hand inside them.
- Hand-rolled `observable.box` bridges mirroring props or `useState` into MobX.
- `store.getAll()` convenience wrappers.
- `transform` config functions — pass the subclass to the store instead: `createStore(Admin, …)`.
- `.sort()` calls and order-only `computed` getters over a store's lists — `sort` covers them.
- Casts around `Model.get` / `Model.create` results on a subclass.
- `as const` on `keys`.
- Wrapper arrows that only forward arguments to the API client.
- `AbortController` plumbing around list fetches.
- Debounce/throttle wrappers around search inputs feeding a lazy.
- `setInterval` polling loops.
- Post-mutation `reload()` calls that `invalidateOn` now covers.
- Code compensating for a model belonging to only one store.
- Selection-restoring hacks around table refreshes (`getRowId` plus the intersect behaviour covers it).
- `empty={list.loading ? undefined : …}` gating around a table's empty state — both slots gate
  themselves now.
- `.slice()` in a table `rows` getter, where the rows are handed over rather than derived.
- Hand-rolled skeleton delay/minimum-duration timers — `useSlowLoading` is the same behaviour the
  router's `[LOADING]` has always had.
- `useMemo(() => lazyObservable(() => Model.get(…)), [id])` blocks on detail pages — `useModel`.
- `{ deep: false }` on a lazy over models. It was never required (MobX leaves an already-observable
  value alone) and `store.collection` sets it for you; keep it only where you measured it.
- Redirect call sites passing `replace: true` — that is the default now.
- Hand-written column lists that only exist because configuring one column lost the rest — `columns`
  plus `autoColumns` now compose.
- Custom sorting of a column array to force a column first or last — `order`, or `pinned` for an edge.
- `--table-header-height` declarations, and any JS constant mirroring the header's height or the gap
  below it into a style object. The header is measured now; `<Table.Root>` publishes the number.
- `--table-header-gap` as a _shared_ token, if it existed only so the library could find out about
  your header padding. Keep it as your own spacing variable if you like it.
- CSS compensating for a vertical scrollbar running up behind the sticky header — a custom scrollbar
  inset with `top: var(--table-header-height)` replaces the whole workaround. (The scrollbar itself
  is yours to build or to take from a scroll-area primitive; the library only supplies the number.)
- Any `calc()` in your own overlay or empty-state styling that re-derived "height minus header",
  which `<Table.Overlay>` now does exactly.
- Flex or grid wrappers you built _around_ `<Table.Root>` to place a status bar, pagination or a
  toolbar next to the table, plus the height arithmetic that fed them. Chrome goes inside the root
  now and the browser subtracts it.
- A `maxHeight` used purely to reserve room for a bar rendered below the table — the bar can be
  chrome inside the root instead, and then nothing needs a fixed cap at all.
- Opaque backgrounds, `z-index` values and negative margins on a status bar, all of which existed to
  survive being inside the scrollport.
- `{!table.loading && !table.error && <Table.StatusBar>}` guards added _because_ the bar painted
  over the overlay surfaces. It no longer overlaps them. Keep the guard only if showing a row count
  beside an error message actually reads badly.
- Comments and wrapper props warning that `style={{ maxHeight }}` lands on the wrong box, and any
  helper that existed to funnel a height into the `maxHeight` prop.
- Selectors reaching the scrolling box the long way round — `.table-viewport > [role="table"]` and
  similar — now that it has a `.table-scroll` class of its own.

---

## Report back with

1. What Phase 1 required, file by file.
2. Each ⚠️ occurrence you found, and how you verified it.
3. The Phase 2 proposal list — ranked, with anything you decided _against_ and why.
4. Anything the new API couldn't express as cleanly as the old code did. That's useful feedback.
