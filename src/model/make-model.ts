import { action, makeObservable, observable, runInAction, toJS, type AnnotationsMap } from "mobx";
import * as T from "typebox";

// -----------------------------------------------------------------------------
// Public structural contract
// -----------------------------------------------------------------------------

/** Minimal interface a model's host store must satisfy. */
export interface ModelStore<M> {
  remove?(model: M): void;
}

// -----------------------------------------------------------------------------
// Type plumbing
// -----------------------------------------------------------------------------

type Resource<S extends T.TObject> = T.Static<S>;

type KeyShape<S extends T.TObject, K extends readonly (keyof Resource<S>)[]> = K extends readonly []
  ? undefined
  : Pick<Resource<S>, K[number]>;

type KeyedFn<
  S extends T.TObject,
  K extends readonly (keyof Resource<S>)[],
  R,
> = K extends readonly []
  ? (...args: any[]) => Promise<R>
  : (params: KeyShape<S, K>, ...rest: any[]) => Promise<R>;

type KeyedBodyFn<
  S extends T.TObject,
  K extends readonly (keyof Resource<S>)[],
  R,
> = K extends readonly []
  ? (body: any, ...rest: any[]) => Promise<R>
  : (params: KeyShape<S, K>, body: any, ...rest: any[]) => Promise<R>;

// Strip the first arg when keys is non-empty — model methods don't take the params.
type StripParams<K extends readonly any[], F> = K extends readonly []
  ? F
  : F extends (params: any, ...rest: infer R) => infer Ret
    ? (...args: R) => Ret
    : never;

// Replace a function's Promise return with Promise<R>.
type ReplaceReturn<F, R> = F extends (...args: infer A) => Promise<any>
  ? (...args: A) => Promise<R>
  : never;

type ReservedActionKey = "reload" | "update" | "delete" | "setData" | "toJSON" | "store";

type ActionsConfig<S extends T.TObject, K extends readonly (keyof Resource<S>)[]> = {
  [name: string]: KeyedFn<S, K, Resource<S>>;
} & { [Key in ReservedActionKey]?: never };

export interface ModelConfig<S extends T.TObject, K extends readonly (keyof Resource<S>)[]> {
  keys: K;
  reload?: KeyedFn<S, K, Resource<S>>;
  update?: KeyedBodyFn<S, K, Resource<S>>;
  delete?: KeyedFn<S, K, any>;
  actions?: ActionsConfig<S, K>;
}

// Instance method shape from config. Self-mutating methods return Promise<any>;
// the instance is mutated in place via setData, so callers typically read fields
// off the same reference instead of chaining the return.
type ModelMethods<K extends readonly any[], Cfg> = (Cfg extends { reload: infer F }
  ? { reload: ReplaceReturn<StripParams<K, F>, any> }
  : {}) &
  (Cfg extends { update: infer F } ? { update: ReplaceReturn<StripParams<K, F>, any> } : {}) &
  (Cfg extends { delete: infer F } ? { delete: StripParams<K, F> } : {}) &
  (Cfg extends { actions: infer A }
    ? {
        [N in keyof A]: A[N] extends (...args: any[]) => any
          ? ReplaceReturn<StripParams<K, A[N]>, any>
          : never;
      }
    : {});

// -----------------------------------------------------------------------------
// Constructor type
// -----------------------------------------------------------------------------

type ModelInstance<S extends T.TObject, K extends readonly any[], Cfg> = Resource<S> & {
  readonly store?: ModelStore<any>;
  setData(data: Partial<Resource<S>>): void;
  toJSON(): Resource<S>;
  buildParams(): KeyShape<S, K extends readonly (keyof Resource<S>)[] ? K : readonly []>;
  getMobxAnnotations?(): AnnotationsMap<any, never>;
} & ModelMethods<K, Cfg>;

export type ModelConstructor<S extends T.TObject, K extends readonly any[], Cfg> = {
  new (data: Resource<S>, store?: ModelStore<any>): ModelInstance<S, K, Cfg>;
  readonly schema: S;
};

// -----------------------------------------------------------------------------
// makeModel
// -----------------------------------------------------------------------------

export function makeModel<S extends T.TObject>(schema: S): ModelConstructor<S, readonly [], {}>;
export function makeModel<
  S extends T.TObject,
  K extends readonly (keyof Resource<S>)[],
  Cfg extends ModelConfig<S, K>,
>(schema: S, config: Cfg): ModelConstructor<S, K, Cfg>;
export function makeModel<S extends T.TObject>(
  schema: S,
  config?: ModelConfig<S, readonly (keyof Resource<S>)[]>,
): any {
  const keys = (config?.keys ?? []) as readonly PropertyKey[];

  abstract class BaseModel {
    static readonly schema = schema;

    readonly store?: ModelStore<any>;

    constructor(data: Resource<S>, store?: ModelStore<any>) {
      this.store = store;

      const annotations: Record<string, any> = {};
      for (const key of Object.keys(schema.properties)) {
        Object.defineProperty(this, key, {
          value: (data as any)[key],
          enumerable: true,
          configurable: true,
          writable: true,
        });
        annotations[key] = observable.ref;
      }

      makeObservable(this, {
        ...annotations,
        setData: action,
        ...(this as any).getMobxAnnotations?.(),
      });
    }

    setData(data: Partial<Resource<S>>): void {
      Object.assign(this, data);
    }

    /**
     * Build the params object passed as the first arg to keyed API methods.
     * Default extracts each property in `keys` from the model. Override on a
     * subclass when the model field name differs from the API param name, or
     * to construct composite params from derived values.
     */
    buildParams(): any {
      if (keys.length === 0) return undefined;
      const data = this as any;
      return Object.fromEntries(keys.map((k) => [k, data[k]]));
    }

    toJSON(): Resource<S> {
      const data = this as any;
      return Object.keys(schema.properties).reduce(
        (obj, key) => {
          if (data[key] !== undefined) obj[key] = toJS(data[key]);
          return obj;
        },
        {} as Record<string, any>,
      ) as Resource<S>;
    }
  }

  const proto = BaseModel.prototype as any;

  if (config?.reload) {
    const reload = config.reload as (...args: any[]) => Promise<any>;
    proto.reload = async function (...rest: any[]) {
      const params = this.buildParams();
      const data = params === undefined ? await reload(...rest) : await reload(params, ...rest);
      runInAction(() => this.setData(data));
      return this;
    };
  }

  if (config?.update) {
    const update = config.update as (...args: any[]) => Promise<any>;
    proto.update = async function (body: any, ...rest: any[]) {
      const params = this.buildParams();
      const data =
        params === undefined ? await update(body, ...rest) : await update(params, body, ...rest);
      runInAction(() => this.setData(data));
      return this;
    };
  }

  if (config?.delete) {
    const del = config.delete as (...args: any[]) => Promise<any>;
    proto.delete = async function (...rest: any[]) {
      const params = this.buildParams();
      const result = params === undefined ? await del(...rest) : await del(params, ...rest);
      console.log("delete", this.store);
      this.store?.remove?.(this);
      return result;
    };
  }

  if (config?.actions) {
    for (const [name, fn] of Object.entries(config.actions)) {
      const call = fn as (...args: any[]) => Promise<any>;
      proto[name] = async function (body?: any, ...rest: any[]) {
        const params = this.buildParams();
        let data: any;
        if (params === undefined) {
          data = body === undefined ? await call() : await call(body, ...rest);
        } else {
          data = body === undefined ? await call(params) : await call(params, body, ...rest);
        }
        runInAction(() => this.setData(data));
        return this;
      };
    }
  }

  return BaseModel;
}

export type { AnnotationsMap };
