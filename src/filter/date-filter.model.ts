import { action, computed, makeObservable, observable } from "mobx";
import type {
  DateFilterOptions,
  DateFilterProps,
  DateFilterState,
  DateLike,
  DateUnit,
  FilterCondition,
  ValueFilter,
} from "./filter.types";

// Below this, a bare number reads as seconds; at or above, as milliseconds. The boundary is 1973 in
// milliseconds and the year 5138 in seconds, so nothing in between is a date anyone means.
const SECONDS_CEILING = 1e11;

/**
 * Coerce anything date-shaped to epoch milliseconds, or `undefined` when it isn't one.
 *
 * Three inputs, because a "date column" is any of them depending on where the data came from: a
 * hydrated `Date`, a JSON timestamp, or an ISO string straight off the wire. Making the filter
 * absorb the difference is what stops every consumer writing the same three-branch coercion.
 */
const toTime = (value: unknown, unit: DateUnit): number | undefined => {
  const fromNumber = (n: number): number | undefined => {
    if (!Number.isFinite(n)) return undefined;
    if (unit === "ms") return n;
    if (unit === "s") return n * 1000;
    return Math.abs(n) < SECONDS_CEILING ? n * 1000 : n;
  };

  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? undefined : t;
  }
  if (typeof value === "number") return fromNumber(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return undefined;
    // an all-digits string is a timestamp that went through JSON as text, not a date string
    if (/^[+-]?\d+$/.test(trimmed)) return fromNumber(Number(trimmed));
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
};

/**
 * An inclusive date range, either bound optional.
 *
 * Absorbs the three shapes a date column actually arrives in — `Date`, epoch number, ISO string —
 * on both sides: the cell values it compares and the bounds you hand it. So
 * `setRange("2020-01-01", new Date())` works over a column of unix timestamps.
 *
 * Bounds are stored as epoch **milliseconds**, which is what keeps `value` a pair of plain numbers
 * and the JSON round-trip free of date-string parsing.
 */
export class DateFilter implements ValueFilter {
  min: number | undefined;
  max: number | undefined;

  /**
   * Whatever your components need to render this filter. Empty until you augment
   * {@link DateFilterProps} — the library never reads it.
   */
  readonly props: DateFilterProps;

  /** How a bare number is read. See {@link DateFilterOptions.unit}. */
  readonly unit: DateUnit;

  get active(): boolean {
    return this.min !== undefined || this.max !== undefined;
  }

  /** JSON-serializable state; round-trips through {@link setValue}. Unset bounds are omitted. */
  get value(): DateFilterState {
    const state: DateFilterState = {};
    if (this.min !== undefined) state.min = this.min;
    if (this.max !== undefined) state.max = this.max;
    return state;
  }

  /** The bounds as a server condition, in epoch milliseconds. `undefined` while inactive. */
  get condition(): FilterCondition | undefined {
    if (!this.active) return undefined;
    return { op: "range", value: this.value };
  }

  /** The bounds as `Date` objects, for handing to a date picker. */
  get range(): { min?: Date; max?: Date } {
    const range: { min?: Date; max?: Date } = {};
    if (this.min !== undefined) range.min = new Date(this.min);
    if (this.max !== undefined) range.max = new Date(this.max);
    return range;
  }

  constructor(options?: DateFilterOptions) {
    this.unit = options?.unit ?? "auto";
    this.min = toTime(options?.min, this.unit);
    this.max = toTime(options?.max, this.unit);

    this.props = options?.props ?? {};

    makeObservable(this, {
      min: observable,
      max: observable,

      active: computed,
      value: computed,
      condition: computed,
      range: computed,

      setMin: action.bound,
      setMax: action.bound,
      setRange: action.bound,
      setValue: action.bound,
      clear: action.bound,
    });
  }

  /**
   * Inclusive on both ends. A value that isn't date-shaped fails while the filter is active — a
   * blank cell is outside every range, which is what a date picker implies.
   */
  matches(value: unknown): boolean {
    if (this.min === undefined && this.max === undefined) return true;

    const t = toTime(value, this.unit);
    if (t === undefined) return false;
    if (this.min !== undefined && t < this.min) return false;
    if (this.max !== undefined && t > this.max) return false;
    return true;
  }

  setMin(min: DateLike | undefined): void {
    this.min = toTime(min, this.unit);
  }

  setMax(max: DateLike | undefined): void {
    this.max = toTime(max, this.unit);
  }

  setRange(min: DateLike | undefined, max: DateLike | undefined): void {
    this.min = toTime(min, this.unit);
    this.max = toTime(max, this.unit);
  }

  /**
   * Restore state from {@link value}. Bounds are expected as epoch milliseconds, since that is what
   * `value` emits; anything non-numeric is dropped rather than trusted.
   */
  setValue(value?: unknown): void {
    const state = (value ?? {}) as Partial<DateFilterState>;
    const bound = (n: unknown): number | undefined =>
      typeof n === "number" && Number.isFinite(n) ? n : undefined;
    this.min = bound(state.min);
    this.max = bound(state.max);
  }

  clear(): void {
    this.min = undefined;
    this.max = undefined;
  }
}
