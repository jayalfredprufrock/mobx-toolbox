import {
  comparer,
  reaction,
  runInAction,
  type IObservableArray,
  type IReactionDisposer,
  observable,
  onBecomeObserved,
  onBecomeUnobserved,
} from "mobx";

/** Options for `invalidate()`. */
export interface LazyInvalidateOptions {
  /**
   * Drop the current value instead of keeping it readable until the refetch lands.
   * Default `false`: a refresh keeps showing what it already has.
   */
  discard?: boolean;
}

/**
 * Everything about a lazy that does not depend on whether it holds a value.
 *
 * Three facts vary independently here, and none of them is derivable from the others — which is why
 * there is no single `status` enum. `loaded` (below) says whether there is a value; `fetching` says
 * whether a request is running; `error` says how the last request ended. A refresh that fails while
 * a value is on screen is `loaded: true` *and* has an `error`, and both are true statements.
 */
/**
 * How many times a lazy may go from unobserved to observed inside {@link THRASH_WINDOW_MS} before
 * the dev-only warning fires. Well above ordinary churn — a StrictMode double-mount is two, and a
 * list remounting on every keystroke is still single digits per second — and well below the
 * hundreds a runaway produces.
 */
const THRASH_LIMIT = 20;
const THRASH_WINDOW_MS = 1000;

export interface LazyApi<T> {
  /**
   * How the last request ended, or `undefined` if it succeeded (or none has run). Cleared when a
   * new request starts and on every success.
   *
   * An error does **not** clear the value: a failed refresh keeps showing what it had, so `error`
   * and a readable `value` coexist. Check `loaded` to decide whether there is anything to render;
   * `error` only tells you what happened last.
   */
  error: unknown;
  /**
   * `true` whenever a request is in flight, including a background refresh that is still showing
   * its previous value.
   *
   * Orthogonal to `loaded`, deliberately: the two together describe every state without overlapping.
   * A first load is `!loaded && fetching`; a refresh is {@link LazyApi.refreshing}.
   *
   * ⚠️ **Reading this does not observe the lazy.** It is not one of the observation sources, so a
   * render that decides what to show from `fetching` alone subscribes to nothing — see
   * {@link LazyApi.refreshing}, which is the safe way to ask the same question.
   */
  fetching: boolean;
  /**
   * A request is in flight behind a value that is already there — a refresh, as opposed to a first
   * load. Exactly `loaded && fetching`.
   *
   * **Prefer this to a bare `fetching` for anything that decides what to render.** Reading it
   * touches whether there *is* a value, which is one of the reads that marks a lazy observed, so a
   * placeholder branch gated on it keeps the lazy alive. A branch gated on `fetching` alone
   * observes nothing: the lazy is dropped, its load aborted, `fetching` cleared — and the branch
   * renders itself away again, as fast as the event loop allows. Development warns once when it
   * sees that happening.
   *
   * (The `loading` property this resembles was removed for a different reason: it read as the
   * opposite of `loaded` while actually meaning "a request is in flight", and mishandled a failed
   * first load. This one is a conjunction of the two facts rather than a substitute for either.)
   */
  refreshing: boolean;
  /**
   * When a request last succeeded, as epoch milliseconds, or `undefined` if none ever has.
   *
   * Named for the fetch rather than the value, because the two differ: a lazy seeded with
   * `initialValue` is `loaded` with no `fetchedAt` (hydrated, never been to the network), and a
   * failed refresh leaves the previous timestamp in place (still showing data from then).
   */
  fetchedAt: number | undefined;
  /**
   * `true` while at least one reaction is observing `value`, `loaded` or `error`.
   * Observable, so it can be read reactively — reading it does not itself count as observing the
   * value, so it never triggers a load.
   */
  observed: boolean;
  /**
   * Resolve with the current value, loading first if there isn't one *or* the one held is stale.
   * Joins a load already in flight rather than starting a second.
   *
   * Staleness counts, so `invalidate()` followed by `getOrLoad()` fetches rather than handing back
   * the value being replaced — whether or not anything happens to be observing.
   */
  getOrLoad(): Promise<T>;
  /** Always start a fresh load, abandoning any result already in flight. */
  reload(): Promise<T>;
  /**
   * Write the value directly and mark it loaded and fresh, without fetching — the value is treated
   * as authoritative, so no load is owed. Abandons any load in flight (so it cannot clobber this
   * write) and detaches from dependency-driven refetching until the next load.
   *
   * Contrast `initialValue`, which is loaded but still *stale*: a starting point that gets
   * revalidated on first observation.
   */
  set(value: T): void;
  /**
   * Mark the value stale and load again *if anyone is watching*. If nothing is observing, the load
   * happens on next observation — or on the next `getOrLoad()`, which counts staleness.
   *
   * The current value stays readable while the refetch runs (`loaded` remains `true`, `fetching`
   * becomes `true`), so a list doesn't blank out between a mutation and its refresh. Pass
   * `{ discard: true }` to drop it first and show a fresh load instead.
   */
  invalidate(options?: LazyInvalidateOptions): void;
}

/**
 * A lazy observable.
 *
 * `loaded` is a discriminant, so checking it narrows `value` — no separate `!== undefined` guard:
 *
 * ```ts
 * if (list.loaded) list.value.map(render);   // value is T here
 * ```
 *
 * Written as a union of two complete members rather than `Api & (A | B)`. Both narrow — TypeScript
 * distributes the intersection — but `LazyArray` cannot be: it has to `Omit` `set` from
 * the API and replace it, and `Omit` over a union collapses it into one object, taking the
 * discriminant with it. The two types are spelled the same way so they stay comparable.
 */
export type Lazy<T = any> =
  | (LazyApi<T> & { loaded: true; value: T })
  | (LazyApi<T> & { loaded: false; value: undefined });

