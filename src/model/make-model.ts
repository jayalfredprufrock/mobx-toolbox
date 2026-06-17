import { action, makeObservable, observable, runInAction, toJS, type AnnotationsMap } from "mobx";
import * as T from "typebox";
import * as Value from "typebox/value";

// -----------------------------------------------------------------------------
// Public structural contract
// -----------------------------------------------------------------------------

/** Minimal interface a model's host store must satisfy. */
export interface ModelStore<M> {
  remove?(model: M): void;
}

/**
 * Root schema for a model: a single object (`makeModel`) or a discriminated
 * union of objects (`makeUnionModel`). Shared by both factories and by
 * `makeStore`, which accepts either.
 */
export type ModelSchema = T.TObject | T.TUnion<T.TObject[]>;

/**
 * Every property name across the schema. For a union this is the merged set of
 * all variants' keys, so all of them are made observable up front — that keeps
 * `setData` reactive even when it switches the active variant. `toJSON` runs
 * `Value.Clean` to emit only the keys of the variant the data currently matches.
 */
function getPropertyNames(schema: ModelSchema): string[] {
  if (!T.IsUnion(schema)) return Object.keys(schema.properties);
  const names = new Set<string>();
  for (const variant of schema.anyOf) {
    for (const key of Object.keys((variant as T.TObject).properties)) names.add(key);
  }
  return [...names];
}

// -----------------------------------------------------------------------------
// Type plumbing
// -----------------------------------------------------------------------------

type Resource<S extends ModelSchema> = T.Static<S>;

type KeyShape<
  S extends ModelSchema,
  K extends readonly (keyof Resource<S>)[],
> = K extends readonly [] ? undefined : Pick<Resource<S>, K[number]>;

type KeyedFn<
  S extends ModelSchema,
  K extends readonly (keyof Resource<S>)[],
  R,
> = K extends readonly []
  ? (...args: any[]) => Promise<R>
  : (params: KeyShape<S, K>, ...rest: any[]) => Promise<R>;

type KeyedBodyFn<
  S extends ModelSchema,
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

type ActionsConfig<S extends ModelSchema, K extends readonly (keyof Resource<S>)[]> = {
  [name: string]: KeyedFn<S, K, Resource<S>>;
} & { [Key in ReservedActionKey]?: never };

