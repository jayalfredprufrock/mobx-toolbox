import * as T from "typebox";
import {
  lazyObservableArray,
  type LazyFetch,
  type LazyInvalidateOptions,
  type LazyObservableArray,
  type LazyObservableOptions,
} from "../lazy-observable/lazy-observable";
import { action, makeObservable, runInAction } from "mobx";
import type { ModelEventType, ModelSchema } from "./make-model";

// -----------------------------------------------------------------------------
// Type plumbing
// -----------------------------------------------------------------------------

/** Orders a collection, like `Array#sort` — but over model instances rather than payloads. */
export type Comparator<M> = (a: M, b: M) => number;

/** Per-list options: everything a lazy observable takes, plus staleness and ordering. */
export interface CollectionOptions<M = any> extends LazyObservableOptions {
  /**
   * Which mutations to this resource mark this list stale. Defaults to the store's `invalidateOn`,
   * itself `["created"]`. A deletion always removes the model from the list regardless.
   */
  invalidateOn?: readonly ModelEventType[];
  /**
   * Order this list. Defaults to the store's `sort`, since one ordering usually applies to every
   * collection over a resource. Pass `false` to keep server order on this list alone.
   */
  sort?: Comparator<M> | false;
  /**
   * Show a record from `create()` in this list straight away, without waiting for the refetch that
   * the `created` event triggers. Defaults to the store's `optimisticCreate`, itself `false`.
   *
   * Off by default because only the server knows whether a new record belongs in a given list: a
   * filtered or searched collection would flash a row that does not belong to it. Turn it on for
   * the lists a new record certainly joins — usually the unfiltered one.
   */
  optimisticCreate?: boolean;
  /**
   * Drop this list's rows while it refetches after being marked stale, rather than keeping them
   * readable. Defaults to the store's `discardOnInvalidate`, itself `false`.
   *
   * Keeping them is usually right — the rows are still broadly correct and the list doesn't blank
   * on every mutation. Discard when stale rows would actively mislead: a filtered list whose
   * membership an `update` may have changed, for one.
   */
  discardOnInvalidate?: boolean;
}

export interface StoreConfig<M = any> {
  /**
   * Order every collection on this store. Sorting is usually the one thing standing between an API
   * client and being attached directly, and the same ordering almost always applies to every list
   * over a resource — so it is declared once here, and a single collection can still override it.
   *
   * Runs over model instances on every load.
   */
  sort?: Comparator<M>;
  /**
   * Whether a record from `create()` appears in this store's lists before the refetch confirms it.
   * Defaults to `false`; a single collection can still opt in or out.
   */
  optimisticCreate?: boolean;
  /**
   * Whether a list drops its rows while refetching after being marked stale, rather than keeping
   * them readable. Defaults to `false`; a single collection can still opt in or out.
   */
  discardOnInvalidate?: boolean;
  /**
   * Which mutations to this resource — from *any* store, or from the model's own statics — mark this
   * list stale. Defaults to `["created"]`: a new record is the only event whose effect on a list
   * can't be worked out locally, since only the server knows whether it belongs here.
   *
   * `"updated"` is not a default because identity means every list already shows the change — add it
   * when membership depends on a field that can change. `"deleted"` is not a default either: the
   * record is removed from every list outright, which needs no refetch — list it only when a deletion
   * changes the list in some *other* way, a server-side count or ordering, say.
   */
  invalidateOn?: readonly ModelEventType[];
}

/**
 * How a collection is declared to `createStore`: its fetch alone, or its fetch plus that list's own
 * options. The verbose form is what lets a single collection override the store's `sort`, set its
 * own `invalidateOn`, or take any lazy option.
 */
export type CollectionSpec<R, M> =
  | LazyFetch<R[]>
  | ({ fetch: LazyFetch<R[]> } & CollectionOptions<M>);

/** Names a collection may not take, since each is already a member of the store. */
type ReservedCollectionName = "remove" | "collection" | "onModelEvent" | "get" | "create";

/**
 * `createStore` config: everything `makeStore` takes, plus the collections themselves. They live in
 * the config here because there is no subclass to hang them off — the moment you do subclass, every
 * collection is declared the same way, as a field built with `this.collection(...)`.
 */
export interface CreateStoreConfig<R, M> extends StoreConfig<M> {
  collections: Record<string, CollectionSpec<R, M>> & {
    [N in ReservedCollectionName]?: never;
  };
}

