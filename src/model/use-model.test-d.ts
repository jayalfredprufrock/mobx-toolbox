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

// --- a model with no `get` has nothing to fetch through ------------------------

const Detached = makeModel(StudySchema, { keys: ["id"] });

// @ts-expect-error no `get` declared, so there are no params that could be passed
useModel(Detached, { id });

export {};
