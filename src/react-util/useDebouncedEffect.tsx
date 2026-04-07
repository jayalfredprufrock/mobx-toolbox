import { type DependencyList, type EffectCallback, useEffect } from "react";
import { type UseDebouncedCallbackOptions, useDebouncedCallback } from "./useDebouncedCallback";

export function useDebouncedEffect(
  callback: EffectCallback,
  deps: DependencyList,
  options?: UseDebouncedCallbackOptions,
) {
  const debouncedCallback = useDebouncedCallback(callback, deps, { leading: true, ...options });
  // biome-ignore lint/correctness/useExhaustiveDependencies: <explanation>
  return useEffect(debouncedCallback, deps);
}