// Final store-instance shape. `get`/`create` are delegated from the model class, so their presence
// is keyed off the *class* rather than off an inferred config object. Each slot is declared as a
// method rather than a function-valued property, so a subclass can override it with a method —
// which TypeScript forbids when the base declares a property.
type StoreInstance<M, MC, Cfg> = {
  remove(model: M): void;
  /**
   * Mark every collection on this store stale, for a change no model event describes — a tenant
   * switch, a filter reset, a refresh button. Unlike the event path this ignores `invalidateOn`: a
   * list that opted out of refetching on *events* has not opted out of being told directly.
   *
   * Named for what it covers: a subclass may hold lazies that aren't collections — a count, a
   * summary — and those are left alone.
   */
  invalidateCollections(options?: LazyInvalidateOptions): void;
  onModelEvent(type: ModelEventType, model: M): void;
  /**
   * Build another list on this store. Payloads become models, the list joins this
   * store's mutation handling, and every lazy option is available — so a search, a filtered view, or
   * a polled list is a field on a subclass:
   *
   * ```ts
   * class SurveySearch extends makeStore(SurveyModel) {
   *   query = "";
   *   results = this.collection((options) => api.search({ q: this.query, ...options }), {
   *     trackDependencies: { throttle: 300 },
   *   });
   * }
   * ```
   */
  collection(
    fetch: LazyFetch<MC extends { schema: infer S extends ModelSchema } ? T.Static<S>[] : never[]>,
    options?: CollectionOptions<M>,
  ): LazyObservableArray<M>;
} & (MC extends { get: (...args: infer A) => any } ? { get(...args: A): Promise<M> } : {}) &
  (Cfg extends { collections: infer C } ? { [N in keyof C]: LazyObservableArray<M> } : {}) &
  (MC extends { create: (...args: infer A) => any } ? { create(...args: A): Promise<M> } : {});

export type StoreConstructor<M, MC, Cfg> = {
  new (): StoreInstance<M, MC, Cfg>;
};

// -----------------------------------------------------------------------------
// makeStore
// -----------------------------------------------------------------------------

/**
 * A class produced by `makeModel`/`makeUnionModel`: it carries its own schema, so passing one to
 * `makeStore` means not repeating the schema, and its identity map is wired up by default.
 */
export type AnyModelClass = {
  readonly schema: ModelSchema;
  new (data: any, store?: any): any;
};