/**
 * The `loaded: true` arm of {@link Lazy} — a lazy that is known to hold a value, so
 * `value` reads as `T` with no check. What a seeded `lazy` hands back, and what a
 * `loaded` check narrows an ordinary one to.
 */
export type LoadedLazy<T = any> = Extract<Lazy<T>, { loaded: true }>;

export interface LazyOptions {
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

export interface LazyOptionsWithInitialValue<T> extends LazyOptions {
  /**
   * A value to start with, before anything is fetched. The lazy reports `loaded` immediately and
   * still counts as stale, so the first observation revalidates it — which is what makes this the
   * right shape for hydration from SSR, storage, or a cache you already trust.
   *
   * Without it a lazy holds nothing (`loaded: false`, `value: undefined`) until a load lands. That
   * distinction is the point: an empty array means "there are none", not "not known yet".
   *
   * Passing this narrows the result to {@link LoadedLazy}, so `value` reads as `T`
   * without a `loaded` check — the seed is restored by a discard, so a seeded lazy can never go
   * back to holding nothing.
   *
   * Presence is what counts, not the value: for a `T` that includes `undefined`, seeding with
   * `undefined` is a real value and reports `loaded`, matching a fetch that resolves `undefined`.
   * That is why the unseeded overload has no `initialValue` at all — `{ initialValue: maybe }`
   * where `maybe` might be `undefined` is the one state that cannot be represented, so it is
   * rejected at the call site rather than guessed at.
   */
  initialValue?: T;
}

const noop = (): void => {};

/**
 * Which of the two things a request is doing. `"load"` produces the value from scratch — a first
 * load, a reload, a dependency change — and `"more"` adds to what is already held.
 *
 * Only a pager ever asks for `"more"`; without one every request is a `"load"`, which is why
 * nothing above this line has ever needed to say so.
 */
type RequestKind = "load" | "more";

/**
 * The seam `lazyPages` extends the engine through.
 *
 * Paging lives entirely behind these five members, so every rule in `createLazy` — staleness,
 * observation, abort, generations, `keepOnUnobserved` — is written once and knows nothing about
 * cursors, page sizes or envelopes. The engine calls the first four at four exact points and
 * hands over the fifth so a pager can drive requests of its own.
 */
interface Pager {
  /**
   * Whether the request in flight is adding a page rather than replacing the list. Read by
   * `refreshing`, which must not report an append as a refresh.
   */
  readonly appending: boolean;
  /**
   * Extra properties merged into what `fetch` is handed — the cursor, offset, limit and query for
   * this particular request. Called at the moment a request starts, inside that batch, so a pager
   * can record the kind at the same time.
   */
  request(kind: RequestKind): object;
  /**
   * Apply a settled payload. The pager owns the write rather than returning a value, because an
   * append has to reach the owned array directly: handing back `[...held, ...page]` for the engine
   * to `replace` would copy and re-notify the whole list on every page.
   */
  apply(payload: unknown, kind: RequestKind): void;
  /** Forget paging state. Called wherever the engine clears the value. */
  reset(): void;
  /**
   * A value was written directly with `set` rather than fetched. On the seam rather than as an
   * override on the returned object, because `lazyPages` mutates that object in place — a `set`
   * defined over the engine's would be reached by its own call through the property.
   */
  wrote(value: unknown): void;
  /**
   * Receives the engine's request function, once it exists. `"load"` supersedes anything in
   * flight; `"more"` joins it, because two page requests at once would append the same page twice.
   */
  attach(request: (kind: RequestKind) => Promise<unknown>): void;
}

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

export function lazy<T>(
  fetch: LazyFetch<T>,
  options: LazyOptionsWithInitialValue<T> & { initialValue: T },
): LoadedLazy<T>;
export function lazy<T>(fetch: LazyFetch<T>, options?: LazyOptions): Lazy<T>;
export function lazy<T>(fetch: LazyFetch<T>, options?: LazyOptionsWithInitialValue<T>): Lazy<T> {
  // Presence, not value: `undefined` is a legitimate seed when `T` admits it, and the overloads
  // above are what stop an ambiguous `T | undefined` from reaching here in the first place.
  return createLazy(fetch, options, !!options && "initialValue" in options);
}

/**
 * The shared implementation behind `lazy` and `lazyArray`. The only difference
 * between them is where the value lives — a box, or an observable array the lazy owns — so that is
 * the one thing passed in, and every rule about loading, staleness, errors and observation is
 * written once here.
 */
function createLazy<T>(
  fetch: LazyFetch<T>,
  options: LazyOptionsWithInitialValue<T> | undefined,
  /**
   * Whether `options` carried a seed. Passed in rather than derived here, because the two callers
   * decide it differently and only they can: a scalar seed of `undefined` is a real value, while
   * for a list `undefined` is never one — and `lazyArray` rebuilds the options bag on
   * the way through, so an `in` test here would read its own reconstruction rather than what the
   * caller wrote.
   */
  seeded: boolean,
  ownedArray?: IObservableArray<unknown>,
  /**
   * Present only for `lazyPages`. Everything paging-shaped is behind it — see {@link Pager} — so
   * the rules below stay written once for all three factories.
   */
  pager?: Pager,
): Lazy<T> {
  /**
   * Where the value lives. `lazyArray` passes an observable array it owns, which is
   * already an observable container, so it is used directly rather than wrapped in a box. Wrapping
   * it would create two layers with only the outer one deciding when loading starts, so iterating
   * the array would track its contents without ever triggering a fetch; owning it means any read of
   * the contents both tracks *and* loads.
   *
   * Updates then replace the array's contents in place, so `value` keeps its identity for the
   * lifetime of the lazy: a reference you hold stays valid. The trade is that the identity is no
   * longer a signal — observe the contents, or `fetchedAt`.
   */
  const box = ownedArray
    ? undefined
    : observable.box<T | undefined>(options?.initialValue, { deep: options?.deep ?? true });

  /**
   * What a discard returns to. Arrays are snapshotted at construction, because the caller keeps a
   * reference to the array they passed and mutating it must not change what a discard restores.
   * Scalars are held as given, matching how the box would have stored them anyway. Whether there
   * *is* a seed is `seeded`, not `seed !== undefined` — see above.
   */
  const seed = (
    Array.isArray(options?.initialValue) ? [...options.initialValue] : options?.initialValue
  ) as T | undefined;

  /**
   * Whether there is a value at all — the authority behind `loaded`, rather than testing `value`
   * for `undefined`.
   *
   * It has to be its own box for two reasons. The owned array always exists (identity must be
   * stable from construction) so its emptiness says nothing about whether it has been filled; and
   * `undefined` is a legitimate value for a scalar lazy, which a `value !== undefined` test would
   * misread as "nothing here" — and then refetch forever, since `getOrLoad` would never see it as
   * loaded.
   *
   * Only `applyValue` and `clearValue` below write to it, which is what keeps it in step with
   * whichever container is holding the value.
   */
  const hasValue = observable.box(seeded);

  /** The observable that observation hooks attach to: the array itself, or the box. */
  const valueSource = (ownedArray ?? box) as IObservableArray<unknown>;

  /**
   * Reads a value if there is one, and *always* touches an observable on the way — otherwise a read
   * that lands before the first load would return `undefined` without registering anything, and a
   * lazy nothing observes never loads. That is the whole mechanism, so it is deliberately
   * unconditional rather than short-circuiting on `hasValue`.
   */
  const readValue = (): T | undefined => {
    const has = hasValue.get();
    // Touch the container itself, not just the flag: for the array case this is what makes a
    // contents read both track and load, and it must happen whether or not there is a value yet.
    if (ownedArray) void ownedArray.length;
    else void box!.get();
    return has ? ((ownedArray ?? box!.get()) as T) : undefined;
  };

  const applyValue = (next: T): void => {
    if (ownedArray) ownedArray.replace(next as unknown[]);
    else box!.set(next);
    hasValue.set(true);
  };

  /**
   * Back to where the lazy started: the seed if there was one, otherwise holding nothing. The owned
   * array is emptied rather than replaced, so a reference taken earlier stays valid.
   */
  const clearValue = (): void => {
    // Paging state describes the value, so it goes back with it: a discarded list must not keep a
    // cursor pointing into the run that produced the rows it just dropped.
    pager?.reset();
    if (seeded) {
      // `seed` is `T` whenever `seeded` — including a deliberate `undefined` for a `T` that
      // admits one. A list can never reach here with an undefined seed: see `seeded` above.
      applyValue(seed as T);
      return;
    }
    if (ownedArray) ownedArray.clear();
    else box!.set(undefined);
    hasValue.set(false);
  };

  const error = observable.box<unknown>(undefined);

  /**
   * Observation is *derived*, never counted: this holds whichever of the public boxes are
   * currently observed, and `observed` is simply whether that set is non-empty. A single
   * shared counter miscounts any mix of consumers — a spinner reading `loaded` alongside a
   * list reading `value` drove it to zero while the list was still mounted, silently
   * blanking it forever.
   */
  const observedBoxes = new Set<unknown>();
  const observed = observable.box(false);

  /**
   * Staleness is its own box, deliberately not derived from anything public: the gate reaction
   * below reads it, and reading a *public* box there would register the lazy's own reaction
   * as an observer of itself — it would report as permanently observed and never be lazy.
   */
  const stale = observable.box(true);

  /** Whether a request is in flight. Independent of whether a value is held. */
  const fetching = observable.box(false);

  /**
   * When a request last succeeded. Tracks the *fetch*, not the value: a seeded lazy holds a value
   * with no `fetchedAt`, and a failed refresh keeps the previous one.
   */
  const fetchedAt = observable.box<number | undefined>(undefined);

  /**
   * When the last request finished, successfully or not. `reloadEvery` measures from here rather
   * than from `fetchedAt` so a failed reload waits a full interval instead of retrying instantly
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
   * value. Loads triggered by observation have no deferred — there is no call stack to throw
   * into — so a failed background fetch surfaces through `error` instead of becoming an
   * unhandled rejection.
   */
  let pending: Deferred<T> | undefined;

  const log = (message: string) => {
    if (options?.debugName) console.log(`lazy ${options.debugName}`, message);
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

  const settle = (
    requestGeneration: number,
    result: { value: T } | { error: unknown },
    kind: RequestKind,
  ): void => {
    // A newer request has superseded this one — drop the result entirely.
    if (requestGeneration !== generation) return;

    controller = undefined; // this request has landed; there is nothing left to abort

    const deferred = pending;
    pending = undefined;

    if ("error" in result) {
      // The value is deliberately left alone: a refresh that fails keeps showing what it had, so
      // `error` and a readable `value` coexist. Consumers decide from `loaded` whether there is
      // anything to render, and from `error` what happened last.
      write(() => {
        error.set(result.error);
        settledAt.set(Date.now());
        fetching.set(false);
      });
      deferred?.reject(result.error);
    } else {
      write(() => {
        if (pager) {
          // The pager writes the value itself, so `hasValue` is set here rather than inside
          // `applyValue` — an append never goes through it.
          pager.apply(result.value, kind);
          hasValue.set(true);
        } else {
          applyValue(result.value);
        }
        error.set(undefined);
        fetchedAt.set(Date.now());
        settledAt.set(Date.now());
        fetching.set(false);
      });
      // Resolve with what `value` now holds, not with the raw payload. For a list lazy those are
      // different objects — the payload is a plain array, `value` is the observable one the lazy
      // owns — and handing back the payload would give an awaiting caller a detached snapshot that
      // never updates and isn't the array everything else is looking at.
      deferred?.resolve(readValue() as T);
    }
  };

  /** One request: supersedes whatever came before it and applies its own result, or nothing. */
  const runRequest = (kind: RequestKind = "load"): void => {
    abandon();
    const requestGeneration = generation;
    const requestController = new AbortController();
    controller = requestController;

    let paging: object | undefined;
    write(() => {
      // Only a `"load"` settles the staleness question. An append adds a page to rows that may
      // already be stale, and clearing the flag here would let a `loadMore` swallow an
      // `invalidate()` issued in the same tick: the gate reaction has queued a reload, and the
      // microtask re-checks `stale` before running it.
      if (kind === "load") stale.set(false);
      fetching.set(true);
      // Whatever value is held stays held — a refresh never blanks what is on screen; `loading`
      // derives from `!loaded && fetching`, so a first load reports it and a refresh does not.
      // The previous failure is cleared here: a request is running, so it is no longer the
      // current state of affairs.
      error.set(undefined);
      // Inside the batch, so recording the kind and reading the cursor happen with everything
      // else this request changes — `refreshing` and `loadingMore` must never disagree with
      // `fetching` for even one derivation.
      paging = pager?.request(kind);
    });

    let fetchPromise: Promise<T>;
    try {
      fetchPromise = fetch({ signal: requestController.signal, ...paging });
    } catch (e) {
      settle(requestGeneration, { error: e }, kind);
      return;
    }

    fetchPromise.then(
      (newValue) => settle(requestGeneration, { value: newValue }, kind),
      (e) => settle(requestGeneration, { error: e }, kind),
    );
  };

  const startLoad = (kind: RequestKind = "load"): void => {
    clearTimeout(keepTimer);

    // A `"more"` request adds a page to what is already held, which makes it wrong on both counts
    // here: it must not *become* the tracked expression (a dependency change would then re-run an
    // append rather than starting the list over), and it must not tear down the tracking reaction
    // an earlier load installed.
    if (kind === "more") {
      runRequest("more");
      return;
    }

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
    fetchDisposer = reaction(() => runRequest("load"), noop, { delay: trackThrottle });
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
      if (discard || !hasValue.get()) {
        // Back to `initialValue` — which for most lazies means holding nothing again, so a
        // discarded list reads `undefined` rather than an empty array it could be mistaken for.
        clearValue();
        error.set(undefined);
        fetchedAt.set(undefined);
      }
    });

    // A caller awaiting a value is demand, not staleness: never leave them hanging on a
    // request we just abandoned. Otherwise the gate reaction loads now if observed, or on
    // next observation if not.
    if (pending) startLoad();
  };

