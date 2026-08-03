# mobx-toolbox

A collection of MobX + React utilities: lazy-loading observables, model/store factories, a client-side router, form state management, dialog management, a headless virtualized table, and general-purpose React hooks.

## Installation

```sh
pnpm add @jayalfredprufrock/mobx-toolbox mobx mobx-react-lite
```

Peer dependencies are per-module — see the **Requires** column below. `typebox` and `history` are declared optional, so they are only pulled in if you reach for `form`/`model` or `router`.

---

## Modules

Each module is its own entry point — import from `@jayalfredprufrock/mobx-toolbox/<module>` so you only pull in what you use.

| Module                                | Summary                                                                       | Requires                                      |
| ------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------- |
| [`dialog`](#dialog)                   | Dialog/modal stack with state transitions for enter/exit animations           | `mobx`, `mobx-react-lite`, `react`            |
| [`form`](#form)                       | Schema-driven form state with TypeBox validation and submit lifecycle         | `mobx`, `mobx-react-lite`, `react`, `typebox` |
| [`lazy-observable`](#lazy-observable) | Observables that fetch on first observation and reset when unobserved         | `mobx`, `mobx-react-lite`, `react`            |
| [`model`](#model)                     | Observable model classes and collection stores from TypeBox schemas           | `mobx`, `typebox`                             |
| [`react-util`](#react-util)           | General-purpose React hooks: async state, debouncing, resize, mount lifecycle | `react`                                       |
| [`router`](#router)                   | Client-side router with symbol-keyed guards, loaders and layouts              | `mobx`, `mobx-react-lite`, `react`, `history` |
| [`table`](#table)                     | Headless, virtualized data table                                              | `mobx`, `mobx-react-lite`, `react`            |
| [`uploader`](#uploader)               | Headless multipart upload engine with progress, retries and a form value      | `mobx`, `mobx-react-lite`, `react`            |
| [`util`](#util)                       | Small MobX + React utilities — `mutable`, `useAutorun`                        | `mobx`, `react`                               |

### [`dialog`](src/dialog/README.md)

MobX-powered dialog/modal stack with state-transition support for enter/exit animations.

```tsx
import { useDialogs, MobxDialogs } from "@jayalfredprufrock/mobx-toolbox/dialog";

function App() {
  const dialogs = useDialogs();
  return <MobxDialogs store={dialogs} />;
}

// Anywhere in the tree:
const dialogs = useDialogStore();
dialogs.open(ConfirmModal, { message: "Are you sure?" });
```

→ [Full docs](src/dialog/README.md)

---

### [`form`](src/form/README.md)

Schema-driven form state with TypeBox validation, field-level error messages, and submit lifecycle tracking.

```tsx
import { useForm, MobxForm } from "@jayalfredprufrock/mobx-toolbox/form";
import * as T from "typebox";

const schema = T.Object({ email: T.String(), password: T.String({ minLength: 8 }) });

function LoginForm() {
  const form = useForm(schema, { handleSubmit: async (data) => login(data) });
  return (
    <MobxForm store={form}>
      <input {...form.fields.email.props()} />
      <button type="submit">Login</button>
    </MobxForm>
  );
}
```

→ [Full docs](src/form/README.md)

---

### [`lazy-observable`](src/lazy-observable/README.md)

Lazy-loading MobX observables that fetch data on first observation and reset automatically when unobserved.

```ts
import { lazyObservableArray } from "@jayalfredprufrock/mobx-toolbox/lazy-observable";

const users = lazyObservableArray(() => api.getUsers());
// users.value is [] until observed; fetch fires automatically inside an observer
```

Includes a `LazyObserver` React component that renders a placeholder while loading and propagates fetch errors to an error boundary.

→ [Full docs](src/lazy-observable/README.md)

---

### [`model`](src/model/README.md)

Factory functions for creating observable model classes and collection stores from TypeBox schemas.

```ts
import { makeModel, makeStore } from "@jayalfredprufrock/mobx-toolbox/model";
import * as T from "typebox";

const UserModel = makeModel(T.Object({ id: T.Number(), name: T.String() }), {
  keys: ["id"] as const,
  reload: ({ id }) => api.get(`/users/${id}`),
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
await userStore.getAll(); // → User[]
await userStore.all.value[0].delete(); // removes from store too
```

→ [Full docs](src/model/README.md)

---

### [`react-util`](src/react-util/README.md)

General-purpose React hooks: async state management, debouncing, resize observation, and mount lifecycle helpers.

```ts
import { useAsync, useDebouncedCallback } from "@jayalfredprufrock/mobx-toolbox/react-util";

// Runs on mount; re-runs when deps change; handles loading/error/value
const state = useAsync(async (signal) => fetchUser(id), [id]);

// Stable debounced callback, safe to call after unmount
const save = useDebouncedCallback((value) => persist(value), []);
```

→ [Full docs](src/react-util/README.md)

---

### [`router`](src/router/README.md)

MobX-based client-side router for React. Routes are plain objects; symbol-keyed metadata controls guards, loaders, and layouts.

```tsx
import {
  RouterStore,
  Router,
  makeRoutes,
  GUARD,
  LOAD,
} from "@jayalfredprufrock/mobx-toolbox/router";

const routes = makeRoutes()({
  index: HomePage,
  dashboard: {
    [GUARD]: requireAuth,
    [LOAD]: loadDashboard,
    index: DashboardPage,
    $id: DetailPage,
  },
});

const router = new RouterStore();
router.initialize(routes);

function App() {
  return <Router store={router} />;
}
```

→ [Full docs](src/router/README.md)

---

### [`table`](src/table/README.md)

Headless, virtualized data table. The model owns columns, widths, sorting, selection, expansion and the render window; the components own only structure and ARIA.

```tsx
import { useTable, Table } from "@jayalfredprufrock/mobx-toolbox/table";

function UserTable({ users }) {
  const table = useTable({ rows: users, columns: ["name", "email", { selection: true }] });

  return (
    <Table.Root table={table}>
      <Table.Header>
        {(column) => <Table.ColumnHeader column={column}>{column.title}</Table.ColumnHeader>}
      </Table.Header>
      <Table.Body>
        {(row) => (
          <Table.Row row={row}>
            {(column) => <Table.Cell column={column}>{String(column.getValue(row))}</Table.Cell>}
          </Table.Row>
        )}
      </Table.Body>
    </Table.Root>
  );
}
```

→ [Full docs](src/table/README.md)

---

### [`uploader`](src/uploader/README.md)

Headless multipart upload engine. The model owns part slicing, concurrency, progress, retries, cancellation and the completed-upload form value; you own the selection UI. Drives equally well from a bare `<input>` or from Chakra/Ark's `FileUpload`.

```tsx
import { useUploader, Uploader } from "@jayalfredprufrock/mobx-toolbox/uploader";

function DocumentUpload({ value, onChange }) {
  const uploader = useUploader({
    accept: ".pdf",
    value,
    onChange,
    requestUpload: async (signal, file) => {
      const res = await api.requestUpload({ fileName: file.name, size: file.size }, { signal });
      // part sizes come from the server — never derived client-side
      return { id: res.id, name: res.fileName, parts: res.parts };
    },
  });

  return (
    <Uploader.Root uploader={uploader}>
      <ul>
        <Uploader.Uploads>
          {(upload) => (
            <li>
              {upload.name} — {upload.status} {upload.progress}%
            </li>
          )}
        </Uploader.Uploads>
      </ul>
    </Uploader.Root>
  );
}
```

→ [Full docs](src/uploader/README.md)

---

### [`util`](src/util/README.md)

Small MobX + React utilities.

```ts
import { mutable, useAutorun } from "@jayalfredprufrock/mobx-toolbox/util";

// Class accessor decorator — makes a field reactive without makeObservable
class Store {
  @mutable accessor theme = "light";
}

// MobX autorun that disposes on unmount
function MyComponent() {
  useAutorun(() => {
    document.title = store.pageTitle;
  });
}
```

→ [Full docs](src/util/README.md)
