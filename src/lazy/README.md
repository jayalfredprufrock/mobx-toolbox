# @mobx-toolbox/lazy

Lazy-loading MobX observables that fetch their value on first observation and drop it automatically when they go unobserved.

## Naming

The factories are `lazy`, `lazyArray` and `lazyPages`; the types are `Lazy`, `LazyArray`,
`LazyPages`, `LazyApi`, `LazyArrayApi`, `LazyPagesApi`, `LazyOptions`, `LazyArrayOptions`,
`LazyPagesOptions`, `LoadedLazy`, `LoadedLazyArray` and `InferLazy`.

All three are the same machine with a different answer to one question — where the value lives and
what a new one does to it. `lazy` holds a box and replaces it, `lazyArray` owns an array and
replaces its contents, `lazyPages` owns an array and _appends_ to it. Everything else — loading on
observation, dropping when unobserved, aborting a superseded request, staleness, dependency
tracking — is one implementation, so using all three costs barely more than using one.

The old `lazyObservable*` / `LazyObservable*` spellings still export as deprecated aliases, and the
old import path `mobx-toolbox/lazy-observable` still resolves, so a codebase can migrate a file at a
time. **Both go away at 1.0** — the aliases live in `deprecated.ts`, and the old path is a second
`pack` entry in `vite.config.ts` that re-exports this one (284 bytes; the implementation is in a
shared chunk either way). Removing them is deleting that file, its line in `index.ts`, and that
entry — at which point every remaining use of an old name or the old path fails loudly rather than
drifting.

> **Importing alongside React?** `lazy` collides with `React.lazy`, which is common in the same
> files that do route-level code splitting. Alias one of them at the import — `import { lazy as
lazyValue }` or `import { lazy as reactLazy }` — or import this one as
> `import * as Lazy from ".../lazy"`.

## `lazy`

```ts
import { lazy } from "@jayalfredprufrock/mobx-toolbox/lazy";

const currentUser = lazy(() => api.fetchCurrentUser());
```

The fetch function runs the first time the observable is accessed inside a reactive context (observer component, autorun, reaction, etc.). It does **not** run on direct access outside a reactive context.

### Properties

| Property     | Type                  | Description                                             |
| ------------ | --------------------- | ------------------------------------------------------- |
| `value`      | `T \| undefined`      | The value, or `undefined` when there isn't one          |
| `loaded`     | `boolean`             | Whether there is a value — **narrows `value`**          |
| `fetching`   | `boolean`             | A request is in flight, refreshes included              |
| `refreshing` | `boolean`             | A request is in flight _behind an existing value_       |
| `error`      | `unknown`             | How the last request ended; `undefined` if it succeeded |
| `fetchedAt`  | `number \| undefined` | When a request last succeeded                           |
| `observed`   | `boolean`             | `true` while something is observing this lazy           |

Three facts vary independently here, and none is derivable from the others:

- **`loaded`** — is there a value? Decides what renders.
- **`fetching`** — is a request running?
- **`error`** — how did the last request end?