  /**
   * MobX fires `onBecomeObserved` synchronously, which for an `observer()` component means *during
   * its render*. Calling `startLoad()` there writes observable state mid-render, and if another
   * component already observes this lazy, mobx-react-lite force-updates it while React is rendering
   * something else — which React rejects ("Cannot update a component while rendering a different
   * component").
   *
   * Deferring to a microtask moves the write just past the render pass. It still runs in the same
   * task, well before any fetch could resolve, so the only observable difference is that `fetching`
   * reads `false` during that first render.
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
        observed.get() && !fetching.get() && !stale.get() && fetchedAt.get() !== undefined
          ? settledAt.get()
          : undefined,
      (anchor) => {
        clearTimeout(pollTimer);
        if (anchor === undefined) return;
        // Overdue (came back into observation late) schedules at 0 and refreshes right away.
        // Wrapped rather than passed bare: `startLoad` now takes a kind, and a timer handing
        // it an argument would be a silent mode change.
        pollTimer = setTimeout(
          () => startLoad("load"),
          Math.max(0, interval - (Date.now() - anchor)),
        );
      },
      { fireImmediately: true },
    );
  }

  /** Dev-only; see `warnOnThrash`. */
  let observeTimes: number[] = [];
  let thrashWarned = false;

  /**
   * A lazy that keeps being observed, dropped, and observed again is almost always a render gating
   * on `fetching` without reading anything that observes. The cycle is self-sustaining and silent —
   * no error, no failed request, just a component that renders forever and a server that gets hit
   * forever — so it is worth spending a timestamp per transition to name it. Fires once per lazy,
   * and only in development.
   *
   * Counted on the transition *into* observation, which is the edge that starts a load.
   */
  const warnOnThrash = (): void => {
    if (thrashWarned) return;
    const now = Date.now();
    observeTimes = observeTimes.filter((t) => now - t < THRASH_WINDOW_MS);
    observeTimes.push(now);
    if (observeTimes.length <= THRASH_LIMIT) return;

    thrashWarned = true;
    const name = options?.debugName ? ` "${options.debugName}"` : "";
    console.warn(
      `[mobx-toolbox] lazy${name} was observed ${observeTimes.length} times in ` +
        `under ${THRASH_WINDOW_MS}ms, and is probably in a reload loop.\n\n` +
        "This happens when a render decides what to show from `fetching` or `fetchedAt` alone. " +
        "Neither one observes the lazy, so the branch that shows a placeholder drops it — which " +
        "aborts the load, clears `fetching`, and renders the other branch again, forever.\n\n" +
        "Gate on `refreshing` (a request behind an existing value) or `!loaded && fetching` (a " +
        "first load) instead. Both read whether there is a value, which is what keeps the lazy " +
        "observed while the placeholder is up.",
    );
  };

