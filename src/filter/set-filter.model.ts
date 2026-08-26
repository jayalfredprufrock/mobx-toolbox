import { action, computed, makeObservable, observable } from "mobx";
import type {
  FilterCondition,
  SetFilterOptions,
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
   * How selections combine. Observable because it is *state*, not configuration — a UI can offer
   * the toggle. Only meaningful for array-valued data; see {@link SetMatchMode}.
   */
  matchMode: SetMatchMode = "any";

  /** Declared value domain, in declaration order. See {@link SetFilterOptions.options}. */
  readonly options: readonly SetFilterValue[] | undefined;

  /** Whether facet counts were asked for. See {@link SetFilterOptions.counts}. */
  readonly counts: boolean;

  /**
   * Whether the values are arrays, and so whether a UI should offer the any/all toggle. Advisory
   * only — see {@link SetFilterOptions.multiValue}.
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
   * True under `matchMode: "all"`, where each additional pick narrows the result instead of widening
   * it — so facet counts have to be taken against the current selection rather than ignoring it.
   * See {@link ValueFilter.intersecting}.
   */
  get intersecting(): boolean {
    return this.matchMode === "all";
  }

  /**
   * The selection as a server condition: `"in"` for the default match mode, `"all"` when every
   * selection must be present. `undefined` while inactive.
   */
  get condition(): FilterCondition | undefined {
    if (this.selected.size === 0) return undefined;
    return { op: this.matchMode === "all" ? "all" : "in", value: [...this.selected] };
  }

  constructor(options?: SetFilterOptions) {
    this.options = options?.options;
    this.counts = options?.counts === true;
    this.multiValue = options?.multiValue === true;
    if (options?.matchMode) this.matchMode = options.matchMode;
    if (options?.selected) for (const v of options.selected) this.selected.add(v);

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

    const values = facetValues(value);
    if (this.matchMode === "all") {
      for (const s of this.selected) if (!values.has(s)) return false;
      return true;
    }
    for (const v of values) if (this.selected.has(v)) return true;
    return false;
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

  setValue(value?: SetFilterState): void {
    this.select(value?.selected);
    this.matchMode = value?.matchMode ?? "any";
  }

  /**
   * Clear the selection. `matchMode` is left alone — it is a mode the user chose, like a sort
   * direction, not part of what is being filtered.
   */
  clear(): void {
    this.selected.clear();
  }
}
