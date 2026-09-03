/**
 * A value a set filter can hold.
 *
 * Primitives only, and deliberately so: the domain has to survive `JSON.stringify` for filter state
 * to be persistable, and it has to compare by value for a `Set` to dedupe it. Anything else a column
 * yields is stringified on the way in (see `facetValues`), and missing/empty values normalise to
 * `BLANK`.
 */
export type SetFilterValue = string | number | boolean;

/**
 * How multiple selections combine.
 *
 * | | matches a value that… | picking more |
 * | ------- | ------------------------------------- | ------------ |
 * | `"any"` | is any of the selections (the default) | widens |
 * | `"all"` | carries every selection | narrows |
 * | `"none"` | is none of the selections | narrows |
 *
 * `"all"` is only meaningful for array-valued data — on a scalar, two selections under it match
 * nothing — which is what {@link SetFilterOptions.multiValue} exists to signal. `"none"` has no
 * such restriction: excluding two statuses from a scalar column is an ordinary thing to want, so a
 * UI can offer any/none unconditionally and gate only `"all"`.
 *
 * `"any"` and `"none"` ask the same question and differ only in the answer they want, which is why
 * they share a branch in `matches` and why `intersecting` is simply `!== "any"`.
 */
export type SetMatchMode = "any" | "all" | "none";

/** How a text filter compares its query against a value. */
export type TextMatchMode = "contains" | "startsWith" | "equals";

/**
 * What kind of comparison a serialized condition describes. The built-ins cover `"in"` / `"notIn"` /
 * `"all"` (set), `"range"`, `"contains"` / `"startsWith"` / `"equals"` (text) and `"search"` (a
 * table's cross-column search). Open to arbitrary strings so a custom filter can name its own,
 * while the built-in ops still autocomplete.
 *
 * Negation is spelled as its own op rather than as a flag beside one. A `negate: boolean` on every
 * condition would give two ways to say the same thing — `{ op: "eq", negate: true }` alongside the
 * `"neq"` that already exists — and would put an orthogonal field on ops where it means nothing.
 */
export type FilterOp =
  | "in"
  | "notIn"
  | "all"
  | "range"
  | "contains"
  | "startsWith"
  | "equals"
  | "search"
  | NumberOp
  | (string & Record<never, never>);

/**
 * A filter's state as plain, JSON-safe data — what you send to a server that will do the filtering
 * for you.
 *
 * Deliberately neutral rather than any particular query language: it names *what* is being compared
 * and *how*, and the caller maps that onto whatever its endpoint speaks. A filter fills in `op` and
 * `value`; `field` is added by whoever knows the name the data goes by on the wire (for a table,
 * that is the column — see its `field` option).
 */
export interface FilterCondition {
  /** The name this data goes by on the server. Absent when the filter is not tied to one field. */
  field?: string;
  op: FilterOp;
  value: unknown;
}

/**
 * Whatever a UI needs to render a `SetFilter` that the filter itself has no use for — an option
 * label, an icon, a section heading.
 *
 * Empty by design, and **open for augmentation**: declare what your components need and it becomes
 * type-checked at every `new SetFilter({ props })` and every read of `filter.props`.
 *
 * ```ts
 * declare module "@jayalfredprufrock/mobx-toolbox/filter" {
 *   interface SetFilterProps {
 *     renderOption?: (value: SetFilterValue) => ReactNode;
 *   }
 * }
 * ```
 *
 * This is the escape hatch for anything view-shaped. The library only declares a named option of its
 * own when one of three things is true: it *reads* the value (`hideable` gates snapshot restore), it
 * supplies a non-trivial *default* (`filterable` is `!== false && filter !== undefined &&
 * !selection`), or the concept is universal and precisely typable (`multiValue`). A render function
 * is none of those — hence `props` rather than an option per view concern.
 */
export interface SetFilterProps {}

/** View props for a `NumberFilter`. Open for augmentation — see {@link SetFilterProps}. */
export interface NumberFilterProps {}

/** View props for a `DateFilter`. Open for augmentation — see {@link SetFilterProps}. */
export interface DateFilterProps {}

/** View props for a `TextFilter`. Open for augmentation — see {@link SetFilterProps}. */
export interface TextFilterProps {}

/**
 * View props for a `BucketFilter`. Extends {@link SetFilterProps}, so a popover that narrows by
 * `instanceof SetFilter` reads a bucket filter's props through the same shape.
 */
export interface BucketFilterProps extends SetFilterProps {}

/**
 * A reactive predicate over a single extracted value — the shape every filter in this module
 * satisfies.
 *
 * Note what is *not* here: `has` / `toggle` / `select` belong to a set filter alone, and a UI that
 * needs them narrows by `instanceof`. Keeping them off the interface is what stops it becoming a
 * bag of optional capabilities that every consumer has to sniff.
 */