  const syncObserved = (): void => {
    const next = observedBoxes.size > 0;
    if (next === observed.get()) return;

    log(next ? "observed" : "unobserved");
    write(() => observed.set(next));

    // Development only, and the spelling is load-bearing: `process.env.NODE_ENV` is what mobx
    // uses, so a consumer already has it defined, and keeping the comparison inline and literal
    // is what lets their bundler drop `warnOnThrash` and its bookkeeping entirely. This survives
    // into the published chunk only because `pack` builds with `platform: "neutral"` — under
    // `"browser"`, rolldown rewrites `process.env` in shared chunks and the guard folds to `true`.
    if (process.env.NODE_ENV !== "production") {
      if (next) warnOnThrash();
    }

    if (next) {
      clearTimeout(keepTimer);
      return;
    }

    // Errors are never kept regardless of keepOnUnobserved — failure state shouldn't persist
    // across mounts, only successfully loaded values should.
    const keep = options?.keepOnUnobserved ?? false;
    // Unobserved data is dropped outright: nothing can be showing it, so there is nothing to keep.
    if (error.get() !== undefined || keep === false) {
      drop(true);
    } else if (typeof keep === "object") {
      keepTimer = setTimeout(() => drop(true), keep.for);
    }
    // keep === true: hold the loaded value indefinitely.
  };

