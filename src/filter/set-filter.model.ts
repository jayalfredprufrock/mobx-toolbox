import { action, computed, makeObservable, observable } from "mobx";
import type {
  FilterCondition,
  SetFilterOptions,
  SetFilterProps,
  SetFilterState,
  SetFilterValue,
  SetMatchMode,
  ValueFilter,
} from "./filter.types";
import { facetValues } from "./util";

/**
 * A filter over a discrete set of values — the checkbox-list filter.
 *
 * Nothing here knows what a row is. It is handed one already-extracted value and answers whether
 * that value passes, which is what lets the same instance sit on a table column, a sidebar rail, or
 * a plain `array.filter`.
 *
 * Blanks need no separate state: {@link BLANK} sits inside `selected` like any other value, so
 * `matches`, `has`, `toggle`, `select`, `value`, `active`, `selectedCount` and `clear` are all
 * unchanged by it, and "select all" needs no special case.
 */
export class SetFilter implements ValueFilter {
  /** The chosen values. Empty = inactive = everything passes. */
  selected = new Set<SetFilterValue>();

  /**
   * How selections combine — any of, all of, or none of. Observable because it is *state*, not
   * configuration: a UI can offer the toggle. See {@link SetMatchMode}; only `"all"` is restricted
   * to array-valued data.
   */
  matchMode: SetMatchMode = "any";

  /**
   * Whatever your components need to render this filter. Empty until you augment
   * {@link SetFilterProps} — the library never reads it.
   */
  readonly props: SetFilterProps;

  /** Declared value domain, in declaration order. See {@link SetFilterOptions.options}. */
  readonly options: readonly SetFilterValue[] | undefined;

  /**
   * Groups raw values before they are compared. See {@link SetFilterOptions.project} — and note
   * `matches` applies it itself, so callers pass raw values in.
   */
  readonly project: ((value: unknown) => unknown) | undefined;

  /** Whether facet counts were asked for. See {@link SetFilterOptions.counts}. */
  readonly counts: boolean;

  /**
   * Whether the values are arrays, and so whether a UI should offer `"all"` as a match mode.
   * `"none"` is not gated by it. Advisory only — see {@link SetFilterOptions.multiValue}.
   */
  readonly multiValue: boolean;

  get active(): boolean {
    return this.selected.size > 0;
  }

  /** How many values are selected — the number a filter chip shows. */
  get selectedCount(): number {
    return this.selected.size;
  }

  /** JSON-serializable state; round-trips through {@link setValue}. */
  get value(): SetFilterState {
    return { selected: [...this.selected], matchMode: this.matchMode };
  }

  /**
   * True in every mode but `"any"` — under `"all"` and `"none"` alike each additional pick narrows
   * the result instead of widening it, so facet counts have to be taken against the current
   * selection rather than ignoring it. See {@link ValueFilter.intersecting}.
   *
   * The count that produces reads differently in the two modes, and both readings are the useful
   * one. Under `"all"` it is "tick this too and you get that many rows". Under `"none"` the walk
   * counts rows this filter currently *admits* that carry the value — which is exactly the rows
   * ticking it would remove, so it reads as "excluding this drops that many". An already-excluded
   * value therefore tallies zero, which is true: excluding it again removes nothing. Zero-count
   * entries are kept in the facet list, so it can still be unticked.
   */
  get intersecting(): boolean {
    return this.matchMode !== "any";
  }

  /**
   * The selection as a server condition — `"in"`, `"all"` or `"notIn"`, following the match mode.
   * `undefined` while inactive.
   */
  get condition(): FilterCondition | undefined {
    if (this.selected.size === 0) return undefined;
    const op = this.matchMode === "all" ? "all" : this.matchMode === "none" ? "notIn" : "in";
    return { op, value: [...this.selected] };
  }

  constructor(options?: SetFilterOptions) {
    this.options = options?.options;
    this.project = options?.project;
    this.counts = options?.counts === true;
    this.multiValue = options?.multiValue === true;
    if (options?.matchMode) this.matchMode = options.matchMode;
    if (options?.selected) for (const v of options.selected) this.selected.add(v);

    this.props = options?.props ?? {};

    makeObservable(this, {
      selected: observable.shallow,
      matchMode: observable,

      active: computed,
      selectedCount: computed,
      value: computed,
      condition: computed,
      intersecting: computed,

      toggle: action.bound,
      select: action.bound,
      setMatchMode: action.bound,
      setValue: action.bound,
      clear: action.bound,
    });
  }

  matches(value: unknown): boolean {
    if (this.selected.size === 0) return true;

    const values = facetValues(this.project ? this.project(value) : value);
    if (this.matchMode === "all") {
      for (const s of this.selected) if (!values.has(s)) return false;
      return true;
    }
    // `"any"` and `"none"` ask the same question — is any selection present — and differ only in
    // the answer they want, so they share the walk rather than inverting one another's result.
    for (const v of values) if (this.selected.has(v)) return this.matchMode !== "none";
    return this.matchMode === "none";
  }

  has(value: SetFilterValue): boolean {
    return this.selected.has(value);
  }

  toggle(value: SetFilterValue): void {
    if (this.selected.has(value)) this.selected.delete(value);
    else this.selected.add(value);
  }

  /** Replace the whole selection. Passing nothing clears it. */
  select(values?: Iterable<SetFilterValue>): void {
    this.selected.clear();
    if (values) for (const v of values) this.selected.add(v);
  }

  setMatchMode(matchMode: SetMatchMode): void {
    this.matchMode = matchMode;
  }

  /**
   * Restore state from {@link value}. Anything that is not a recognisable set-filter snapshot —
   * a range filter's state left in storage under this key, a hand-edited URL — resets rather than
   * being trusted, and unusable entries within a valid one are dropped.
   */
  setValue(value?: unknown): void {
    const state = (value ?? {}) as Partial<SetFilterState>;
    const selected = Array.isArray(state.selected)
      ? state.selected.filter(
          (v): v is SetFilterValue =>
            typeof v === "string" || typeof v === "number" || typeof v === "boolean",
        )
      : undefined;
    this.select(selected);
    this.matchMode =
      state.matchMode === "all" || state.matchMode === "none" ? state.matchMode : "any";
  }

  /**
   * Clear the selection. `matchMode` is left alone — it is a mode the user chose, like a sort
   * direction, not part of what is being filtered.
   */
  clear(): void {
    this.selected.clear();
  }
}
