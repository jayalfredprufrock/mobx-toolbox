import { useStable } from "../react-util/useStable";
import { useParamsFetch, type WithoutTracking } from "./params";
import {
  lazy,
  lazyArray,
  lazyPages,
  type LazyFetch,
  type LazyFetchOptions,
  type Lazy,
  type LazyArray,
  type LazyArrayOptions,
  type LazyOptions,
  type LazyOptionsWithInitialValue,
  type LazyPages,
  type LazyPagesFetch,
  type LazyPagesOptions,
  type LazyPageRequest,
  type LazyPageResult,
  type LoadedLazy,
  type LoadedLazyArray,
} from "./lazy";

/**
 * The options that make a hook's lazy follow the component's inputs: the `params` themselves, and
 * what a change to them does.
 */
export interface UseLazyParamsOptions<P> {
  params: P;
  /**
   * What a param change does to the value already held. `true` (the default) starts over: the
   * value empties — or returns to its seed — and loads again, which is right when the params say
   * *which* value this is, a record by id or a list owned by a parent. `false` refetches in place,
   * keeping the value readable and `loaded` while the next one loads, which is right when they
   * refine one value — a search term, a filter, a date range.
   *
   * Get it wrong in the safe direction: a discard you didn't need costs a placeholder flash, while
   * a keep you didn't want shows the previous record under the new params with nothing to say so.
   */
  discardOnChange?: boolean;
  /**
   * Wait this long, in milliseconds, after a param change before the request goes out, restarting
   * the wait on every change — so typing into a search box costs one request, sent once the typing
   * pauses.
   *
   * The wait happens inside the request, so `fetching` is `true` from the first change and a
   * "searching…" indicator shows throughout. Only a param change waits: the first load, a reload, an
   * invalidation, a `setQuery` and a next page all go straight out.
   */
  debounce?: number;
}

/**
 * A lazy observable that belongs to one component, for an async read whose inputs are the
 * component's own — a route param, a prop, a piece of local state.
 *
 * ```tsx
 * const stats = useLazy(({ studyId }, options) => api.getStudyStats({ studyId }, options), {
 *   params: { studyId },
 * });
 * ```
 *
 * What comes back is an ordinary `lazy`: it loads when something observes it, keeps its
 * value while it reloads, and aborts a request it supersedes. Nothing reading one can tell whether
 * it came from a hook, a store, or a hand-rolled construction — which is the point.
 *
 * `params` arrive as the fetch's first argument, ahead of the lazy's own options — the same
 * params-first shape `useCollection` and `useModel` take. They are the whole of the fetch's inputs:
 * there is no dependency list to keep in step with them, and they are compared structurally, so
 * rebuilding the object every render — arrays and nested objects included — is not a change, and
 * key order does not matter. Keep them plain data: ids, not model instances or observables.
 *
 * A change starts over by default — the value empties and loads again, since showing the study you
 * navigated away from while the next one loads would be a lie. Pass `discardOnChange: false` when
 * the params refine one value instead, and a change refetches in place with the value readable
 * throughout; `debounce: ms` then folds a burst of keystrokes into one request. See
 * {@link UseLazyParamsOptions.discardOnChange} and {@link UseLazyParamsOptions.debounce}.
 *
 * Everything the fetch reads from outside goes in `params` — a store's observable included, read in
 * the component and passed in — since that is what decides what a change does. The fetch itself is
 * never tracked, so `trackDependencies` is not an option here.
 *
 * A fetch with no inputs takes no `params` and is built once.
 *
 * Held through {@link useStable} rather than `useMemo`, which React may discard — that would rebuild
 * the lazy and silently drop what it had loaded.
 *
 * An `initialValue` seeds it, exactly as it does for a hand-built lazy, and narrows the result so
 * `value` reads without a `loaded` check. A discarding change returns to the seed, which is what
 * you want, since the seed describes the inputs it was written for; a keeping one refetches over
 * whatever is held.
 */
export function useLazy<T>(
  fetch: LazyFetch<T>,
  // `params?: never` separates these overloads from the params ones below, exactly as it does for
  // `useCollection` — see the note there.
  options: WithoutTracking<LazyOptionsWithInitialValue<T>> & { initialValue: T; params?: never },
): LoadedLazy<T>;
export function useLazy<T>(
  fetch: LazyFetch<T>,
  options?: WithoutTracking<LazyOptions> & { params?: never },
): Lazy<T>;
export function useLazy<T, P extends object>(
  fetch: (params: P, options: LazyFetchOptions) => Promise<T>,
  options: WithoutTracking<LazyOptionsWithInitialValue<T>> &
    UseLazyParamsOptions<P> & { initialValue: T },
): LoadedLazy<T>;
export function useLazy<T, P extends object>(
  fetch: (params: P, options: LazyFetchOptions) => Promise<T>,
  options: WithoutTracking<LazyOptions> & UseLazyParamsOptions<P>,
): Lazy<T>;

