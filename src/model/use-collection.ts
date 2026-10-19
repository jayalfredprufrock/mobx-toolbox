import { useStable } from "../react-util/useStable";
import { useParamsFetch, type WithoutTracking } from "../lazy/params";
import type * as T from "typebox";
import type {
  LazyFetch,
  LazyFetchOptions,
  LazyArray,
  LazyPageRequest,
  LazyPageResult,
  LazyPages,
} from "../lazy/lazy";
import {
  makeStore,
  type AnyModelClass,
  type CollectionOptions,
  type PagedCollectionOptions,
} from "./make-store";

/** The payload a model's collections resolve to arrays of. */
type Payload<MC extends AnyModelClass> = T.Static<MC["schema"]>;

/**
 * `CollectionOptions` plus the component's own inputs. Their type is inferred from what you pass,
 * so the fetch's first argument is typed without declaring anything twice. They are the whole of
 * the fetch's inputs, so `trackDependencies` is not among the options: the hook tracks the params
 * itself, and nothing else.
 */
export interface UseCollectionOptions<P, M> extends WithoutTracking<CollectionOptions<M>> {
  params: P;
  /**
   * What a param change does to the rows already held. `false` (the default here, unlike the lazy
   * hooks) refetches in place, rows readable throughout — right for filters over one list. `true`
   * starts over with an empty list — right for a list owned by a parent, an org's members, where
   * the previous org's rows under the new params would be a lie.
   */
  discardOnChange?: boolean;
  /**
   * Wait this long, in milliseconds, after a param change before the request goes out, restarting
   * the wait on every change. `fetching` is `true` throughout, and only a param change waits — see
   * `UseLazyParamsOptions.debounce` in `lazy`.
   */
  debounce?: number;
}

/**
 * {@link PagedCollectionOptions} plus the component's own inputs, which arrive as the fetch's
 * first argument. Same params-first shape as `useCollection`, and the same consequence: no
 * `trackDependencies`, since the params are what the hook tracks.
 */
export interface UsePagedCollectionOptions<P, M, Q = undefined> extends WithoutTracking<
  PagedCollectionOptions<M, Q>
> {
  params: P;
  /** See {@link UseCollectionOptions.discardOnChange}: `false` by default, as there. */
  discardOnChange?: boolean;
  /** See {@link UseCollectionOptions.debounce}. A next page or a `setQuery` never waits. */
  debounce?: number;
}

/**
 * One store per model class, rather than one per component: `makeStore` builds a class, and there
 * is no reason for two components over the same model to each build their own.
 */
const storeClasses = new WeakMap<AnyModelClass, new () => any>();

const storeClassFor = (model: AnyModelClass): new () => any => {
  let StoreClass = storeClasses.get(model);
  if (!StoreClass) {
    StoreClass = makeStore(model) as unknown as new () => any;
    storeClasses.set(model, StoreClass);
  }
  return StoreClass;
};

/**
 * A collection that belongs to one component: `store.collection()`, for a list whose parameters are
 * the component's own — a filter, a search box, a route param — where a shared store is the wrong
 * home for them.
 *
 * ```tsx
 * const list = useCollection(SurveyModel, (options) => api.listSurveys(options));
 * ```
 *
 * Pass `params` and they arrive as the fetch's first argument, ahead of the lazy's own options —
 * the same params-first shape `collectionMap` uses. They are plain React values; the hook keeps
 * them in an observable the fetch reads through, so a change refetches while leaving the current
 * rows readable and aborting the request it supersedes:
 *
 * ```tsx
 * const [query, setQuery] = useState("");
 *
 * const list = useCollection(
 *   SurveyModel,
 *   ({ orgId, query }, options) => api.listSurveys({ orgId, q: query, ...options }),
 *   { params: { orgId, query }, debounce: 300 },
 * );
 * ```
 *
 * Refetching in place is the default here because filters over one list are what this hook is
 * for — the reverse of the lazy hooks. For a list a param *picks*, the members of an org, pass
 * `discardOnChange: true`: a change then starts over with an empty list, so the previous org's
 * rows never show under the new one.
 *
 * Being component-scoped costs nothing global: the model's identity map still hands out one
 * instance per record, and mutations still fan out — so an edit here shows in the app-wide store
 * and vice versa. Nothing needs disposing either, since the model holds its listeners weakly.
 */
