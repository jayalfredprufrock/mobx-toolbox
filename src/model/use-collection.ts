import { useObservableBox } from "../util/use-observable-box";
import { useStable } from "../react-util/useStable";
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
 * so the fetch's first argument is typed without declaring anything twice — and since they are the
 * one reactive part, `trackDependencies` defaults to `true` when they are present.
 */
export interface UseCollectionOptions<P, M> extends CollectionOptions<M> {
  params: P;
}

/**
 * {@link PagedCollectionOptions} plus the component's own inputs, which arrive as the fetch's
 * first argument. Same params-first shape as `useCollection`, and the same consequence:
 * `trackDependencies` defaults to `true` when they are present, because reading them is what makes
 * a change restart the list.
 */
export interface UsePagedCollectionOptions<P, M, Q = undefined> extends PagedCollectionOptions<
  M,
  Q
> {
  params: P;
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
 *   { params: { orgId, query }, trackDependencies: { throttle: 300 } },
 * );
 * ```
 *
 * Being component-scoped costs nothing global: the model's identity map still hands out one
 * instance per record, and mutations still fan out — so an edit here shows in the app-wide store
 * and vice versa. Nothing needs disposing either, since the model holds its listeners weakly.
 */
export function useCollection<MC extends AnyModelClass>(
  model: MC,
  fetch: LazyFetch<Payload<MC>[]>,
  // `params?: never` is what keeps this overload out of the way of the one below. Without it,
  // options carrying `params` *and* anything else — `{ params, trackDependencies }` — resolved to
  // neither overload: this one is only rejected by an excess-property check, which TypeScript
  // stops applying once another key matches, so the params-form arrow got no contextual type and
  // every one of its parameters read as an implicit `any`. Spelled the same way `UseTableConfig`
  // separates its two arms.
  options?: CollectionOptions<InstanceType<MC>> & { params?: never },
): LazyArray<InstanceType<MC>>;
export function useCollection<MC extends AnyModelClass, P extends object>(
  model: MC,
  fetch: (params: P, options: LazyFetchOptions) => Promise<Payload<MC>[]>,
  options: UseCollectionOptions<P, InstanceType<MC>>,
): LazyArray<InstanceType<MC>>;

export function useCollection(model: AnyModelClass, fetch: any, options?: any): any {
  const hasParams = options !== undefined && "params" in options;
  const { params, ...collectionOptions } = options ?? {};

  // Built once per component and garbage the moment it unmounts: the model holds its listeners
  // weakly, so a component-scoped store needs no disposal.
  const store = useStable(() => new (storeClassFor(model))(), []);
  const box = useObservableBox(params);

  // No deps: a collection's params are inputs to this one list, read through the box, so a change
  // refetches rather than building a different list.
  return useStable(
    () =>
      store.collection(
        hasParams
          ? (fetchOptions: LazyFetchOptions) => fetch(box.get(), fetchOptions)
          : (fetchOptions: LazyFetchOptions) => fetch(fetchOptions),
        {
          // Reading the box is what makes a param change refetch, so tracking has to be on. Without
          // params there is nothing to track and `collection()`'s own default stands.
          ...(hasParams ? { trackDependencies: true } : {}),
          ...collectionOptions,
        },
      ),
    [],
  );
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
 * one of the new list loads.
 */
export function usePagedCollection<MC extends AnyModelClass, Q = undefined>(
  model: MC,
  fetch: (request: LazyPageRequest<Q>) => Promise<LazyPageResult<Payload<MC>>>,
  // See the note on `useCollection`'s first overload for why `params?: never` is here.
  options?: PagedCollectionOptions<InstanceType<MC>, Q> & { params?: never },
): LazyPages<InstanceType<MC>, Q>;
export function usePagedCollection<MC extends AnyModelClass, P extends object, Q = undefined>(
  model: MC,
  fetch: (params: P, request: LazyPageRequest<Q>) => Promise<LazyPageResult<Payload<MC>>>,
  options: UsePagedCollectionOptions<P, InstanceType<MC>, Q>,
): LazyPages<InstanceType<MC>, Q>;

export function usePagedCollection(model: AnyModelClass, fetch: any, options?: any): any {
  const hasParams = options !== undefined && "params" in options;
  const { params, ...collectionOptions } = options ?? {};

  const store = useStable(() => new (storeClassFor(model))(), []);
  const box = useObservableBox(params);

  // No deps, for the same reason `useCollection` has none: params are inputs to *this* list, read
  // through the box, so a change restarts it rather than building a different one.
  return useStable(
    () =>
      store.pagedCollection(
        hasParams
          ? (request: LazyPageRequest<any>) => fetch(box.get(), request)
          : (request: LazyPageRequest<any>) => fetch(request),
        {
          // Reading the box is what makes a param change restart the list, so tracking has to be
          // on. Note this survives a `setQuery` from a table: the reload it triggers reinstalls the
          // tracking reaction, and the pager's own state stays out of the dependency set because it
          // is read inside an action.
          ...(hasParams ? { trackDependencies: true } : {}),
          ...collectionOptions,
        },
      ),
    [],
  );
}
