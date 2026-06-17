# @mobx-toolbox/model

Factory functions for creating MobX-observable model classes and their stores from a TypeBox schema. Models are lightweight, reactive data objects tied to an optional store reference; stores wrap a `transform` function and optionally expose `get`, `getAll`, and `create` methods.

## Setup

```ts
import { makeModel, makeStore } from "@jayalfredprufrock/mobx-toolbox/model";
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
  keys: ["id"] as const, // fields used to build API params
  reload: (params) => api.getUser(params.id),
  update: (params, body) => api.updateUser(params.id, body),
  delete: (params) => api.deleteUser(params.id),
  actions: {
    activate: (params) => api.activateUser(params.id),
  },
});

type UserInstance = InstanceType<typeof UserModel>;
```

### `keys`

`keys` is a tuple of schema property names whose values are bundled into a params object and passed as the first argument to every API method. When `keys` is empty or omitted, API methods receive no leading params argument.

```ts
// keys: ["id"] as const  →  methods receive { id: ... } as first arg
// keys: [] as const       →  methods receive no leading params arg
```

### Built-in instance methods

| Method                  | Description                                                                       |
| ----------------------- | --------------------------------------------------------------------------------- |
| `reload(...rest)`       | Calls the `reload` fn, then calls `setData` with the result                       |
| `update(body, ...rest)` | Calls the `update` fn with the body, then calls `setData`                         |
| `delete(...rest)`       | Calls the `delete` fn, then calls `store.remove(this)`                            |
| `setData(resource)`     | Replaces the model's data with a complete resource (full replace, not a merge)    |
| `toJSON()`              | Returns a plain object with all schema-defined fields                             |
| `buildParams()`         | Returns `{ [key]: this[key] }` for each configured key, or `undefined` if no keys |

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

Override `buildParams()` when the API param names differ from model field names, or to include derived values:

```ts
class UserInstance extends UserModel {
  buildParams() {
    return { userId: this.id, tenantId: currentTenant.id };
  }
  getMobxAnnotations() {
    return { role: observable }; // annotate extra fields
  }
}
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

const PaymentModel = makeUnionModel(PaymentSchema, "kind", { keys: ["id"] as const });
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

`makeStore` accepts a union schema too, so a store of union models (built in `transform` via `makeUnionModel`) is fully typed.

---

## Defining a store

`makeStore(schema, config?)` returns a class that manages a collection of models. The schema is used to type the raw API response (`R = T.Static<S>`) so all config methods and the `transform` parameter are fully typed.

```ts
const UserStore = makeStore(UserSchema, {
  transform(data) {
    // data is typed as T.Static<typeof UserSchema> — no annotation needed
    return new UserModel(data, this); // `this` is the store instance
  },
  get: (id: number) => api.getUser(id),
  getAll: () => api.getUsers(),
  create: (body: Partial<User>) => api.createUser(body),
});

const userStore = new UserStore();
```

`transform` is optional. When omitted, models are the raw schema objects (`M = R`):

```ts
const UserStore = makeStore(UserSchema, {
  getAll: () => api.getUsers(),
});
// store.all.value is LazyObservableArray<T.Static<typeof UserSchema>>
```

### Store methods and properties

| Name              | Description                                                                  |
| ----------------- | ---------------------------------------------------------------------------- |
| `remove(model)`   | Removes the model from `all.value`                                           |
| `get(...args)`    | Calls the `get` fn and returns a transformed model                           |
| `getAll()`        | Returns `all.getOrLoad()` — triggers a load if not yet loaded                |
| `create(...args)` | Calls the `create` fn, transforms the result, and prepends it to `all.value` |
| `all`             | `LazyObservableArray<M>` — populated when `getAll` is configured             |

`all` is a `LazyObservableArray` that loads automatically when first observed in a reactive context (e.g., inside an observer component). Use `getAll()` for imperative access.

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
  keys: ["id"] as const,
  reload: ({ id }) => api.get(`/users/${id}`),
  update: ({ id }, body) => api.patch(`/users/${id}`, body),
  delete: ({ id }) => api.delete(`/users/${id}`),
});

const UserStore = makeStore(UserSchema, {
  transform(data) {
    return new UserModel(data, this);
  },
  getAll: () => api.get("/users"),
  create: (body) => api.post("/users", body),
});

export const userStore = new UserStore();

// In a component (observer):
const users = userStore.all.value; // loads on first observation

// Imperatively:
const user = await userStore.get(42);
await user.update({ name: "New Name" });
await user.delete(); // also calls userStore.remove(user)
```

---

## Key types

```ts
import type {
  ModelSchema, // a TObject, or a TUnion of TObjects (discriminated union)
  ModelConfig, // config object passed to makeModel / makeUnionModel
  ModelConstructor, // the class returned by makeModel
  UnionModelConstructor, // the class returned by makeUnionModel
  ModelStore, // minimal interface a store must satisfy (has remove?)
  StoreConfig, // config object passed to makeStore
  StoreConstructor, // the class returned by makeStore
  LazyObservableArray, // the type of store.all
  AnnotationsMap, // re-export from mobx, for getMobxAnnotations return type
} from "@jayalfredprufrock/mobx-toolbox/model";
```

---

## Agent notes

**`buildParams` returns `undefined` when `keys` is empty.** All internal method implementations branch on `params === undefined` to decide whether to prepend the params argument. If you override `buildParams()` and return `undefined`, the methods behave as if no keys were configured.

**`store.remove` is called only if the store reference exists and exposes a `remove` method.** The `ModelStore` interface makes `remove` optional — stores that do not manage a collection can omit it.

**`transform` is optional.** When omitted, the model type is `T.Static<S>` (the raw schema type). When provided, the model type is its return type.

**`transform` is bound to the store instance.** Inside `transform`, `this` refers to the store. This allows the transform to pass `this` as the store reference to the model constructor, wiring up `model.store`.

**`all` is only present when `getAll` is configured.** Accessing `store.all` when `getAll` was not passed to `makeStore` returns `undefined`. The `getAll()` method and `create` method both depend on `all` being present.

**`create` prepends to `all.value` — it does not append.** Newly created models appear at index `0` of the observable array.
