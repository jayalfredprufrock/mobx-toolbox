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
 * How multiple selections combine. `"any"` (the default) matches a value that is any of the
 * selections; `"all"` requires every selection to be present, which is only meaningful for
 * array-valued data — on a scalar, two selections under `"all"` match nothing.
 */
export type SetMatchMode = "any" | "all";

/** How a text filter compares its query against a value. */
export type TextMatchMode = "contains" | "startsWith" | "equals";

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
}

/**
 * One entry in a set filter's value domain.
 *
 * `count` is present only when counts were asked for (`counts: true`) — an absent count means
 * "not counted", never "zero".
 */
export interface Facet {
  value: unknown;
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
   * anything — so a UI should only offer the any/all toggle when this is set.
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
}

/** JSON-serializable `SetFilter` state. An object rather than a bare array so `matchMode` rides along. */
export interface SetFilterState {
  selected: SetFilterValue[];
  matchMode: SetMatchMode;
}

/**
 * Note the absence of `options` and `counts`: a numeric range has no discrete domain to enumerate
 * and no facet list to count, so a `counts: true` here is a type error rather than a runtime no-op.
 */
export interface RangeFilterOptions {
  min?: number;
  max?: number;
}

/** JSON-serializable `RangeFilter` state. Bounds are always plain numbers — see `RangeFilter.matches`. */
export interface RangeFilterState {
  min?: number;
  max?: number;
}

/** As with {@link RangeFilterOptions}, no `options`/`counts`: free text has no enumerable domain. */
export interface TextFilterOptions {
  /** Initial query text. */
  text?: string;
  /** How to compare. Defaults to `"contains"`. */
  match?: TextMatchMode;
  /** Defaults to `false`. */
  caseSensitive?: boolean;
}
