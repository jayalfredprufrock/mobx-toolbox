# @mobx-toolbox/model

Factory functions for MobX-observable model classes and the stores that list them, built from a TypeBox schema.

A **model** owns a resource: its schema, its endpoints, and its identity — one instance per record, shared by everything that loads it. A **store** owns a _list_ of them: a lazily-loaded observable array that stays in step with mutations. A resource usually has one model and as many stores as it has lists.

## Setup

```ts
import { createStore, makeModel } from "@jayalfredprufrock/mobx-toolbox/model";
import * as T from "typebox";
```

## Defining a model

`makeModel(schema, config?)` returns a class whose constructor accepts raw data and an optional store reference. Every property defined in the schema becomes a `observable.ref` field.

```ts
const UserSchema = T.Object({
  id: T.Number(),
  name: T.String(),
  email: T.String(),
});

const UserModel = makeModel(UserSchema, {
  keys: ["id"], // fields used to build API params
  get: (params) => api.getUser(params.id), // → UserModel.get({ id }), and derives reload()
  create: (body) => api.createUser(body), // → UserModel.create(body)
  update: (params, body) => api.updateUser(params.id, body),
  delete: (params) => api.deleteUser(params.id),
  actions: {
    activate: (params) => api.activateUser(params.id),
  },
});

type UserInstance = InstanceType<typeof UserModel>;
```

### `keys`

`keys` declares what identifies one record. Its values are bundled into a params object and passed
as the first argument to every API method, and they are what the identity map keys on. It carries
three declarations:

| `keys`   | Params to API methods | Identity                                        |
| -------- | --------------------- | ----------------------------------------------- |
| `["id"]` | `{ id }`              | One instance per `id`                           |
| `[]`     | none                  | Singleton — one instance, full stop             |
| `false`  | none                  | None — the identity statics aren't on the class |

`makeModel(schema)` with no config at all resolves to `keys: false`, so it means exactly what the
explicit spelling means rather than being a rule of its own.

**`[]` is a singleton, not "no identity".** A resource with no identifying fields is one you have
exactly one of — settings, the current session — so `Settings.get()` hands back the same instance
every time and anything observing it stays bound across refetches.

**`false` opts out.** `instantiate`, `forget` and `clearIdentity` are removed from the class type, so
reaching for identity you never declared is a compile error rather than a runtime throw. `get` and
`create` still work; they hand back a detached instance per call. The throw remains underneath for
JavaScript callers and `as any` escapes.

`as const` is not needed on the array: the property names are inferred as literals. It's only
required when the config is hoisted into its own variable, where TypeScript widens the array to
`string[]` before `makeModel` ever sees it — declare the config inline, or write
`keys: ["id"] as const` there.

### Statics — `get` and `create`

`get` and `create` don't need an instance, so they become statics on the class, returning
identity-mapped models:

```ts
const user = await UserModel.get({ id: 1 }); // → UserInstance
const created = await UserModel.create({ name: "Alice", email: "a@example.com" });
```

