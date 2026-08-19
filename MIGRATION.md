# Upgrade prompt: mobx-toolbox `model` / `lazy-observable` / `table` / `util`

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

### lazy-observable

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

⚠️ **`lazyObservableArray().value` is now the same array for the lazy's lifetime** — loads replace its
_contents_. Anything watching the array _identity_ as a change signal will stop firing:

```ts
// before: fired on every load, because the array was a new one each time
reaction(
  () => rows.value,
  (items) => persist(items),
);
// after: observe when data landed, or read the contents
reaction(
  () => rows.loadedAt,
  () => persist(rows.value),
);
autorun(() => render(rows.value.slice()));
```

Also check React dependency arrays (`useEffect(…, [rows.value])`) and any `=== previousArray` checks.

⚠️ **`reload()` mid-flight now starts a fresh request** instead of silently joining the one in flight,
and **`set()` now beats an in-flight fetch** instead of being overwritten by it. Both are bug fixes;
code that relied on the old behaviour to deduplicate should use `getOrLoad()`, which still joins.

**Keyed collections.** If you used `lazyObservableArrayMap` to hold one list per key, the replacement
is one store (or one lazy) per list — see _Several stores per model_. If the keys were genuinely
dynamic (a page number, a search term), drive a single lazy from observable params instead, with
`trackDependencies`.

### model

| before                                     | after                                                      |
| ------------------------------------------ | ---------------------------------------------------------- |
| `makeStore(Schema, …)`                     | `makeStore(Model, …)` — the schema form is gone            |
| `store.all`                                | `store.list`                                               |
| config `getAll: …`                         | config `list: ({ signal }) => …`                           |
| `await store.getAll()`                     | `await store.list.getOrLoad()`                             |
| store config `get:` / `create:`            | model config `get:` / `create:` (now statics on the model) |
| model config `reload:`                     | removed — derived from `get`                               |
| `new Model(data, store)`                   | `new Model(data)`                                          |
| `Model.instantiate(data, store)`           | `Model.instantiate(data)`                                  |
| `transform(data, store)`                   | `transform(data)` (`this` is the store)                    |
| `model.store`, `attachStore`, `ModelStore` | removed — see _Mutations travel by event_                  |

A model no longer references a store. `delete()` used to call `store.remove(this)` on the one store
that owned it; now it notifies every listener registered on the model class, so **every** list drops
the record. If you have code compensating for the old single-store behaviour, it can go.

⚠️ **`update()` no longer causes a refetch.** Lists holding the record already show the change,
because identity means they hold the same object. If a list's _membership_ depends on a field that
`update` can change (a status, an owner), opt in: `invalidateOn: ["created", "updated"]`.

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
list: api.listUsers,        // if its first parameter is an options bag
list: (options) => api.listUsers({ status: "draft", ...options }),   // with query params
```

Keep the arrow where it reshapes arguments, or where the client's method is bound to `this`.

**Identity instead of hand-rolled deduplication.** A keyed model class returns the same instance for
the same record. Any local `Map<id, model>` cache, `findById`-then-patch helper, or "refresh the
detail panel after the list reloads" workaround is likely now redundant.

**Mutation events instead of manual refetch calls.** `invalidateOn` (default `["created"]`) and the
automatic delete-sweep replace most `await store.list.reload()` calls after a mutation. Anything that
isn't a store — a count, a chart, a hand-rolled feed — can implement `ModelListener` and register
with `Model.addListener(this)`; listeners are held weakly, so there's nothing to dispose.

**`reloadEvery` instead of a polling timer.** It only runs while the list is observed, measures from
the last completed request, and resets when a manual reload happens. Any `setInterval` around a
refetch is a candidate.

**`trackDependencies: { throttle }` instead of a debounced search wrapper.** Read the query inside the
fetch and it refetches on change, coalescing bursts and aborting superseded requests.

**`{ signal }` instead of manual `AbortController` plumbing.** Every fetch receives one that fires when
its request is superseded.

**`fetching` vs `loading`.** `loading` means "nothing to show yet"; `fetching` means "a request is in
flight". A refresh keeps the old rows visible with `fetching` true, so `if (!loaded) return <Spinner/>`
no longer blanks the table on every poll.

**Several stores per model.** A store is one list. Separate stores for separate queries behave as one
because identity lives on the model — so a single store with client-side filtering, or a store with
branching fetch logic, can often become two or three plain stores. Use `createStore` for the common
case, `makeStore` + a subclass with `collection()` when a list needs reactive parameters.

---

## Code that can now be deleted (Phase 2 — propose first)

- `Map`/`WeakMap` model caches, and any `instantiate`-like helper of your own.
- `store.getAll()` convenience wrappers.
- Wrapper arrows that only forward arguments to the API client.
- `AbortController` plumbing around list fetches.
- Debounce/throttle wrappers around search inputs feeding a lazy.
- `setInterval` polling loops.
- Post-mutation `reload()` calls that `invalidateOn` now covers.
- Code compensating for a model belonging to only one store.
- Selection-restoring hacks around table refreshes (`getRowId` plus the intersect behaviour covers it).
- Hand-written column lists that only exist because configuring one column lost the rest — `columns`
  plus `autoColumns` now compose.
- Custom sorting of a column array to force a column first or last — `order`, or `pinned` for an edge.

---

## Report back with

1. What Phase 1 required, file by file.
2. Each ⚠️ occurrence you found, and how you verified it.
3. The Phase 2 proposal list — ranked, with anything you decided _against_ and why.
4. Anything the new API couldn't express as cleanly as the old code did. That's useful feedback.
