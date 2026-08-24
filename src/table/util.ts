import type { RowData, RowSource } from "./table.types";

export const titleCase = (str: string): string => {
  return str
    .trim()
    .replace(/([a-z])([A-Z]+)/g, "$1 $2")
    .split(/[-_\s]+/)
    .filter((s) => s.trim())
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
    .join(" ");
};

/**
 * Resolve a column key against a row: a direct property hit wins (so a literal "a.b" property
 * still works), otherwise the key is walked as a dot-path ("owner.name").
 */
export const getPath = (obj: unknown, path: string): unknown => {
  if (obj == null) return undefined;
  const direct = (obj as RowData)[path];
  if (direct !== undefined || !path.includes(".")) return direct;
  let current: unknown = obj;
  for (const segment of path.split(".")) {
    if (current == null) return undefined;
    current = (current as RowData)[segment];
  }
  return current;
};

// Values reaching the string fallback below are primitives in practice — numbers and Dates are
// already handled, and a column whose values are plain objects has no meaningful order anyway. The
// cast is what lets the type-aware linter accept stringifying an `unknown`.
const asString = (value: unknown): string => String(value as string);

/**
 * Default sort comparator over extracted cell values — nullish first, numbers numerically, Dates
 * chronologically, everything else by locale string.
 */
export const compareValues = (a: unknown, b: unknown): number => {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  return asString(a).localeCompare(asString(b));
};

/**
 * Whether `rows` was given as a {@link RowSource} rather than an array or a getter.
 *
 * Structural rather than an `instanceof`: the point of `RowSource` is that `table` never has to
 * know about `lazy-observable`, so the check is for the shape it needs — a `value` that may be an
 * array and a boolean `fetching`.
 */
export const isRowSource = <T>(rows: unknown): rows is RowSource<T> =>
  typeof rows === "object" &&
  rows !== null &&
  !Array.isArray(rows) &&
  "fetching" in rows &&
  "value" in rows;
