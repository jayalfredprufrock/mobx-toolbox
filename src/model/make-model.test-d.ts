/**
 * Type-level tests for what a config function's signature becomes.
 *
 * The config slots are pass-through: the first parameter is enforced from `keys`, and everything
 * after it is yours — carried to the statics unchanged, and to the instance methods with the params
 * stripped, optionality included. That is what lets a generated api client be attached directly and
 * read back as the static. Nothing at runtime would notice if it stopped holding, so the file
 * passing `vp check` *is* the test.
 */
import * as T from "typebox";
import type { LazyFetchOptions } from "../lazy/lazy";
import { makeModel } from "./make-model";

const SurveySchema = T.Object({ id: T.String(), orgId: T.String(), title: T.String() });
type Survey = { id: string; orgId: string; title: string };
type Key = { id: string; orgId: string };

// --- a generated client, attached directly -----------------------------------

// The shape a generated client has: params, then its own options, optional. Attaching it is the
// whole point of the config being pass-through — its signature *is* the static's.
declare const getSurvey: (params: Key, init?: RequestInit) => Promise<Survey>;
declare const createSurvey: (body: { title: string }, init?: RequestInit) => Promise<Survey>;
declare const patchSurvey: (
  params: Key,
  body: { title: string },
  init?: RequestInit,
) => Promise<Survey>;

const Survey = makeModel(SurveySchema, {
  keys: ["id", "orgId"],
  get: getSurvey,
  create: createSurvey,
  update: patchSurvey,
});

declare const key: Key;

// the client's optional options stay optional, so a hand-written call reads clean
void Survey.get(key);
void Survey.reload(key);
void Survey.create({ title: "t" });

// and are still there when you want them — per-call options are your client's to define
void Survey.get(key, { cache: "no-store" });
void Survey.create({ title: "t" }, { cache: "no-store" });

// @ts-expect-error the first parameter is enforced from `keys`
void Survey.get({ id: "1" });

// @ts-expect-error and it is checked, not merely present
void Survey.get({ id: "1", orgId: 2 });

// --- instance methods, with the params stripped ------------------------------

declare const survey: InstanceType<typeof Survey>;

void survey.reload();
void survey.reload({ cache: "no-store" });
void survey.update({ title: "t" });
void survey.update({ title: "t" }, { cache: "no-store" });

// @ts-expect-error the params come off the record, so there is nothing to pass for them
void survey.reload(key);

// --- a wrapper arrow: the `?` is yours to write ------------------------------

// Contextual typing supplies the *type* of a parameter, never its optionality — so a wrapper that
// wants its bag omittable says so. This is the difference between the next two models.
const Optional = makeModel(SurveySchema, {
  keys: ["id", "orgId"],
  get: (params, options?: LazyFetchOptions) => getSurvey(params, options),
});

void Optional.get(key);
void Optional.get(key, { signal: new AbortController().signal });

const Required = makeModel(SurveySchema, {
  keys: ["id", "orgId"],
  get: (params, options: LazyFetchOptions) => getSurvey(params, options),
});

void Required.get(key, { signal: new AbortController().signal });

// @ts-expect-error declared required, so it stays required — the signature is passed through as is
void Required.get(key);

// --- a parameter that is not an options bag at all ---------------------------

// Anything after the params is arbitrary: the library neither interprets it nor fills it in.
const Expanded = makeModel(SurveySchema, {
  keys: ["id", "orgId"],
  get: (params, expand: string, init?: RequestInit) => getSurvey(params, init).then((s) => s),
});

void Expanded.get(key, "questions");
void Expanded.get(key, "questions", { cache: "no-store" });

// @ts-expect-error `expand` was declared required
void Expanded.get(key);

// --- keyless models ----------------------------------------------------------

const Settings = makeModel(T.Object({ theme: T.String() }), {
  keys: [],
  get: (options?: LazyFetchOptions) =>
    getSurvey({ id: "s", orgId: "o" }, options).then(() => ({ theme: "dark" })),
});

void Settings.get();
void Settings.get({ signal: new AbortController().signal });

// --- the first parameter carries only the declared keys -----------------------

// The params that identify a record are the params every call uses: the instance methods rebuild
// that argument from `buildParams()`, which knows only the keys. A fetcher taking more would be
// called by `reload()` — including the background refresh under `optimistic` — with the rest
// missing, so the config refuses it.

declare const wider: (
  params: { id: string; orgId: string; expand?: string },
  init?: RequestInit,
) => Promise<Survey>;

// @ts-expect-error `expand` is not a declared key
const WideGet = makeModel(SurveySchema, { keys: ["id", "orgId"], get: wider });
void WideGet;

// @ts-expect-error the same rule applies to `update`, whose params come from `buildParams()` too
const WideUpdate = makeModel(SurveySchema, {
  keys: ["id", "orgId"],
  update: (p: { id: string; orgId: string; expand?: string }, body: { title: string }) =>
    patchSurvey({ id: p.id, orgId: p.orgId }, body),
});
void WideUpdate;

// @ts-expect-error and to `delete`
const WideDelete = makeModel(SurveySchema, {
  keys: ["id", "orgId"],
  delete: (_p: { id: string; orgId: string; expand?: string }) => Promise.resolve(),
});
void WideDelete;

// @ts-expect-error and to an action
const WideAction = makeModel(SurveySchema, {
  keys: ["id", "orgId"],
  actions: { archive: (p: { id: string; orgId: string; reason?: string }) => getSurvey(p) },
});
void WideAction;

// a *narrower* first parameter is fine — the fetcher simply ignores a key it doesn't need
const Narrow = makeModel(SurveySchema, {
  keys: ["id", "orgId"],
  get: (p: { id: string }) => getSurvey({ id: p.id, orgId: "acme" }),
});
void Narrow.get(key);

// `create`'s body is not params, so it carries whatever it likes
const Created = makeModel(SurveySchema, {
  keys: ["id", "orgId"],
  create: (body: { title: string; notifyOwner?: boolean }) => createSurvey(body),
});
void Created.create({ title: "t", notifyOwner: true });

// keyless models have no keys to match, so the rule doesn't apply to them
const Detached = makeModel(SurveySchema, {
  keys: false,
  get: (p: { anything: string }, o?: LazyFetchOptions) =>
    getSurvey({ id: p.anything, orgId: "o" }, o),
});
void Detached;

// --- what the rule cannot see ------------------------------------------------

// `any` and an index signature say nothing about which fields exist, so neither is judged. These
// attach, and the divergence they risk is unguarded.
const LooseAny = makeModel(SurveySchema, {
  keys: ["id", "orgId"],
  get: (p: any) => getSurvey(p),
});
const LooseIndex = makeModel(SurveySchema, {
  keys: ["id", "orgId"],
  get: (p: Record<string, string>) => getSurvey({ id: p.id!, orgId: p.orgId! }),
});
void LooseAny;
void LooseIndex;

export {};
