import * as T from "typebox";
import {
  lazyArray,
  lazyPages,
  type LazyFetch,
  type LazyFetchOptions,
  type LazyInvalidateOptions,
  type LazyArray,
  type LazyOptions,
  type LazyPageRequest,
  type LazyPageResult,
  type LazyPages,
  type LazyPagesOptions,
} from "../lazy/lazy";
import { action, makeObservable, runInAction } from "mobx";
import { serializeKey, type ModelEventType, type ModelSchema } from "./make-model";

// -----------------------------------------------------------------------------
// Type plumbing
// -----------------------------------------------------------------------------

/** Orders a collection, like `Array#sort` — but over model instances rather than payloads. */
export type Comparator<M> = (a: M, b: M) => number;

/** Per-list options: everything a lazy observable takes, plus staleness and ordering. */
export interface CollectionOptions<M = any> extends LazyOptions {
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

/**
 * Per-list options for a paged collection: every {@link LazyPagesOptions} option, plus the two
 * store-level concerns that still apply.
 *
 * **`sort` is deliberately absent.** A comparator can only ever see the page in front of it, so
 * ordering a paged list client-side would sort each page against itself and leave the list
 * globally unordered — the order is the server's, and it is the server's for the same reason the
 * filtering is. A store-level `sort` is therefore *not* inherited here; nothing silently applies it
 * to one page at a time.
 */
export interface PagedCollectionOptions<M = any, Q = undefined>
  extends LazyPagesOptions<M, Q>, Omit<CollectionOptions<M>, keyof LazyOptions | "sort"> {}

/**
 * How a paged collection is declared to `createStore`: its fetch alone, or its fetch plus that
 * list's own options — the same two shapes as {@link CollectionSpec}.
 */
export type PagedCollectionSpec<R, M, Q = undefined> =
  | ((request: LazyPageRequest<Q>) => Promise<LazyPageResult<R>>)
  | ({
      fetch: (request: LazyPageRequest<Q>) => Promise<LazyPageResult<R>>;
    } & PagedCollectionOptions<M, Q>);

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

/**
 * A family of collections, one per key — the same list fetched separately per tenant, per parent
 * record, per page. Call it to get that key's list, building it on first use.
 */
export interface CollectionMap<K, M> {
  (key: K): LazyArray<M>;
  /**
   * Drop one key's list, unregistering it from the store's mutation handling. For a key that is
   * gone for good — an organization the user just left — so the map doesn't hold a list nothing
   * will ask for again. The next call for that key builds a fresh one.
   */
  forget(key: K): boolean;
  /** Drop every list this map has built. For teardown: a logout, a tenant switch. */
  clear(): void;
}

/** Options for the free-form form of `collectionMap`, whose key is whatever you say it is. */
export interface CollectionMapOptions<K, M> extends CollectionOptions<M> {
  /**
   * Spell a key as something a map can hold. Only needed for a key that isn't already a string or
   * a number — a filter object, a params tuple. The declared-fields form has no use for it: those
   * serialize exactly as the identity map does.
   */
  keyOf?: (key: K) => string | number;
}

/** The payload a store's collections resolve to arrays of, read off the model class's schema. */
type StoreResource<MC> = MC extends { schema: infer S extends ModelSchema } ? T.Static<S> : never;

/**
 * The fields a collection may be keyed by: those holding something that can be a map key on its
 * own. Anything else has no obvious spelling, so it belongs in the free-form form with a `keyOf`.
 */
type ScalarField<R> = {
  [P in keyof R]-?: NonNullable<R[P]> extends string | number ? P : never;
}[keyof R];

/** Names a collection may not take, since each is already a member of the store. */
export type ReservedCollectionName =
  | "remove"
  | "collection"
  | "collectionMap"
  | "pagedCollection"
  | "invalidateCollections"
  | "onModelEvent"
  | "get"
  | "create";

/**
 * `createStore` config: everything `makeStore` takes, plus the collections themselves. They live in
 * the config here because there is no subclass to hang them off — the moment you do subclass, every
 * collection is declared the same way, as a field built with `this.collection(...)`.
 */
export interface CreateStoreConfig<R, M> extends StoreConfig<M> {
  collections: Record<string, CollectionSpec<R, M>> & {
    [N in ReservedCollectionName]?: never;
  };
  /**
   * Accumulating lists, declared alongside the ordinary ones and kept apart from them because they
   * are a different shape of fetch: a page rather than the whole list. Each becomes a
   * {@link LazyPages} on the instance, under its own name.
   *
   * ```ts
   * createStore(SurveyModel, {
   *   collections: { drafts: api.listDraftSurveys },
   *   pagedCollections: { feed: ({ cursor, limit }) => api.listSurveys({ cursor, limit }) },
   * });
   * ```
   */
  pagedCollections?: Record<string, PagedCollectionSpec<R, M>> & {
    [N in ReservedCollectionName]?: never;
  };
}

// Final store-instance shape. `get`/`create` are delegated from the model class, so their presence
// is keyed off the *class* rather than off an inferred config object. Each slot is declared as a
// method rather than a function-valued property, so a subclass can override it with a method —
// which TypeScript forbids when the base declares a property.
export type StoreInstance<M, MC, Cfg> = {
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
  ): LazyArray<M>;
  /**
   * Build an **accumulating** list on this store — one that grows a page at a time, for a dataset
   * too large to hand over whole. Payloads become models and the list joins this store's mutation
   * handling exactly as `collection()`'s does; what differs is that the fetch resolves one page:
   *
   * ```ts
   * class Surveys extends makeStore(SurveyModel) {
   *   feed = this.pagedCollection(({ cursor, limit, signal }) =>
   *     api.listSurveys({ cursor, limit, signal }),
   *   );
   * }
   *
   * surveys.feed.loadMore();
   * surveys.feed.total;
   * ```
   *
   * `Q` is the query type the list is driven by — `TableQuery` when a table owns it. Deduplication
   * defaults to the model's `identityKey`, and `sort` is not an option: see
   * {@link PagedCollectionOptions}.
   */
  pagedCollection<Q = undefined>(
    fetch: (
      request: LazyPageRequest<Q>,
    ) => Promise<
      LazyPageResult<MC extends { schema: infer S extends ModelSchema } ? T.Static<S> : never>
    >,
    options?: PagedCollectionOptions<M, Q>,
  ): LazyPages<M, Q>;
  /**
   * Build a *family* of lists on this store, one per key, for a resource that has to be fetched
   * separately per tenant, per parent record, or per page — keys you can't enumerate in advance.
   * Each list is built on first use and behaves exactly as a `collection()` does from then on.
   *
   * Name the fields that select a list and the fetch's params are typed from the schema, the same
   * way a model's `keys` type its statics:
   *
   * ```ts
   * class Surveys extends makeStore(SurveyModel) {
   *   byOrg = this.collectionMap(["orgId"], ({ orgId }, options) =>
   *     api.listSurveys({ orgId, ...options }),
   *   );
   * }
   *
   * surveys.byOrg({ orgId }).getOrLoad();
   * ```
   *
   * Reach for the free-form form below when the key isn't a field on the resource — a page number,
   * a filter of your own.
   */
  collectionMap<F extends ScalarField<StoreResource<MC>>>(
    keys: readonly [F, ...F[]],
    fetch: (
      params: Pick<StoreResource<MC>, F>,
      options: LazyFetchOptions,
    ) => Promise<StoreResource<MC>[]>,
    options?: CollectionOptions<M>,
  ): CollectionMap<Pick<StoreResource<MC>, F>, M>;
  /**
   * Keyed by something that isn't a field on the resource:
   *
   * ```ts
   * pages = this.collectionMap((page: number, options) =>
   *   api.listSurveys({ page, ...options }),
   * );
   * ```
   */
  collectionMap<K extends string | number>(
    fetch: (key: K, options: LazyFetchOptions) => Promise<StoreResource<MC>[]>,
    options?: CollectionOptions<M>,
  ): CollectionMap<K, M>;
  /** Keyed by a value a map can't hold as it stands, so `keyOf` says how to spell it. */
  collectionMap<K>(
    fetch: (key: K, options: LazyFetchOptions) => Promise<StoreResource<MC>[]>,
    options: CollectionMapOptions<K, M> & { keyOf: (key: K) => string | number },
  ): CollectionMap<K, M>;
} & (MC extends { get: (...args: infer A) => any } ? { get(...args: A): Promise<M> } : {}) &
  (Cfg extends { collections: infer C } ? { [N in keyof C]: LazyArray<M> } : {}) &
  // Each paged entry's query type is carried through from its own fetch, so a list a table drives
  // types `query` inside that fetch rather than falling back to `undefined`.
  (Cfg extends { pagedCollections: infer P }
    ? {
        [N in keyof P]: P[N] extends PagedCollectionSpec<any, any, infer Q>
          ? LazyPages<M, Q>
          : LazyPages<M>;
      }
    : {}) &
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
  config?: StoreConfig<any> & {
    collections?: Record<string, CollectionSpec<any, any>>;
    pagedCollections?: Record<string, PagedCollectionSpec<any, any>>;
  },
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
      lazy: LazyArray<any>;
      invalidateOn: readonly ModelEventType[];
      sort: Comparator<any> | undefined;
      optimisticCreate: boolean;
      discardOnInvalidate: boolean;
    }[] = [];

    constructor() {
      makeObservable<this, "_collections" | "unregister">(this, {
        _collections: false,
        unregister: false,
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

      for (const [name, spec] of Object.entries(config?.pagedCollections ?? {})) {
        if (name in this) {
          throw new Error(`Collection "${name}" would shadow a member the store already has.`);
        }
        const { fetch, ...options } = typeof spec === "function" ? { fetch: spec } : spec;
        (this as any)[name] = this.pagedCollection(fetch, options);
      }

      // Held weakly, so registering never keeps this store alive.
      Model.addListener?.(this);
    }

    /**
     * Build another list on this store: payloads become models, and the list joins this store's
     * mutation handling. Call it in a subclass field initializer.
     */
    collection(fetch: LazyFetch<R[]>, options?: CollectionOptions<any>): LazyArray<any> {
      const { invalidateOn, sort, optimisticCreate, discardOnInvalidate, ...lazyOptions } =
        options ?? {};
      // Omitted means "use the store's"; `false` means this one list keeps server order.
      const comparator = (sort === undefined ? config?.sort : sort) || undefined;
      const lazy = lazyArray(
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

    /**
     * Build an **accumulating** list on this store: one that grows a page at a time rather than
     * arriving whole. Payloads become models exactly as `collection()` does, and the list joins
     * this store's mutation handling identically — `invalidateCollections()` reaches it, a
     * `created` event marks it stale, a deletion drops the model from it.
     *
     * ```ts
     * class Surveys extends makeStore(SurveyModel) {
     *   feed = this.pagedCollection(({ cursor, limit, signal }) =>
     *     api.listSurveys({ cursor, limit, signal }),
     *   );
     * }
     * ```
     *
     * The fetch resolves a page rather than the list — a bare array, or an envelope carrying
     * `cursor` / `total` / `hasMore`. The envelope is unwrapped, its items become models, and it is
     * handed on intact, so the paging fields reach `lazyPages` and `total` is readable off the list.
     * That is the whole of what a store had to add: `collection()` maps `R[] -> M[]`, and this maps
     * the `items` inside whatever shape they arrived in.
     *
     * **Deduplication is on by default** for an identity-mapped model, keyed on `identityKey`.
     * That is not a nicety: a record served on two pages — a cursor over a non-unique sort key, an
     * offset while rows are being inserted — is *literally the same object* under identity, so it
     * would appear twice in one array. A table keys its rows by identity, so that means two rows
     * sharing a React key and one selection toggle hitting both. Pass your own `dedupeBy` to
     * override, or a model with no identity gets none (there is nothing to key on).
     *
     * An invalidation restarts the list at page one, which is what marking a *paged* list stale has
     * to mean: the membership and ordering of every page after the first depend on the first.
     *
     * See {@link PagedCollectionOptions} for why `sort` is not among the options.
     */
    pagedCollection(
      fetch: (request: LazyPageRequest<any>) => Promise<LazyPageResult<R>>,
      options?: PagedCollectionOptions<any, any>,
    ): LazyPages<any, any> {
      const { invalidateOn, optimisticCreate, discardOnInvalidate, dedupeBy, ...pagesOptions } =
        options ?? {};

      const list = lazyPages(
        async (request) => {
          const page = await fetch(request);
          if (Array.isArray(page)) return page.map((item) => buildModel(item));
          // Spread rather than rebuild: `lazyPages` treats the *presence* of `cursor` as
          // authoritative for `hasMore`, so a key that arrived has to survive the trip even when
          // its value is null.
          return { ...page, items: page.items.map((item) => buildModel(item)) };
        },
        {
          // deep: false — models are observable in their own right, so nothing needs converting.
          deep: false,
          // Identity is exactly the right key, and the failure it prevents is invisible otherwise.
          ...(Array.isArray(Model.keys) ? { dedupeBy: (m: any) => Model.identityKey(m) } : {}),
          ...pagesOptions,
          ...(dedupeBy ? { dedupeBy } : {}),
        },
      );

      this._collections.push({
        lazy: list,
        invalidateOn: invalidateOn ?? config?.invalidateOn ?? ["created"],
        // Never a comparator: see `PagedCollectionOptions`. A store-level `sort` stops here rather
        // than being applied to one page at a time — which also means `create()` prepends an
        // optimistic row instead of placing it.
        sort: undefined,
        optimisticCreate: optimisticCreate ?? config?.optimisticCreate ?? false,
        discardOnInvalidate: discardOnInvalidate ?? config?.discardOnInvalidate ?? false,
      });
      return list;
    }

    /**
     * Build a family of lists, one per key, each built on first use and registered exactly as a
     * `collection()` is — so every key's list joins this store's mutation handling, is marked
     * stale by `invalidateCollections()`, and drops a deleted model like any other list.
     *
     * The two forms differ only in how a key is spelled: declared fields serialize through the
     * same `serializeKey` the identity map uses, and a free-form key is used as-is unless `keyOf`
     * says otherwise.
     */
    collectionMap(
      keysOrFetch: readonly string[] | ((key: any, options: any) => Promise<R[]>),
      fetchOrOptions?: any,
      maybeOptions?: CollectionOptions<any>,
    ): any {
      const fields = Array.isArray(keysOrFetch) ? (keysOrFetch as readonly string[]) : undefined;
      const fetch = (fields ? fetchOrOptions : keysOrFetch) as (
        key: any,
        options: any,
      ) => Promise<R[]>;
      // `keyOf` is ours, not a lazy option — it must not travel on to `collection()`.
      const { keyOf, ...options } = ((fields ? maybeOptions : fetchOrOptions) ??
        {}) as CollectionMapOptions<any, any>;

      const serialize = fields
        ? (params: any) => serializeKey(fields.map((field) => params[field]))
        : (keyOf ?? ((key: any) => key as string | number));

      const byKey = new Map<string | number, LazyArray<any>>();

      const map = (key: any): LazyArray<any> => {
        const id = serialize(key);
        const existing = byKey.get(id);
        if (existing) return existing;
        // Only the declared fields reach the fetch, so selecting a list with a whole record is the
        // same call as selecting it with the fields alone — and whatever else the first caller
        // happened to pass can't leak into a list every later caller shares.
        const params = fields
          ? Object.fromEntries(fields.map((field) => [field, key[field]]))
          : key;
        const lazy = this.collection((fetchOptions) => fetch(params, fetchOptions), options);
        byKey.set(id, lazy);
        return lazy;
      };

      return Object.assign(map, {
        forget: (key: any): boolean => {
          const id = serialize(key);
          const lazy = byKey.get(id);
          if (!lazy) return false;
          this.unregister(lazy);
          return byKey.delete(id);
        },
        clear: (): void => {
          for (const lazy of byKey.values()) this.unregister(lazy);
          byKey.clear();
        },
      });
    }

    /**
     * Take a list back out of this store's mutation handling. Only a keyed collection is ever
     * dropped — a field collection lives as long as the store does, so there is nothing to
     * unregister and no public method for it.
     */
    private unregister(lazy: LazyArray<any>): void {
      const at = this._collections.findIndex((entry) => entry.lazy === lazy);
      if (at !== -1) this._collections.splice(at, 1);
    }

    /** Drop a model from every list on this store, without implying the record is gone. */
    remove(model: any): void {
      for (const { lazy } of this._collections) lazy.value?.remove(model);
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
        if (type === "deleted") lazy.value?.remove(model);
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

export type { LazyArray };
