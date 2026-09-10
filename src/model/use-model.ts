import { useLazy } from "../lazy/use-lazy";
import type { Lazy, LazyFetchOptions, LazyOptions } from "../lazy/lazy";
import type { AnyModelClass } from "./make-store";

/**
 * The params `Model.get` takes, read off the model itself — so a keyed model requires exactly the
 * fields it declared and a keyless one takes `undefined`, without any of that being restated here.
 *
 * A conditional rather than a constraint, matching how `makeStore` reads the same statics: the
 * generated `get` is generic over the class it is called on, which a plain structural constraint
 * fails to match. A model with no `get` resolves to `never`, so there is nothing that can be passed
 * for `params` and the call fails at the argument rather than the type parameter.
 */
type GetParams<MC> = MC extends { get: (params: infer P, ...rest: any[]) => any } ? P : never;

/**
 * Whether the model declared no key params, so `Model.get` takes none.
 *
 * Asked through `K[number]` rather than `K extends readonly []` for the reason `makeModel` documents
 * on its own `Keyless`: an inline `keys: []` infers as `never[]`, which is not assignable to
 * `readonly []` and would read as keyed. This is the same question `buildParams()` answers at
 * runtime, so the type and the call can't disagree about which argument is which.
 */
type Keyless<MC> = MC extends { keys: infer K }
  ? [K] extends [readonly any[]]
    ? [K[number]] extends [never]
      ? true
      : false
    : true
  : true;

/**
 * What `Model.get` takes after its params — the part of the fetcher's signature this hook has to
 * be able to satisfy on its own.
 */
type FetchArgs<MC> =
  Keyless<MC> extends true
    ? MC extends { get: (...args: infer A) => any }
      ? A
      : never
    : MC extends { get: (params: any, ...rest: infer R) => any }
      ? R
      : never;

/**
 * Whether the hook can drive this model's `get`.
 *
 * Every other layer that calls a fetch *declares* the shape it will call — `lazy` takes a
 * `LazyFetch`, `collection` the same, `collectionMap` a `(key, options)`, `pagedCollection` a
 * `(request)` — so a fetcher with an argument they can't fill is rejected where it is attached.
 * This hook is the one that inherits its fetcher's signature from the model config, which is
 * deliberately pass-through, so it has to state the same contract here instead.
 *
 * The contract is `get(keys, options?)`, or `get(options?)` with no keys, and the question asked of
 * that trailing parameter is whether a `LazyFetchOptions` can *satisfy* it — not whether it is
 * spelled one. That admits the partial shapes a client declares for itself: `RequestInit`,
 * `{ signal?: AbortSignal }`, an optional bag, a required one. It also admits a fetcher taking
 * nothing after its params, where the bag is ignored as in any JavaScript call, and one with an
 * untyped rest, where there is nothing to check.
 *
 * What it rejects is a parameter the bag cannot stand in for: `expand: string`, an options type
 * needing more than a signal, or a required argument past the bag. Optionality doesn't rescue any
 * of them, because arguments go by position — `(keys, expand?: string, o?)` would receive the bag
 * as its `expand`, and the request would get no signal at all.
 */
type HookFetchable<MC> =
  FetchArgs<MC> extends [] ? true : [LazyFetchOptions] extends FetchArgs<MC> ? true : false;

/**
 * Attached to the model argument so an unreachable fetcher fails here, at the hook, rather than by
 * sending the options bag to whatever argument happened to be in the way. Named as a sentence
 * against the repo's usual style on purpose: TypeScript prints the alias name and elides the
 * structure, so the name is the only part of this the reader will see.
 */
type UseLazyInstead_GetTakesMoreThanParamsAndFetchOptions = {
  readonly __useLazyInstead: never;
};

/**
 * Everything after the model. A keyless model has nothing to pass for params, so it takes options
 * directly rather than a placeholder ahead of them.
 */
type UseModelArgs<MC> =
  Keyless<MC> extends true
    ? [options?: LazyOptions]
    : [params: GetParams<MC>, options?: LazyOptions];

/**
 * Turn `params` into a dependency list. Sorted by key so a differently-ordered object of the same
 * values isn't read as a change, and keys are included alongside values so adding or removing one
 * counts.
 */
const paramsToDeps = (params: unknown): unknown[] => {
  if (params === undefined || params === null || typeof params !== "object") return [params];
  return Object.entries(params as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .flat();
};

/**
 * One record, loaded in a component — the detail-page counterpart to {@link useCollection}.
 *
 * ```tsx
 * const StudyPage = observer(({ studyId }: { studyId: string }) => {
 *   const study = useModel(StudyModel, { id: studyId });
 *
 *   return (
 *     <LazyObserver observe={study} placeholder={<Spinner />}>
 *       {(s) => <StudyDetail study={s} />}
 *     </LazyObserver>
 *   );
 * });
 * ```
 *
 * What comes back is an ordinary `lazy` over the model's own `get`, so it loads when
 * something observes it, honours whatever the model declared for `cache`, and hands back the
 * identity-mapped instance — an edit made anywhere else in the app shows up here.
 *
 * **The params are the dependencies.** There is no dependency array to keep in step with them, which
 * is the whole reason this exists rather than spelling it out with `useLazy`:
 *
 * ```tsx
 * useLazy((o) => StudyModel.get({ id, orgId }, o), [id]); // `orgId` forgotten — silently stale
 * useModel(StudyModel, { id, orgId }); // can't desync
 * ```
 *
 * They are compared shallowly, so rebuilding the object every render costs nothing. A change builds
 * a new lazy — the value starts empty and loads again, which is what you want for a record: showing
 * the study you navigated away from while the next one loads would be a lie.
 *
 * A model with no key params (`keys: []` or `keys: false`) takes no params argument at all —
 * `useModel(SettingsModel)`, and `useModel(SettingsModel, { keepOnUnobserved: true })` for options.
 */
export function useModel<MC extends AnyModelClass>(
  model: MC &
    (HookFetchable<MC> extends true
      ? unknown
      : UseLazyInstead_GetTakesMoreThanParamsAndFetchOptions),
  ...args: UseModelArgs<MC>
): Lazy<InstanceType<MC>> {
  // Which argument holds what depends on whether the model declared keys — the same question
  // `buildParams()` asks, so a keyless model's `get` is called with the fetch options first rather
  // than with a placeholder ahead of them.
  const keys = (model as { keys?: unknown }).keys;
  const keyed = Array.isArray(keys) && keys.length > 0;
  const params = keyed ? (args[0] as object) : undefined;
  const options = (keyed ? args[1] : args[0]) as LazyOptions | undefined;

  // `get` is generic over the class it is called on, so it can't be reached through a structural
  // type — the conditional above is what types the params, and this is what reaches the function.
  const get = (model as unknown as { get: (...a: any[]) => Promise<InstanceType<MC>> }).get.bind(
    model,
  );
  return useLazy<InstanceType<MC>>(
    (fetchOptions) => (params === undefined ? get(fetchOptions) : get(params, fetchOptions)),
    [model, ...paramsToDeps(params)],
    {
      // Models are observable in their own right, so nothing needs converting on the way in — the
      // same default `store.collection` uses. Harmless either way, since MobX leaves an already
      // observable value alone; this just skips the check.
      deep: false,
      ...options,
    },
  );
}
