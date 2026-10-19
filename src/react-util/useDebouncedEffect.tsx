import { type DependencyList, type EffectCallback, useEffect, useRef } from "react";
import { type UseDebouncedCallbackOptions, useDebouncedCallback } from "./useDebouncedCallback";

/**
 * A `useEffect` that only fires once its deps have been stable for `delayMs`.
 *
 * The effect's cleanup is honoured, with one difference from `useEffect` forced by the delay: it
 * runs right before the next run fires, rather than the moment the deps change — so whatever the
 * previous run set up stays in place until its replacement is ready — and on unmount.
 */
export function useDebouncedEffect(
  callback: EffectCallback,
  deps: DependencyList,
  options?: UseDebouncedCallbackOptions,
) {
  const cleanup = useRef<ReturnType<EffectCallback>>(undefined);

  const debouncedCallback = useDebouncedCallback(
    () => {
      cleanup.current?.();
      cleanup.current = callback();
    },
    deps,
    { leading: true, ...options },
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: <explanation>
  useEffect(() => debouncedCallback(), deps);

  useEffect(
    () => () => {
      cleanup.current?.();
      cleanup.current = undefined;
    },
    [],
  );
}