export interface ModelConfig<S extends ModelSchema, K extends readonly (keyof Resource<S>)[]> {
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

type ModelInstance<S extends ModelSchema, K extends readonly any[], Cfg> = Resource<S> & {
  readonly store?: ModelStore<any>;
  setData(data: Resource<S>): void;
  toJSON(): Resource<S>;
  buildParams(): KeyShape<S, K extends readonly (keyof Resource<S>)[] ? K : readonly []>;
  getMobxAnnotations?(): AnnotationsMap<any, never>;
} & ModelMethods<K, Cfg>;

export type ModelConstructor<S extends ModelSchema, K extends readonly any[], Cfg> = {
  new (data: Resource<S>, store?: ModelStore<any>): ModelInstance<S, K, Cfg>;
  readonly schema: S;
};

// -----------------------------------------------------------------------------
// Shared class builder
// -----------------------------------------------------------------------------

// Builds the observable model class used by both makeModel and makeUnionModel.
// Handles object and union schemas at runtime; the public factories layer the
// appropriate types (and, for unions, the `is`/`as` guards) on top.
function createModelClass(schema: ModelSchema, config?: ModelConfig<any, any>): any {
  const keys = (config?.keys ?? []) as readonly PropertyKey[];
  const isUnion = T.IsUnion(schema);
  const propertyNames = getPropertyNames(schema);

  abstract class BaseModel {
    static readonly schema = schema;

    readonly store?: ModelStore<any>;

    constructor(data: any, store?: ModelStore<any>) {
      this.store = store;

      // Make every property of every variant observable up front, so `setData`
      // stays reactive even when it switches the active variant. Foreign-variant
      // fields sit as `undefined`; TypeScript hides them, and `toJSON` cleans them out.
      const annotations: Record<string, any> = {};
      for (const key of propertyNames) {
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

    /**
     * Replace the model's data with a complete resource. Every property is
     * reassigned (fields absent from `data` — e.g. another variant's — become
     * `undefined`), so the model always holds a coherent, whole variant rather
     * than a partial merge that could mix fields across the union.
     */
    setData(data: any): void {
      for (const key of propertyNames) {
        (this as any)[key] = (data as any)[key];
      }
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

    toJSON(): any {
      const data = this as any;
      const snapshot = propertyNames.reduce(
        (obj, key) => {
          if (data[key] !== undefined) obj[key] = toJS(data[key]);
          return obj;
        },
        {} as Record<string, any>,
      );
      // For a union, strip any fields not belonging to the variant the current
      // data matches (e.g. a stale field left over from a previous variant).
      return isUnion ? Value.Clean(schema, snapshot) : snapshot;
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

// -----------------------------------------------------------------------------
// makeModel (single object schemas)
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
  return createModelClass(schema, config);
}

// -----------------------------------------------------------------------------
// makeUnionModel (discriminated union schemas)
// -----------------------------------------------------------------------------

type UnionSchema = T.TUnion<T.TObject[]>;

// Properties common to every variant (`keyof` a union resolves to shared keys).
type SharedFields<S extends UnionSchema> = { [K in keyof Resource<S>]: Resource<S>[K] };

// The full static shape of the variant whose discriminator `D` equals `V`.
type VariantFields<S extends UnionSchema, D extends keyof Resource<S>, V> = Extract<
  Resource<S>,
  Record<D, V>
>;

// The members makeUnionModel adds. An interface (not a type-alias literal) so the
// polymorphic `this` in `is`/`as` is allowed; at a call site `this` resolves to
// the full instance, so the guard reveals the variant's fields on it.
interface UnionModelMembers<
  S extends UnionSchema,
  D extends keyof Resource<S>,
  K extends readonly any[],
> {
  readonly store?: ModelStore<any>;
  setData(data: Resource<S>): void;
  toJSON(): Resource<S>;
  buildParams(): KeyShape<S, K extends readonly (keyof Resource<S>)[] ? K : readonly []>;
  getMobxAnnotations?(): AnnotationsMap<any, never>;
  /** Type guard: true when the discriminator equals `value`, revealing that variant's fields on this same instance. */
  is<V extends Resource<S>[D]>(value: V): this is this & VariantFields<S, D, V>;
  /** This instance narrowed to the `value` variant (fields exposed directly), or `undefined` if it doesn't match. */
  as<V extends Resource<S>[D]>(value: V): (this & VariantFields<S, D, V>) | undefined;
}

// Base instance exposes only the shared fields (a single object type, so it can
// be subclassed). Variant-specific fields exist at runtime but are revealed on
// the type only through `is`/`as`.
type UnionModelInstance<
  S extends UnionSchema,
  D extends keyof Resource<S>,
  K extends readonly any[],
  Cfg,
> = SharedFields<S> & UnionModelMembers<S, D, K> & ModelMethods<K, Cfg>;

export type UnionModelConstructor<
  S extends UnionSchema,
  D extends keyof Resource<S>,
  K extends readonly any[],
  Cfg,
> = {
  new (data: Resource<S>, store?: ModelStore<any>): UnionModelInstance<S, D, K, Cfg>;
  readonly schema: S;
  readonly discriminator: D;
};

export function makeUnionModel<S extends UnionSchema, D extends keyof Resource<S> & string>(
  schema: S,
  discriminator: D,
): UnionModelConstructor<S, D, readonly [], {}>;
export function makeUnionModel<
  S extends UnionSchema,
  D extends keyof Resource<S> & string,
  K extends readonly (keyof Resource<S>)[],
  Cfg extends ModelConfig<S, K>,
>(schema: S, discriminator: D, config: Cfg): UnionModelConstructor<S, D, K, Cfg>;
export function makeUnionModel(
  schema: UnionSchema,
  discriminator: string,
  config?: ModelConfig<any, any>,
): any {
  const ModelClass = createModelClass(schema, config);
  ModelClass.discriminator = discriminator;

  const proto = ModelClass.prototype as any;
  proto.is = function (value: unknown): boolean {
    return (this as any)[discriminator] === value;
  };
  proto.as = function (value: unknown): unknown {
    return (this as any)[discriminator] === value ? this : undefined;
  };

  return ModelClass;
}

export type { AnnotationsMap };
