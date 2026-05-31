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

## `useResizeObserver`

Tracks the size of a DOM element using `ResizeObserver` (with a `window.resize` fallback for environments that don't support it).

```ts
import { useResizeObserver } from "@jayalfredprufrock/mobx-toolbox/react-util";

function ResizableBox() {
  const ref = useRef<HTMLDivElement>(null);

  useResizeObserver(ref, (width, height) => {
    console.log("new size:", width, height);
  });

  return <div ref={ref} />;
}
```

The callback fires once on mount with the initial size, then again whenever the element resizes.
