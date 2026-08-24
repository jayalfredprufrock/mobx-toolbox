import { useLazy } from "../lazy-observable/use-lazy";
import type { LazyObservable, LazyObservableOptions } from "../lazy-observable/lazy-observable";
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
 * What comes back is an ordinary `lazyObservable` over the model's own `get`, so it loads when
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
 * For a model with no key params (`keys: []` or `keys: false`), pass `undefined`.
 */
export function useModel<MC extends AnyModelClass>(
  model: MC,
  params: GetParams<MC>,
  options?: LazyObservableOptions,
): LazyObservable<InstanceType<MC>> {
  // `get` is generic over the class it is called on, so it can't be reached through a structural
  // type — the conditional above is what types the params, and this is what reaches the function.
  const get = (model as unknown as { get: (...args: any[]) => Promise<InstanceType<MC>> }).get.bind(
    model,
  );
  return useLazy<InstanceType<MC>>(
    // A keyless model's `get` takes the fetch options first — passing `undefined` ahead of them
    // would land in whatever its first parameter is. Same rule the instance's `reload` follows.
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
