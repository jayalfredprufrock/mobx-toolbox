import { action, computed, makeObservable, observable } from "mobx";
import type {
  FilterCondition,
  RangeFilterOptions,
  RangeFilterState,
  ValueFilter,
} from "./filter.types";

/**
 * Coerce a value to the number the bounds are compared against. `Date` goes through `getTime()`, so
 * a date column and a numeric column are the same code path — and so the *bounds themselves* stay
 * plain numbers, which is what lets state round-trip through JSON with no date-string handling.
 *
 * Numeric strings are accepted, because a column of `"42"` is a data shape, not a mistake.
 */
const toNumber = (value: unknown): number | undefined => {
  if (typeof value === "number") return Number.isNaN(value) ? undefined : value;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? undefined : t;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};

/**
 * An inclusive numeric range filter, either bound optional.
 *
 * Works over dates as well as numbers: values are coerced with `getTime()`, so `setRange` takes
 * epoch millis for a date column. That keeps the persisted state a pair of plain numbers.
 */
export class RangeFilter implements ValueFilter {
  min: number | undefined;
  max: number | undefined;

  get active(): boolean {
    return this.min !== undefined || this.max !== undefined;
  }

  /** JSON-serializable state; round-trips through {@link setValue}. Unset bounds are omitted. */
  get value(): RangeFilterState {
    const state: RangeFilterState = {};
    if (this.min !== undefined) state.min = this.min;
    if (this.max !== undefined) state.max = this.max;
    return state;
  }

  /**
   * The bounds as a server condition. `value` is the same `{ min?, max? }` pair `value` returns —
   * plain numbers, inclusive on both ends. `undefined` while inactive.
   */
  get condition(): FilterCondition | undefined {
    if (this.min === undefined && this.max === undefined) return undefined;
    return { op: "range", value: this.value };
  }

  constructor(options?: RangeFilterOptions) {
    this.min = options?.min;
    this.max = options?.max;

    makeObservable(this, {
      min: observable,
      max: observable,

      active: computed,
      value: computed,
      condition: computed,

      setMin: action.bound,
      setMax: action.bound,
      setRange: action.bound,
      setValue: action.bound,
      clear: action.bound,
    });
  }

  /**
   * Inclusive on both ends. A value that is not a number, a date, or a numeric string fails while
   * the filter is active — a blank cell is outside every bound, which is the answer a range control
   * implies.
   */
  matches(value: unknown): boolean {
    if (this.min === undefined && this.max === undefined) return true;

    const n = toNumber(value);
    if (n === undefined) return false;
    if (this.min !== undefined && n < this.min) return false;
    if (this.max !== undefined && n > this.max) return false;
    return true;
  }

  setMin(min: number | undefined): void {
    this.min = min;
  }

  setMax(max: number | undefined): void {
    this.max = max;
  }

  setRange(min: number | undefined, max: number | undefined): void {
    this.min = min;
    this.max = max;
  }

  setValue(value?: RangeFilterState): void {
    this.min = value?.min;
    this.max = value?.max;
  }

  clear(): void {
    this.min = undefined;
    this.max = undefined;
  }
}