export interface ValueFilter {
  /** Whether the filter is currently narrowing anything. An inactive filter matches everything. */
  readonly active: boolean;
  /** Whether one extracted value passes. Always `true` while `active` is false. */
  matches(value: unknown): boolean;
  /** Reset to the inactive state. */
  clear(): void;
  /**
   * This filter's state as JSON-serializable data — for persisting to storage or a URL, and
   * restoring later through {@link setValue}.
   *
   * A pair: a filter offering one without the other can be saved but never restored, or the
   * reverse. Whoever persists filters should skip a filter missing either.
   */
  readonly value?: unknown;
  /**
   * Restore state produced by {@link value}. Takes `unknown` on purpose — what comes back from
   * storage was written by some earlier version of your app, or typed by hand into a URL, so each
   * filter validates it and falls back to cleared rather than trusting the shape.
   */
  setValue?(value?: unknown): void;
  /**
   * Maps a raw value to the value this filter actually compares — grouping scores into grades,
   * dates into months, names into initials.
   *
   * `matches` applies it itself, so nothing else has to. It is on the interface because whoever
   * computes facets walks the data separately and has to project identically, or the list would
   * offer raw values that select nothing. Same reason `facetValues` is one exported function.
   */
  readonly project?: (value: unknown) => unknown;
  /**
   * Whether picking more narrows the result rather than widening it — whether the picks combine by
   * intersection rather than union.
   *
   * Facet counts normally leave this filter out of their own tally, because the usual question is
   * "how many rows carry this value", which is the right one while picking widens. When picking
   * narrows, that number promises rows the pick could never surface, so the count has to be taken
   * against the current selection as well.
   *
   * What the resulting number *means* is then the filter's business rather than the counter's, and
   * it differs by mode without the counting differing at all: for an intersecting pick it reads as
   * "tick this too and you get that many", and for an excluding one — a set filter in `"none"` mode
   * — the same tally is the rows currently admitted that carry the value, which is what ticking it
   * would remove. Both are the predictive number for their mode.
   *
   * A boolean rather than the filter's own mode, so the rule for deciding it stays with the filter
   * that has the modes; whoever computes facets never has to interpret them.
   *
   * Only affects counts, never which values are listed.
   */
  readonly intersecting?: boolean;
  /**
   * This filter's state as a {@link FilterCondition}, or `undefined` while inactive — for handing
   * the work to a server instead of evaluating it here.
   *
   * Optional: a filter that only ever runs in-process has nothing to serialize. But a table column
   * set to `filterMode: "server"` whose filter omits this contributes nothing to `filterQuery` and
   * is not applied client-side either, so it would silently do nothing.
   */
  readonly condition?: FilterCondition | undefined;
}

/**
 * One entry in a set filter's value domain.
 *
 * `count` is present only when counts were asked for (`counts: true`) — an absent count means
 * "not counted", never "zero".
 */
export interface Facet {
  value: SetFilterValue;
  count?: number;
  /**
   * Render hint: this entry stands for missing/empty values. Present so a view can show it
   * differently (italic "(Blank)", pinned last) without ever comparing against the `BLANK`
   * sentinel itself.
   */
  blank?: boolean;
}

export interface SetFilterOptions {
  /**
   * Seeds the value domain, in declaration order.
   *
   * Providing it is also a cost decision: a filter that already knows its domain does not need the
   * rows walked to discover one. See `ColumnModel.facets` for the three tiers.
   */
  options?: readonly SetFilterValue[];
  /**
   * Opt into cross-filtered facet counts. Off by default because it is the expensive tier —
   * O(rows x other active filters), recomputed whenever *any* filter is toggled.
   */
  counts?: boolean;
  /**
   * Declares that this filter's values are arrays, which is what makes `matchMode: "all"` mean
   * anything — so a UI should gate the "all" option on this. `"none"` needs no such gate: excluding
   * values from a scalar column is ordinary, so any/none can always be offered.
   *
   * Advisory in the way `sortable` and `filterable` are: nothing is gated by it, and
   * `setMatchMode("all")` still works without it. It exists so the decision lives next to the
   * column def instead of as a `column.key === "tags"` switch inside a filter popover.
   *
   * It does *not* change matching. `matches` flattens arrays either way — see `facetValues`.
   */
  multiValue?: boolean;
  /** Initial {@link SetMatchMode}. Defaults to `"any"`. */
  matchMode?: SetMatchMode;
  /** Initially selected values. */
  selected?: Iterable<SetFilterValue>;
  /** View props your components read; see {@link SetFilterProps}. */
  props?: SetFilterProps;
  /**
   * Group raw values before matching them — the score-into-grades case. The column keeps showing and
   * sorting the raw value; only the filter sees the projection, and the facet list becomes the
   * projected domain. See {@link ValueFilter.project}, or `BucketFilter` for numeric ranges.
   */
  project?: (value: unknown) => unknown;
}

