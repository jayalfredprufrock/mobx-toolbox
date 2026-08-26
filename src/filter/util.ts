import type { SetFilterValue, TextMatchMode } from "./filter.types";

/**
 * The sentinel a missing or empty value normalises to.
 *
 * `""` is the right choice *because* it conflates empty-string with missing — that is the behaviour
 * a "(Blank)" checkbox is expected to have. A more distinctive sentinel would preserve a
 * distinction no filter UI has a way to express, and would stop the domain being JSON-safe.
 */
export const BLANK = "" as const;

// Values reaching here are primitives in practice; the cast is what lets the type-aware linter
// accept stringifying an `unknown`. Same idiom as `table/util.ts`.
const asString = (value: unknown): string => String(value as string);

/**
 * Whether a value counts as missing/empty: `null`, `undefined`, `""`, or an array that contributes
 * nothing once flattened (so a `tags: []` row is reachable through the "(Blank)" facet rather than
 * being unreachable).
 */
export const isBlank = (value: unknown): boolean => {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value)) {
    return (value as unknown[])
      .flat(Number.POSITIVE_INFINITY)
      .every((v) => v === null || v === undefined || v === "");
  }
  return false;
};

/**
 * The set of facet values one raw cell value contributes: arrays flattened, blanks dropped, and
 * `{ BLANK }` when nothing non-blank survives.
 *
 * This is the single definition of the blank rule, shared verbatim by `SetFilter.matches` and the
 * table's facet tally. If those two ever disagreed you would get a facet in the list that selects
 * no rows — which reads as a broken filter rather than as a normalisation bug, and is why this is
 * one exported function rather than a rule written twice.
 *
 * Non-primitives are stringified so the domain stays comparable by value and JSON-safe; see
 * {@link SetFilterValue}.
 */
export const facetValues = (value: unknown): Set<SetFilterValue> => {
  const out = new Set<SetFilterValue>();
  const raw: unknown[] = Array.isArray(value)
    ? (value as unknown[]).flat(Number.POSITIVE_INFINITY)
    : [value];

  for (const v of raw) {
    if (v === null || v === undefined || v === "") continue;
    out.add(
      typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : asString(v),
    );
  }

  if (out.size === 0) out.add(BLANK);
  return out;
};

/**
 * Compare a query against one value as text. An empty query matches everything, which is what makes
 * "no query typed" a pass-through rather than a special case at every call site.
 *
 * Nothing is trimmed: a trailing space is a legitimate part of a "contains" query, and trimming here
 * but not there is how the two drift apart.
 */
export const textMatches = (
  query: string,
  value: unknown,
  match: TextMatchMode = "contains",
  caseSensitive = false,
): boolean => {
  if (query === "") return true;

  let haystack = value === null || value === undefined ? "" : asString(value);
  let needle = query;
  if (!caseSensitive) {
    haystack = haystack.toLowerCase();
    needle = needle.toLowerCase();
  }

  if (match === "equals") return haystack === needle;
  if (match === "startsWith") return haystack.startsWith(needle);
  return haystack.includes(needle);
};
