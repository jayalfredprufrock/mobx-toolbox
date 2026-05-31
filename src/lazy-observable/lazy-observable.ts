import {
  _allowStateChanges,
  autorun,
  type IObservableArray,
  type IReactionDisposer,
  observable,
  onBecomeObserved,
  onBecomeUnobserved,
} from "mobx";

export interface LazyObservable<T = any, TInitialValue = T | undefined> {
  value: TInitialValue;
  reset(): TInitialValue;
  getOrLoad(): Promise<T>;
  set(value: T): void;
  reload(): Promise<T>;
  status: "init" | "loading" | "loaded" | "error";
  error: unknown;
  loading: boolean;
  loaded: boolean;
}

export interface LazyObservableOptions {
  shallow?: boolean;
  resetOnUnobserved?: "never" | "always" | number;
  debugName?: string;
}

export interface LazyObservableOptionsWithInitialValue<
  TInitialValue,
> extends LazyObservableOptions {
  initialValue?: TInitialValue;
}

export function lazyObservable<T>(fetch: () => Promise<T>): LazyObservable<T>;
export function lazyObservable<T>(
  fetch: () => Promise<T>,
  options: LazyObservableOptions,
): LazyObservable<T>;
export function lazyObservable<T, TInitialValue>(
  fetch: () => Promise<T>,
  options: LazyObservableOptionsWithInitialValue<TInitialValue>,
): LazyObservable<T, TInitialValue>;

export function lazyObservable<T>(
  fetch: () => Promise<T>,
  options?: LazyObservableOptionsWithInitialValue<T>,
): LazyObservable<T> {
  const value = observable.box<T>(options?.initialValue, { deep: !options?.shallow });
  const status = observable.box<LazyObservable<T>["status"]>("init");
  const error = observable.box<unknown>(undefined);

  let resetTimer: NodeJS.Timeout;
  let autorunDisposer: IReactionDisposer;

  let promise: Promise<T> | undefined;
  let promiseResolve: ((value: T) => void) | undefined;
  let promiseReject: ((value: unknown) => void) | undefined;

  const getOrCreatePromise = () => {
    if (promise && status.get() !== "loaded" && status.get() !== "error") {
      return promise;
    }
    promise = new Promise<T>((resolve, reject) => {
      promiseResolve = resolve;
      promiseReject = reject;
    });
    return promise;
  };

  const reset = () => {
    clearTimeout(resetTimer);
    autorunDisposer?.();
    _allowStateChanges(true, () => {
      value.set(options?.initialValue);
      status.set("init");
      error.set(undefined);
    });
    return options?.initialValue;
  };

  const load = (): void => {
    if (status.get() === "loading") return;
    clearTimeout(resetTimer);

    // TODO: this disposer is unreliable while we are using
    // babel to convert all async function to generators
    autorunDisposer?.();
    autorunDisposer = autorun(() => {
      _allowStateChanges(true, () => {
        status.set("loading");
        error.set(undefined);
      });

      let fetchPromise: Promise<T>;
      try {
        fetchPromise = fetch();
      } catch (e) {
        _allowStateChanges(true, () => {
          error.set(e);
          status.set("error");
          promiseReject?.(e);
        });
        return;
      }

      fetchPromise
        .then((newValue) => {
          _allowStateChanges(true, () => {
            value.set(newValue);
            status.set("loaded");
            promiseResolve?.(newValue);
          });
        })
        .catch((e) => {
          _allowStateChanges(true, () => {
            error.set(e);
            status.set("error");
            promiseReject?.(e);
          });
        });
    });
  };

  // TODO: should this resolve any promises?
  const set = (val: T): void => {
    _allowStateChanges(true, () => {
      value.set(val);
      status.set("loaded");
    });
  };

  let observedCount = 0;

  const onObserved = () => {
    observedCount = Math.min(2, observedCount + 1);

    // only consider observed the first time this handler gets called
    if (observedCount !== 1) return;

    if (options?.debugName) {
      console.log(`lazyObservable ${options.debugName}`, "observed");
    }
    clearTimeout(resetTimer);
    if (status.get() === "error" || status.get() === "init") {
      load();
    }
  };

  const onUnobserved = () => {
    observedCount = Math.max(0, observedCount - 1);

    // only consider unobserved when count reaches zero
    if (observedCount) return;

    if (options?.debugName) {
      console.log(`lazyObservable ${options.debugName}`, "unobserved");
    }

    // Errors are never cached regardless of resetOnUnobserved — failure state
    // shouldn't persist across mounts, only successfully loaded values should.
    if (status.get() === "error") {
      _allowStateChanges(true, () => {
        status.set("init");
        error.set(undefined);
      });
      return;
    }

    if (options?.resetOnUnobserved === "never") {
      return;
    } else if (typeof options?.resetOnUnobserved === "number") {
      resetTimer = setTimeout(() => {
        reset();
      }, options?.resetOnUnobserved);
    } else {
      reset();
    }
  };

  onBecomeObserved(value, onObserved);
  onBecomeObserved(status, onObserved);
  onBecomeObserved(error, onObserved);

  onBecomeUnobserved(value, onUnobserved);
  onBecomeUnobserved(status, onUnobserved);
  onBecomeUnobserved(error, onUnobserved);

  return {
    get value() {
      return value.get();
    },
    get status() {
      return status.get();
    },
    get error() {
      return error.get();
    },
    get loading() {
      return status.get() === "loading";
    },
    get loaded() {
      return status.get() === "loaded";
    },
    reload() {
      const promise = getOrCreatePromise();
      load();
      return promise;
    },
    getOrLoad() {
      // TODO: this assertion shouldn't be necessary
      // consider fixing box/value type
      if (this.loaded) return Promise.resolve(value.get() as Promise<T>);
      return this.reload();
    },
    set,
    reset,
  };
}

export interface LazyObservableArray<T = any> extends Omit<
  LazyObservable<IObservableArray<T>>,
  "set"
> {
  set(value: T[]): void;
}

export interface LazyObservableArrayOptions<T> extends LazyObservableOptions {
  initialValue?: T[];
}

export function lazyObservableArray<T>(
  fetch: () => Promise<T[]>,
  options?: LazyObservableArrayOptions<T>,
): LazyObservableArray<T> {
  return lazyObservable(fetch, { initialValue: [], ...options }) as LazyObservableArray<T>;
}

export type InferLazyObservable<O> =
  O extends LazyObservableArray<infer T> ? T[] : O extends LazyObservable<infer T> ? T : never;
