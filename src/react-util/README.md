# @mobx-toolbox/react-util

General-purpose React hooks for async state, debouncing, resize observation, and mount lifecycle.

## `useAsyncFn`

Manages the state of an async function call — loading, error, and resolved value — with built-in debouncing and `AbortSignal` cancellation.

```ts
import { useAsyncFn } from "@jayalfredprufrock/mobx-toolbox/react-util";

const state = useAsyncFn(
  async (signal, query: string) => {
    const res = await fetch(`/api/search?q=${query}`, { signal });
    return res.json();
  },
  [], // deps — recreates the function when changed
  { debounceMs: 300 }, // options
);

// state.loading  — true while in-flight
// state.value    — resolved value
// state.error    — Error if the last call rejected
// state.run(q)   — call the function manually
```

The `signal` argument is an `AbortSignal` injected by the hook. Previous in-flight calls are aborted automatically when `run` is called again.

### Options

```ts
{
  initialValue?: T;              // skip the initial loading state
  debounceMs?: number;           // default 650ms
  debounceType?: "leading" | "trailing"; // default "leading"
}
```

## `useAsync`

Like `useAsyncFn` but runs automatically on mount (and whenever `deps` change), without needing to call `run` manually.

```ts
import { useAsync } from "@jayalfredprufrock/mobx-toolbox/react-util";

const state = useAsync(
  async (signal) => {
    const res = await fetch("/api/user", { signal });
    return res.json();
  },
  [], // deps
  { runImmediately: true }, // default true
);
```

## `useDebouncedCallback`

Returns a stable, debounced version of any callback.

```ts
import { useDebouncedCallback } from "@jayalfredprufrock/mobx-toolbox/react-util";

const handleSearch = useDebouncedCallback(
  (query: string) => {
    /* ... */
  },
  [
    /* deps */
  ],
  { delayMs: 400, leading: false },
);
```

The returned function is safe to call after unmount — it becomes a no-op.

## `useDebouncedEffect`

A `useEffect` that only fires after the deps have been stable for `delayMs` milliseconds.

```ts
import { useDebouncedEffect } from "@jayalfredprufrock/mobx-toolbox/react-util";

useDebouncedEffect(
  () => {
    saveToStorage(value);
  },
  [value],
  { delayMs: 500 },
);
```

## `useMountedState`

Returns a getter function that reports whether the component is currently mounted. Useful for guarding async callbacks that run after unmount.

```ts
import { useMountedState } from "@jayalfredprufrock/mobx-toolbox/react-util";

const isMounted = useMountedState();

useEffect(() => {
  fetchData().then((data) => {
    if (isMounted()) setState(data);
  });
}, []);
```

## `useMountEffect`

`useEffect` with an empty dependency array — just clearer intent.

```ts
import { useMountEffect } from "@jayalfredprufrock/mobx-toolbox/react-util";

useMountEffect(() => {
  analytics.track("page_view");
});
```

## `useStable`

Builds a value once and keeps it until `deps` change — the guarantee `useMemo` does not make.

```ts
import { useStable } from "@jayalfredprufrock/mobx-toolbox/react-util";

const controller = useStable(() => new AbortController(), [requestId]);
```

`useMemo` is documented as a _performance hint_: React may throw a cached value away and recompute it
whenever it likes. That is harmless for a derived number and quietly wrong for anything that holds
state, which would be rebuilt mid-life — a lazy observable dropping what it loaded, a store losing its
subscriptions. Reach for `useStable` whenever the value **is** the state rather than a view of it.

`deps` are compared with `Object.is`, exactly as React compares its own, and a change in the list's
length counts.

It backs [`useLazy`](../lazy-observable/README.md#uselazy--uselazyarray) and
[`useCollection`](../model/README.md#component-scoped-collections--usecollection).

## `useResize`

Tracks the **content-box** size of a DOM element using `ResizeObserver` (with a `window.resize` fallback for environments that don't support it).

```ts
import { useResize } from "@jayalfredprufrock/mobx-toolbox/react-util";

function ResizableBox() {
  const ref = useRef<HTMLDivElement>(null);

  useResize(ref, (width, height) => {
    console.log("new size:", width, height);
  });

  return <div ref={ref} />;
}
```

The callback fires with the initial size before the first paint, then again whenever the element resizes.

Content box means padding, border and scrollbars are all excluded. That matters when the measurement feeds back into layout: a width that included the scrollbar would size children to overflow the very box you measured. It also means a scrollbar (or a reserved `scrollbar-gutter` strip) appearing or disappearing is reported as a real size change. Values are fractional — round at the point of use if you need integers.

`onResize` is read through a ref, so an inline arrow is fine: the observer is created once per element and always calls your latest callback. This is the hook the `table` module uses to measure its viewport.