Each static mirrors its config function's signature exactly, so extra arguments pass through
(`UserModel.get({ id: 1 }, { expand: "roles" })`) and a resource with no key params reads naturally
(`get: () => api.getSettings()` → `Settings.get()`). Both are typed through the class they're called
on, so `Admin.get({ id: 1 })` is an `Admin` — see [Identity](#identity--one-instance-per-record).

**Request bodies are typed by what you supply, not by the schema.** `create` and `update` leave the
body unconstrained, so any shape attaches — and whatever you attach or annotate is the type callers
see:

```ts
create: api.signUp,                                    // Model.create(body: { inviteToken: string })
update: api.updateUser,                                // user.update(body: UpdateUserBody)
create: (body: { name: string; password: string }) => api.signUp(body),
```

Constraining the body to `Partial<Resource>` was tried and reverted: TypeScript's weak-type rule
rejects any body sharing no field names with the resource (`{ inviteToken: string }`), and a rejected
slot makes the whole config fall back to its constraint — which silently removes _every_ generated
method. An unannotated inline body is `any`; annotate it, or attach a typed client function.

Two consequences worth knowing:

- **`reload()` is derived from `get`**, so the endpoint is declared once instead of appearing as both
  `get` and `reload`. There is no separate `reload` slot, and no `reload()` on a model without `get`.
  The same endpoint also backs the static `Model.reload(params)` — see
  [Caching a record](#caching-a-record).
- **No store is required.** A route loader can call `SurveyModel.get({ id })` directly. A model holds
  no reference to any store; stores listen to the _model class_, so a record fetched before any store
  existed is still removed from every list when it is deleted.

### Identity — one instance per record

A keyed model class is an identity map. `Model.instantiate(data, store?)` returns the _same_ object
every time it sees the same record, applying the newer payload to it rather than building a second
copy:

```ts
const a = UserModel.instantiate({ id: 1, name: "Alice", email: "a@example.com" });
const b = UserModel.instantiate({ id: 1, name: "Renamed", email: "a@example.com" });
a === b; // true
a.name; // "Renamed"
```

Pass the **model class** to a store and this is wired up for you — every list, `get`, and `create`
hands back the same instance for a record, so a reference held by a detail panel keeps updating when
the list reloads, an edit through one reference is visible through all of them, and _separate stores
over the same model behave as one_:

```ts
const drafts = createStore(UserModel, { collections: { all: api.listDraftUsers } });
const active = createStore(UserModel, { collections: { all: api.listActiveUsers } });
// the same user in both lists is the same object
```

At scale this is also a performance feature: reloading a 50k-row list reuses the instances instead of
running `makeObservable` 50k more times, which measured ~10× faster (233ms → 24ms).

| Static                      | Description                                                              |
| --------------------------- | ------------------------------------------------------------------------ |
| `instantiate(data, store?)` | The one instance for this record, created or updated                     |
| `identityKey(source)`       | The registry key for a payload or model — override to scope identity     |
| `forget(source)`            | Drop the entry, so the next `instantiate` builds a fresh instance        |
| `clearIdentity()`           | Forget every record — for logout or a tenant switch                      |
| `keys`, `schema`            | Exactly what was declared — the tuple, `[]`, or `false` — and the schema |

Notes:

- **Identity is opt-out, per class and per instance.** `keys: false` removes it from the class; on a
  model that has it, `new Model(data)` builds a detached instance that is never registered. Reach for
  the latter when you need two live copies of one record — a before/after diff, or history rows
  sharing an id — since `instantiate` would collapse them onto a single object.
- **Entries are weak.** The registry never keeps a model alive on its own: identity lasts exactly as
  long as something — a collection, your own code — holds the instance. Once nothing does, the entry
  goes and a later `instantiate` builds a fresh one, which is unobservable because nothing was
  holding the old one.
- **`delete()` gives up identity automatically.** The record is gone, so a later payload for its key
  must not revive the deleted instance.
- **Each subclass gets its own registry**, so `class Admin extends UserModel {}` never hands you a
  plain `UserModel` where an `Admin` was expected. `Admin.instantiate(data)` is typed as an `Admin`,
  and so are `Admin.get(...)` and `Admin.create(...)` — every static is typed through the class it
  is called on, so a subclass's own members come through.
- **Override `identityKey` to scope identity** — folding in a tenant id, say, so ids from different
  tenants cannot collide:

```ts
class TenantUser extends UserModel {
  static override identityKey(source: { id: number }) {
    return `${session.tenantId}:${source.id}`;
  }
}
```

- **Payload shapes must agree.** `instantiate` applies each payload with `setData`, which replaces
  every field. If a list endpoint returns a projection and the detail endpoint returns the whole
  record, a list refresh would wipe the detail-only fields — use separate models/stores for shapes
  that genuinely differ.

### Caching a record

The identity map is already a cache of records — `cache` decides whether `get` is allowed to answer
from it instead of calling the API.

```ts
export const StudyModel = makeModel(StudySchema, {
  keys: ["id"],
  get: api.getStudy,
  cache: { for: 30_000 },
  optimistic: true,
});
```

| `cache`           | `Model.get(params)`                       |
| ----------------- | ----------------------------------------- |
| `false` (default) | always calls the API                      |
| `true`            | reuses a loaded record indefinitely       |
| `{ for: ms }`     | reuses a record loaded within that window |

There is no second store of records and nothing to invalidate: the record `get` hands back is the
same instance every list, loader and other `get` holds, so a cache hit and a fresh fetch are
indistinguishable to everything downstream.

`cache` only ever applies to a model that declared `keys`. Without identity there is nothing to reuse,
and the setting is ignored.

**Three ways to reach a record**, so nothing needs a per-call cache flag:

```ts
StudyModel.peek({ id }); // sync — the loaded record or undefined, never fetches
StudyModel.get({ id }); // honors `cache`
StudyModel.reload({ id }); // always calls the API
```

`peek` reports _presence, not freshness_: a record `cache` would consider stale still comes back. It
is the one to use during render, or to decide whether a fetch is needed at all. `reload` is the
static mirror of `instance.reload()` — same endpoint, params passed in rather than read off a record
you already hold — and it re-freshens the record, so the next `get` is cached again.

#### `optimistic`

With `optimistic: true`, a `get` whose record has gone stale hands the record back **now** and
refreshes it in the background, instead of making the caller wait:

```ts
const study = await StudyModel.get({ id }); // resolves immediately with the stale record
// …fields update in place when the refresh lands
```

The refreshed fields land on that same instance, so anything observing it re-renders. It only fires
when there is something cached to answer with — a record that was never loaded is always awaited.

**A failed background refresh introduces no new error source.** The promise has already resolved, so
there is nowhere to throw. Instead the failure is logged and the record's load stamp is cleared, which
means the _next_ `get` goes to the API and reports its failure through the normal path. Repeated
failures simply degrade to `cache: false`. Clearing the stamp overrides even `cache: true` — a record
that could not be refreshed is never treated as fresh again.

#### When _not_ to turn `cache` on

Only when this model's payload is the same shape wherever it is loaded from. If a list endpoint
returns a projection and a detail endpoint returns the whole record, those are two models, not one
cached model — [`setData` replaces, it does not merge](#setdata-replaces-it-does-not-merge), so a
cached record could serve list-shaped data to a detail page with its extra fields permanently
`undefined`.

Compose the schemas and declare a second model instead:

```ts
const StudyDetailSchema = T.Composite([
  StudySchema,
  T.Object({ sections: T.Array(SectionSchema) }),
]);

export const StudyDetailModel = makeModel(StudyDetailSchema, {
  keys: ["id"],
  get: api.getStudyDetail,
  cache: { for: 60_000 },
});
```

The two have separate identity maps, so they are separate instances of one record — an `update`
through one does not show in the other without wiring
[`addListener`](#mutations-travel-by-event).

### Built-in instance methods

| Method                  | Description                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `reload(...rest)`       | Calls the `get` fn with this model's params, then `setData` (present only with `get`) |
| `update(body, ...rest)` | Calls the `update` fn with the body, then calls `setData`                             |
| `delete(...rest)`       | Calls the `delete` fn, tells every listener, then gives up identity                   |
| `setData(resource)`     | Replaces the model's data with a complete resource (full replace, not a merge)        |
| `toJSON()`              | Returns a plain object with all schema-defined fields                                 |
| `buildParams()`         | Returns `{ [key]: this[key] }` for each configured key, or `undefined` if no keys     |

### Custom actions via `actions`

Each entry in `actions` generates an instance method that calls the function, then calls `setData` with the result:

```ts
await user.activate(); // calls activateFn({ id: user.id })
```

Actions that receive a body beyond the params still pass it through:

```ts
await user.sendMessage({ text: "Hello" }); // fn({ id }, { text: "Hello" })
```

### Extending via subclass

Subclass to add derived members, or to annotate extra observable fields:

```ts
class UserInstance extends UserModel {
  get label() {
    return `${this.name} <${this.email}>`;
  }
  getMobxAnnotations() {
    return { role: observable }; // annotate extra fields
  }
}
```

**`buildParams()` is not the place to rename params.** Its return type is `Pick<Resource, ...keys>`,
so an override returning a different shape doesn't typecheck — and it wouldn't help anyway, since the
config functions are typed from `keys` independently. When the API's param names differ from the
model's fields, map them where the endpoint is declared:

```ts
const UserModel = makeModel(UserSchema, {
  keys: ["id"],
  get: ({ id }) => api.getUser({ userId: id }), // ← the mapping lives here
  update: ({ id }, body) => api.updateUser({ userId: id }, body),
});
```

`getMobxAnnotations()` is merged into the `makeObservable` call in the constructor, allowing subclasses to add their own observable fields without re-calling `makeObservable`.

### `setData` replaces, it does not merge

`setData` takes a **complete** resource and reassigns every field — fields absent from the argument become `undefined`. It deliberately does not accept a partial: a partial update could leave the model in an incoherent state (especially across a discriminated union — see below). To change a single field, assign it directly inside an action, or go through `update`/`actions` (which pass the full API response to `setData`).

```ts
// ❌ rejected at compile time
user.setData({ name: "Bob" });
// ✅ full resource
runInAction(() => user.setData({ id: 1, name: "Bob", email: "bob@example.com" }));
// ✅ single field
runInAction(() => (user.name = "Bob"));
```

## Discriminated unions — `makeUnionModel`

For a `T.Union` of objects, use `makeUnionModel(schema, discriminator, config?)`. It takes the discriminator property name and returns a model whose instance exposes the **shared** fields directly; variant-specific fields are reached through the `is`/`as` guards. `makeModel` itself only accepts a single `T.Object`.

```ts
const PaymentSchema = T.Union([
  T.Object({ kind: T.Literal("card"), id: T.Number(), cardNumber: T.String() }),
  T.Object({ kind: T.Literal("bank"), id: T.Number(), routing: T.String() }),
]);

const PaymentModel = makeUnionModel(PaymentSchema, "kind", { keys: ["id"] });
const payment = new PaymentModel({ kind: "card", id: 1, cardNumber: "4242" });

payment.id; // ✅ shared field
payment.kind; // ✅ discriminator
// payment.cardNumber          ← type error: variant field hidden until guarded

if (payment.is("card")) {
  payment.cardNumber; // ✅ same instance, variant field revealed
}

const card = payment.as("card"); // (this & CardVariant) | undefined
if (card) card.cardNumber;
```

### Why not just `makeModel(union)` with discriminator narrowing?

Because the resulting instance type would be a union, and **a union type cannot be a class base** (`class X extends Model {}` fails with TS2509). `makeUnionModel` keeps the base instance a single object type (shared fields + `is`/`as`), so models stay subclassable:

```ts
class Payment extends PaymentModel {
  get label() {
    if (this.is("card")) return `card ${this.cardNumber}`;
    if (this.is("bank")) return `bank ${this.routing}`;
    return "?";
  }
}
```

### Guards

| Method      | Returns                                                               |
| ----------- | --------------------------------------------------------------------- |
| `is(value)` | Type guard — `true` reveals the variant's fields on the same instance |
| `as(value)` | The same instance narrowed to that variant, or `undefined`            |

### Things to know

- **`keys`/`buildParams` are limited to shared fields.** `keyof` a union collapses to the keys present in every variant (e.g. `id`) — exactly what you want for a keyed resource. The `discriminator` argument must likewise be a shared key.
- **All variants' fields are observable.** Every property across the union is made `observable.ref` up front, so `setData` stays reactive even when it switches the active variant. `toJSON` runs `Value.Clean` to emit only the active variant's fields.
- **`setData` switches variants cleanly.** It takes the full resource and reassigns every field, so moving between variants clears the previous variant's fields on the live instance (not just in `toJSON`).
- **Reflection still sees every key.** `Object.keys`, spread, and `in` expose all union properties (inactive ones as `undefined`); only typed access (via the guards) and `toJSON` are variant-faithful. This is the deliberate trade for a subclassable, reactive model.

`makeStore` accepts a union model class too, so a store of union models is fully typed.

---

## Mutations travel by event

A model reports its own mutations, and stores listen on the **class** — so a model never references a
store, and every store over a resource stays in step regardless of which one loaded a record.

| event     | emitted by                      | what a store does by default                  |
| --------- | ------------------------------- | --------------------------------------------- |
| `created` | `Model.create` / `store.create` | marks its lists stale                         |
| `updated` | `update()` and custom `actions` | nothing — identity already shows the change   |
| `deleted` | `delete()`                      | removes the model from every list, no refetch |

Loads never emit, so a 50k-row refresh costs no notifications.

`updated` doing nothing is the identity map paying off: every list holding that record holds the
_same object_, so it already shows the new fields. Opt in per list when membership depends on a
mutable field:

```ts
createStore(SurveyModel, {
  collections: { drafts: api.listDrafts },
  invalidateOn: ["created", "updated"],
});
```

`"deleted"` may be listed too — the model is removed either way, so add it only when a deletion
changes the list in some _other_ way, a server-side count or ordering, say.

Set on the store it covers every collection, and a single one can still override it — see
[Options a collection inherits](#options-a-collection-inherits).

**What a list shows while it refetches** is `discardOnInvalidate`. By default the rows stay readable,
so a list doesn't blank on every mutation. Set it where stale rows would actively mislead — a
filtered list whose membership an `update` may have changed:

```ts
createStore(SurveyModel, {
  invalidateOn: ["created", "updated"],
  collections: {
    all: api.listSurveys,
    drafts: { fetch: api.listDraftSurveys, discardOnInvalidate: true },
  },
});
```

For a change no model event describes — a tenant switch, a filter reset, a refresh button —
`store.invalidateCollections()` marks every collection stale, honouring each list's
`discardOnInvalidate`; an explicit `{ discard: true }` overrides them all. It deliberately ignores
`invalidateOn`: that option governs which _events_ reach a list, not whether you can refetch one on
purpose.

It is named for what it covers. A subclass may hold lazies that aren't collections — `counts` in the
example below — and those are left alone; invalidate them wherever you already know they're stale.

Anything can listen, not just stores — a count, a chart, a hand-rolled feed:

```ts
class SurveyFeed implements ModelListener {
  constructor() {
    SurveyModel.addListener(this); // held weakly; nothing to dispose
  }
  onModelEvent(type: ModelEventType, model: SurveyInstance) {
    if (type === "deleted") this.rows.remove(model);
  }
}
```

Listeners live in a `WeakRef` set, pruned as they are collected, so registering never keeps a store or
a page model alive.

---

## Defining a store

A store is **lists over one resource**. There are two ways in, and which one you want depends only on
whether the store needs behaviour of its own:

- **`createStore(model, config)`** returns an instance, with its collections named in the config.
- **`makeStore(model, config?)`** returns the class, for when you want to subclass it. Every option
  is optional; collections are declared as fields.

```ts
export const surveys = createStore(SurveyModel, {
  collections: {
    drafts: (options) => api.listSurveys({ status: "draft", ...options }),
    published: api.listPublishedSurveys, // attached directly — see below
  },
});

surveys.drafts.getOrLoad();
```

Collections are named by you — there is no reserved `list`. They are the same thing whichever way
you declare them, so a store never mixes config-level lists with subclass-level ones: use
`createStore` until you need a subclass, then declare every collection as a field.

Several stores over one model is also a normal arrangement, and they behave as one: identity lives on
the model class, so the same record is the same object in every list, and mutations reach all of them
by event.

Models are built by the store from the class you hand it, so **to get a subclass in a list, pass the
subclass**: `createStore(Admin, …)` fills its collections with `Admin` instances.

### Declaring a collection

Each fetch receives `{ signal }`, which aborts when the request is superseded. A client whose own
first parameter is an options bag can be **attached directly**; one that takes query params spreads
it:

```ts
collections: {
  all: api.listSurveys,                                          // (options) => …
  drafts: (options) => api.listSurveys({ status: "draft", ...options }),
}
```

Each is a `LazyArray<M>` that loads when first observed in a reactive context. For
imperative access, `await store.drafts.getOrLoad()`.

The verbose form adds that collection's own options — every lazy option, plus `invalidateOn` and
`sort`:

```ts
createStore(SurveyModel, {
  collections: {
    all: { fetch: api.listSurveys, reloadEvery: 30_000, keepOnUnobserved: { for: 10_000 } },
  },
});
```

### A collection holds nothing until it loads

`collection()` returns a `LazyArray`, so `value` is `undefined` until the first load
rather than `[]`, and `loaded` narrows it:

```tsx
const Surveys = observer(() => {
  const list = surveyStore.all;
  if (!list.loaded) return <Spinner />;
  return <List items={list.value} />; // `value` is SurveyInstance[] here
});
```

The distinction matters for exactly one reason, and it is the one that used to cost every table
author an afternoon: `undefined` means _not known yet_, `[]` means _there are none_. See
[nothing yet is not the same as nothing](../lazy/README.md#nothing-yet-is-not-the-same-as-nothing).

A `discard` — from `invalidate({ discard: true })` or `discardOnInvalidate` — returns the collection
to holding nothing, not to an empty list.

### Options a collection inherits

Three options are declared on the store and overridden per collection, since the same answer usually
applies to every list over a resource. Each resolves the same way — the collection's own value, else
the store's, else the built-in default:

| Option                | Store-level default | What a collection can say                       |
| --------------------- | ------------------- | ----------------------------------------------- |
| `sort`                | unsorted            | its own comparator, or `false` for server order |
| `invalidateOn`        | `["created"]`       | its own event list, or `[]` to never refetch    |
| `optimisticCreate`    | `false`             | `true` to show a created record before it lands |
| `discardOnInvalidate` | `false`             | `true` to blank the list while it refetches     |

Everything else on the store config applies to it as a whole.

### `sort`

Ordering is usually the one thing standing between an API client and being attached directly, and the
same order almost always applies to every list over a resource — so declare it once on the store. It
runs over **model instances**, on every load:

```ts
createStore(SurveyModel, {
  sort: (a, b) => a.title.localeCompare(b.title),
  collections: { all: api.listSurveys, drafts: api.listDraftSurveys },
});
```

A single collection overrides it, or opts out with `sort: false` to keep server order — for a
relevance-ranked search, say:

```ts
class SurveySearch extends makeStore(SurveyModel, { sort: byTitle }) {
  results = this.collection(api.searchSurveys, { sort: false }); // server ranking wins
  recent = this.collection(api.recentSurveys, { sort: (a, b) => b.updatedAt - a.updatedAt });
}
```

When a list opts into `optimisticCreate`, a record from `create()` is inserted where the sort puts it
rather than at the top, so it doesn't visibly jump when the list next loads.

### `optimisticCreate`

Off by default: `create()` announces itself, every list that cares marks itself stale, and the row
appears when the refetch confirms it. Only the server knows whether a new record belongs in a given
list, so inserting into a filtered or searched collection would flash a row that doesn't belong
there.

Turn it on for the lists a new record certainly joins — store-wide, or per collection:

```ts
createStore(SurveyModel, {
  collections: {
    all: { fetch: api.listSurveys, optimisticCreate: true }, // a new survey is always in `all`
    drafts: api.listDraftSurveys, // …but only sometimes a draft
  },
});
```

Identity means the refetch reuses the same instance, so an optimistically inserted row moves into
place rather than flickering out and back.

### Collections on a subclass

`collection()` builds one, turning payloads into models and joining the store's mutation handling.
Call it in a field initializer — which is also how a list gets reactive parameters:

```ts
class SurveySearch extends makeStore(SurveyModel) {
  query = "";

  results = this.collection((options) => api.searchSurveys({ q: this.query, ...options }), {
    trackDependencies: { throttle: 300 },
  });

  constructor() {
    super();
    // annotations only — mobx rejects an options object on an already-observable instance
    makeObservable(this, { query: observable, setQuery: action });
  }

  setQuery(q: string) {
    this.query = q;
  }
}
```

Reading `this.query` inside the fetch is what makes it refetch; the throttle folds a burst of
keystrokes into one request, and the signal aborts what it supersedes. `createStore`'s `collections`
are built with the same `collection()`, so the two behave identically.

### Keyed collections — `collectionMap`

Some resources have to be fetched separately per tenant, per parent record, per page — keys you can't
enumerate when the store is written. `collectionMap` builds one list per key, on first use:

```ts
class Surveys extends makeStore(SurveyModel) {
  byOrg = this.collectionMap(["orgId"], ({ orgId }, options) =>
    api.listSurveys({ orgId, ...options }),
  );
}

surveys.byOrg({ orgId }).getOrLoad();
```

Name the fields that select a list and the fetch's params are typed from the schema, the same way a
model's `keys` type its statics. Key fields must hold a string or a number, and they serialize
through the same `serializeKey` the identity map uses — so only the declared fields reach the fetch,
and a whole record works as the key:

```ts
surveys.byOrg(survey); // the same list as surveys.byOrg({ orgId: survey.orgId })
```

Each list is an ordinary collection from the moment it exists: it joins the store's mutation
handling, `invalidateCollections()` reaches it, and a deletion drops the model from it.

When the key isn't a field on the resource — a page number, a filter of your own — pass the fetch
alone. A key that isn't already a string or a number needs a `keyOf` to say how it is spelled:

```ts
pages = this.collectionMap((page: number, options) => api.listSurveys({ page, ...options }));

byFilter = this.collectionMap((f: Filter) => api.listSurveys(f), {
  keyOf: (f) => `${f.orgId}/${f.status}`,
});
```

`collectionMap` is a subclass-only method; `createStore`'s config has no form for it.

**On growth.** The map never evicts on its own, but a key costs very little: `keepOnUnobserved`
defaults to `false`, so a list nobody is watching has already dropped its rows, and what stays behind
is an empty shell. When you know a key is finished with — an organization the user just left, a
logout — `forget(key)` drops that list and unregisters it from the store, and `clear()` drops them
all.

### Component-scoped collections — `useCollection`

When a list's parameters are the component's own — a filter, a search box, a route param — a shared
store is the wrong home for them, since putting them on the store is what stops the store being
shared. `useCollection` builds a collection that belongs to one component instead:

```tsx
const list = useCollection(SurveyModel, (options) => api.listSurveys(options));
```

Pass `params` and they arrive as the fetch's first argument, ahead of the lazy's own options — the
same params-first shape `collectionMap` uses. They are plain React values, and their type is inferred
from what you pass:

```tsx
const Surveys = observer(({ orgId }: { orgId: string }) => {
  const [query, setQuery] = useState("");

  const list = useCollection(
    SurveyModel,
    ({ orgId, query }, options) => api.listSurveys({ orgId, q: query, ...options }),
    { params: { orgId, query }, trackDependencies: { throttle: 300 } },
  );

  return (
    <LazyObserver observe={list} placeholder={<Spinner />}>
      {(rows) => rows.map((s) => <SurveyRow key={s.id} survey={s} />)}
    </LazyObserver>
  );
});
```

The hook keeps the params in an observable box the fetch reads through, so `useState` stays where it
is and a change refetches — leaving the current rows readable while the next set loads, and aborting
the request it supersedes. Params are compared shallowly, so rebuilding the object every render costs
nothing.

Being component-scoped costs nothing global: the model's identity map still hands out one instance
per record and mutations still fan out, so an edit here shows up in the app-wide store and vice versa.
Nothing needs disposing either — the model holds its listeners weakly, so the store and its list are
garbage the moment the component unmounts.

### A single record in a component — `useModel`

A detail page loads one record, not a list, so there is no collection to build:

```tsx
const StudyPage = observer(({ studyId }: { studyId: string }) => {
  const study = useModel(StudyModel, { id: studyId });

  return (
    <LazyObserver observe={study} placeholder={<Spinner />}>
      {(s) => <StudyDetail study={s} />}
    </LazyObserver>
  );
});
```

What comes back is an ordinary `lazy` over the model's own `get`. It loads when something
observes it, honours whatever the model declared for [`cache`](#caching-a-record), aborts a request
it supersedes, and hands back the identity-mapped instance — so an edit made anywhere else in the app
shows up here.

**The params are the dependencies.** There is no dependency array to keep in step with them, which is
the whole reason this exists rather than reaching for `useLazy`:

```tsx
useLazy((o) => StudyModel.get({ id, orgId }, o), [id]); // `orgId` forgotten — silently stale
useModel(StudyModel, { id, orgId }); // can't desync
```

They are typed from the model's `keys`, compared shallowly (so rebuilding the object every render
costs nothing), and key order is not a change.

A model with **no key params** (`keys: []` or `keys: false`) takes no params argument at all — the
slot isn't there to fill:

```tsx
const settings = useModel(SettingsModel);
const settings = useModel(SettingsModel, { keepOnUnobserved: true }); // options move up
```

**A param change builds a new lazy**, so the value starts empty and loads again — which is what you
want for a record: showing the study you navigated away from while the next one loads would be a lie.
That is the difference from `useCollection`'s `params`, and it is the difference between the two
questions being asked:

|                                | means                   | on change                                 |
| ------------------------------ | ----------------------- | ----------------------------------------- |
| `useModel(Model, params)`      | _which_ record this is  | new lazy — value starts empty             |
| `useCollection(…, { params })` | filters over _one_ list | same lazy — refetches, rows stay readable |

A study id changing makes it a different record. A search term changing does not make it a different
list.

**Pair it with `cache`.** With [`cache`](#caching-a-record) on the model, navigating back to a record
you have already seen resolves from the identity map and paints without a request.

#### When you'd still reach for `useLazy`

`useModel` covers a record fetched through the model's `get`, which is the case an app hits over and
over. For anything else — a count, a summary, an endpoint that isn't a model at all — reach past it
to [`useLazy`](../lazy/README.md#uselazy--uselazyarray), which knows nothing about models
and takes an explicit `deps` array:

```tsx
const stats = useLazy((o) => api.getStudyStats({ id: studyId }, o), [studyId]);
```

### Where a list should live

| The parameters are…                          | Put the list…                                                 |
| -------------------------------------------- | ------------------------------------------------------------- |
| fixed                                        | on a shared store — `collections`, or a field                 |
| global observable state (the current tenant) | on a shared store, read in the fetch with `trackDependencies` |
| varying per caller, and spellable as a key   | on a shared store — `collectionMap`                           |
| the component's own React state              | in the component — `useCollection`                            |

And for a value that is one record rather than a list, `useModel` in the component — see
[above](#a-single-record-in-a-component--usemodel).

`collection()` has no `params` option on purpose. A store always has somewhere observable to read
from — `this`, or module state — so reading it inside the fetch _is_ the feature. React state is the
one place that isn't true, which is why `params` is a hook-only option.

### Store methods and properties

| Name                                    | Description                                                             |
| --------------------------------------- | ----------------------------------------------------------------------- |
| _your collection names_                 | `LazyArray<M>` — one per entry in `collections`, or per field           |
| `collection(fetch, options?)`           | Build another list on this store                                        |
| `collectionMap(keys?, fetch, options?)` | Build a family of lists, one per key                                    |
| `get(...args)`                          | Delegates to `Model.get`                                                |
| `create(...args)`                       | Delegates to `Model.create`; inserts into lists with `optimisticCreate` |
| `invalidateCollections(opts?)`          | Marks every collection stale, ignoring `invalidateOn`                   |
| `remove(model)`                         | Drops a model from every list on this store, without deleting anything  |
| `onModelEvent(type, model)`             | The mutation handler — override to extend it                            |

`get` and `create` exist only when the model declares them.

Extending `onModelEvent` is how anything else on the store joins in:

```ts
class SurveysWithCounts extends makeStore(SurveyModel) {
  all = this.collection(api.listSurveys);
  counts = lazy(api.surveyCounts);

  override onModelEvent(type: ModelEventType, model: SurveyInstance) {
    super.onModelEvent(type, model);
    if (type === "created") this.counts.invalidate();
  }
}
```

### What a store deliberately isn't

- **Accumulating lists** ("load more") don't fit a lazy: its fetch returns the whole value, so
  `reload()` and "next page" would be the same operation. Build those as a plain
  `observable.array` plus a `loadMore()` action, and implement `ModelListener` to stay in step.
- **Paginated envelopes** — a collection's fetch must resolve to `R[]`, so a `{ items, total }`
  response needs the extra fields written out of the fetch as a side effect.

### Full example

```ts
import { makeModel, makeStore } from "@jayalfredprufrock/mobx-toolbox/model";
import * as T from "typebox";

const UserSchema = T.Object({
  id: T.Number(),
  name: T.String(),
  email: T.String(),
});

const UserModel = makeModel(UserSchema, {
  keys: ["id"],
  get: ({ id }) => api.get(`/users/${id}`),
  create: (body) => api.post("/users", body),
  update: ({ id }, body) => api.patch(`/users/${id}`, body),
  delete: ({ id }) => api.delete(`/users/${id}`),
});

export const userStore = createStore(UserModel, {
  sort: (a, b) => a.name.localeCompare(b.name),
  collections: {
    all: (options) => api.get("/users", options),
  },
});

// In a component (observer):
const users = userStore.all.value; // loads on first observation; undefined until it lands

// Imperatively:
const user = await userStore.get({ id: 42 });
await user.update({ name: "New Name" });
await user.delete(); // removed from every list over this model
```

---

## Key types

```ts
import type {
  ModelSchema, // a TObject, or a TUnion of TObjects (discriminated union)
  ModelConfig, // config object passed to makeModel / makeUnionModel
  ModelConstructor, // the class returned by makeModel
  UnionModelConstructor, // the class returned by makeUnionModel
  ModelListener, // what a store exposes to hear about mutations
  ModelEventType, // "created" | "updated" | "deleted"
  ModelIdentity, // the identity-map statics — only on a model that declared identity
  ModelEvents, // the mutation fan-out statics, on every model class
  KeySpec, // what `keys` accepts: the field tuple, or false
  StoreConfig, // config object passed to makeStore
  CreateStoreConfig, // StoreConfig plus the `collections` createStore requires
  CollectionSpec, // a collections entry: a fetch, or a fetch plus that list's options
  CollectionOptions, // options for collection() — lazy options, invalidateOn, sort, optimisticCreate
  CollectionMap, // what collectionMap returns: call it with a key, plus forget/clear
  CollectionMapOptions, // CollectionOptions plus keyOf, for a free-form collectionMap key
  UseCollectionOptions, // CollectionOptions plus the params useCollection feeds the fetch
  Comparator, // (a: M, b: M) => number, what `sort` takes
  AnyModelClass, // a model class accepted as makeStore's first argument
  StoreConstructor, // the class returned by makeStore
  LazyArray, // the type of each collection
  AnnotationsMap, // re-export from mobx, for getMobxAnnotations return type
} from "@jayalfredprufrock/mobx-toolbox/model";
```

---

## Agent notes

**`buildParams` returns `undefined` for `keys: []` and `keys: false`.** All internal method implementations branch on `params === undefined` to decide whether to prepend the params argument. If you override `buildParams()` and return `undefined`, the methods behave as if no keys were configured.

**A model holds no reference to a store.** Mutations travel by event to listeners registered on the model _class_, held in a `WeakRef` set. So there is no ownership, no ordering to get wrong, and every store over the resource is notified — not just whichever one loaded the record first.

**Loads never emit events; only mutations do.** `create`, `update`, `delete`, and custom `actions` notify. `reload`, `get`, and list loads do not — which is why no suppression is needed when a 50k-row list refreshes.

**Models are built by the store from the class you pass it** — `Model.instantiate(data)`, or `new Model(data)` when the model declared `keys: false` and so has no identity to map through. To get a subclass in a list, pass the subclass: `createStore(Admin, …)`.

**`makeStore` requires a model class.** The schema form is gone: `makeModel(schema)` is the one extra line, and having a single source for the schema, keys, identity, and endpoints is what keeps the store's type surface from being inference-derived.

**A store's collections are whatever you named them.** `createStore` requires `collections` and puts each one on the instance under its own name; `makeStore` takes none, and a subclass declares each as a field built with `this.collection(...)`. Both go through the same code path, so a store never mixes the two.

**A keyed collection is registered exactly like any other, which `optimisticCreate` does not know about.** With `optimisticCreate` on, a created record is spliced into every list that opted in — including the lists of _other_ keys, which it does not belong to. It is `false` by default, so this is opt-in breakage rather than a trap, but leave it off on a store that uses `collectionMap`, or restrict it to the collections a new record certainly joins.

**`serializeKey` is shared by the identity map and by keyed collections, deliberately.** One value passes through as it stands, so a numeric id stays a number; several join on `\u0000`, which no real id contains. That is what lets a record and the params that select its list spell the same key.

**`collectionMap`'s declared-fields form rebuilds the params from the declared fields.** The fetch closure captures those, not the object the first caller happened to pass — so selecting a list with a whole model is the same call as selecting it with the fields alone, and no stray field leaks into a list every later caller shares.

**`useCollection` builds one store per component, and one store _class_ per model.** `makeStore` builds a class, so the class is cached in a `WeakMap` keyed by the model and every component instantiates it. Nothing needs disposing: the model holds its listeners weakly, so an unmounted component's store is garbage.

**`useCollection` reads `model` and the fetch once.** Both are captured on the first render, as `useState`'s initial value is. `params` is the reactive channel — everything else about the collection is fixed for the component's lifetime.

**`create` inserts nothing unless a list set `optimisticCreate`.** It always marks lists stale via the `created` event, so the server decides position and membership. Where a list does opt in, the row is placed by that list's `sort` if it has one and prepended otherwise, and a record the list already holds is never inserted twice.

**`remove(model)` drops the model from every list on the store but keeps its identity.** Removing from a list is not the same as the record ceasing to exist, so a later payload for that key still updates the same instance. `model.delete()` forgets identity, because there the record really is gone.

**A subclass may call `makeObservable(this, annotations)` but not pass an options object.** The generated base constructor already made the instance observable, and mobx rejects a second options argument with "Options can't be provided for already observable objects."

**Request bodies are typed by what you supply.** `create` and `update` leave the body unconstrained so any shape attaches; the type callers see comes from the function you attach or annotate. A `Partial<Resource>` default was tried and reverted — TypeScript's weak-type rule rejects any body sharing no field names with the resource, and a rejected slot makes the whole config fall back to its constraint, silently removing every generated method.
