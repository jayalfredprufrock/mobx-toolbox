/**
 * Type-level tests for `useModel`'s params.
 *
 * Typed params are half of why this hook exists — the other half being that they double as the
 * dependency list. If the params stop being checked against the model's `keys`, the hook degrades
 * to `useLazy` with extra steps and nothing at runtime would notice. The file passing `vp check`
 * *is* the test.
 */
import * as T from "typebox";
import { makeModel } from "./make-model";
import { useModel } from "./use-model";
import { useLazy } from "../lazy/use-lazy";
import type { LazyFetchOptions } from "../lazy/lazy";

const StudySchema = T.Object({ id: T.Number(), orgId: T.String(), title: T.String() });

const Study = makeModel(StudySchema, {
  keys: ["id", "orgId"],
  get: async (params: { id: number; orgId: string }) => ({ ...params, title: "x" }),
});

declare const id: number;
declare const orgId: string;

// the shape the model declared
useModel(Study, { id, orgId });

// @ts-expect-error `orgId` is part of the key, so it isn't optional
useModel(Study, { id });

// @ts-expect-error wrong type for a declared key
useModel(Study, { id: "1", orgId });

// @ts-expect-error params are required for a keyed model
useModel(Study);

// the instance comes back typed, through the `loaded` discriminant
const study = useModel(Study, { id, orgId });
if (study.loaded) {
  const title: string = study.value.title;
  void title;
  // @ts-expect-error not a field on the model
  void study.value.nope;
}

// --- keyless models take no params argument ----------------------------------

const Settings = T.Object({ theme: T.String() });

// a singleton: `keys: []`
const Singleton = makeModel(Settings, {
  keys: [],
  get: async (_o?: { signal: AbortSignal }) => ({ theme: "dark" }),
});

// no identity at all: `keys: false`
const Detached = makeModel(Settings, {
  keys: false,
  get: async (_o?: { signal: AbortSignal }) => ({ theme: "dark" }),
});

// no placeholder argument — this is the whole point
useModel(Singleton);
useModel(Detached);

// options still reachable, without an `undefined` in between
useModel(Singleton, { keepOnUnobserved: true });
useModel(Detached, { deep: false });

// @ts-expect-error a keyless model takes no params, so an object here is the options bag
// and `id` is not one of its keys
useModel(Singleton, { id: 1 });

// the instance still comes back typed
const settings = useModel(Singleton);
if (settings.loaded) {
  const theme: string = settings.value.theme;
  void theme;
}

// --- and a keyed model still requires them -----------------------------------

// @ts-expect-error params are not optional just because another model's are
useModel(Study);

// @ts-expect-error options are not accepted in the params slot
useModel(Study, { keepOnUnobserved: true });

useModel(Study, { id, orgId }, { keepOnUnobserved: true });

// --- a model with no `get` has nothing to fetch through ------------------------

const NoGet = makeModel(StudySchema, { keys: ["id"] });

// @ts-expect-error no `get` declared, so there are no params that could be passed
useModel(NoGet, { id });

// --- a `get` the hook cannot call --------------------------------------------

// The hook calls `get(params, fetchOptions)` and nothing else, so one bag has to satisfy
// everything after the params. Every other layer states this in its own fetch type; this one
// inherits the signature from the config, so it states it here.

declare const listStudy: (
  params: { id: number; orgId: string },
  expand: string,
  options?: RequestInit,
) => Promise<{ id: number; orgId: string; title: string }>;

const Expanded = makeModel(StudySchema, { keys: ["id", "orgId"], get: listStudy });

// @ts-expect-error `expand` sits between the params and the bag
useModel(Expanded, { id, orgId });

declare const listStudyLoose: (
  params: { id: number; orgId: string },
  expand?: string,
  options?: RequestInit,
) => Promise<{ id: number; orgId: string; title: string }>;

const Loose = makeModel(StudySchema, { keys: ["id", "orgId"], get: listStudyLoose });

// @ts-expect-error optional doesn't help — arguments go by position, so the bag would land in
// `expand` and no signal would reach the request at all
useModel(Loose, { id, orgId });

declare const needsMore: (
  params: { id: number; orgId: string },
  options: { signal: AbortSignal; expand: string },
) => Promise<{ id: number; orgId: string; title: string }>;

const NeedsMore = makeModel(StudySchema, { keys: ["id", "orgId"], get: needsMore });

// @ts-expect-error the bag alone cannot satisfy this options type
useModel(NeedsMore, { id, orgId });

// the escape hatch: write the call yourself, and every value it closes over is a dependency
declare const expand: string;
const expanded = useLazy((o) => Expanded.get({ id, orgId }, expand, o), [id, orgId, expand]);
if (expanded.loaded) {
  const title: string = expanded.value.title;
  void title;
}

// --- and the shapes the hook can drive ---------------------------------------

// nothing after the params: the extra argument is ignored, as in any JavaScript call
const Bare = makeModel(StudySchema, {
  keys: ["id", "orgId"],
  get: async (params: { id: number; orgId: string }) => ({ ...params, title: "x" }),
});
useModel(Bare, { id, orgId });

// a client's own options type, required or optional. The question is whether a bag can *satisfy*
// the parameter, not whether it is spelled `LazyFetchOptions` — so the partial shapes a client
// declares for itself are all fine. Requiredness is the fetcher's business and only constrains
// calls written by hand; the hook always has a bag to pass.
declare const attached: (
  params: { id: number; orgId: string },
  init: RequestInit,
) => Promise<{ id: number; orgId: string; title: string }>;
declare const partialBag: (
  params: { id: number; orgId: string },
  options?: Partial<LazyFetchOptions>,
) => Promise<{ id: number; orgId: string; title: string }>;
const Attached = makeModel(StudySchema, { keys: ["id", "orgId"], get: attached });
const PartialBag = makeModel(StudySchema, { keys: ["id", "orgId"], get: partialBag });
useModel(Attached, { id, orgId });
useModel(Attached, { id, orgId }, { keepOnUnobserved: true });
useModel(PartialBag, { id, orgId });

// an argument *past* the bag is fine when the hook's omitting it is legal
declare const trailingOptional: (
  params: { id: number; orgId: string },
  options: LazyFetchOptions,
  retries?: number,
) => Promise<{ id: number; orgId: string; title: string }>;
const TrailingOptional = makeModel(StudySchema, { keys: ["id", "orgId"], get: trailingOptional });
useModel(TrailingOptional, { id, orgId });

declare const trailingRequired: (
  params: { id: number; orgId: string },
  options: LazyFetchOptions,
  retries: number,
) => Promise<{ id: number; orgId: string; title: string }>;
const TrailingRequired = makeModel(StudySchema, { keys: ["id", "orgId"], get: trailingRequired });
// @ts-expect-error `retries` is required and the hook has nothing to pass for it
useModel(TrailingRequired, { id, orgId });

export {};