  // What counts as "observing": the value itself, whether there is one, and how the last request
  // ended. `fetching` is deliberately not here — it would let a header "syncing…" indicator both
  // pin a value in memory and *start* a fetch merely by rendering, since becoming observed is what
  // triggers a load. The cost of that exclusion is that `fetching` cannot safely gate a render on
  // its own, which is what `refreshing` and the thrash warning above exist to handle.
  for (const source of [valueSource, hasValue, error]) {
    onBecomeObserved(source, () => {
      observedBoxes.add(source);
      syncObserved();
    });
    onBecomeUnobserved(source, () => {
      observedBoxes.delete(source);
      syncObserved();
    });
  }

  /**
   * `"load"` supersedes anything in flight, exactly as `reload()` does. `"more"` joins it instead
   * and resolves with whatever that request produces: two page requests running at once would
   * append the same page twice, or land page 3 ahead of page 2.
   */
  pager?.attach((kind) => {
    if (kind === "more" && fetching.get()) return ensurePending().promise;
    const deferred = ensurePending();
    startLoad(kind);
    return deferred.promise;
  });

  return {
    get value() {
      return readValue();
    },
    get error() {
      return error.get();
    },
    get loaded() {
      return hasValue.get();
    },
    get fetching() {
      return fetching.get();
    },
    get refreshing() {
      // `hasValue` is an observation source and `fetching` is not, which is what makes this safe
      // to gate a render on where a bare `fetching` is not.
      //
      // The operand order matters, and only in one case: reading this when it is *false* because
      // nothing is in flight. Written the other way round, `fetching` short-circuits and nothing
      // is read at all — so a component whose only read is `refreshing` would observe nothing and
      // never load. Leading with `hasValue` means every path through this getter observes.
      //
      // A pager's append is deliberately not this: it is adding to what is held rather than
      // replacing it, and `loadingMore` is what reports it.
      return hasValue.get() && fetching.get() && !pager?.appending;
    },
    get fetchedAt() {
      return fetchedAt.get();
    },
    get observed() {
      return observed.get();
    },
    getOrLoad() {
      // Staleness counts, not just presence: an invalidated lazy holds a value it has been told to
      // replace, and a seeded one holds a value it has never verified. Both owe a fetch, and a
      // caller who awaited deserves the result of it rather than the thing being superseded.
      if (hasValue.get() && !stale.get()) return Promise.resolve(readValue() as T);
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
        pager?.wrote(newValue);
        error.set(undefined);
        // A written value is authoritative, so it is fresh rather than merely present: no fetch is
        // owed, and it is stamped as though a request had just produced it.
        fetchedAt.set(Date.now());
        settledAt.set(Date.now());
        stale.set(false);
        fetching.set(false);
      });

      // Same as in `settle`: hand back what is held, which for a list is the owned array.
      deferred?.resolve(readValue() as T);
    },
    invalidate(invalidateOptions?: LazyInvalidateOptions) {
      drop(invalidateOptions?.discard ?? false);
    },
    // `loaded` and `value` are getters over the same pair of boxes, so they always agree — but the
    // compiler can only see two independent properties, not the union's guarantee.
  } as Lazy<T>;
}

/**
 * The API of a list lazy: everything a scalar one has, except that `set` takes a plain array —
 * callers hand over data, not an observable container.
 */
export type LazyArrayApi<T> = Omit<LazyApi<IObservableArray<T>>, "set"> & {
  set(value: T[]): void;
};

/**
 * A lazy over a list. `value` is the *same* observable array for the lifetime of the lazy once
 * there is one — loads replace its contents rather than the array — so a reference you hold stays
 * valid. The trade is that the identity is no longer a change signal: observe the contents, or
 * `fetchedAt`.
 *
 * `value` is `undefined` until the first load (or an explicit `initialValue`), because "no rows
 * yet" and "zero rows" are different answers and only one of them is a fact. `loaded` narrows it,
 * exactly as it does for a scalar lazy.
 */
export type LazyArray<T = any> =
  | (LazyArrayApi<T> & { loaded: true; value: IObservableArray<T> })
  | (LazyArrayApi<T> & { loaded: false; value: undefined });

/**
 * The `loaded: true` arm of {@link LazyArray} — the list counterpart of
 * {@link LoadedLazy}. What a seeded `lazyArray` hands back, including one
 * seeded with `[]`: "there are none" is a fact, and a fact is loaded.
 */
export type LoadedLazyArray<T = any> = Extract<LazyArray<T>, { loaded: true }>;

export interface LazyArrayOptions<T> extends LazyOptions {
  /**
   * Rows to start with — see {@link LazyOptionsWithInitialValue.initialValue}, of which
   * this is the list form. Passing it narrows the result to {@link LoadedLazyArray}.
   *
   * Unlike the scalar case there is nothing ambiguous to guard against, because `undefined` is
   * never a list: `{ initialValue: maybeRows }` is accepted and simply does not narrow, since a
   * seed that might not be there cannot promise a value.
   */
  initialValue?: T[];
}

