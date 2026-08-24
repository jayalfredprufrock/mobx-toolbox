/**
 * Type-level tests for the `loaded` discriminant.
 *
 * The whole reason `LazyObservable` is spelled as a union of two full members rather than one API
 * intersected with a union is that narrowing has to work through it. If it stops working, `value`
 * silently goes back to needing a `!== undefined` guard at every call site — and nothing at runtime
 * would notice. These are compile-time assertions: the file passing `vp check` *is* the test.
 */
import type { IObservableArray } from "mobx";
import { lazyObservable, lazyObservableArray } from "./lazy-observable";

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

const scalar = lazyObservable(() => Promise.resolve(42));

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

const list = lazyObservableArray(() => Promise.resolve([1, 2, 3]));

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

export {};
