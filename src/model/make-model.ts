import { action, makeObservable, observable, runInAction, toJS, type AnnotationsMap } from "mobx";
import { WeakRefMap } from "../util/weak-ref-map";
import * as T from "typebox";
import * as Value from "typebox/value";

// -----------------------------------------------------------------------------
// Public structural contract
// -----------------------------------------------------------------------------

/** What a model reports to its stores. Loads never emit — only mutations do. */
export type ModelEventType = "created" | "updated" | "deleted";

/**
 * The one thing a store exposes for a model to keep it in step. Stores register themselves with the
 * model class, held weakly, so a model needs no reference to any store — which is what lets several
 * stores over the same resource all stay consistent.
 */
export interface ModelListener {
  onModelEvent(type: ModelEventType, model: any): void;
}

/**
 * Root schema for a model: a single object (`makeModel`) or a discriminated
 * union of objects (`makeUnionModel`). Shared by both factories and by
 * `makeStore`, which accepts either.
 */
export type ModelSchema = T.TObject | T.TUnion<T.TObject[]>;

/**
 * Fold several values into one map key. A lone value is handed back as it stands, so a numeric id
 * stays a number; several are joined on `\u0000`, which no real id contains — so no two different
 * combinations can spell the same key.
 *
 * Shared by the identity map and by a store's keyed collections, which is the point: a record and
 * the params that select it serialize the same way.
 */
export const serializeKey = (values: readonly unknown[]): string | number =>
  values.length === 1 ? (values[0] as string | number) : values.map(String).join("\u0000");

/**
 * @internal When a record's fields were last replaced. Stamped by `setData`, so every path that
 * loads a record — `instantiate` from a list, `get`, `reload`, `update`, a custom action — refreshes
 * it through one choke point.
 *
 * A symbol so it never collides with a schema field and never reaches `toJSON`, and deliberately
 * *not* observable: it is metadata read imperatively by `get`, and making it observable would
 * re-render every consumer of a record on each load for nothing.
 */
export const LOADED_AT = Symbol("loadedAt");

/** The registry key a singleton (`keys: []`) maps to. Prefixed so no real id can collide with it. */
const SINGLETON_KEY = "\u0000singleton";

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

/**
 * What `keys` may hold: the schema fields that identify one record, or `false` to declare that this
 * model has no identity at all. `[]` is neither of those — a resource with no identifying fields is
 * a singleton, so it identity-maps to exactly one instance.
 */
export type KeySpec<S extends ModelSchema> = readonly (keyof Resource<S>)[] | false;

/**
 * Whether the model's methods take a leading params argument. True for both `keys: false` and
 * `keys: []`, which leave nothing to build params from.
 *
 * The empty-array case is asked through `K[number]` rather than `K extends readonly []` because an
 * inline `keys: []` infers as `never[]`, which is not assignable to `readonly []` and so would read
 * as keyed — leaving `buildParams()` typed `{}` and stripping the body argument off `update` and
 * every action. Via `K[number]`, `keys: []` and `keys: [] as const` are identical.
 */
type Keyless<K> = [K] extends [readonly any[]]
  ? [K[number]] extends [never]
    ? true
    : false
  : true;

/**
 * Whether the identity map is available. `keys: false` — and the config-less `makeModel(schema)`,
 * which resolves to the same `false` — drop `instantiate` and the rest of the registry statics off
 * the class type, so reaching for identity you never declared fails to compile rather than throwing.
 */
type HasIdentity<K> = [K] extends [false] ? false : true;

type KeyShape<S extends ModelSchema, K> =
  Keyless<K> extends true
    ? undefined
    : Pick<Resource<S>, K extends readonly any[] ? K[number] : never>;

type KeyedFn<S extends ModelSchema, K, R> =
  Keyless<K> extends true
    ? (...args: any[]) => Promise<R>
    : (params: KeyShape<S, K>, ...rest: any[]) => Promise<R>;

type KeyedBodyFn<S extends ModelSchema, K, R> =
  Keyless<K> extends true
    ? (body: any, ...rest: any[]) => Promise<R>
    : (params: KeyShape<S, K>, body: any, ...rest: any[]) => Promise<R>;

// Strip the first arg when keys is non-empty — model methods don't take the params.
type StripParams<K, F> =
  Keyless<K> extends true
    ? F
    : F extends (params: any, ...rest: infer R) => infer Ret
      ? (...args: R) => Ret
      : never;

