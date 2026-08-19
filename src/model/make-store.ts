import * as T from "typebox";
import {
  lazyObservableArray,
  type LazyFetch,
  type LazyObservableArray,
  type LazyObservableOptions,
} from "../lazy-observable/lazy-observable";
import { action, makeObservable, runInAction } from "mobx";
import type { ModelEventType, ModelSchema } from "./make-model";

// -----------------------------------------------------------------------------
// Type plumbing
// -----------------------------------------------------------------------------

// The structural shape passed as `this` inside `transform` — the only member
// transform ever needs is `remove`, since it's about to construct a model and
// hand the store reference along to its constructor.
type StoreThis<M> = {
  remove(model: M): void;
};

// Infer M from config: when transform is present use its return type, else use R.
type InferModel<R, Cfg> = Cfg extends { transform: (...args: any[]) => infer M } ? M : R;

/** Per-list options: everything a lazy observable takes, plus which mutations mark it stale. */
export interface CollectionOptions extends LazyObservableOptions {
  /**
   * Which mutations to this resource mark this list stale. Defaults to the store's `invalidateOn`,
   * itself `["created"]`. A deletion always removes the model from the list regardless.
   */
  invalidateOn?: readonly ModelEventType[];
}

export interface StoreConfig<R> {
  /**
   * Build a model from a payload. Defaults to the model class's identity map, so supply this only
   * to construct something else — a subclass, say.
   */
  transform?: (data: R) => any;
  /**
   * Fetch this store's list. Receives `{ signal }`, which aborts when the request is superseded — so
   * a client whose own first parameter is an options bag can be attached directly, and one that
   * takes query params can spread it: `(opts) => api.list({ status: "draft", ...opts })`.
   *
   * `get` and `create` live on the model class, not here.
   */
  list?: LazyFetch<R[]>;
  /**
   * Options for `list` — throttled dependency tracking, caching, polling. The same options
   * `collection()` takes, which is what `list` is built with.
   */
  listOptions?: LazyObservableOptions;
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

// Final store-instance shape. `get`/`create` are delegated from the model class, so their presence
// is keyed off the *class* rather than off an inferred config object. Each slot is declared as a
// method rather than a function-valued property, so a subclass can override it with a method —
// which TypeScript forbids when the base declares a property.
type StoreInstance<M, MC, Cfg> = {
  remove(model: M): void;
  onModelEvent(type: ModelEventType, model: M): void;
  /**
   * Build another list on this store. Payloads are transformed into models, the list joins this
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
    options?: CollectionOptions,
  ): LazyObservableArray<M>;
} & (MC extends { get: (...args: infer A) => any } ? { get(...args: A): Promise<M> } : {}) &
  (Cfg extends { list: any } ? { list: LazyObservableArray<M> } : {}) &
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
export function makeStore<
  MC extends AnyModelClass,
  Cfg extends StoreConfig<T.Static<MC["schema"]>>,
>(
  model: MC,
  // Typed from the model class, never from `Cfg`: referencing `Cfg` inside its own inference site
  // makes TypeScript fall back to the constraint, which collapses every conditional slot below.
  config: Cfg & ThisType<StoreThis<InstanceType<MC>>>,
): StoreConstructor<InferModel<InstanceType<MC>, Cfg>, MC, Cfg>;
export function makeStore(
  ModelClass: AnyModelClass,
  config?: StoreConfig<any>,
): StoreConstructor<any, any, any> {
  type R = any;

  class Store {
    private readonly _transform: (data: R) => any;

    /** Every list this store owns, with the events that mark each stale. */
    private readonly _collections: {
      lazy: LazyObservableArray<any>;
      invalidateOn: readonly ModelEventType[];
    }[] = [];

    list?: LazyObservableArray<any>;

    constructor() {
      const rawTransform = config?.transform;
      const Model = ModelClass as any;
      this._transform = rawTransform
        ? (data: R) => rawTransform.call(this, data)
        : // Route through the model's identity map when it has keys to do so with, so every list,
          // `get`, and `create` hands back the same instance for a record.
          (data: R) => (Model.keys?.length ? Model.instantiate(data) : new Model(data));

      makeObservable<this, "_transform" | "_collections">(this, {
        _transform: false,
        _collections: false,
        remove: action,
        onModelEvent: action,
      });

      // `list` is just the first collection — same code path as any added by a subclass.
      if (config?.list) {
        this.list = this.collection(config.list, config.listOptions);
      }

      // Held weakly, so registering never keeps this store alive.
      Model.addListener?.(this);
    }

    /**
     * Build another list on this store: payloads become models, and the list joins this store's
     * mutation handling. Call it in a subclass field initializer.
     */
    collection(fetch: LazyFetch<R[]>, options?: CollectionOptions): LazyObservableArray<any> {
      const { invalidateOn, ...lazyOptions } = options ?? {};
      const lazy = lazyObservableArray(
        async (fetchOptions) => {
          const items = await fetch(fetchOptions);
          return items.map((item) => this._transform(item));
        },
        // deep: false — models are observable in their own right, so nothing needs converting.
        { deep: false, ...lazyOptions },
      );
      this._collections.push({
        lazy,
        invalidateOn: invalidateOn ?? config?.invalidateOn ?? ["created"],
      });
      return lazy;
    }

    /** Drop a model from every list on this store, without implying the record is gone. */
    remove(model: any): void {
      for (const { lazy } of this._collections) lazy.value.remove(model);
    }

    /**
     * A mutation happened somewhere — this store, another store over the same resource, or the
     * model's own statics. A deletion always drops the model from this list; whether any event also
     * marks the list stale is up to `invalidateOn`.
     */
    onModelEvent(type: ModelEventType, model: any): void {
      for (const { lazy, invalidateOn } of this._collections) {
        // Removal is unconditional: the record is gone, and dropping it is always correct.
        if (type === "deleted") lazy.value.remove(model);
        if (invalidateOn.includes(type)) lazy.invalidate();
      }
    }
  }

  const proto = Store.prototype as any;

  const Model = ModelClass as any;

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
        // Prepend for immediate feedback; the `created` event has already marked this list stale, so
        // the server still gets the last word on position and membership. Identity means the refetch
        // reuses this instance, so the row moves rather than flickering.
        if (this.list && !this.list.value.includes(model)) this.list.value.unshift(model);
        return model;
      });
    };
  }

  return Store as unknown as StoreConstructor<any, any, any>;
}

export function createStore<MC extends AnyModelClass>(
  model: MC,
): StoreInstance<InstanceType<MC>, MC, {}>;
export function createStore<
  MC extends AnyModelClass,
  Cfg extends StoreConfig<T.Static<MC["schema"]>>,
>(
  model: MC,
  config: Cfg & ThisType<StoreThis<InstanceType<MC>>>,
): StoreInstance<InferModel<InstanceType<MC>, Cfg>, MC, Cfg>;

/** `makeStore` plus `new` — for the common case of one store per list. */
export function createStore(model: AnyModelClass, config?: StoreConfig<any>): any {
  return new (makeStore(model, config as any))();
}

export type { LazyObservableArray };