export function makeStore<MC extends AnyModelClass>(
  model: MC,
): StoreConstructor<InstanceType<MC>, MC, {}>;
export function makeStore<MC extends AnyModelClass, Cfg extends StoreConfig<InstanceType<MC>>>(
  model: MC,
  config: Cfg,
): StoreConstructor<InstanceType<MC>, MC, Cfg>;
export function makeStore(
  ModelClass: AnyModelClass,
  config?: StoreConfig<any> & { collections?: Record<string, CollectionSpec<any, any>> },
): StoreConstructor<any, any, any> {
  type R = any;

  const Model = ModelClass as any;

  // Route through the model's identity map whenever it has one, so every list, `get`, and `create`
  // hands back the same instance for a record. `keys` is `false` on a model that declared no
  // identity; an empty array is a singleton, which still maps.
  const buildModel = (data: R) =>
    Array.isArray(Model.keys) ? Model.instantiate(data) : new Model(data);

  class Store {
    /** Every list this store owns, with the events that mark each stale and how each is ordered. */
    private readonly _collections: {
      lazy: LazyObservableArray<any>;
      invalidateOn: readonly ModelEventType[];
      sort: Comparator<any> | undefined;
      optimisticCreate: boolean;
      discardOnInvalidate: boolean;
    }[] = [];

    constructor() {
      makeObservable<this, "_collections">(this, {
        _collections: false,
        remove: action,
        invalidateCollections: action,
        onModelEvent: action,
      });

      // `createStore` puts collections in the config, since it has no subclass to hang them off.
      // They go through the same `collection()` a subclass field would.
      for (const [name, spec] of Object.entries(config?.collections ?? {})) {
        if (name in this) {
          throw new Error(`Collection "${name}" would shadow a member the store already has.`);
        }
        const { fetch, ...options } = typeof spec === "function" ? { fetch: spec } : spec;
        (this as any)[name] = this.collection(fetch, options);
      }

      // Held weakly, so registering never keeps this store alive.
      Model.addListener?.(this);
    }

    /**
     * Build another list on this store: payloads become models, and the list joins this store's
     * mutation handling. Call it in a subclass field initializer.
     */
    collection(fetch: LazyFetch<R[]>, options?: CollectionOptions<any>): LazyObservableArray<any> {
      const { invalidateOn, sort, optimisticCreate, discardOnInvalidate, ...lazyOptions } =
        options ?? {};
      // Omitted means "use the store's"; `false` means this one list keeps server order.
      const comparator = (sort === undefined ? config?.sort : sort) || undefined;
      const lazy = lazyObservableArray(
        async (fetchOptions) => {
          const items = await fetch(fetchOptions);
          const models = items.map((item) => buildModel(item));
          return comparator ? models.sort(comparator) : models;
        },
        // deep: false — models are observable in their own right, so nothing needs converting.
        { deep: false, ...lazyOptions },
      );
      this._collections.push({
        lazy,
        invalidateOn: invalidateOn ?? config?.invalidateOn ?? ["created"],
        sort: comparator,
        optimisticCreate: optimisticCreate ?? config?.optimisticCreate ?? false,
        discardOnInvalidate: discardOnInvalidate ?? config?.discardOnInvalidate ?? false,
      });
      return lazy;
    }

    /** Drop a model from every list on this store, without implying the record is gone. */
    remove(model: any): void {
      for (const { lazy } of this._collections) lazy.value.remove(model);
    }

    /**
     * Mark every collection on this store stale. For a change no model event describes — a tenant
     * switch, a filter reset, a refresh button. `invalidateOn` is deliberately not consulted: it
     * governs which *events* reach a list, not whether you can refetch one on purpose.
     *
     * Only collections: a subclass's own lazies are its business, and it can invalidate them in
     * whatever handler already knows they need it.
     */
    invalidateCollections(options?: LazyInvalidateOptions): void {
      for (const { lazy, discardOnInvalidate } of this._collections) {
        // An explicit `discard` wins; otherwise each list's own declaration stands.
        lazy.invalidate({ discard: options?.discard ?? discardOnInvalidate });
      }
    }

    /**
     * A mutation happened somewhere — this store, another store over the same resource, or the
     * model's own statics. A deletion always drops the model from this list; whether any event also
     * marks the list stale is up to `invalidateOn`.
     */
    onModelEvent(type: ModelEventType, model: any): void {
      for (const { lazy, invalidateOn, discardOnInvalidate } of this._collections) {
        // Removal is unconditional: the record is gone, and dropping it is always correct.
        if (type === "deleted") lazy.value.remove(model);
        if (invalidateOn.includes(type)) lazy.invalidate({ discard: discardOnInvalidate });
      }
    }
  }

  const proto = Store.prototype as any;

  if (typeof Model.get === "function") {
    // The static already returns the identity-mapped instance, and removal travels by event rather
    // than by ownership, so there is nothing for the store to add.
    proto.get = function (...args: any[]) {
      return Model.get(...args);
    };
  }

  if (typeof Model.create === "function") {
    proto.create = async function (...args: any[]) {
      const model = await Model.create(...args);
      return runInAction(() => {
        // Show it immediately in the lists that asked for it; the `created` event has already
        // marked them stale, so the server still gets the last word on position and membership.
        // Identity means the refetch reuses this instance, so the row moves rather than flickering.
        for (const { lazy, sort, optimisticCreate } of this._collections) {
          if (!optimisticCreate) continue;
          const rows = lazy.value;
          if (rows.includes(model)) continue;
          if (!sort) {
            rows.unshift(model);
            continue;
          }
          // Land it where the configured order puts it, rather than at the top where the next
          // load would visibly move it.
          const at = rows.findIndex((existing: any) => sort(model, existing) < 0);
          rows.splice(at === -1 ? rows.length : at, 0, model);
        }
        return model;
      });
    };
  }

  return Store as unknown as StoreConstructor<any, any, any>;
}

/**
 * `makeStore` plus `new`, for a store you don't need to subclass. Its collections are named in the
 * config and land on the instance under those names — so `createStore` is the whole story when a
 * store is just lists over a resource, and the moment you need behaviour of your own you move to
 * `makeStore` and declare every collection as a field.
 *
 * ```ts
 * const surveys = createStore(SurveyModel, {
 *   sort: (a, b) => a.name.localeCompare(b.name),
 *   collections: {
 *     all: (options) => api.listSurveys(options),
 *     drafts: { fetch: (options) => api.listSurveys({ status: "draft", ...options }), sort: false },
 *   },
 * });
 *
 * surveys.all.getOrLoad();
 * ```
 */
export function createStore<
  MC extends AnyModelClass,
  Cfg extends CreateStoreConfig<T.Static<MC["schema"]>, InstanceType<MC>>,
>(model: MC, config: Cfg): StoreInstance<InstanceType<MC>, MC, Cfg>;

export function createStore(model: AnyModelClass, config: CreateStoreConfig<any, any>): any {
  return new (makeStore(model, config as any))();
}

export type { LazyObservableArray };