export function useCollection<MC extends AnyModelClass>(
  model: MC,
  fetch: LazyFetch<Payload<MC>[]>,
  // `params?: never` is what keeps this overload out of the way of the one below. Without it,
  // options carrying `params` *and* anything else — `{ params, debounce }` — resolved to
  // neither overload: this one is only rejected by an excess-property check, which TypeScript
  // stops applying once another key matches, so the params-form arrow got no contextual type and
  // every one of its parameters read as an implicit `any`. Spelled the same way `UseTableConfig`
  // separates its two arms.
  options?: WithoutTracking<CollectionOptions<InstanceType<MC>>> & { params?: never },
): LazyArray<InstanceType<MC>>;
export function useCollection<MC extends AnyModelClass, P extends object>(
  model: MC,
  fetch: (params: P, options: LazyFetchOptions) => Promise<Payload<MC>[]>,
  options: UseCollectionOptions<P, InstanceType<MC>>,
): LazyArray<InstanceType<MC>>;

export function useCollection(model: AnyModelClass, fetch: any, options?: any): any {
  // Keeping is the default here, the reverse of the lazy hooks: filters over one list are what
  // this hook is for.
  const source = useParamsFetch<LazyFetchOptions>(fetch, options, false);

  // The store shares the list's lifetime. Discarding rebuilds both, so the previous list isn't left
  // registered for mutation handling — the old store is garbage along with it, and so is this one
  // when the component unmounts: the model holds its listeners weakly, so nothing needs disposing.
  const store = useStable(() => new (storeClassFor(model))(), source.deps);
  return useStable(() => store.collection(source.fetch, source.options), source.deps);
}

/**
 * An accumulating list that belongs to one component — an infinite feed, a load-more table — whose
 * parameters are the component's own.
 *
 * ```tsx
 * const feed = usePagedCollection(SurveyModel, ({ cursor, limit, signal }) =>
 *   api.listSurveys({ cursor, limit, signal }),
 * );
 * ```
 *
 * Everything `pagedCollection()` gives a store-owned list applies here: payloads become
 * identity-mapped models, duplicates across page boundaries are dropped on `identityKey`, a
 * `created` event restarts the list, and a deletion removes the record from it. Being
 * component-scoped costs none of that — the model's identity map and event fan-out are global, so
 * an edit here shows up in the app-wide store and vice versa, and nothing needs disposing because
 * the model holds its listeners weakly.
 *
 * **Bound to a table, there is nothing else to write.** The table infers `mode: "server"`, pushes
 * its query in, and asks for the next page as the window nears the end:
 *
 * ```tsx
 * const feed = usePagedCollection<typeof SurveyModel, TableQuery>(
 *   SurveyModel,
 *   ({ query, cursor, limit, signal }) =>
 *     api.listSurveys({ where: query.filters, sort: query.sorts, cursor, limit, signal }),
 * );
 * const table = useTable({ data: feed, columns });
 * ```
 *
 * `params` are for inputs the *table doesn't own* — a route param, a parent record. They arrive as
 * the fetch's first argument and a change restarts the list, leaving the rows readable while page
 * one of the new list loads. `discardOnChange: true` empties it instead, as for `useCollection` —
 * and builds a new list, so a query the table pushed in is pushed again rather than carried over.
 */
export function usePagedCollection<MC extends AnyModelClass, Q = undefined>(
  model: MC,
  fetch: (request: LazyPageRequest<Q>) => Promise<LazyPageResult<Payload<MC>>>,
  // See the note on `useCollection`'s first overload for why `params?: never` is here.
  options?: WithoutTracking<PagedCollectionOptions<InstanceType<MC>, Q>> & { params?: never },
): LazyPages<InstanceType<MC>, Q>;
export function usePagedCollection<MC extends AnyModelClass, P extends object, Q = undefined>(
  model: MC,
  fetch: (params: P, request: LazyPageRequest<Q>) => Promise<LazyPageResult<Payload<MC>>>,
  options: UsePagedCollectionOptions<P, InstanceType<MC>, Q>,
): LazyPages<InstanceType<MC>, Q>;

export function usePagedCollection(model: AnyModelClass, fetch: any, options?: any): any {
  // The same defaults and lifetimes as `useCollection`'s — see the notes there. Keeping survives a
  // `setQuery` from a table: the restart reinstalls the tracking reaction, and the pager's own state
  // stays out of the dependency set because it is read inside an action.
  const source = useParamsFetch<LazyPageRequest<any>>(fetch, options, false);

  const store = useStable(() => new (storeClassFor(model))(), source.deps);
  return useStable(() => store.pagedCollection(source.fetch, source.options), source.deps);
}
