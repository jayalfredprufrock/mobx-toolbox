import { useObservableBox } from "../util/use-observable-box";
import { useStable } from "../react-util/useStable";
import type * as T from "typebox";
import type {
  LazyFetch,
  LazyFetchOptions,
  LazyObservableArray,
} from "../lazy-observable/lazy-observable";
import { makeStore, type AnyModelClass, type CollectionOptions } from "./make-store";

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
  options?: CollectionOptions<InstanceType<MC>>,
): LazyObservableArray<InstanceType<MC>>;
export function useCollection<MC extends AnyModelClass, P extends object>(
  model: MC,
  fetch: (params: P, options: LazyFetchOptions) => Promise<Payload<MC>[]>,
  options: UseCollectionOptions<P, InstanceType<MC>>,
): LazyObservableArray<InstanceType<MC>>;

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
