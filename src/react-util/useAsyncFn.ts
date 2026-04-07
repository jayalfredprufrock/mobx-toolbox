import { type DependencyList, useCallback, useEffect, useRef, useState } from "react";

export interface UseAsyncFnOptions<F extends UseAsyncFn> {
  initialValue?: InferValue<F>;
  debounceMs?: number;
  debounceType?: "leading" | "trailing";
}

export type UseAsyncFn = (signal: AbortSignal, ...args: any[]) => Promise<any>;
export type UseAsyncFnRun<Value, Args> = Args extends unknown[]
  ? (...args: Args) => Promise<Value>
  : () => Promise<Value>;

export interface UseAsyncFnStateBase<Value, Args> {
  run: UseAsyncFnRun<Value, Args>;
}

export interface UseAsyncFnStateLoading<Value, Args> extends UseAsyncFnStateBase<Value, Args> {
  loading: true;
  error?: Error | undefined;
  value?: Value;
}

export interface UseAsyncFnStateError<Value, Args> extends UseAsyncFnStateBase<Value, Args> {
  loading: false;
  error: Error;
  value?: undefined;
}

export interface UseAsyncFnStateResolved<Value, Args> extends UseAsyncFnStateBase<Value, Args> {
  loading: false;
  error?: undefined;
  value: Value;
}

type InferValue<F extends UseAsyncFn> = Awaited<ReturnType<F>>;
type InferArgs<F extends UseAsyncFn> = Parameters<F> extends [any, ...infer Rest] ? Rest : [];

export type UseAsyncFnState<Value, Args> =
  | UseAsyncFnStateLoading<Value, Args>
  | UseAsyncFnStateError<Value, Args>
  | UseAsyncFnStateResolved<Value, Args>;

export const useAsyncFn = <F extends UseAsyncFn, Value = InferValue<F>, Args = InferArgs<F>>(
  fn: F,
  deps: DependencyList = [],
  options?: UseAsyncFnOptions<F>,
): UseAsyncFnState<Value, Args> => {
  const { debounceType = "leading", debounceMs = 650 } = options ?? {};

  const timeoutRef = useRef<number | undefined>(undefined);
  const abortControllerRef = useRef<AbortController | undefined>(undefined);

  const [state, setState] = useState<Omit<UseAsyncFnState<Value, Args>, "run">>(
    options?.initialValue ? { loading: false, value: options?.initialValue } : { loading: true },
  );

  const run = useCallback((...args: Parameters<F>) => {
    window.clearTimeout(timeoutRef.current);

    abortControllerRef.current?.abort();
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    if (!state?.loading) {
      setState((prevState) => ({ ...prevState, loading: true }));
    }

    return new Promise((resolve, reject) => {
      const timeoutMs = debounceType === "leading" && !timeoutRef.current ? 0 : debounceMs;

      timeoutRef.current = window.setTimeout(() => {
        fn(abortController.signal, ...args)
          .then(
            (value) => {
              if (!abortController.signal.aborted) {
                setState({ value, loading: false });
              }
              resolve(value);
            },
            (error) => {
              if (!abortController.signal.aborted) {
                setState({ error, loading: false });
              }
              reject(error);
            },
          )
          .finally(() => {
            timeoutRef.current = undefined;
          });
      }, timeoutMs);
    });

    // biome-ignore lint/correctness/useExhaustiveDependencies: deps are controlled by caller
  }, deps);

  useEffect(() => {
    return () => abortControllerRef.current?.abort();
  }, []);

  return { ...state, run } as UseAsyncFnState<Value, Args>;
};
