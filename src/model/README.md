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

Each is a `LazyObservableArray<M>` that loads when first observed in a reactive context. For
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

### Options a collection inherits

Three options are declared on the store and overridden per collection, since the same answer usually
applies to every list over a resource. Each resolves the same way — the collection's own value, else
the store's, else the built-in default:

| Option             | Store-level default | What a collection can say                       |
| ------------------ | ------------------- | ----------------------------------------------- |
| `sort`             | unsorted            | its own comparator, or `false` for server order |
| `invalidateOn`     | `["created"]`       | its own event list, or `[]` to never refetch    |
| `optimisticCreate` | `false`             | `true` to show a created record before it lands |

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

### Store methods and properties

| Name                          | Description                                                             |
| ----------------------------- | ----------------------------------------------------------------------- |
| _your collection names_       | `LazyObservableArray<M>` — one per entry in `collections`, or per field |
| `collection(fetch, options?)` | Build another list on this store                                        |
| `get(...args)`                | Delegates to `Model.get`                                                |
| `create(...args)`             | Delegates to `Model.create`; inserts into lists with `optimisticCreate` |
| `remove(model)`               | Drops a model from every list on this store, without deleting anything  |
| `onModelEvent(type, model)`   | The mutation handler — override to extend it                            |

`get` and `create` exist only when the model declares them.

Extending `onModelEvent` is how anything else on the store joins in:

```ts
class SurveysWithCounts extends makeStore(SurveyModel) {
  all = this.collection(api.listSurveys);
  counts = lazyObservable(api.surveyCounts);

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
const users = userStore.all.value; // loads on first observation

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
  Comparator, // (a: M, b: M) => number, what `sort` takes
  AnyModelClass, // a model class accepted as makeStore's first argument
  StoreConstructor, // the class returned by makeStore
  LazyObservableArray, // the type of each collection
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

**`create` inserts nothing unless a list set `optimisticCreate`.** It always marks lists stale via the `created` event, so the server decides position and membership. Where a list does opt in, the row is placed by that list's `sort` if it has one and prepended otherwise, and a record the list already holds is never inserted twice.

**`remove(model)` drops the model from every list on the store but keeps its identity.** Removing from a list is not the same as the record ceasing to exist, so a later payload for that key still updates the same instance. `model.delete()` forgets identity, because there the record really is gone.

**A subclass may call `makeObservable(this, annotations)` but not pass an options object.** The generated base constructor already made the instance observable, and mobx rejects a second options argument with "Options can't be provided for already observable objects."

**Request bodies are typed by what you supply.** `create` and `update` leave the body unconstrained so any shape attaches; the type callers see comes from the function you attach or annotate. A `Partial<Resource>` default was tried and reverted — TypeScript's weak-type rule rejects any body sharing no field names with the resource, and a rejected slot makes the whole config fall back to its constraint, silently removing every generated method.