A first load is `!loaded && fetching`. A refresh — a request behind data already on screen — is
`loaded && fetching`, which is what **`refreshing`** is. It exists as its own property for a reason
that has nothing to do with brevity: see [below](#what-you-read-is-what-keeps-a-lazy-alive).

A refresh that fails while data is on screen is `loaded: true` _and_ has an `error`. Both are true
statements, and there is no single enum value that says so — which is why there isn't one.

#### `loaded` narrows `value`

`loaded` is a discriminant, so checking it is all the guard you need:

```ts
if (list.loaded) {
  list.value.map(render); // `value` is T here — no `!`, no `!== undefined`
}
```

### Methods

```ts
lazy.getOrLoad(); // → Promise<T> — resolve with the value, loading first if needed
lazy.reload(); // → Promise<T> — always fetch fresh, abandoning anything in flight
lazy.set(value); // → void — write the value directly and mark it loaded (no fetch)
lazy.invalidate(); // → void — mark stale, keeping the current value: reload if observed
lazy.invalidate({ discard: true }); // → void — same, but clear the value first
```

#### Refreshing without blanking

`loaded` describes what the lazy _holds_; `fetching` describes whether a request is in flight. A
refresh that already has a value stays `loaded` and merely flips `fetching`, so the data keeps
rendering instead of flashing empty between a mutation and its refetch:

```tsx
const SurveyList = observer(() => {
  const surveys = surveyStore.all;
  if (surveys.error) return <Error />;
  if (!surveys.loaded) return <Spinner />; // first load only
  return <List items={surveys.value} dimmed={surveys.fetching} />;
});
```

| situation                  | `value`     | `loaded` | `fetching` | `refreshing` | `error` |
| -------------------------- | ----------- | -------- | ---------- | ------------ | ------- |
| nothing yet                | `undefined` | `false`  | `false`    | `false`      | —       |
| first load                 | `undefined` | `false`  | `true`     | `false`      | —       |
| first load failed          | `undefined` | `false`  | `false`    | `false`      | set     |
| loaded, idle               | value       | `true`   | `false`    | `false`      | —       |
| refreshing (default)       | value       | `true`   | `true`     | `true`       | —       |
| refreshing after `discard` | `undefined` | `false`  | `true`     | `false`      | —       |
| **refresh failed**         | **value**   | **true** | `false`    | `false`      | **set** |

That last row is the one worth reading twice. A failed refresh keeps the previous value readable and
records the error — so `error` alone never means "there is nothing to show". Check `loaded` for that.

Pass `{ discard: true }` when stale data would be misleading rather than helpful — a filter change,
or switching to a different record.

#### What you read is what keeps a lazy alive

A lazy loads when something observes it and drops its value when nothing does. "Observing" means
reading **`value`**, **`loaded`**, **`error`** or **`refreshing`** — and deliberately _not_
`fetching` or `fetchedAt`, so that a header "syncing…" indicator can watch a store's lazy without
pinning it in memory or kicking off a fetch just by rendering.

The cost of that exclusion is one sharp edge, and it is worth knowing before you meet it:

```tsx
// ✗ renders forever, and fetches forever
const SurveyList = observer(() => {
  if (surveys.fetching) return <Skeleton />; // reads nothing that observes
  return <List items={surveys.value} />;
});
```

The skeleton branch observes nothing, so the lazy is dropped, which aborts the load, which clears
`fetching`, which renders the other branch, which observes again — a loop that spins as fast as the
event loop allows. Nothing throws; the tab just gets hot. Development warns once when it detects
this, naming the lazy if you gave it a `debugName`.

Use `refreshing`, which asks the same question and observes while it does:

```tsx
// ✓
const SurveyList = observer(() => {
  if (surveys.refreshing) return <Skeleton />;
  return <List items={surveys.value} />;
});
```

`fetching` is still the right thing to read _alongside_ something that observes — `dimmed={surveys.fetching}`
in the example above is fine, because the same expression reads `value`. The rule is only that it
must never be the sole read on a path that renders no data.

This matters most with `initialValue`: a seeded lazy is `loaded` from construction, so the usual
`if (!loaded)` gate is dead code and the obvious replacement is the broken one.

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
const surveys = lazyArray(() => api.getSurveys());

await surveys.getOrLoad(); // demand: fetches, nothing observing
surveys.invalidate(); // staleness: nothing observing → drops the value, no fetch
// ...next time a component renders it, it loads.
```

#### Automatic refreshing

`reloadEvery` refreshes the value on an interval — for data that shouldn't go stale on screen:

```ts
const queue = lazyArray(() => api.getQueue(), { reloadEvery: 30_000 });
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

If you'd rather decide when to refresh yourself, `fetchedAt` records when a request last
succeeded:

```tsx
useEffect(() => {
  if (surveys.fetchedAt && Date.now() - surveys.fetchedAt > 300_000) surveys.invalidate();
}, []);
```

It tracks the _fetch_, not the value, and the two genuinely differ: a lazy seeded with
`initialValue` is `loaded` with no `fetchedAt` (hydrated, never been to the network), and a failed
refresh leaves the previous timestamp in place (still showing data from then).

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
lazy(fetch, {
  initialValue: seed, // start loaded with this, and still revalidate — default: none
  //                    (narrows the result — see “A seed narrows the type”)
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
const surveys = lazyArray(api.getSurveys); // if its first param is `{ signal? }`
```

The signal aborts the moment its request is superseded — by `reload()`, `set()`, `invalidate()`,
going unobserved, or a dependency change. Taking the argument is optional, so zero-argument fetchers
keep working:

```ts
const surveys = lazyArray(({ signal }) => api.getSurveys({ signal }));
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
const surveys = lazyArray(() => api.getSurveys({ orgId: session.orgId }));
```

Opt in with `trackDependencies` when the refetch is the point:

```ts
const surveys = lazyArray(() => api.getSurveys({ orgId: session.orgId }), {
  trackDependencies: true,
});
```

Now every observable `fetch` reads _while running_ becomes a refetch trigger. That includes reads
you didn't intend — `toJS(this.filters)` touches every field, so any filter edit refetches — which
is why this isn't the default. Each re-run supersedes the previous request and aborts its signal.

For an observable that changes rapidly, throttle the refetching:

```ts
const results = lazyArray(({ signal }) => api.search({ q: query.get(), signal }), {
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

## `lazyArray`

A variant that initializes with `[]` so you never have to handle an undefined array.

```ts
import { lazyArray } from "@jayalfredprufrock/mobx-toolbox/lazy";

const users = lazyArray(() => api.getUsers());

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
autorun(() => render(users.value?.slice())); // tracks contents *and* triggers the load
```

Reading `value` registers observation **even when there is nothing there yet** — that is what makes
the first load happen at all. Optional chaining is fine; the read still counts.

`deep` applies to the array's items. Pass `deep: false` for rows that are already observable, such
as models, so nothing is converted on the way in.

The trade for a stable reference: **the identity is no longer a signal that data arrived.** Observe
the contents, or observe `fetchedAt`:

```ts
// ✅ a load landed
reaction(
  () => users.fetchedAt,
  () => persist(users.value),
);
// ❌ fires once, when the first load fills it in, then never again
reaction(
  () => users.value,
  (items) => persist(items),
);
```

Identity is stable **from the first load onward**. Before that `value` is `undefined`, and a
`discard` (or going unobserved) returns it to `undefined` — but the array itself is never replaced,
so a reference taken earlier is still valid when the next load fills it back in.

### Nothing yet is not the same as nothing

`value` is `undefined` until a load lands, not `[]`:

```ts
const rows = lazyArray(api.listSurveys);

rows.value; // undefined — "not known yet"
await rows.getOrLoad();
rows.value; // [] — "there are none"
```

An empty array as the starting value would be a claim about the data that nothing had checked, and
it is the reason table empty-states used to need the loading case wired in by hand.
If you want that behaviour on purpose, ask for it — and it means what it says:

```ts
lazyArray(api.listSurveys, { initialValue: [] }); // loaded, zero rows, still revalidates
```

## A seed narrows the type

Seeding is a promise the lazy can keep: a discard restores the seed rather than dropping to
nothing, so a seeded lazy is `loaded` from construction and can never go back. The type says so,
which means no guard at the call site:

```ts
const rows = lazyArray(api.listSurveys, { initialValue: [] });
rows.value.length; // IObservableArray<Survey> — no `loaded` check, no `?.`, no `?? []`

const count = lazy(api.countSurveys, { initialValue: 0 });
count.value * 2; // number
```

Without a seed you get the union, and the `loaded` guard is still how you read it:

```ts
const rows = lazyArray(api.listSurveys);
rows.value; // IObservableArray<Survey> | undefined
```

This works through `useLazy` and `useLazyArray` too, and the narrowed type is just the `loaded:
true` arm of the union — so anything that accepts a `Lazy` still accepts a seeded one,
`<LazyObserver>` and table `rows={...}` included. Name it `LoadedLazy<T>` or
`LoadedLazyArray<T>` if you need to write it down.

### `undefined` can be a seed, when it can be a value

For a lazy whose `T` includes `undefined`, seeding with `undefined` means "I already know there
isn't one" — and it reports `loaded`, exactly as a fetch resolving `undefined` always has:

```ts
lazy<Session | undefined>(api.getSession, { initialValue: undefined });
// loaded: true, value: undefined — no spinner, and still revalidates on first observation
```

What separates that from an unseeded lazy is the _presence of the option_, not its value:

```ts
lazy<Session | undefined>(api.getSession); // loaded: false — nothing known yet
```

The consequence is that a seed which _might_ be `undefined` can't be taken at face value, because
nothing can tell it apart from a deliberate one. With the type free, TypeScript widens it and both
readings stay true:

```ts
declare const maybe: number | undefined;
const c = lazy(api.countSurveys, { initialValue: maybe });
// LoadedLazy<number | undefined> — loaded, and `value` still admits undefined
```

Pin the type and there is nothing left to widen, so it is rejected instead:

```ts
lazy<number>(api.countSurveys, { initialValue: maybe });
// ✗ 'initialValue' does not exist in type 'LazyOptions'
```

Resolve it at the call site — `initialValue: maybe ?? 0`, or branch — rather than handing the lazy
a seed it can't describe.

Lists have none of this to worry about, since `undefined` is never a list. `{ initialValue:
maybeRows }` is accepted and simply doesn't narrow.

## `lazyPages`

A list that grows a page at a time, for a dataset too large to hand over whole — an infinite feed,
a load-more table, an activity log.

```ts
import { lazyPages } from "@jayalfredprufrock/mobx-toolbox/lazy";

const feed = lazyPages(({ cursor, limit, signal }) => api.listSurveys({ cursor, limit, signal }));

feed.value; // undefined until the first page lands, then every row loaded so far
feed.loadMore(); // append the page after them
feed.hasMore; // whether there is one
```

Everything about _when_ it loads is `lazy`'s, unchanged: the first page is fetched when something
observes the list, a superseded request aborts, `keepOnUnobserved` decides how long the pages
outlive their last observer, and `trackDependencies` makes an observable the fetch reads a reason to
start the list over. `value` is one observable array for the lifetime of the lazy, exactly as
[`lazyArray`](#lazyarray)'s is, so a page landing reaches everything watching the contents without
the array being replaced.

That makes it a `LazyArray` as far as anything reading rows can tell — **anything that accepts one
accepts this**, the table's `data` included.

### Three operations, not two

A single-fetch lazy has room for two ideas: it has the value, or it needs it again. A paged list has
three, and conflating any pair of them is the bug this type exists to prevent:

|                   |                                            |                       |
| ----------------- | ------------------------------------------ | --------------------- |
| **`loadMore()`**  | the page after the ones held, appended     | reports `loadingMore` |
| **`reload()`**    | the first page again, replacing everything | reports `refreshing`  |
| **`setQuery(q)`** | a _different_ list — page one of it        | reports `refreshing`  |

`refreshing` and `loadingMore` are mutually exclusive and both observe the list, so either is safe
to gate a render on:

```tsx
const Feed = observer(() => {
  if (!feed.loaded) return <Spinner />;
  return (
    <>
      <List items={feed.value} />
      {feed.loadingMore ? (
        <Spinner />
      ) : feed.hasMore ? (
        <button onClick={() => void feed.loadMore()}>Load more</button>
      ) : (
        <EndOfResults total={feed.total} />
      )}
    </>
  );
});
```

`loadMore()` is written to be called speculatively, which is what makes it usable straight from a
scroll handler: it resolves immediately when there is nothing more, and **joins** a request already
in flight rather than starting a second — so a burst of scroll events costs one page, not one each.
On a list holding nothing it fetches the first page, which is the same thing it always does: the
page after the ones held.

### Properties

Beyond everything on a [`lazyArray`](#lazyarray):

| Property      | Type                  | Description                                                        |
| ------------- | --------------------- | ------------------------------------------------------------------ |
| `loadingMore` | `boolean`             | A page request is running _behind rows already held_               |
| `hasMore`     | `boolean`             | Whether another page exists — `true` before anything has loaded    |
| `total`       | `number \| undefined` | Rows matching the query across every page, if a page said          |
| `pages`       | `number`              | How many pages are held; `0` before the first, and after a restart |
| `query`       | `Q`                   | Whatever `setQuery` was last given                                 |

**Which of these observe the list matters.** `value`, `loaded`, `error` and `loadingMore` do, so a
render gated on any of them keeps the list alive and triggers its first load. `hasMore`, `total`,
`pages` and `fetching` do **not** — they describe the requests rather than the rows, so a footer
rendering "1–100 of 4,382" cannot pin a list in memory or start a fetch just by being on screen.
Same split, same reasoning, as [`fetching` versus
`refreshing`](#what-you-read-is-what-keeps-a-lazy-alive).

`pages` is the one that answers a question nothing else can: **did this list restart, or did it
grow?** The array identity is stable by design, so it cannot say, and a row count only goes up
either way. `pages` drops to `0` on a reload, a query change and a discard — which is what a view
scrolled to page eight needs in order to go back to the top when the filters change.

### The page a fetch is handed, and what it may return

Every request carries both a `cursor` and an `offset`, so the same shape serves either kind of
endpoint and you read whichever yours speaks:

```ts
lazyPages(({ cursor, offset, limit, page, query, signal }) => ...);
```

The result can be a bare array, or an envelope with whatever else the endpoint knows:

```ts
{ items, cursor: "eyJpZCI6NDJ9" }   // cursor pagination
{ items, total: 4382 }               // offset pagination
{ items, hasMore: false }            // an endpoint that just says
[row, row, row]                      // an endpoint that returns rows and nothing else
```

`hasMore` is resolved from whichever of those arrived, in this order:

1. **An empty page ends the list**, whatever else it claims. Trusting `hasMore: true` alongside zero
   rows is what turns a server bug into a request loop, and anything driving `loadMore()` off a
   scroll position would spin it as fast as the event loop allows.
2. An explicit `hasMore`.
3. A `cursor` field, if the envelope carried one — `null` means the end. The field being **present**
   is what makes it authoritative; an absent `cursor` says nothing.
4. A `total`, if one has been reported: whether the rows held reach it.
5. Otherwise a short page is the last page. An endpoint whose final page happens to be exactly
   `pageSize` long therefore costs one extra request, which comes back empty and ends it.

### Options

Every [`lazy` option](#options) except two, plus three of its own:

```ts
lazyPages(fetch, {
  pageSize: 50, // rows per request, sent as `limit` — default 50
  query: { status: "draft" }, // the query the first page is fetched with
  dedupeBy: (row) => row.id, // identity, to drop a record a later page repeats
  deep: false,
  keepOnUnobserved: { for: 10_000 },
  trackDependencies: { throttle: 300 },
  debugName: "feed",
});
```

**`dedupeBy` is worth setting** for anything served by cursor over a non-unique sort key, or by
offset while rows are being inserted. Both hand back a record already held, and the duplicate is not
harmless: a table keys its rows by identity, so two entries for one record render two rows sharing a
React key and one selection toggle that hits both. For a model-backed list, `dedupeBy:
SurveyModel.identityKey` is exactly this. Deduplication never shortens the list early — `hasMore` is
resolved from the page's _own_ row count, so a page made entirely of records already held is still a
page the server had.

`pageSize` doubles as the fallback for `hasMore`, so it should match what the server actually
returns.

Two options are **missing**, and both are missing for a reason:

- **`initialValue`** — a seed cannot say which cursor follows it, so it could be listed but never
  continued. `set(rows)` says the same thing honestly: these rows, all of them, and no page after
  them (`hasMore` goes `false`).
- **`reloadEvery`** — a reload starts the list over at page one, so polling would yank a user who
  had scrolled to page eight back to the top on a timer. Refresh a paged list on an event
  (`invalidate()`), not on a clock.

### `setQuery` — a different list, not a stale one

The query decides which rows exist, so changing it is not a refresh of the rows on screen:

```ts
feed.setQuery({ status: "published", sort: "title" });
```

The list goes stale from page one and reloads now if anything is watching, or on the next
observation if not — the same rule as `invalidate()`. The rows stay readable throughout, so a view
keeps showing the previous results until the new first page lands rather than blanking. `pages`
drops to `0` immediately, which is how a view can tell this apart from a page landing.

A structurally equal query is a no-op, so this is safe to call from an effect that runs more often
than the query actually changes:

```tsx
useEffect(() => feed.setQuery(query), [query]);
```

If you would rather drive it reactively, `trackDependencies` covers that instead — read your own
observables inside the fetch and a change starts the list over, with `{ throttle: ms }` folding a
burst of keystrokes into one request. `setQuery` exists for the parameters that are _pushed in_ from
somewhere that has no observable to offer.

### An append never settles staleness

`invalidate()` followed by `loadMore()` in the same tick reloads: an append adds a page to rows that
may already be stale, so it deliberately leaves the staleness flag alone. Without that, a scroll
handler firing between a store event and its refetch would swallow the invalidation — the list would
keep growing from a cursor into data it had been told to replace, with nothing to show anything was
wrong.

For the same reason, a `loadMore()` on an unobserved stale list leaves it stale, so the next
`getOrLoad()` starts over rather than handing back what it has.

### Failures leave the pages alone

A failed append keeps every page already held, records the error, and keeps its cursor — so
retrying asks for the page that failed rather than starting over:

```ts
await feed.loadMore().catch(() => toast.error("Couldn't load more"));
```

`loadMore()` rejects, like `getOrLoad()` and `reload()` do, because there is a caller to throw at. A
first page that fails is the ordinary [failed-load](#what-it-throws-and-what-it-doesnt) case: nothing
held, `error` set, and `<LazyObserver>` re-throws it to a boundary.

## `useLazy` / `useLazyArray`

A lazy that belongs to one component, for an async read whose inputs are the component's own — a
route param, a prop, a piece of local state.

```tsx
import { useLazy } from "@jayalfredprufrock/mobx-toolbox/lazy";

const StudyPage = observer(({ studyId }: { studyId: string }) => {
  const study = useLazy((options) => api.getStudy({ id: studyId }, options), [studyId]);

  return (
    <LazyObserver observe={study} placeholder={<Spinner />}>
      {(s) => <StudyDetail study={s} />}
    </LazyObserver>
  );
});
```

What comes back is an ordinary `lazy` — nothing reading one can tell whether it came from a
hook, a store, or a hand-rolled construction. It loads when observed, keeps its value while it
reloads, and aborts what it supersedes. Passing the fetch options through, as above, is what gives
you that abort.

> **Fetching one record through a model?** Reach for
> [`useModel`](../model/README.md#a-single-record-in-a-component--usemodel) instead — the params
> double as the dependency list, so there is no array to keep in step with them. `useLazy` is for
> everything else: a count, a summary, an endpoint with no model behind it.

`useLazyArray` is the same for a list-shaped value, and returns a `lazyArray`.

Both take an `initialValue`, and narrow when you pass one, exactly as the factories do — see
[A seed narrows the type](#a-seed-narrows-the-type). The seed belongs to _this_ lazy, so a
`deps` change builds a new one starting from the seed again.

**`deps` say _which_ lazy this is.** Changing them builds a new one, exactly as constructing a second
lazy by hand would: the value starts empty and loads again. For a single record that is the point —
showing the study you navigated away from while the next one loads would be a lie.

The same applies to `useLazyArray`: the array identity a lazy owns is
[for that lazy's lifetime](#lazyobservablearray), and a `deps` change ends it. Anything watching
identity as a change signal should watch `loadedAt` instead — the same caveat that applies to a
hand-built array lazy.

When the inputs are _filters over one list_ rather than a different list, the other shape is
[`useCollection`](../model/README.md#component-scoped-collections--usecollection): one lazy that
refetches, with rows readable throughout.

**Held through `useStable`, not `useMemo`.** `useMemo` is a performance hint React may discard and
recompute, which would rebuild the lazy and silently drop what it had loaded. See
[`useStable`](../react-util/README.md#usestable).

## `LazyObserver` component

Renders `children` once every observed lazy holds a value, a `placeholder` while they don't, and
re-throws a failure that leaves nothing to render so an error boundary can take over.

```tsx
import { LazyObserver } from "@jayalfredprufrock/mobx-toolbox/lazy";

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

### The placeholder waits before it appears

A request that resolves in 60 ms would otherwise produce a 60 ms skeleton — long enough to see, too
short to read, on every navigation. So the placeholder is held back until the wait has lasted 300 ms,
and then kept up for at least 300 ms. A fast load renders **nothing at all** in between.

```tsx
<LazyObserver observe={users} placeholder={<Spinner />} sustain={false}>      // show it at once
<LazyObserver observe={users} placeholder={<Spinner />} sustain={{ after: 100 }}>
```

With the tuple form the clock runs off the _combined_ gate — it starts when the first value is
missing and resets once they are all present — rather than per-lazy. The timing is
[`useSlowLoading`](../util/README.md#useslowloading), which you can use directly for a component
that renders its own skeleton — note that doing it by hand needs
[three branches](../util/README.md#three-states-not-two), which is what this component is doing for
you above.

### What it throws, and what it doesn't

Only a failure with **nothing to render** reaches the boundary:

| state                   | renders                     |
| ----------------------- | --------------------------- |
| error, nothing loaded   | re-throws to the boundary   |
| error, value still held | `children`, with that value |

A failed _refresh_ keeps the screen it has. Throwing there would destroy working data over a
background request, and the error is still readable on the lazy for anyone who wants to surface it.

Note also that the gate is `loaded`, not `fetching`: a reload that keeps its value renders
`children` throughout, so a refresh never blanks the page.

### Why a failed load can't just throw

`lazy` captures errors rather than throwing them, and that is structural rather than a
preference. Loads are triggered by _observation_ — when a component renders, reads `value`, and that
starts a fetch, there is no call stack belonging to anyone. Throwing from inside a MobX reaction
produces an unhandled rejection no error boundary can catch, and the render that caused it finished
long ago.

The explicit path does throw: `await lazy.getOrLoad()` and `await lazy.reload()` reject normally.
Both behaviours exist, split by whether there is a caller to throw at — and `LazyObserver` is what
turns a captured error back into one a boundary can see.

## Key types

```ts
import type {
  Lazy, // the object returned by lazy() and useLazy()
  LazyApi, // the half of it that doesn't depend on `loaded`
  LazyArray, // the object returned by lazyArray() and useLazyArray()
  LazyArrayApi, // the half of that which doesn't depend on `loaded`
  LazyPages, // the object returned by lazyPages()
  LazyPagesApi, // the same, minus the `loaded` union
  LoadedLazy, // its `loaded: true` arm — what a seeded lazy() returns
  LoadedLazyArray, // the same for a seeded lazyArray()
  LazyOptions, // options for lazy()
  LazyOptionsWithInitialValue, // ...plus the seed, for the seeded overload
  LazyInvalidateOptions, // options for invalidate()
  LazyFetch, // ({ signal }: LazyFetchOptions) => Promise<T>
  LazyFetchOptions, // what a fetch is handed — currently { signal }
  LazyPagesOptions, // options for lazyPages()
  LazyPagesFetch, // (request: LazyPageRequest) => Promise<LazyPageResult<T>>
  LazyPageRequest, // LazyFetchOptions plus { cursor, offset, limit, page, query }
  LazyPageResult, // T[], or { items, cursor?, total?, hasMore? }
  InferLazy, // InferLazy<typeof obs> → T
} from "@jayalfredprufrock/mobx-toolbox/lazy";
```
