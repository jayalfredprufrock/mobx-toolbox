import { type DependencyList, useCallback, useEffect, useRef } from "react";

export interface UseDebouncedCallbackOptions {
  leading?: boolean;
  delayMs?: number;
}

export function useDebouncedCallback<T extends (...args: any) => any>(
  callback: T,
  deps: DependencyList,
  options?: UseDebouncedCallbackOptions,
) {
  const ref = useRef<
    UseDebouncedCallbackOptions & {
      timeout: number | null;
      mounted: boolean;
      leadingTriggered: boolean;
    }
  >({
    ...options,
    timeout: null,
    mounted: false,
    leadingTriggered: options?.leading ?? false,
  });

  useEffect(() => {
    const currentRef = ref.current;
    currentRef.mounted = true;
    currentRef.leadingTriggered = false;
    return () => {
      currentRef.mounted = false;
      window.clearTimeout(currentRef.timeout!);
    };
  }, []);

  return useCallback((...params: Parameters<T>) => {
    const currentRef = ref.current;
    window.clearTimeout(currentRef.timeout!);
    if (!currentRef.leadingTriggered && currentRef.leading) {
      currentRef.leadingTriggered = true;
      callback(...params);
      currentRef.timeout = window.setTimeout(() => {
        currentRef.leadingTriggered = true;
      }, currentRef.delayMs ?? 1600);
    } else {
      currentRef.timeout = window.setTimeout(() => {
        if (!currentRef.mounted) return;
        callback(...params);
        currentRef.leadingTriggered = false;
      }, currentRef.delayMs ?? 1600);
    }
    // biome-ignore lint/correctness/useExhaustiveDependencies: <explanation>
  }, deps) as T;
}
