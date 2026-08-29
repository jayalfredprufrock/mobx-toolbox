/**
 * The pre-rename spellings, kept so existing code keeps compiling.
 *
 * `lazyObservable` said "observable" twice — once in the name and once in the fact that everything
 * in this library is one — and the extra ten characters showed up at every call site. The short
 * forms are the official names now; these are here only so a codebase can migrate a file at a time.
 *
 * **Delete this file at 1.0**, along with its line in `index.ts`. Nothing else imports it: the
 * library itself uses the short names throughout, so removal is the file and the export, and every
 * remaining consumer of an old name breaks loudly at compile time rather than silently.
 */
import {
  lazy,
  lazyArray,
  type InferLazy,
  type Lazy,
  type LazyApi,
  type LazyArray,
  type LazyArrayOptions,
  type LazyOptions,
  type LazyOptionsWithInitialValue,
  type LoadedLazy,
  type LoadedLazyArray,
} from "./lazy";

/** @deprecated Renamed to `lazy`. Removed at 1.0. */
export const lazyObservable = lazy;

/** @deprecated Renamed to `lazyArray`. Removed at 1.0. */
export const lazyObservableArray = lazyArray;

/** @deprecated Renamed to `Lazy`. Removed at 1.0. */
export type LazyObservable<T = any> = Lazy<T>;

/** @deprecated Renamed to `LazyArray`. Removed at 1.0. */
export type LazyObservableArray<T = any> = LazyArray<T>;

/** @deprecated Renamed to `LazyApi`. Removed at 1.0. */
export type LazyObservableApi<T> = LazyApi<T>;

/** @deprecated Renamed to `LazyOptions`. Removed at 1.0. */
export type LazyObservableOptions = LazyOptions;

/** @deprecated Renamed to `LazyOptionsWithInitialValue`. Removed at 1.0. */
export type LazyObservableOptionsWithInitialValue<T> = LazyOptionsWithInitialValue<T>;

/** @deprecated Renamed to `LazyArrayOptions`. Removed at 1.0. */
export type LazyObservableArrayOptions<T> = LazyArrayOptions<T>;

/** @deprecated Renamed to `LoadedLazy`. Removed at 1.0. */
export type LoadedLazyObservable<T = any> = LoadedLazy<T>;

/** @deprecated Renamed to `LoadedLazyArray`. Removed at 1.0. */
export type LoadedLazyObservableArray<T = any> = LoadedLazyArray<T>;

/** @deprecated Renamed to `InferLazy`. Removed at 1.0. */
export type InferLazyObservable<O> = InferLazy<O>;
