import type { LazyArray, LazyPages } from "../lazy/lazy";
import type { RowData, TableQuery } from "./table.types";

/**
 * Whether `data` was given as a lazy rather than an array or a getter.
 *
 * Structural rather than an `instanceof`, because `lazyArray` is a factory over a closure
 * and there is no class to test against. Checking two members no plain dataset has is enough, and
 * it keeps this a *type-only* dependency on `lazy` — nothing from that module is
 * imported at runtime, so a consumer who only ever hands the table arrays never bundles it.
 *
 * Not exported from the package: the shapes `data` accepts are documented, so a caller always knows
 * which one they passed, and `table.lazy` answers the question for anyone holding only a model.
 */
export const isLazy = (data: unknown): data is LazyArray<RowData> =>
  typeof data === "object" &&
  data !== null &&
  !Array.isArray(data) &&
  "loaded" in data &&
  "getOrLoad" in data;

/**
 * Whether `data` is a *paged* lazy — one that grows by appending rather than replacing.
 *
 * Structural for the same reason {@link isLazy} is, and narrower on purpose: `loadMore` is what
 * distinguishes an accumulating source from any other lazy, and it is the member the table actually
 * needs. A discrete-page source (one that replaces its rows per page) has none, so it is correctly
 * *not* one of these and never gets auto-fetched.
 *
 * Not exported from the package; `table.pages` answers the question for a caller holding a model.
 */
export const isPaged = (data: unknown): data is LazyPages<RowData, TableQuery> =>
  isLazy(data) && "loadMore" in data && "setQuery" in data;
