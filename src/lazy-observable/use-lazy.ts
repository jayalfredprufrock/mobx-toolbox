import { useStable } from "../react-util/useStable";
import {
  lazyObservable,
  lazyObservableArray,
  type LazyFetch,
  type LazyObservable,
  type LazyObservableArray,
  type LazyObservableArrayOptions,
  type LazyObservableOptions,
} from "./lazy-observable";

/**
 * A lazy observable that belongs to one component, for an async read whose inputs are the
 * component's own — a route param, a prop, a piece of local state.
 *
 * ```tsx
 * const study = useLazy((options) => StudyModel.get({ id: studyId }, options), [studyId]);
 * ```
 *
 * What comes back is an ordinary `lazyObservable`: it loads when something observes it, keeps its
 * value while it reloads, and aborts a request it supersedes. Nothing reading one can tell whether
 * it came from a hook, a store, or a hand-rolled construction — which is the point.
 *
 * `deps` say *which* lazy this is, so changing them builds a new one, exactly as constructing a
 * second lazy by hand would: the value starts empty and loads again. That is what you want for a
 * record — showing the study you navigated away from while the next one loads would be a lie. When
 * the inputs are filters over a single list rather than a different list, `useCollection`'s `params`
 * are the other shape: same lazy, refetched, rows readable throughout.
 *
 * Held through {@link useStable} rather than `useMemo`, which React may discard — that would rebuild
 * the lazy and silently drop what it had loaded.
 */
export function useLazy<T>(
  fetch: LazyFetch<T>,
  deps: React.DependencyList,
  options?: LazyObservableOptions,
): LazyObservable<T> {
  return useStable(() => lazyObservable(fetch, options ?? {}), deps);
}

/**
 * {@link useLazy} for a value that is a list.
 *
 * ```tsx
 * const rows = useLazyArray((options) => api.listSections({ studyId }, options), [studyId]);
 * ```
 *
 * The lazy owns one observable array for its lifetime, so loads replace its *contents* — but `deps`
 * changing ends that lifetime and builds a new lazy with a new array, just as constructing one by
 * hand would. Anything watching array identity should watch the lazy's `loadedAt` instead.
 */
export function useLazyArray<T>(
  fetch: LazyFetch<T[]>,
  deps: React.DependencyList,
  options?: LazyObservableArrayOptions<T>,
): LazyObservableArray<T> {
  return useStable(() => lazyObservableArray(fetch, options), deps);
}
