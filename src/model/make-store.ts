import { lazyObservableArray, type LazyObservableArray } from "../lazy-observable/lazy-observable";
import { action, makeObservable, runInAction } from "mobx";

// -----------------------------------------------------------------------------
// Type plumbing
// -----------------------------------------------------------------------------

// Replace a function's Promise return with Promise<R> — used so get/create
// return models rather than the raw API response.
type ReplaceReturn<F, R> = F extends (...args: infer A) => Promise<any>
  ? (...args: A) => Promise<R>
  : never;

// The structural shape passed as `this` inside `transform` — the only member
// transform ever needs is `remove`, since it's about to construct a model and
// hand the store reference along to its constructor.
type StoreThis<M> = {
  remove(model: M): void;
};

export interface StoreConfig<R, M> {
  transform: (data: R) => M;
  get?: (...args: any[]) => Promise<R>;
  getAll?: (...args: any[]) => Promise<R[]>;
  create?: (...args: any[]) => Promise<R>;
}

// Final store-instance shape, derived from config slots.
type StoreInstance<M, Cfg> = {
  remove(model: M): void;
} & (Cfg extends { get: infer G } ? { get: ReplaceReturn<G, M> } : {}) &
  (Cfg extends { getAll: any } ? { getAll: () => Promise<M[]>; all: LazyObservableArray<M> } : {}) &
  (Cfg extends { create: infer C } ? { create: ReplaceReturn<C, M> } : {});

export type StoreConstructor<M, Cfg> = {
  new (): StoreInstance<M, Cfg>;
};

// -----------------------------------------------------------------------------
// makeStore
// -----------------------------------------------------------------------------

export function makeStore<R, M, Cfg extends StoreConfig<R, M>>(
  config: Cfg & ThisType<StoreThis<M>>,
): StoreConstructor<M, Cfg> {
  class Store {
    // Bound `transform` so user-provided `this` keyword resolves to the store instance.
    private readonly _transform: (data: R) => M;

    all?: LazyObservableArray<M>;

    constructor() {
      this._transform = config.transform.bind(this as any);

      makeObservable<this, "_transform">(this, {
        _transform: false,
        remove: action,
      });

      if (config.getAll) {
        this.all = lazyObservableArray(async () => {
          const items = await (config.getAll as (...args: any[]) => Promise<R[]>)();
          return items.map((item) => this._transform(item));
        });
      }
    }

    remove(model: M): void {
      const value = this.all?.value;
      if (!value) return;
      const idx = value.indexOf(model);
      if (idx >= 0) value.splice(idx, 1);
    }
  }

  const proto = Store.prototype as any;

  if (config.get) {
    const get = config.get;
    proto.get = function (...args: any[]) {
      return get(...args).then((data: R) => this._transform(data));
    };
  }

  if (config.getAll) {
    proto.getAll = function () {
      return this.all.getOrLoad();
    };
  }

  if (config.create) {
    const create = config.create;
    proto.create = async function (...args: any[]) {
      const data = await create(...args);
      return runInAction(() => {
        const model = this._transform(data);
        if (this.all) this.all.value.unshift(model);
        return model;
      });
    };
  }

  return Store as unknown as StoreConstructor<M, Cfg>;
}

export type { LazyObservableArray };