// Replace a function's Promise return with Promise<R>.
type ReplaceReturn<F, R> = F extends (...args: infer A) => Promise<any>
  ? (...args: A) => Promise<R>
  : never;

type ReservedActionKey = "reload" | "update" | "delete" | "setData" | "toJSON";

type ActionsConfig<S extends ModelSchema, K> = {
  [name: string]: KeyedFn<S, K, Resource<S>>;
} & { [Key in ReservedActionKey]?: never };

/**
 * How long a loaded record stays usable without going back to the API. `false` (the default) always
 * fetches, `true` reuses a loaded record indefinitely, and `{ for: ms }` reuses one loaded within
 * that window.
 *
 * The identity map is the cache — there is no second store of records — so this is purely a policy
 * over what is already there. It only ever applies to a model that declared `keys`; without identity
 * there is nothing to reuse.
 */
export type CacheSpec = boolean | { for: number };

export interface ModelConfig<S extends ModelSchema, K> {
  /**
   * The schema fields that identify one record, or `false` for a model with no identity. `[]` marks
   * a singleton resource — one with no identifying fields, and so exactly one instance.
   */
  keys: K;
  /**
   * Fetch one record. Exposed as the static `Model.get(params)`, which returns the identity-mapped
   * instance, and used to derive the instance's `reload()` — so the endpoint is declared once.
   */
  get?: KeyedFn<S, K, Resource<S>>;
  /**
   * Whether `Model.get` may answer from the identity map instead of the API, and for how long.
   * Defaults to `false`.
   *
   * Only turn this on when this model's payload is the *same shape* wherever it is loaded from. A
   * list endpoint returning a projection and a detail endpoint returning the whole record are two
   * different models, not one cached model — see the note on `setData` being a full replace.
   *
   * `Model.reload()` ignores this and always goes to the API; `Model.peek()` reads the map without
   * one.
   */
  cache?: CacheSpec;
  /**
   * When `cache` has expired but the record is still in the identity map, hand back the record now
   * and refresh it in the background rather than making the caller wait. Defaults to `false`.
   *
   * The refreshed fields land on the same instance, so anything observing it re-renders when they
   * do. Only meaningful alongside `cache`: with nothing cached there is nothing to answer with.
   *
   * A background refresh that fails is logged and clears the record's load stamp, so the *next*
   * `get()` goes to the API and reports its failure through the normal path. Nothing new to catch.
   */
  optimistic?: boolean;
  /**
   * Create a record. Exposed as the static `Model.create(body)`.
   *
   * The body is deliberately unconstrained: its real type comes from whatever you attach or
   * annotate, and that flows through to `Model.create`. Defaulting it to a partial of the resource
   * looks more helpful but *rejects* any body sharing no field names with it — TypeScript's
   * weak-type rule — and a rejected slot makes the whole config fall back to its constraint,
   * silently removing every generated method.
   */
  create?: (body: any, ...rest: any[]) => Promise<Resource<S>>;
  update?: KeyedBodyFn<S, K, Resource<S>>;
  delete?: KeyedFn<S, K, any>;
  actions?: ActionsConfig<S, K>;
}

