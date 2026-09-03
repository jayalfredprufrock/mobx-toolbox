/**
 * Type-level tests for `useCollection` / `usePagedCollection` overload resolution.
 *
 * The two overloads of each — with and without `params` — are separated by `params?: never` on the
 * first. Without it, options carrying `params` *and* anything else (`{ params, pageSize }`,
 * `{ params, trackDependencies }`) resolved to neither overload: the no-params one is rejected only
 * by an excess-property check, which TypeScript stops applying once another key matches, so the
 * fetch's parameters got no contextual type and read as implicit `any`. Nothing at runtime noticed,
 * and the README's own example did not compile.
 *
 * The file passing `vp check` *is* the test: every fetch below leaves its parameters un-annotated,
 * so anything that breaks contextual typing fails under `noImplicitAny`.
 */
import * as T from "typebox";
import { makeModel } from "./make-model";
import { useCollection, usePagedCollection } from "./use-collection";
import type { LazyPageResult } from "../lazy/lazy";

const SurveySchema = T.Object({ id: T.Number(), orgId: T.String(), title: T.String() });
type SurveyPayload = T.Static<typeof SurveySchema>;
const Survey = makeModel(SurveySchema, { keys: ["id"] });

declare const listSurveys: (args: {
  orgId: string;
  q?: string;
  signal: AbortSignal;
}) => Promise<SurveyPayload[]>;

declare const pageSurveys: (args: {
  orgId: string;
  cursor: string | undefined;
  limit: number;
  signal: AbortSignal;
}) => Promise<LazyPageResult<SurveyPayload>>;

declare const orgId: string;
declare const q: string;

// -- useCollection -----------------------------------------------------------

// no params
useCollection(Survey, (options) => listSurveys({ orgId, ...options }));
useCollection(Survey, (options) => listSurveys({ orgId, ...options }), { deep: false });

// params alone
useCollection(Survey, ({ orgId }, options) => listSurveys({ orgId, ...options }), {
  params: { orgId },
});

// params *plus* another option — the combination that used to resolve to neither overload
useCollection(Survey, ({ orgId, q }, options) => listSurveys({ orgId, q, ...options }), {
  params: { orgId, q },
  trackDependencies: { throttle: 300 },
});

useCollection(Survey, ({ orgId }, options) => listSurveys({ orgId, ...options }), {
  params: { orgId },
  sort: (a, b) => a.title.localeCompare(b.title),
  invalidateOn: ["created", "updated"],
  keepOnUnobserved: { for: 10_000 },
});

// -- usePagedCollection ------------------------------------------------------

usePagedCollection(Survey, (request) => pageSurveys({ orgId, ...request }));
usePagedCollection(Survey, (request) => pageSurveys({ orgId, ...request }), { pageSize: 25 });

usePagedCollection(Survey, ({ orgId }, request) => pageSurveys({ orgId, ...request }), {
  params: { orgId },
});

usePagedCollection(Survey, ({ orgId }, request) => pageSurveys({ orgId, ...request }), {
  params: { orgId },
  pageSize: 25,
  dedupeBy: (survey) => survey.id,
  invalidateOn: ["created"],
});

// the query type flows into the fetch's `query` when it is named
interface Query {
  filters: string[];
  sorts: string[];
}
declare const search: (args: {
  where: string[];
  order: string[];
  cursor: string | undefined;
}) => Promise<LazyPageResult<SurveyPayload>>;

usePagedCollection<typeof Survey, Query>(Survey, ({ query, cursor }) =>
  search({ where: query.filters, order: query.sorts, cursor }),
);