/** JSON-serializable `SetFilter` state. An object rather than a bare array so `matchMode` rides along. */
export interface SetFilterState {
  selected: SetFilterValue[];
  matchMode: SetMatchMode;
}

/** How a bare number in a date column should be read. See {@link DateFilterOptions.unit}. */
export type DateUnit = "s" | "ms" | "auto";

/**
 * Anything `DateFilter` accepts as a bound or compares against: a `Date`, epoch seconds or
 * milliseconds, or a date string.
 */
export type DateLike = Date | number | string;

/**
 * Note the absence of `options` and `counts`: a date range has no discrete domain to enumerate and
 * no facet list to count, so a `counts: true` here is a type error rather than a runtime no-op.
 */
export interface DateFilterOptions {
  min?: DateLike;
  max?: DateLike;
  /**
   * How to read a bare number. `"auto"` (the default) decides on magnitude: below 1e11 is seconds,
   * at or above is milliseconds. That boundary is 1973 read as milliseconds and the year 5138 read
   * as seconds, so no plausible modern date is ambiguous — but pin it if your data is near the
   * epoch, or if guessing wrong would be worse than being explicit.
   */
  unit?: DateUnit;
  /** View props your components read; see {@link SetFilterProps}. */
  props?: DateFilterProps;
}

/** JSON-serializable `DateFilter` state. Bounds are always epoch **milliseconds**. */
export interface DateFilterState {
  min?: number;
  max?: number;
}

/** Operators comparing against a single number. */
export type UnaryNumberOp = "eq" | "neq" | "gt" | "lt" | "gte" | "lte";

/** Operators comparing against a pair of bounds. `"between"` is inclusive, the other is not. */
export type IntervalNumberOp = "between" | "betweenExclusive";

export type NumberOp = UnaryNumberOp | IntervalNumberOp;

/**
 * The bounds of an interval operator, each independently optional — `{ min: 60 }` is "60 and up".
 *
 * Optional on purpose rather than for tidiness: a two-input range control has to be able to hold one
 * bound while the other is still empty. Requiring both would mean clearing the second box wipes the
 * first, so every consumer would carry a draft copy in component state to work around it.
 *
 * Named bounds rather than a positional pair, matching {@link DateFilterState}: an absent bound is
 * simply an absent key, so nothing has to survive JSON as `null`, and a server reading the condition
 * gets `{ min, max }` instead of having to know which end of a tuple is which.
 */
export interface NumberBounds {
  min?: number;
  max?: number;
}

/**
 * The operand shape follows the operator, so a mismatch is a compile error rather than something
 * `active` has to reject at runtime.
 */
export type NumberFilterOptions =
  | { op?: UnaryNumberOp; operand?: number; props?: NumberFilterProps }
  | { op: IntervalNumberOp; operand?: NumberBounds; props?: NumberFilterProps };

/** JSON-serializable `NumberFilter` state. */
export type NumberFilterState =
  | { op: UnaryNumberOp; operand?: number }
  | { op: IntervalNumberOp; operand?: NumberBounds };

/**
 * One named range in a {@link BucketFilterOptions} list. Bounds are `[min, max)` — inclusive lower,
 * exclusive upper — so adjacent buckets sharing a number don't both claim it. Omit either for an
 * open end.
 */
export interface Bucket {
  label: SetFilterValue;
  min?: number;
  max?: number;
}

export interface BucketFilterOptions {
  /**
   * The buckets, in the order a filter UI should list them. The first whose range contains a value
   * wins, so overlapping buckets resolve by declaration order rather than being an error.
   */
  buckets: readonly Bucket[];
  counts?: boolean;
  matchMode?: SetMatchMode;
  selected?: Iterable<SetFilterValue>;
  /** View props your components read; see {@link SetFilterProps}. */
  props?: BucketFilterProps;
}

/** As with {@link NumberFilterOptions}, no `options`/`counts`: free text has no enumerable domain. */
export interface TextFilterOptions {
  /** Initial query text. */
  text?: string;
  /** How to compare. Defaults to `"contains"`. */
  match?: TextMatchMode;
  /** Defaults to `false`. */
  caseSensitive?: boolean;
  /** View props your components read; see {@link SetFilterProps}. */
  props?: TextFilterProps;
}
