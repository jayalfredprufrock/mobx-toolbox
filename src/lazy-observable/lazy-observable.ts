import {
  isObservableArray,
  reaction,
  runInAction,
  type IObservableArray,
  type IReactionDisposer,
  observable,
  onBecomeObserved,
  onBecomeUnobserved,
  untracked,
} from "mobx";

/** Options for `invalidate()`. */
export interface LazyInvalidateOptions {
  /**
   * Drop the current value instead of keeping it readable until the refetch lands.
   * Default `false`: a refresh keeps showing what it already has.
   */
  discard?: boolean;
}

export interface LazyObservable<T = any, TInitialValue = T | undefined> {
  value: TInitialValue;
  /**
   * What this lazy currently *holds* — not what it is doing. A refresh that keeps its existing
   * value stays `"loaded"`; use `fetching` to tell whether a request is in flight.
   */
  status: "init" | "loading" | "loaded" | "error";
  error: unknown;
  /** `true` when there is nothing to show yet and a request is in flight (`status === "loading"`). */
  loading: boolean;
  loaded: boolean;
  /**
   * `true` whenever a request is in flight, including a background refresh that is still
   * showing its previous value. `loading` is the subset of this with nothing to show yet.
   */
  fetching: boolean;
  /**
   * When the current value landed, as epoch milliseconds, or `undefined` when nothing is held.
   * Tracks the value itself: a refresh that keeps the old value keeps its original timestamp
   * until the new one arrives, and a failed refresh leaves it untouched.
   */
  loadedAt: number | undefined;
  /**
   * `true` while at least one reaction is observing `value`, `status`, or `error`.
   * Observable, so it can be read reactively — reading it does not itself count as
   * observing the value, so it never triggers a load.
   */
  observed: boolean;
  /** Resolve with the current value, loading first if it isn't loaded. Joins a load already in flight. */
  getOrLoad(): Promise<T>;
  /** Always start a fresh load, abandoning any result already in flight. */
  reload(): Promise<T>;
  /**
   * Write the value directly and mark it loaded, without fetching. Abandons any load in
   * flight (so it cannot clobber this write) and detaches from dependency-driven refetching
   * until the next load.
   */
  set(value: T): void;
  /**
   * Mark the value stale and load again *if anyone is watching*. If nothing is observing, the
   * load happens on next observation instead — the same rule that governs the very first load.
   *
   * The current value stays readable while the refetch runs (`status` remains `"loaded"`,
   * `fetching` becomes `true`), so a list doesn't blank out between a mutation and its
   * refresh. Pass `{ discard: true }` to clear it first and show a fresh load instead.
   */
  invalidate(options?: LazyInvalidateOptions): void;
}

export interface LazyObservableOptions {
  /**
   * Whether the value's contents are made observable recursively, as in mobx's own `deep` option.
   * Defaults to `true`. Pass `false` for values that manage their own observability — model
   * instances, for one — so nothing is converted on the way in.
   */
  deep?: boolean;
  /**
   * How long a loaded value outlives its last observer. `false` (the default) drops it as soon
   * as nothing is watching, `true` keeps it forever, and `{ for: ms }` keeps it that long before
   * dropping it — useful to survive a quick unmount/remount without refetching.
   *
   * Errors are never kept, regardless of this setting.
   */
  keepOnUnobserved?: boolean | { for: number };
  /**
   * Re-run `fetch` when observables it read while running change — a filter, a session field,
   * a parent model's id.
   *
   * `false` (the default) calls `fetch` exactly once per load, so an observable it happens to
   * touch can never trigger a request you didn't ask for. `true` tracks its reads and refetches
   * on change. `{ throttle: ms }` tracks and allows at most one refetch per window, so a burst of
   * changes (a filter bound to a text input) costs one request rather than one per keystroke.
   * The first load is never throttled.
   *
   * Note this throttles rather than debounces: the window opens at the first change and is not
   * pushed back by later ones, so sustained changes still refresh once per window instead of
   * waiting for them to stop.
   *
   * Each re-run supersedes the previous request and aborts its signal.
   */
  trackDependencies?: boolean | { throttle: number };
  /**
   * Refresh the value automatically this often, in milliseconds — for data that should not go
   * stale on screen (a dashboard, a queue, a status board).
   *
   * Only runs while something is observing: an unobserved lazy has nobody to refresh for. The
   * interval is measured from the last completed request rather than a fixed clock, so a slow
   * response pushes the next reload out instead of stacking requests. Coming back into
   * observation after longer than the interval refreshes immediately.
   *
   * The current value stays readable throughout, exactly as with `invalidate()`. A failed
   * reload reports its error and is retried on the next interval.
   */
  reloadEvery?: number;
  debugName?: string;
}

