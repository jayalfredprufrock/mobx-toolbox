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
| `setData(partial)`      | Merges a partial update into the observable fields                                |
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

---

## Defining a store

`makeStore(config)` returns a class that manages a collection of models.

```ts
const UserStore = makeStore({
  transform(data) {
    return new UserModel(data, this); // `this` is the store instance
  },
  get: (id: number) => api.getUser(id),
  getAll: () => api.getUsers(),
  create: (body: Partial<User>) => api.createUser(body),
});

const userStore = new UserStore();
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

const UserStore = makeStore({
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
  ModelConfig, // config object passed to makeModel
  ModelConstructor, // the class returned by makeModel
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

**`transform` is bound to the store instance.** Inside `transform`, `this` refers to the store. This allows the transform to pass `this` as the store reference to the model constructor, wiring up `model.store`.

**`all` is only present when `getAll` is configured.** Accessing `store.all` when `getAll` was not passed to `makeStore` returns `undefined`. The `getAll()` method and `create` method both depend on `all` being present.

**`create` prepends to `all.value` — it does not append.** Newly created models appear at index `0` of the observable array.
