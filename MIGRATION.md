# Upgrade prompt: mobx-toolbox `model` / `lazy-observable` / `table` / `util` / `router` / `react-util`

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

### router

No API changed here — one default did.

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
  if (!auth.isLoggedIn) router.navigate({ to: "/login" });
});
```

Related fix: a `redirect()` thrown from a `[LOAD]` no longer marks the outlet `error` on its way
out, so the generic "A route loader or lazy component failed." text no longer flashes before the
new route lands. If you avoided loader redirects because of that flash, they are now clean.

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

⚠️ **A lazy constructed inside an `observer()` render now loads.** It previously never did — the
constructor's own read of its array spent mobx's single `onBecomeObserved` transition before the
hooks were attached, so the lazy was watched, never learned it, and sat at `"init"` forever. Code
that compiled and quietly fetched nothing will start fetching. A workaround that called `getOrLoad()`
by hand is safe to leave in place: it joins the load rather than starting a second one.

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

**`fetching` vs `loading`.** `loading` means "nothing to show yet"; `fetching` means "a request is in
flight". A refresh keeps the old rows visible with `fetching` true, so `if (!loaded) return <Spinner/>`
no longer blanks the table on every poll.

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

**`useLazy` instead of `useMemo(() => lazyObservable(…))` for a details page.** Loading one record
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
- Hand-written column lists that only exist because configuring one column lost the rest — `columns`
  plus `autoColumns` now compose.
- Custom sorting of a column array to force a column first or last — `order`, or `pinned` for an edge.

---

## Report back with

1. What Phase 1 required, file by file.
2. Each ⚠️ occurrence you found, and how you verified it.
3. The Phase 2 proposal list — ranked, with anything you decided _against_ and why.
4. Anything the new API couldn't express as cleanly as the old code did. That's useful feedback.
