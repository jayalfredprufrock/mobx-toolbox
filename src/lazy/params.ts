import { compareShallow, untracked } from "mobx";
import { useRef } from "react";
import { useObservableBox } from "../util/use-observable-box";

/**
 * A lazy's options as a hook takes them: everything but `trackDependencies`, which the hook does
 * for itself. Its inputs arrive as `params`, so there is nothing else for the fetch to track.
 */
export type WithoutTracking<O> = Omit<O, "trackDependencies">;

/**
 * Turn `params` into a dependency list, for a hook that discards on a param change by rebuilding
 * what it holds. Sorted by key so a differently-ordered object of the same values isn't read as a
 * change, and keys are included alongside values so adding or removing one counts.
 */
const paramsToDeps = (params: object): unknown[] =>
  Object.entries(params)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .flat();

/** Resolve after `ms`, or reject with the signal's reason the moment it aborts. */
const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

/** What {@link useParamsFetch} hands back for a hook to build its lazy from. */
export interface ParamsFetch<A> {
  /** The fetch the lazy calls, with the params already applied ahead of `A`. */
  fetch: (arg: A) => Promise<any>;
  /** The caller's options, minus the hook's own, plus whatever keeping needs. */
  options: Record<string, any>;
  /** What to rebuild on: the params when discarding, nothing otherwise. */
  deps: unknown[];
}

/**
 * The `params` logic every component-scoped lazy hook shares — `useLazy`, `useLazyArray`,
 * `useLazyPages`, `useCollection` and `usePagedCollection` — so they can't drift apart on what a
 * param change does. Each hook builds its lazy from the result, through `useStable` with `deps`.
 *
 * - **No `params`:** the fetch is passed through and the lazy is built once.
 * - **Discarding:** the params are applied directly and become the deps, so a change rebuilds the
 *   lazy. The new one is what that very render returns, so no render ever pairs the new params with
 *   the old value.
 * - **Keeping:** one lazy for the component's lifetime, reading the params through an observable
 *   box. Tracked, so a change refetches in place. Only the box is tracked: the caller's fetch runs
 *   untracked, since anything it should react to belongs in `params`.
 *
 * **`debounce` waits inside the request**, not in front of it. The params reach the lazy at once,
 * so the refetch starts — `fetching` is `true` from the first keystroke, which is what a "searching…"
 * indicator needs — and the request sleeps on its own signal before calling the caller's fetch.
 * Another change supersedes it, which aborts the sleep and starts a fresh one: a true debounce, with
 * no timer held in React and nothing to clean up, because unmounting leaves the lazy unobserved and
 * that aborts the sleep too.
 *
 * Only a param change waits. A request with the same params as the one before it — the first load,
 * a reload, an invalidation from a mutation, a `setQuery`, a next page — goes straight out. "The
 * one before" spans lazies, so a discarding rebuild's first request waits too, while the component's
 * very first does not.
 *
 * `discardByDefault` is the one thing the hooks disagree on: the collection hooks keep, everything
 * else discards.
 *
 * Internal: not exported from the package.
 */
export function useParamsFetch<A extends { signal: AbortSignal }>(
  fetch: (...args: any[]) => Promise<any>,
  options: { params?: unknown; discardOnChange?: boolean; debounce?: number } | undefined,
  discardByDefault: boolean,
): ParamsFetch<A> {
  const hasParams = options !== undefined && "params" in options;
  // Destructuring into a rest rather than passing `options` straight through: a seed is read off the
  // presence of its key, which an absent bag and an empty one answer the same way.
  const { params, discardOnChange = discardByDefault, debounce = 0, ...rest } = options ?? {};
  // Called whatever the form, since a hook can't be conditional; only a keeping lazy reads it.
  const box = useObservableBox(params);
  // The params the last request went out with — across rebuilds, so a discarding change can tell
  // it is one. Empty until the first request, which therefore never waits.
  const last = useRef<{ params: unknown }>(undefined);

  if (!hasParams) return { fetch, options: rest, deps: [] };

  const request = async (current: unknown, arg: A) => {
    const previous = last.current;
    last.current = { params: current };
    if (debounce > 0 && previous && !compareShallow(previous.params, current)) {
      await sleep(debounce, arg.signal);
    }
    return untracked(() => fetch(current, arg));
  };

  if (!discardOnChange) {
    return {
      // Read synchronously, before anything awaits, so the tracking pass sees it.
      fetch: (arg) => request(box.get(), arg),
      // After the caller's options rather than before: tracking is how a keeping lazy hears about a
      // param change at all, so it is not the caller's to turn off.
      options: { ...rest, trackDependencies: true },
      deps: [],
    };
  }

  return {
    fetch: (arg) => request(params, arg),
    options: rest,
    deps: paramsToDeps(params as object),
  };
}