export function lazyArray<T>(
  fetch: LazyFetch<T[]>,
  options: LazyArrayOptions<T> & { initialValue: T[] },
): LoadedLazyArray<T>;
export function lazyArray<T>(fetch: LazyFetch<T[]>, options?: LazyArrayOptions<T>): LazyArray<T>;
export function lazyArray<T>(fetch: LazyFetch<T[]>, options?: LazyArrayOptions<T>): LazyArray<T> {
  // Created here and owned for the lifetime of the lazy, so `value` is the same array every time
  // there is one and loads replace its contents. `deep` applies to the array's *items*.
  //
  // It is created even when nothing seeds it — identity has to be stable from the start — but it is
  // not *exposed* until there is a value, so an unloaded lazy reads `undefined` rather than `[]`.
  const { deep, ...rest } = options ?? {};
  const items = observable.array<T>(options?.initialValue ?? [], { deep: deep ?? true });
  // The internal generic is what `fetch` returns — a plain array — while the public type says
  // `IObservableArray`, which is what `value` actually hands back. `applyValue` bridges them by
  // replacing contents rather than assigning.
  return createLazy<T[]>(
    fetch,
    { ...rest, initialValue: options?.initialValue },
    // A list is seeded by *having* rows, never by the key being present: `undefined` is not a
    // list, so an explicit `initialValue: undefined` means the same as omitting it.
    options?.initialValue !== undefined,
    items as unknown as IObservableArray<unknown>,
  ) as unknown as LazyArray<T>;
}

/** Rows per request when `pageSize` is not given. What most list endpoints default to anyway. */
const DEFAULT_PAGE_SIZE = 50;

/**
 * What a page fetch is handed: the lazy's own options, plus where in the list this request is.
 *
 * Both `cursor` and `offset` are supplied on every request, so the same shape serves a
 * cursor-paginated endpoint and an offset-paginated one and you use whichever your API speaks.
 */
export interface LazyPageRequest<Q = undefined> extends LazyFetchOptions {
  /** The cursor the previous page reported, or `undefined` for the first page of a run. */
  cursor: string | undefined;
  /** How many rows are already held — the offset an offset-paginated endpoint wants. `0` on a first page. */
  offset: number;
  /** How many rows to ask for: whatever `pageSize` is set to. */
  limit: number;
  /** Zero-based index of the page being fetched. `0` for a first load, a reload, or a query change. */
  page: number;
  /** Whatever `setQuery` was last given — the filters and sorts, for a table-driven list. */
  query: Q;
}

/**
 * What a page fetch resolves to.
 *
 * A bare array is the whole answer for an endpoint that returns rows and nothing else. The
 * envelope carries whatever else it knows, and every field is optional because most endpoints
 * report one or two of them rather than all three — see {@link LazyPagesApi.hasMore} for how they
 * combine.
 */
export type LazyPageResult<T> =
  | T[]
  | {
      items: T[];
      /**
       * Cursor for the *next* page. `null` means this page was the last, which is why the field
       * being **present** is what makes it authoritative: an absent `cursor` says nothing.
       */
      cursor?: string | null;
      /** Total rows matching the query across every page — the "of 4,382" in a row count. */
      total?: number;
      /** Whether another page exists, for an endpoint that says so outright. Outranks the rest. */
      hasMore?: boolean;
    };

export type LazyPagesFetch<T, Q = undefined> = (
  request: LazyPageRequest<Q>,
) => Promise<LazyPageResult<T>>;

/**
 * Options for `lazyPages`. A deliberate subset of {@link LazyOptions}, and the two that are
 * missing are missing for reasons rather than oversight:
 *
 * - **`initialValue`** — a seed cannot say which cursor follows it, so it could be listed but
 *   never continued. Hydrating the first page is `set(rows)`, which says the same thing honestly:
 *   these rows, and nothing after them.
 * - **`reloadEvery`** — a reload starts the list over at page one, so polling would yank a user
 *   who had scrolled to page eight back to the top on a timer. Refresh a paged list on an event
 *   (`invalidate()`), not on a clock.
 */
export interface LazyPagesOptions<T, Q = undefined> extends Pick<
  LazyOptions,
  "deep" | "keepOnUnobserved" | "trackDependencies" | "debugName"
> {
  /**
   * Rows per request, sent to the fetch as `limit`. Default 50.
   *
   * It doubles as the fallback for `hasMore` when an endpoint reports nothing else — a page
   * shorter than this is the last one — so it should match what the server actually returns.
   */
  pageSize?: number;
  /** The query the first page is fetched with, before any {@link LazyPagesApi.setQuery}. */
  query?: Q;
  /**
   * A row's identity, used to drop a record that a later page repeats.
   *
   * Worth setting for anything served by cursor over a non-unique sort key, or by offset while
   * rows are being inserted: both hand back a record already held, and the duplicate is not
   * harmless — a table keys its rows by identity, so two entries for one record produce two rows
   * that share a React key and a single selection toggle that hits both.
   *
   * For a model-backed list, `dedupeBy: SurveyModel.identityKey` is exactly this.
   */
  dedupeBy?: (item: T) => unknown;
}

/**
 * Everything a {@link LazyArray} has, plus what only an accumulating list can answer.
 *
 * Note which of these observe the list and which do not. `value`, `loaded`, `error` and
 * `loadingMore` do, so a render gated on any of them keeps the list alive and triggers its first
 * load. `hasMore`, `total`, `pages` and `fetching` do **not** — they describe the requests rather
 * than the rows, so a footer that renders "1–100 of 4,382" can't pin a list in memory or start a
 * fetch just by being on screen. It is the same split, and the same reasoning, as
 * {@link LazyApi.fetching} versus {@link LazyApi.refreshing}.
 */