// Instance method shape from config. Self-mutating methods return Promise<any>;
// the instance is mutated in place via setData, so callers typically read fields
// off the same reference instead of chaining the return.
// `reload` is derived from `get`: refreshing an instance is the same endpoint as fetching one.
type ModelMethods<K, Cfg> = (Cfg extends { get: infer F }
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

type ModelInstance<S extends ModelSchema, K, Cfg> = Resource<S> & {
  setData(data: Resource<S>): void;
  toJSON(): Resource<S>;
  buildParams(): KeyShape<S, K>;
  getMobxAnnotations?(): AnnotationsMap<any, never>;
} & ModelMethods<K, Cfg>;

/**
 * Mutation fan-out, which every model class has whatever it declared for `keys` — a model with no
 * identity still creates, updates and deletes records, and stores still need to hear about it.
 */
export interface ModelEvents<I extends object> {
  /**
   * Start hearing about mutations to this resource. Held weakly, so registering never keeps a
   * listener alive — a store that goes out of scope is dropped on the next event. Called for you by
   * `makeStore`; only needed directly for something hand-rolled that has to stay in step.
   */
  addListener(listener: ModelListener): void;
  /** @internal Fan a mutation out to every live listener. */
  notifyListeners(type: ModelEventType, model: I): void;
}

/**
 * The identity-map statics. Present only on a model that declared identity — `keys: false`, and the
 * config-less `makeModel(schema)` that means the same thing, leave these off the class type.
 */
export interface ModelIdentity<S extends ModelSchema, K, I extends object> {
  readonly identityCache: WeakRefMap<string | number, I>;
  /**
   * The record for these params if it is already in the identity map, without ever fetching.
   * Synchronous, so it can answer during render.
   *
   * Presence, not freshness: a record `cache` would consider stale still comes back. Use it to
   * decide whether a fetch is needed at all, or to reach a record you know is loaded.
   */
  peek(params: KeyShape<S, K>): I | undefined;
  /** The registry key for a payload or model. Override on a subclass to scope identity. */
  identityKey(source: Resource<S> | I): string | number;
  /**
   * The one instance for this record — existing and updated, or newly created and registered.
   * Typed through the class it is called on, so a subclass's own members come through:
   * `Admin.instantiate(data)` is an `Admin`, not a base instance.
   */
  instantiate<This extends new (...args: any[]) => any>(
    this: This,
    data: Resource<S>,
  ): InstanceType<This>;
  /** Drop this record's entry so the next `instantiate` builds a fresh instance. */
  forget(source: Resource<S> | I): boolean;
  /** Forget every record. For teardown — a logout, or switching tenant. */
  clearIdentity(): void;
}

/**
 * Statics generated from the config slots that don't need an instance. Both are typed through the
 * class they are called on, exactly as `instantiate` is — a generated model class is always
 * subclassed, and a static that hardcoded the base instance would drop the subclass's own members:
 * `Admin.get(...)` is an `Admin`, not a base instance.
 */
type ModelStatics<Cfg> = (Cfg extends { get: (...args: infer A) => any }
  ? {
      /**
       * Fetch this record, or hand back the one in the identity map when `cache` allows — see the
       * `cache` and `optimistic` config.
       */
      get<This extends new (...args: any[]) => any>(
        this: This,
        ...args: A
      ): Promise<InstanceType<This>>;
      /**
       * Fetch this record from the API, whatever `cache` says, and apply it to the identity-mapped
       * instance. The static mirror of `instance.reload()`: same endpoint, params passed in rather
       * than read off a record you already hold.
       */
      reload<This extends new (...args: any[]) => any>(
        this: This,
        ...args: A
      ): Promise<InstanceType<This>>;
    }
  : {}) &
  (Cfg extends { create: (...args: infer A) => any }
    ? {
        create<This extends new (...args: any[]) => any>(
          this: This,
          ...args: A
        ): Promise<InstanceType<This>>;
      }
    : {});

export type ModelConstructor<S extends ModelSchema, K, Cfg> = {
  new (data: Resource<S>): ModelInstance<S, K, Cfg>;
  readonly schema: S;
  /** Exactly what was declared, so `Model.keys` reads back the tuple — or `false`. */
  readonly keys: K;
} & ModelEvents<ModelInstance<S, K, Cfg>> &
  (HasIdentity<K> extends true ? ModelIdentity<S, K, ModelInstance<S, K, Cfg>> : {}) &
  ModelStatics<Cfg>;

// -----------------------------------------------------------------------------
// Shared class builder
// -----------------------------------------------------------------------------

// Builds the observable model class used by both makeModel and makeUnionModel.
// Handles object and union schemas at runtime; the public factories layer the
// appropriate types (and, for unions, the `is`/`as` guards) on top.
function createModelClass(schema: ModelSchema, config?: ModelConfig<any, any>): any {
  // `keys: false` opts out of identity, and no config at all means the same thing. `keys: []` is a
  // different declaration: a resource with no identifying fields is a singleton, so it maps to one
  // instance under a fixed key rather than to none.
  const keySpec = (config?.keys ?? false) as readonly PropertyKey[] | false;
  const hasIdentity = Array.isArray(keySpec);
  const keys = (hasIdentity ? keySpec : []) as readonly PropertyKey[];
  const isSingleton = hasIdentity && keys.length === 0;
  const isUnion = T.IsUnion(schema);
  const propertyNames = getPropertyNames(schema);

  abstract class BaseModel {
    static readonly schema = schema;
    static readonly keys = keySpec;

    /**
     * Identity registry for this class. Created per class on first access — via an own property
     * rather than an inherited one — so a subclass never shares its parent's registry and can
     * never be handed a parent instance in its place.
     */
    static get identityCache(): WeakRefMap<string | number, any> {
      if (!Object.hasOwn(this, "_identityCache")) {
        Object.defineProperty(this, "_identityCache", {
          value: new WeakRefMap<string | number, any>(),
          configurable: true,
        });
      }
      return (this as any)._identityCache;
    }

    /**
     * The registry key for a payload or a model — both expose the schema's fields. Override on a
     * subclass to scope identity, e.g. to fold in a tenant id so ids from different tenants can't
     * collide.
     */
    static identityKey(source: any): string | number {
      if (!hasIdentity) {
        throw new Error(
          "This model has no identity — it was declared with `keys: false`, or with no config at all. Use `new Model(data)` for a detached instance, or declare `keys` to identity-map it.",
        );
      }
      // A singleton has no identifying fields to read, and only ever occupies this one entry.
      if (isSingleton) return SINGLETON_KEY;
      return serializeKey(keys.map((key) => source[key as keyof typeof source]));
    }

    /**
     * The one instance for this record: the existing one with `data` applied to it, or a new one
     * registered for next time. Use in place of `new Model(...)` so every part of the app that
     * loads the same record ends up holding the same object.
     */
    static instantiate(data: any): any {
      const key = this.identityKey(data);
      const existing = this.identityCache.get(key);
      if (existing) {
        existing.setData(data);
        return existing;
      }
      return this.identityCache.add(key, new (this as any)(data));
    }

    /**
     * The instance already registered for these params, or `undefined`. Never fetches, so it is
     * safe to call during render.
     */
    static peek(params?: any): any {
      return this.identityCache.get(this.identityKey(params));
    }

    /**
     * Drop a record's registry entry, so the next `instantiate` builds a fresh instance rather
     * than reviving this one. Called automatically by `delete()`.
     */
    static forget(source: any): boolean {
      return this.identityCache.delete(this.identityKey(source));
    }

    /** Forget every record. For teardown — a logout, or switching tenant. */
    static clearIdentity(): void {
      this.identityCache.clear();
    }

    /**
     * Listeners, held weakly and per class, exactly as `identityCache` is. Weak because the model
     * class outlives everything: a strong set would keep every store ever created alive, which for
     * a scoped store means leaking it and every model in its collections.
     */
    static get listeners(): Set<WeakRef<ModelListener>> {
      if (!Object.hasOwn(this, "_listeners")) {
        Object.defineProperty(this, "_listeners", {
          value: new Set<WeakRef<ModelListener>>(),
          configurable: true,
        });
      }
      return (this as any)._listeners;
    }

    static addListener(listener: ModelListener): void {
      this.listeners.add(new WeakRef(listener));
    }

    /** Fan a mutation out, pruning any listener that has since been collected. */
    static notifyListeners(type: ModelEventType, model: any): void {
      for (const ref of this.listeners) {
        const listener = ref.deref();
        if (listener) listener.onModelEvent(type, model);
        else this.listeners.delete(ref);
      }
    }

    constructor(data: any) {
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

      // The constructor populates fields directly rather than through `setData`, so it carries its
      // own stamp — a record built from a payload is loaded as of now, however it was built.
      // Non-enumerable so it never rides along in a spread of the instance.
      Object.defineProperty(this, LOADED_AT, {
        value: Date.now(),
        writable: true,
        configurable: true,
        enumerable: false,
      });

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
      // Refresh the stamp: every load of an *existing* record lands here, as the constructor does
      // for a new one.
      (this as any)[LOADED_AT] = Date.now();
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

  if (config?.get) {
    const get = config.get as (...args: any[]) => Promise<any>;
    const cache = config.cache ?? false;
    const optimistic = config.optimistic ?? false;
    // Cache is a policy over the identity map, so a model without one can never answer from it.
    const cacheable = hasIdentity && cache !== false;

    /**
     * Whether a record may be answered with as it stands. An absent stamp always means no — that is
     * how a failed background refresh forces the next `get` back to the API even under `cache: true`.
     */
    const isFresh = (model: any): boolean => {
      const loadedAt = model[LOADED_AT];
      if (loadedAt === undefined) return false;
      if (cache === true) return true;
      return Date.now() - loadedAt < (cache as { for: number }).for;
    };

    (BaseModel as any).reload = function (this: any, ...args: any[]) {
      // Without identity there is nothing to map through, and the opt-out was explicit — so hand
      // back a detached instance rather than throwing.
      return get(...args).then((data: any) =>
        hasIdentity ? this.instantiate(data) : new this(data),
      );
    };

    (BaseModel as any).get = function (this: any, ...args: any[]) {
      if (cacheable) {
        // A keyed model is called as `get(params, ...rest)`; a singleton has no params, so every
        // argument is rest. `identityKey` ignores its source for a singleton either way.
        const rest = keys.length === 0 ? args : args.slice(1);
        const existing = this.peek(args[0]);

        if (existing) {
          if (isFresh(existing)) return Promise.resolve(existing);

          if (optimistic) {
            // Answer now, refresh behind. A failure has nowhere to surface — this promise has
            // already resolved — so it clears the stamp instead, which sends the next `get` to the
            // API where the error can be reported normally.
            void existing.reload(...rest).catch((cause: unknown) => {
              console.error(cause);
              existing[LOADED_AT] = undefined;
            });
            return Promise.resolve(existing);
          }
        }
      }

      return this.reload(...args);
    };
  }

  if (config?.create) {
    const create = config.create as (...args: any[]) => Promise<any>;
    (BaseModel as any).create = function (this: any, ...args: any[]) {
      return create(...args).then((data: any) => {
        const model = hasIdentity ? this.instantiate(data) : new this(data);
        this.notifyListeners("created", model);
        return model;
      });
    };
  }

  // One endpoint declaration serves both: `Model.get(params)` and the instance's `reload()`.
  if (config?.get) {
    const reload = config.get as (...args: any[]) => Promise<any>;
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
      (this.constructor as typeof BaseModel).notifyListeners("updated", this);
      return this;
    };
  }

  if (config?.delete) {
    const del = config.delete as (...args: any[]) => Promise<any>;
    proto.delete = async function (...rest: any[]) {
      const params = this.buildParams();
      const result = params === undefined ? await del(...rest) : await del(params, ...rest);
      // Every store listening to this model drops it, and a later payload for its key must not
      // revive the instance.
      (this.constructor as typeof BaseModel).notifyListeners("deleted", this);
      if (hasIdentity) (this.constructor as typeof BaseModel).forget(this);
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
        (this.constructor as typeof BaseModel).notifyListeners("updated", this);
        return this;
      };
    }
  }

  return BaseModel;
}

// -----------------------------------------------------------------------------
// makeModel (single object schemas)
// -----------------------------------------------------------------------------

// No config means no identity, which is exactly what `keys: false` declares — so it resolves to the
// same `false` rather than being a rule of its own.
export function makeModel<S extends T.TObject>(schema: S): ModelConstructor<S, false, {}>;
export function makeModel<S extends T.TObject, K extends KeySpec<S>, Cfg extends ModelConfig<S, K>>(
  schema: S,
  config: Cfg & { keys: K },
): ModelConstructor<S, K, Cfg>;
export function makeModel<S extends T.TObject>(
  schema: S,
  config?: ModelConfig<S, KeySpec<S>>,
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
interface UnionModelMembers<S extends UnionSchema, D extends keyof Resource<S>, K> {
  setData(data: Resource<S>): void;
  toJSON(): Resource<S>;
  buildParams(): KeyShape<S, K>;
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
  K,
  Cfg,
> = SharedFields<S> & UnionModelMembers<S, D, K> & ModelMethods<K, Cfg>;

export type UnionModelConstructor<S extends UnionSchema, D extends keyof Resource<S>, K, Cfg> = {
  new (data: Resource<S>): UnionModelInstance<S, D, K, Cfg>;
  readonly schema: S;
  readonly discriminator: D;
  readonly keys: K;
} & ModelEvents<UnionModelInstance<S, D, K, Cfg>> &
  (HasIdentity<K> extends true ? ModelIdentity<S, K, UnionModelInstance<S, D, K, Cfg>> : {}) &
  ModelStatics<Cfg>;

export function makeUnionModel<S extends UnionSchema, D extends keyof Resource<S> & string>(
  schema: S,
  discriminator: D,
): UnionModelConstructor<S, D, false, {}>;
export function makeUnionModel<
  S extends UnionSchema,
  D extends keyof Resource<S> & string,
  K extends KeySpec<S>,
  Cfg extends ModelConfig<S, K>,
>(schema: S, discriminator: D, config: Cfg & { keys: K }): UnionModelConstructor<S, D, K, Cfg>;
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
export { WeakRefMap };