export interface LazyObservableOptionsWithInitialValue<
  TInitialValue,
> extends LazyObservableOptions {
  initialValue?: TInitialValue;
}

const noop = (): void => {};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

/**
 * What a fetch is handed. An object rather than a bare signal so more can be added later without
 * breaking every fetcher — and so a client whose own first parameter is an options bag can be
 * attached directly.
 */
export interface LazyFetchOptions {
  /**
   * Aborts as soon as the request is superseded — by `reload`, `set`, `invalidate`, going
   * unobserved, or a dependency change.
   */
  signal: AbortSignal;
}

/** Taking the argument is optional; zero-argument fetchers remain valid. */
export type LazyFetch<T> = (options: LazyFetchOptions) => Promise<T>;

export function lazyObservable<T>(fetch: LazyFetch<T>): LazyObservable<T>;
export function lazyObservable<T>(
  fetch: LazyFetch<T>,
  options: LazyObservableOptions,
): LazyObservable<T>;
export function lazyObservable<T, TInitialValue>(
  fetch: LazyFetch<T>,
  options: LazyObservableOptionsWithInitialValue<TInitialValue>,
): LazyObservable<T, TInitialValue>;

export function lazyObservable<T>(
  fetch: LazyFetch<T>,
  options?: LazyObservableOptionsWithInitialValue<T>,
): LazyObservable<T> {
  /**
   * Where the value lives. An observable array — which `lazyObservableArray` seeds — is already an
   * observable container, so it is owned directly rather than wrapped in a box. Wrapping it would
   * create two layers with only the outer one deciding when loading starts, so iterating the array
   * would track its contents without ever triggering a fetch; owning it means any read of the
   * contents both tracks *and* loads.
   *
   * Updates then replace the array's contents in place, so `value` keeps its identity for the
   * lifetime of the lazy: a reference you hold stays valid. The trade is that the identity is no
   * longer a signal — observe the contents, or `loadedAt`.
   */
  const ownedArray = isObservableArray(options?.initialValue)
    ? (options.initialValue as unknown as IObservableArray<unknown>)
    : undefined;
  // Untracked: mobx fires `onBecomeObserved` synchronously from the *first* read of an atom inside
  // a tracking context, and only that once. Constructing a lazy during an `observer()` render puts
  // this snapshot inside that context, so a tracked read here would spend the array's one
  // transition before the hooks below are attached — leaving a lazy that is watched, never learns
  // it, and so never loads.
  const initialItems = ownedArray ? untracked(() => [...ownedArray]) : undefined;
  const box = ownedArray
    ? undefined
    : observable.box<T>(options?.initialValue, { deep: options?.deep ?? true });

  /** The observable that observation hooks attach to: the array itself, or the box. */
  const valueSource = (ownedArray ?? box) as IObservableArray<unknown>;

  const readValue = (): T => (ownedArray ?? box!.get()) as T;

  const applyValue = (next: T): void => {
    if (ownedArray) ownedArray.replace(next as unknown[]);
    else box!.set(next);
  };
  const status = observable.box<LazyObservable<T>["status"]>("init");
  const error = observable.box<unknown>(undefined);

  /**
   * Observation is *derived*, never counted: this holds whichever of the public boxes are
   * currently observed, and `observed` is simply whether that set is non-empty. A single
   * shared counter miscounts any mix of consumers — a spinner reading `status` alongside a
   * list reading `value` drove it to zero while the list was still mounted, silently
   * blanking it forever.
   */
  const observedBoxes = new Set<unknown>();
  const observed = observable.box(false);

  /**
   * Staleness is its own box, deliberately not derived from `status`: the gate reaction
   * below reads it, and reading a *public* box there would register the lazy's own reaction
   * as an observer of itself — it would report as permanently observed and never be lazy.
   */
  const stale = observable.box(true);

  /** Whether a request is in flight. Separate from `status`, which describes what is held. */
  const fetching = observable.box(false);

  /** When the currently held value landed. Tracks the value, not the request. */
  const loadedAt = observable.box<number | undefined>(undefined);

  /**
   * When the last request finished, successfully or not. `reloadEvery` measures from here rather
   * than from `loadedAt` so a failed reload waits a full interval instead of retrying instantly
   * off an old value's timestamp.
   */
  const settledAt = observable.box<number | undefined>(undefined);

  let pollTimer: ReturnType<typeof setTimeout> | undefined;

  const track = options?.trackDependencies ?? false;
  const trackThrottle = typeof track === "object" ? track.throttle : 0;

  /**
   * Identifies the load whose result is still wanted. Every request captures the value at
   * its start and only applies its result if it still matches, so a superseded fetch — one
   * abandoned by `reload`, `set`, `invalidate`, or a dependency change — can never write
   * back over newer state.
   */
  let generation = 0;

  let keepTimer: ReturnType<typeof setTimeout> | undefined;
  let fetchDisposer: IReactionDisposer | undefined;
  let loadScheduled = false;
  let controller: AbortController | undefined;

  /**
   * Created only by `getOrLoad`/`reload`, i.e. only when a caller is actually awaiting a
   * value. Loads triggered by observation have no deferred, so a failed background fetch
   * surfaces through `error`/`status` instead of becoming an unhandled rejection.
   */
  let pending: Deferred<T> | undefined;

  const log = (message: string) => {
    if (options?.debugName) console.log(`lazyObservable ${options.debugName}`, message);
  };

  /**
   * Every mutation goes through here, for two reasons. Writes can originate inside a
   * derivation — `onBecomeObserved` fires during an `observer()` render — which mobx permits
   * inside an action and rejects outside one. And they always come in related groups, so
   * batching them means observers never see a half-applied state such as `loaded` with the
   * value already cleared.
   */
  const write = (fn: () => void): void => {
    runInAction(fn);
  };

  /**
   * Supersede the request in flight: its result will be discarded, and its signal aborts so
   * the work actually stops rather than merely being ignored.
   */
  const abandon = (): void => {
    clearTimeout(pollTimer);
    generation++;
    controller?.abort();
    controller = undefined;
  };

  const ensurePending = (): Deferred<T> => {
    if (pending) return pending;
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    pending = { promise, resolve, reject };
    return pending;
  };

  const settle = (requestGeneration: number, result: { value: T } | { error: unknown }): void => {
    // A newer request has superseded this one — drop the result entirely.
    if (requestGeneration !== generation) return;

    controller = undefined; // this request has landed; there is nothing left to abort

    const deferred = pending;
    pending = undefined;

    if ("error" in result) {
      write(() => {
        error.set(result.error);
        status.set("error");
        settledAt.set(Date.now());
        fetching.set(false);
      });
      deferred?.reject(result.error);
    } else {
      write(() => {
        applyValue(result.value);
        error.set(undefined);
        status.set("loaded");
        loadedAt.set(Date.now());
        settledAt.set(Date.now());
        fetching.set(false);
      });
      deferred?.resolve(result.value);
    }
  };

  /** One request: supersedes whatever came before it and applies its own result, or nothing. */
  const runRequest = (): void => {
    abandon();
    const requestGeneration = generation;
    const requestController = new AbortController();
    controller = requestController;

    write(() => {
      stale.set(false);
      fetching.set(true);
      // A refresh that still holds a value stays "loaded" so consumers keep rendering it;
      // only a load with nothing to show claims "loading".
      if (status.get() !== "loaded") {
        error.set(undefined);
        status.set("loading");
      }
    });

    let fetchPromise: Promise<T>;
    try {
      fetchPromise = fetch({ signal: requestController.signal });
    } catch (e) {
      settle(requestGeneration, { error: e });
      return;
    }

    fetchPromise.then(
      (newValue) => settle(requestGeneration, { value: newValue }),
      (e) => settle(requestGeneration, { error: e }),
    );
  };

  const startLoad = (): void => {
    clearTimeout(keepTimer);
    fetchDisposer?.();
    fetchDisposer = undefined;

    if (!track) {
      runRequest();
      return;
    }

    /**
     * The request *is* the tracked expression — that is what has to re-run to pick up new
     * dependencies — so the effect has nothing left to do. `reaction` is used rather than
     * `autorun` because it always runs that first pass synchronously (mobx routes an autorun's
     * initial pass through the scheduler too, which would postpone the very first load); with
     * `delay` only the re-runs wait. A delay of 0 makes mobx run everything synchronously, so
     * this one call covers both the tracked and the throttled cases.
     */
    fetchDisposer = reaction(runRequest, noop, { delay: trackThrottle });
  };

  /**
   * Abandon whatever is in flight and mark the value stale. The value itself is kept unless
   * `discard` is set — or unless there is no loaded value to keep, in which case there is
   * nothing to preserve and the state resets either way. Loads again only if someone is
   * awaiting a value; otherwise the gate reaction decides.
   */
  const drop = (discard: boolean): void => {
    abandon();
    clearTimeout(keepTimer);
    fetchDisposer?.();
    fetchDisposer = undefined;
    write(() => {
      stale.set(true);
      fetching.set(false);
      if (discard || status.get() !== "loaded") {
        // For an owned array, reset its *contents*: `options.initialValue` is that same live array,
        // so setting it back would leave the stale rows in place.
        if (initialItems) applyValue(initialItems as T);
        else box!.set(options?.initialValue);
        error.set(undefined);
        status.set("init");
        loadedAt.set(undefined);
      }
    });

    // A caller awaiting a value is demand, not staleness: never leave them hanging on a
    // request we just abandoned. Otherwise the gate reaction loads now if observed, or on
    // next observation if not.
    if (pending) startLoad();
  };

  /**
   * MobX fires `onBecomeObserved` synchronously, which for an `observer()` component means *during
   * its render*. Calling `startLoad()` there writes `status` mid-render, and if another mounted
   * component already observes this lazy, mobx-react-lite force-updates it while React is rendering
   * something else — which React rejects ("Cannot update a component while rendering a different
   * component").
   *
   * Deferring to a microtask moves the write just past the render pass. It still runs in the same
   * task, well before any fetch could resolve, so the only observable difference is that `status`
   * reads "init" rather than "loading" during that first render.
   */
  const scheduleLoad = (): void => {
    if (loadScheduled) return;
    loadScheduled = true;
    queueMicrotask(() => {
      loadScheduled = false;
      // Conditions are re-checked: the lazy may have been unobserved again before this ran
      // (a component that mounted and immediately unmounted), or already loaded explicitly.
      if (observed.get() && stale.get()) startLoad();
    });
  };

  /**
   * The single rule that decides when to load: something is watching, and what we hold is
   * stale. Every state-changing operation just moves those two inputs and lets this derive
   * the consequence, rather than each one re-deciding for itself.
   */
  reaction(
    () => observed.get() && stale.get(),
    (shouldLoad) => {
      if (shouldLoad) scheduleLoad();
    },
    // Fired immediately so the dependency on `observed` is registered here rather than at the end
    // of the enclosing batch. Constructing a lazy during an `observer()` render puts that batch
    // around the render, so a deferred first evaluation would not read `observed` until *after*
    // the render had already set it — leaving the reaction to treat `true` as its initial value
    // and never fire. The immediate run itself is always a no-op: nothing can observe a lazy that
    // does not exist yet.
    { fireImmediately: true },
  );

  /**
   * Auto-reload is derived the same way loading is: rather than sprinkling timer bookkeeping
   * across settle/observe/set, one reaction watches the conditions that make a reload due and
   * (re)schedules or cancels accordingly. Every input here is an internal box — reading a public
   * one would register this reaction as an observer of the lazy itself, and it would never be
   * lazy again.
   */
  if (options?.reloadEvery !== undefined) {
    const interval = options.reloadEvery;
    reaction(
      () =>
        observed.get() && !fetching.get() && !stale.get() && loadedAt.get() !== undefined
          ? settledAt.get()
          : undefined,
      (anchor) => {
        clearTimeout(pollTimer);
        if (anchor === undefined) return;
        // Overdue (came back into observation late) schedules at 0 and refreshes right away.
        pollTimer = setTimeout(startLoad, Math.max(0, interval - (Date.now() - anchor)));
      },
      { fireImmediately: true },
    );
  }

  const syncObserved = (): void => {
    const next = observedBoxes.size > 0;
    if (next === observed.get()) return;

    log(next ? "observed" : "unobserved");
    write(() => observed.set(next));

    if (next) {
      clearTimeout(keepTimer);
      return;
    }

    // Errors are never kept regardless of keepOnUnobserved — failure state shouldn't persist
    // across mounts, only successfully loaded values should.
    const keep = options?.keepOnUnobserved ?? false;
    // Unobserved data is dropped outright: nothing can be showing it, so there is nothing to keep.
    if (status.get() === "error" || keep === false) {
      drop(true);
    } else if (typeof keep === "object") {
      keepTimer = setTimeout(() => drop(true), keep.for);
    }
    // keep === true: hold the loaded value indefinitely.
  };

  for (const source of [valueSource, status, error]) {
    onBecomeObserved(source, () => {
      observedBoxes.add(source);
      syncObserved();
    });
    onBecomeUnobserved(source, () => {
      observedBoxes.delete(source);
      syncObserved();
    });
  }

  return {
    get value() {
      return readValue();
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
    get fetching() {
      return fetching.get();
    },
    get loadedAt() {
      return loadedAt.get();
    },
    get observed() {
      return observed.get();
    },
    getOrLoad() {
      if (status.get() === "loaded") return Promise.resolve(readValue());
      const deferred = ensurePending();
      // Join a load already in flight rather than starting a second one.
      if (!fetching.get()) startLoad();
      return deferred.promise;
    },
    reload() {
      const deferred = ensurePending();
      startLoad();
      return deferred.promise;
    },
    set(newValue: T) {
      abandon();
      clearTimeout(keepTimer);
      fetchDisposer?.();
      fetchDisposer = undefined;

      const deferred = pending;
      pending = undefined;

      write(() => {
        applyValue(newValue);
        error.set(undefined);
        status.set("loaded");
        loadedAt.set(Date.now());
        stale.set(false);
        fetching.set(false);
      });

      deferred?.resolve(newValue);
    },
    invalidate(invalidateOptions?: LazyInvalidateOptions) {
      drop(invalidateOptions?.discard ?? false);
    },
  };
}

export interface LazyObservableArray<T = any> extends Omit<
  // `value` is never undefined and never a different array: the lazy owns one observable array and
  // replaces its contents on every load.
  LazyObservable<IObservableArray<T>, IObservableArray<T>>,
  "set"
> {
  set(value: T[]): void;
}

export interface LazyObservableArrayOptions<T> extends LazyObservableOptions {
  initialValue?: T[];
}

export function lazyObservableArray<T>(
  fetch: LazyFetch<T[]>,
  options?: LazyObservableArrayOptions<T>,
): LazyObservableArray<T> {
  // The array is created here and owned for the lifetime of the lazy: `value` is always the same
  // `IObservableArray`, and loads replace its contents. `deep` applies to the array's *items*; the
  // box itself is a ref, since the array it holds never changes.
  const { deep, ...rest } = options ?? {};
  const items = observable.array<T>(options?.initialValue ?? [], { deep: deep ?? true });
  return lazyObservable(fetch, {
    ...rest,
    initialValue: items,
  }) as unknown as LazyObservableArray<T>;
}

export type InferLazyObservable<O> =
  O extends LazyObservableArray<infer T> ? T[] : O extends LazyObservable<infer T> ? T : never;