export interface LazyPagesApi<T, Q = undefined> extends LazyArrayApi<T> {
  /**
   * Append the next page, resolving with the list once it lands.
   *
   * Safe to call speculatively, which is what makes it usable as a scroll handler: it resolves
   * immediately when there is nothing more, and **joins** a request already in flight rather than
   * starting a second one — so a burst of scroll events costs one page, not one each.
   *
   * On a list that holds nothing yet this fetches the first page, which is the same thing it
   * always is: the page after the ones held.
   */
  loadMore(): Promise<IObservableArray<T>>;
  /**
   * A page request is in flight *behind rows already held* — the append counterpart of
   * {@link LazyApi.refreshing}, and mutually exclusive with it.
   *
   * Reading it observes the list, so this is the one to gate a footer spinner on. The two never
   * overlap: a reload replaces the list and reports `refreshing`, a `loadMore` extends it and
   * reports this.
   */
  readonly loadingMore: boolean;
  /**
   * Whether another page exists. `true` before anything has loaded — the first page is a page.
   *
   * Resolved from what the last page reported, in this order:
   *
   * 1. An empty page ends the list, whatever else it says. Trusting `hasMore: true` alongside zero
   *    rows is what turns a server bug into a request loop, and anything driving `loadMore()` off
   *    a scroll position would spin it as fast as the event loop allows.
   * 2. An explicit `hasMore`.
   * 3. A `cursor` field, if the envelope carried one: `null` means the end.
   * 4. A `total`, if one has been reported: whether the rows held reach it.
   * 5. Otherwise a short page is the last page. An endpoint whose final page happens to be exactly
   *    `pageSize` long therefore costs one extra request, which comes back empty and ends it.
   */
  readonly hasMore: boolean;
  /** Total rows matching the query, if a page reported one. Survives appends; cleared by a query change. */
  readonly total: number | undefined;
  /**
   * How many pages are held. `0` before the first lands, and back to `0` on anything that starts
   * the list over — a reload, a query change, a discard.
   *
   * That makes it the signal for "this list restarted" as opposed to "this list grew", which
   * nothing else here provides: the array identity is stable by design, so it cannot say.
   */
  readonly pages: number;
  /** Whatever `setQuery` was last given, or the `query` option. */
  readonly query: Q;
  /**
   * Point the list at a different query — filters, sorts, a search term.
   *
   * The query decides which rows exist, so this is not a refresh of the rows held: the list goes
   * stale from page one and reloads now if anything is watching, or on the next observation if
   * not. The rows stay readable throughout, so a table keeps showing the previous results until
   * the new first page lands rather than blanking.
   *
   * A structurally equal query is a no-op, so this is safe to call from an effect that runs more
   * often than the query changes.
   */
  setQuery(query: Q): void;
}

/**
 * A lazy over a list that grows a page at a time.
 *
 * It is a {@link LazyArray} in every respect that matters to something reading rows — one stable
 * observable array, `undefined` until the first page lands, `loaded` narrowing it, loading on
 * first observation and dropping when nothing watches — so anything that accepts a `LazyArray`
 * accepts one of these, the table's `data` included.
 *
 * What it adds is the distinction a single-fetch lazy structurally cannot draw: `reload()` starts
 * the list over, `loadMore()` extends it, and `refreshing` / `loadingMore` say which is running.
 */
export type LazyPages<T = any, Q = undefined> =
  | (LazyPagesApi<T, Q> & { loaded: true; value: IObservableArray<T> })
  | (LazyPagesApi<T, Q> & { loaded: false; value: undefined });

/** The envelope form of {@link LazyPageResult}, after a bare array has been wrapped into one. */
type PageEnvelope<T> = Exclude<LazyPageResult<T>, T[]>;

/**
 * An accumulating list: one lazy, fetched a page at a time, for a dataset too large to hand over
 * whole.
 *
 * ```ts
 * const feed = lazyPages(({ cursor, limit, signal }) =>
 *   api.listSurveys({ cursor, limit, signal }),
 * );
 *
 * feed.value;        // undefined until the first page lands, then the accumulated rows
 * feed.loadMore();   // append the next page
 * feed.hasMore;      // whether there is one
 * ```
 *
 * Everything about *when* it loads is `lazy`'s: the first page is fetched when something observes
 * the list, requests abort when superseded, `keepOnUnobserved` decides how long the pages outlive
 * their last observer, and `trackDependencies` makes an observable the fetch reads a reason to
 * start the list over. Only the accumulation is new.
 *
 * **Three operations, deliberately distinct**, where a single-fetch lazy only has room for two:
 *
 * | | |
 * | --- | --- |
 * | `loadMore()` | the page after the ones held, appended |
 * | `reload()` | the first page again, replacing everything — the whole list, refetched |
 * | `setQuery(q)` | a different list; page one of it, rows held until it lands |
 */
