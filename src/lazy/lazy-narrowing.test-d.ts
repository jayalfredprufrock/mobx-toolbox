/**
 * Type-level tests for the `loaded` discriminant.
 *
 * The whole reason `Lazy` is spelled as a union of two full members rather than one API
 * intersected with a union is that narrowing has to work through it. If it stops working, `value`
 * silently goes back to needing a `!== undefined` guard at every call site — and nothing at runtime
 * would notice. These are compile-time assertions: the file passing `vp check` *is* the test.
 */
import type { IObservableArray } from "mobx";
import { lazy, lazyArray, type LazyFetch, type Lazy, type LazyArray } from "./lazy";
import { useLazy, useLazyArray } from "./use-lazy";

/**
 * Compiles only if the argument is assignable to `Expected`.
 *
 * Deliberately an assignability check rather than an exact-type one: a mutual-`extends` helper
 * resolves to `never` on mismatch, and `never` is assignable to everything, so it would report
 * success no matter what. This errors on the failure that actually matters — a `value` still
 * carrying `undefined` after the guard.
 */
const assignableTo = <Expected>(_value: Expected): void => {};

// --- scalar ----------------------------------------------------------------

const scalar = lazy(() => Promise.resolve(42));

// @ts-expect-error unnarrowed, `value` still carries the `undefined` half of the union
assignableTo<number>(scalar.value);
assignableTo<number | undefined>(scalar.value);

if (scalar.loaded) {
  // narrowed by the discriminant alone — no `!`, no `!== undefined`
  assignableTo<number>(scalar.value);
  const doubled: number = scalar.value * 2;
  void doubled;
} else {
  assignableTo<undefined>(scalar.value);
}

// the negative form narrows too, which is what an early return depends on
if (!scalar.loaded) {
  assignableTo<undefined>(scalar.value);
} else {
  assignableTo<number>(scalar.value);
}

// --- array -----------------------------------------------------------------

const list = lazyArray(() => Promise.resolve([1, 2, 3]));

// @ts-expect-error same union, so the same guard is required
assignableTo<IObservableArray<number>>(list.value);

if (list.loaded) {
  assignableTo<IObservableArray<number>>(list.value);
  const count: number = list.value.length;
  void count;
  // the observable-array methods survive the union
  list.value.replace([4, 5]);
}

// `set` still takes a plain array — callers hand over data, not a container
list.set([1, 2]);

// --- narrowing survives the shared API ------------------------------------

// reading an API member first must not collapse the union back to its base
if (list.fetching && list.loaded) {
  assignableTo<IObservableArray<number>>(list.value);
}

// and a narrowed lazy is still fully usable as one
if (scalar.loaded) {
  void scalar.reload();
  void scalar.fetchedAt;
  void scalar.error;
  scalar.invalidate({ discard: true });
}

// --- members that are deliberately gone -----------------------------------

// @ts-expect-error `status` was removed — it conflated value presence with request outcome
void scalar.status;

// @ts-expect-error renamed to `fetchedAt`, which tracks the fetch rather than the value
void scalar.loadedAt;

// @ts-expect-error removed — too easily confused with `fetching`, and the obvious use for it
// mishandled a failed first load. Spell it: `!loaded && fetching`.
void scalar.loading;

// what replaced it, and the two facts it was made of
void (!scalar.loaded && scalar.fetching);

// --- a seed narrows the result, so no guard is needed at all ---------------

const seededScalar = lazy(() => Promise.resolve(42), { initialValue: 0 });

// no `if (loaded)` anywhere: this is the whole point of the seeded overload
assignableTo<number>(seededScalar.value);
assignableTo<true>(seededScalar.loaded);
const seededDoubled: number = seededScalar.value * 2;
void seededDoubled;

const seededList = lazyArray(() => Promise.resolve([1, 2, 3]), { initialValue: [] });
assignableTo<IObservableArray<number>>(seededList.value);
assignableTo<true>(seededList.loaded);
seededList.value.replace([4, 5]);