export function useLazy(fetch: any, options?: any): any {
  const source = useParamsFetch<LazyFetchOptions>(fetch, options, true);
  return useStable(() => lazy(source.fetch, source.options), source.deps);
}

/**
 * {@link useLazy} for a value that is a list.
 *
 * ```tsx
 * const sections = useLazyArray(({ studyId }, options) => api.listSections({ studyId }, options), {
 *   params: { studyId },
 * });
 * ```
 *
 * A param change discards by default, as it does for `useLazy` — a different study's sections are
 * a different list, and showing the previous study's while the next load would be a lie. That
 * builds a new lazy with a new array; anything watching array identity should watch the lazy's
 * `loadedAt` instead.
 *
 * For filters over one list — search results, a report's rows — pass `discardOnChange: false`.
 * That keeps one array for the component's lifetime and refetches into it, so the rows stay
 * readable while the next ones load:
 *
 * ```tsx
 * const results = useLazyArray(({ q }, options) => api.search({ q }, options), {
 *   params: { q },
 *   discardOnChange: false,
 *   debounce: 300,
 * });
 * ```
 *
 * An `initialValue` seeds the list and narrows the result, so `value` reads without a `loaded`
 * check — `initialValue: []` included, which is how you say "there are none yet, and that is a
 * fact" rather than "not known yet".
 */
export function useLazyArray<T>(
  fetch: LazyFetch<T[]>,
  options: WithoutTracking<LazyArrayOptions<T>> & { initialValue: T[]; params?: never },
): LoadedLazyArray<T>;
export function useLazyArray<T>(
  fetch: LazyFetch<T[]>,
  options?: WithoutTracking<LazyArrayOptions<T>> & { params?: never },
): LazyArray<T>;
export function useLazyArray<T, P extends object>(
  fetch: (params: P, options: LazyFetchOptions) => Promise<T[]>,
  options: WithoutTracking<LazyArrayOptions<T>> & UseLazyParamsOptions<P> & { initialValue: T[] },
): LoadedLazyArray<T>;
export function useLazyArray<T, P extends object>(
  fetch: (params: P, options: LazyFetchOptions) => Promise<T[]>,
  options: WithoutTracking<LazyArrayOptions<T>> & UseLazyParamsOptions<P>,
): LazyArray<T>;

export function useLazyArray(fetch: any, options?: any): any {
  const source = useParamsFetch<LazyFetchOptions>(fetch, options, true);
  return useStable(() => lazyArray(source.fetch, source.options), source.deps);
}

/**
 * {@link useLazyArray} for a list that grows a page at a time — an infinite feed or a load-more
 * list whose inputs are the component's own.
 *
 * ```tsx
 * const feed = useLazyPages(
 *   ({ postId }, { cursor, limit, signal }) => api.listComments({ postId, cursor, limit, signal }),
 *   { params: { postId } },
 * );
 * ```
 *
 * `params` arrive ahead of the page request — the same shape `usePagedCollection` takes — and a
 * change discards by default, starting a new list from page one: the right answer for a different
 * post, where continuing to show the previous one's comments while the next arrive would be a lie.
 * `discardOnChange: false` restarts the same list instead, with the rows readable while page one of
 * the new params loads. A fetch with no inputs takes no `params` and is built once.
 *
 * For a query pushed in from somewhere with no observable to offer — a table's sort and filters —
 * there is `setQuery`, which also keeps the list and requeries it:
 *
 * ```tsx
 * const feed = useLazyPages(fetchPage, { params: { postId } });
 * useEffect(() => feed.setQuery({ sort }), [feed, sort]);
 * ```
 *
 * A structurally equal query is a no-op, which is what makes that effect safe to run every render.
 * A discarding param change builds a new list, so it starts from the `query` option again rather
 * than from what was last set.
 */
export function useLazyPages<T, Q = undefined>(
  fetch: LazyPagesFetch<T, Q>,
  // See the note on `useLazy`'s first overload for why `params?: never` is here.
  options?: WithoutTracking<LazyPagesOptions<T, Q>> & { params?: never },
): LazyPages<T, Q>;
export function useLazyPages<T, P extends object, Q = undefined>(
  fetch: (params: P, request: LazyPageRequest<Q>) => Promise<LazyPageResult<T>>,
  options: WithoutTracking<LazyPagesOptions<T, Q>> & UseLazyParamsOptions<P>,
): LazyPages<T, Q>;

export function useLazyPages(fetch: any, options?: any): any {
  // Keeping restarts the list rather than refetching a value, and a query set through `setQuery`
  // survives it: the restart reinstalls the tracking reaction, and the pager's own state is read
  // inside an action, outside its dependencies.
  const source = useParamsFetch<LazyPageRequest<any>>(fetch, options, true);
  return useStable(() => lazyPages(source.fetch, source.options), source.deps);
}