export function lazyPages<T, Q = undefined>(
  fetch: LazyPagesFetch<T, Q>,
  options?: LazyPagesOptions<T, Q>,
): LazyPages<T, Q> {
  const {
    deep,
    pageSize = DEFAULT_PAGE_SIZE,
    dedupeBy,
    query: initialQuery,
    ...rest
  } = options ?? {};

  // Owned for the lifetime of the lazy, exactly as `lazyArray`'s is, so `value` keeps its identity
  // as pages accumulate. That is what lets a table bind once and let MobX carry every later page
  // through its own computeds, rather than re-applying a dataset per page.
  const items = observable.array<T>([], { deep: deep ?? true });

  /**
   * Paging state, in its own observable and deliberately *not* wired into the observation hooks:
   * see the note on {@link LazyPagesApi} for why reading `hasMore` must not start a fetch.
   *
   * `deep: false` because every field is a primitive or an opaque query object the consumer owns.
   */
  const state = observable(
    {
      cursor: undefined as string | undefined,
      hasMore: true,
      total: undefined as number | undefined,
      pages: 0,
      appending: false,
      query: initialQuery as Q,
    },
    {},
    { deep: false },
  );

  /** Identities already held, for `dedupeBy`. Absent when nothing asked for deduplication. */
  const seen = dedupeBy ? new Set<unknown>() : undefined;

  /** Back to knowing nothing about the run: no cursor, no pages, no total, more presumed. */
  const forgetPaging = (): void => {
    state.cursor = undefined;
    state.hasMore = true;
    state.total = undefined;
    state.pages = 0;
    state.appending = false;
    seen?.clear();
  };

  /** Assigned by `createLazy` through {@link Pager.attach}, before anything can call `loadMore`. */
  let request!: (kind: RequestKind) => Promise<unknown>;

  /**
   * Whether a request of this kind extends the list or starts it. Keyed off `pages` rather than
   * the array's length, because the two disagree in exactly the case that matters: a query change
   * leaves the previous rows readable while resetting `pages` to zero, and a `loadMore` arriving
   * in that window has to fetch page one rather than asking for the page after rows it is about
   * to replace.
   */
  const appends = (kind: RequestKind): boolean => kind === "more" && state.pages > 0;

  const resolveHasMore = (page: PageEnvelope<T>, received: number): boolean => {
    if (received === 0) return false;
    if (page.hasMore !== undefined) return page.hasMore;
    if ("cursor" in page) return page.cursor != null;
    if (state.total !== undefined) return items.length < state.total;
    return received >= pageSize;
  };

  const pager: Pager = {
    get appending() {
      return state.appending;
    },

    request(kind) {
      const appending = appends(kind);
      state.appending = appending;
      if (!appending) {
        // A fresh first page: forget where the last run got to, so a reload starts from the top
        // and a retry after a failure doesn't resume mid-list against a cursor from before it.
        state.cursor = undefined;
        state.pages = 0;
        seen?.clear();
      }
      return {
        cursor: appending ? state.cursor : undefined,
        offset: appending ? items.length : 0,
        limit: pageSize,
        page: state.pages,
        query: state.query,
      } satisfies Omit<LazyPageRequest<Q>, "signal">;
    },

    apply(payload, kind) {
      const page = (Array.isArray(payload) ? { items: payload } : payload) as PageEnvelope<T>;
      const received = page.items ?? [];

      // Filtered before the push, so `dedupeBy` sees the payload's own rows rather than whatever
      // `deep` converted them into on the way in.
      const rows = seen
        ? received.filter((row) => {
            const id = dedupeBy!(row);
            if (seen.has(id)) return false;
            seen.add(id);
            return true;
          })
        : received;

      if (appends(kind)) items.push(...rows);
      else items.replace(rows);

      state.pages++;
      if (page.total !== undefined) state.total = page.total;
      state.cursor = page.cursor ?? undefined;
      // Off the payload's own row count, not the deduplicated one: a page entirely made of
      // records already held is still a page the server had, and treating it as empty would end
      // the list one page early.
      state.hasMore = resolveHasMore(page, received.length);
    },

    reset: forgetPaging,

    wrote(value) {
      const written = value as T[];
      forgetPaging();
      // `set` is authoritative — the same promise it makes on any lazy — so it says these are the
      // rows, all of them, and there is no page after them.
      state.hasMore = false;
      state.pages = 1;
      state.total = written.length;
      if (seen) for (const row of written) seen.add(dedupeBy!(row));
    },

    attach(run) {
      request = run;
    },
  };

  const base = createLazy<T[]>(
    fetch as unknown as LazyFetch<T[]>,
    rest,
    // Never seeded: `initialValue` is not among the options, and `set` is the honest way in.
    false,
    items as unknown as IObservableArray<unknown>,
    pager,
  );

  const api = base as unknown as LazyPages<T, Q>;

  // Defined onto the engine's object rather than delegated through a second one: these are
  // accessors, so a wrapper would mean a hand-written passthrough for every member of `LazyApi`
  // and one more thing to keep in step with it.
  Object.defineProperties(api, {
    loadingMore: {
      enumerable: true,
      // `loaded` leads, deliberately: it is an observation source and `fetching` is not, so
      // reading this observes the list on every path through it. Written the other way round,
      // `fetching` would short-circuit and a footer whose only read is this one would observe
      // nothing — the same trap `refreshing` is written to avoid.
      get: () => base.loaded && base.fetching && state.appending,
    },
    hasMore: { enumerable: true, get: () => state.hasMore },
    total: { enumerable: true, get: () => state.total },
    pages: { enumerable: true, get: () => state.pages },
    query: { enumerable: true, get: () => state.query },

    loadMore: {
      enumerable: true,
      value: (): Promise<IObservableArray<T>> =>
        state.hasMore ? request("more").then(() => items) : Promise.resolve(items),
    },

    setQuery: {
      enumerable: true,
      value: (next: Q): void => {
        if (comparer.structural(state.query, next)) return;
        runInAction(() => {
          // Before `invalidate`, so the reload this may trigger already reads the new query — and
          // `pages` drops to 0 now rather than when the page lands, which is what tells a view
          // this is a different list and not a longer one.
          forgetPaging();
          state.query = next;
        });
        api.invalidate();
      },
    },
  });

  return api;
}

/**
 * The value type a lazy resolves to. Inferred off `getOrLoad` rather than the type itself, so it
 * reads through the `loaded` union without needing to match either member.
 */
export type InferLazy<O> = O extends { getOrLoad(): Promise<infer T> } ? T : never;