// an empty seed is still a seed: "there are none" is a fact, so it reports loaded
const emptySeeded = lazyArray(() => Promise.resolve<string[]>([]), { initialValue: [] });
assignableTo<IObservableArray<string>>(emptySeeded.value);

// --- a seed of `undefined` counts, when `T` admits one ---------------------

// matches a fetch resolving `undefined`, which has always reported loaded
const maybeSeeded = lazy<string | undefined>(async () => "later", {
  initialValue: undefined,
});
assignableTo<true>(maybeSeeded.loaded);
// `value` stays wide, because `undefined` is the value rather than the absence of one
assignableTo<string | undefined>(maybeSeeded.value);

// --- a possibly-undefined seed, which is the case the overloads guard -------

declare const maybeNumber: number | undefined;

// With `T` free, inference widens it to include `undefined` rather than rejecting the call: the
// lazy really does hold a value (the seed), and that value really might be `undefined`. So
// `loaded` narrows and `value` stays wide, which is the honest reading of both facts.
const widened = lazy(() => Promise.resolve(1), { initialValue: maybeNumber });
assignableTo<true>(widened.loaded);
assignableTo<number | undefined>(widened.value);
// @ts-expect-error ...so `value` cannot be read as a bare `number`
assignableTo<number>(widened.value);

// A `T` pinned by the fetch widens the same way, for the same reason.
declare const fetchNumber: LazyFetch<number>;
const widenedFromFetch = lazy(fetchNumber, { initialValue: maybeNumber });
assignableTo<number | undefined>(widenedFromFetch.value);

// Pinning `T` explicitly is the one spelling that cannot widen, so it is rejected instead. That
// is the whole breaking change: `T` says `undefined` is not a value, the seed says it might be,
// and nothing sound can be built from the pair.
// @ts-expect-error possibly-undefined seed on an explicitly non-undefined `T`
lazy<number>(() => Promise.resolve(1), { initialValue: maybeNumber });

// Lists have no such ambiguity — `undefined` is never a list — so this is accepted and simply
// does not narrow.
declare const maybeRows: number[] | undefined;
const looseList = lazyArray(() => Promise.resolve([1]), { initialValue: maybeRows });
assignableTo<LazyArray<number>>(looseList);
// @ts-expect-error ...which means it still needs the guard
assignableTo<IObservableArray<number>>(looseList.value);

// --- explicit type arguments still work ------------------------------------

// the reason these are overloads and not one signature with a conditional return type: naming
// `T` must not force a second type parameter to its default
const explicitScalar = lazy<number>(() => Promise.resolve(1), { initialValue: 7 });
assignableTo<number>(explicitScalar.value);
const explicitList = lazyArray<number>(() => Promise.resolve([1]), { initialValue: [] });
assignableTo<IObservableArray<number>>(explicitList.value);

// --- the hooks carry the narrowing, rather than dropping it ----------------

declare const deps: React.DependencyList;

const hookScalar = useLazy(() => Promise.resolve(42), deps);
assignableTo<number | undefined>(hookScalar.value);
// @ts-expect-error unseeded, so still a union
assignableTo<number>(hookScalar.value);

const hookSeeded = useLazy(() => Promise.resolve(42), deps, { initialValue: 0 });
assignableTo<number>(hookSeeded.value);
assignableTo<true>(hookSeeded.loaded);

const hookList = useLazyArray(() => Promise.resolve([1]), deps);
// @ts-expect-error unseeded, so still a union
assignableTo<IObservableArray<number>>(hookList.value);

const hookSeededList = useLazyArray(() => Promise.resolve([1]), deps, { initialValue: [] });
assignableTo<IObservableArray<number>>(hookSeededList.value);
assignableTo<true>(hookSeededList.loaded);

// --- narrowed lazies remain usable everywhere an unnarrowed one is --------

// the narrowed type is one arm of the union, so nothing typed against the union breaks
assignableTo<Lazy<number>>(seededScalar);
assignableTo<LazyArray<number>>(seededList);
// and the full API is still there
void seededScalar.reload();
seededScalar.invalidate({ discard: true });
seededList.set([9]);

export {};
