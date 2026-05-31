# @mobx-toolbox/dialog

MobX-powered dialog/modal management for React. Tracks open dialogs in a stack with state transitions for enter/exit animations, and wires everything up through React context.

## Setup

```tsx
import { DialogStore, MobxDialogs, useDialogs } from "@jayalfredprufrock/mobx-toolbox/dialog";

// Option A — standalone store, render MobxDialogs at the root
const dialogStore = new DialogStore();

function App() {
  return (
    <>
      <MobxDialogs store={dialogStore} />
      <YourApp />
    </>
  );
}

// Option B — hook-managed store (created once and persisted across renders)
function App() {
  const dialogs = useDialogs(); // creates a DialogStore for you
  return (
    <>
      <MobxDialogs store={dialogs} />
      <YourApp />
    </>
  );
}
```

## Opening dialogs

```tsx
import { useDialogStore } from "@jayalfredprufrock/mobx-toolbox/dialog";

function SomeButton() {
  const dialogs = useDialogStore();

  return <button onClick={() => dialogs.open(MyModal, { title: "Hello" })}>Open modal</button>;
}
```

`store.open(Component, props?)` creates a `DialogModel` in `"opening"` state and removes it automatically when closed. When the component requires props, TypeScript enforces them; when it has no required props, `props` is optional.

## Closing dialogs

```tsx
import { useDialogContext, useDialogStore } from "@jayalfredprufrock/mobx-toolbox/dialog";

function MyModal({ title }: { title: string }) {
  const dialog = useDialogContext(); // the DialogModel for this modal
  const store = useDialogStore();

  return (
    <div>
      <h2>{title}</h2>
      <button onClick={() => dialog.close()}>Close with animation</button>
      <button onClick={() => store.close(true)}>Close active dialog immediately</button>
    </div>
  );
}
```

`dialog.close()` transitions to `"closing"` so CSS animations can run before the dialog is removed. Call `dialog.close(true)` or `dialog.setState("closed")` to skip the animation.

## Animating with state

The `dialog.state` field drives CSS class names or conditional rendering for enter/exit transitions:

```tsx
function MyModal() {
  const dialog = useDialogContext();

  return (
    <div className={`modal modal--${dialog.state}`}>
      {/* apply CSS transitions based on "opening" | "opened" | "closing" | "closed" */}
    </div>
  );
}
```

When your CSS transition finishes, call `dialog.setState("opened")` (on open) or `dialog.setState("closed")` (on close) to advance the state.

## Long-lived dialogs

`store.open()` always sets `removeOnClosed: true`. For persistent dialogs (e.g., a side panel that should survive between open/close cycles), use `store.add()`:

```tsx
const panel = store.add({
  component: SidePanel,
  props: { ... },
  initialState: "closed",
  removeOnClosed: false,
});

// Later:
panel.open();   // → "opening"
panel.close();  // → "closing", but NOT removed from store
```

## `DialogStore` API

```ts
const store = new DialogStore();

store.open(Component, props?)   // create + open immediately (removeOnClosed=true)
store.add(config)               // full control — returns DialogModel
store.close(immediately?)       // close the active (topmost) dialog

store.dialogs                   // Map<string, DialogModel> — all registered dialogs
store.openDialogs               // DialogModel[] — non-closed dialogs sorted by openedAt
store.activeDialog              // DialogModel | undefined — topmost open dialog
```

## `DialogModel` API

```ts
dialog.id         // string — auto-generated or config.id
dialog.state      // "opening" | "opened" | "closing" | "closed"
dialog.openedAt   // number — Date.now() when opened
dialog.component  // the React component
dialog.props      // props passed on creation

dialog.open(immediately?)    // → "opening" or "opened"
dialog.close(immediately?)   // → "closing" or "closed"
dialog.setState(state)       // direct transition
```

## Context hooks

| Hook                            | Description                                                                         |
| ------------------------------- | ----------------------------------------------------------------------------------- |
| `useDialogStore()`              | Access the nearest `DialogStore`. Throws if no provider.                            |
| `useDialogStore(store)`         | Pass an explicit store — same result, no context lookup.                            |
| `useDialogContextIfAvailable()` | Returns the store or `undefined` — safe outside a provider.                         |
| `useDialogContext()`            | Access the `DialogModel` for the current dialog. Throws if not inside `MobxDialog`. |

## Key types

```ts
import type {
  DialogState, // "opening" | "opened" | "closing" | "closed"
  DialogModelConfig, // config object for store.add()
  AnyComponent, // React.FC<any>
} from "@jayalfredprufrock/mobx-toolbox/dialog";
```
