import { type DependencyList, useEffect, useRef } from "react";
import { type UseAsyncFn, type UseAsyncFnOptions, useAsyncFn } from "./useAsyncFn";

export const useAsync = <F extends UseAsyncFn>(
  fn: F,
  deps: DependencyList = [],
  options?: UseAsyncFnOptions<F> & { runImmediately?: boolean },
) => {
  const firstRun = useRef(true);

  const { runImmediately = true, ...useAsyncFnOptions } = options ?? {};

  const asyncFn = useAsyncFn(fn, deps, useAsyncFnOptions);

  // biome-ignore lint/correctness/useExhaustiveDependencies: option changes should not trigger effect
  useEffect(() => {
    const isFirstRun = firstRun.current;
    firstRun.current = false;

    if (!runImmediately && isFirstRun) return;

    // TODO: how should errors be handled? this isn't great...
    void asyncFn.run();
  }, [asyncFn.run]);

  return asyncFn;
};
