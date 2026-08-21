import { useRef } from "react";

const depsChanged = (previous: React.DependencyList, next: React.DependencyList): boolean =>
  previous.length !== next.length || previous.some((dep, i) => !Object.is(dep, next[i]));

/**
 * Build a value once and keep it until `deps` change — the guarantee `useMemo` does not make.
 *
 * `useMemo` is a performance hint: React may discard a cached value and recompute it whenever it
 * likes. That is harmless for a derived number and quietly wrong for anything holding state, which
 * would be silently rebuilt mid-life — a lazy observable dropping what it had loaded, a store losing
 * its subscriptions. Reach for this whenever the value *is* the state rather than a view of it.
 *
 * ```ts
 * const controller = useStable(() => new AbortController(), [requestId]);
 * ```
 *
 * `deps` are compared with `Object.is`, exactly as React compares its own.
 */
export function useStable<T>(create: () => T, deps: React.DependencyList): T {
  const ref = useRef<{ deps: React.DependencyList; value: T } | undefined>(undefined);

  if (!ref.current || depsChanged(ref.current.deps, deps)) {
    ref.current = { deps, value: create() };
  }

  return ref.current.value;
}
