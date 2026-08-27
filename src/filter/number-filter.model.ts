import { action, computed, makeObservable, observable } from "mobx";
import type {
  FilterCondition,
  IntervalNumberOp,
  NumberBounds,
  NumberFilterOptions,
  NumberFilterState,
  NumberOp,
  UnaryNumberOp,
  ValueFilter,
} from "./filter.types";

const INTERVAL_OPS = new Set<string>(["between", "betweenExclusive"]);

/** Whether an op takes a pair of bounds rather than a single number. */
export const isIntervalOp = (op: NumberOp): op is IntervalNumberOp => INTERVAL_OPS.has(op);

const toNumber = (value: unknown): number | undefined => {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};

const bound = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

// Absent keys rather than a fixed-length shape, so this accepts a partially filled control and a
// snapshot written by an older version alike. Both ends open is well-formed but inactive.
const toBounds = (v: unknown): NumberBounds | undefined => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const { min, max } = v as NumberBounds;
  const bounds: NumberBounds = {};
  if (bound(min) !== undefined) bounds.min = bound(min);
  if (bound(max) !== undefined) bounds.max = bound(max);
  return bounds;
};

/**
 * A numeric comparison: an operator plus its operand.
 *
 * The operand's shape follows the operator — a single number for `eq`/`neq`/`gt`/`lt`/`gte`/`lte`,
 * `{ min, max }` for the two `between` variants — and the types tie the two together, so a
 * mismatched pair is a compile error at the call site rather than something `active` has to reject.
 *
 * ```ts
 * new NumberFilter({ op: "gte", operand: 60 });
 * new NumberFilter({ op: "between", operand: { min: 60, max: 80 } });
 * new NumberFilter({ op: "between", operand: { min: 60 } }); // 60 and up
 * ```
 *
 * Interval bounds are **independently optional**, and `min` / `max` / `setMin` / `setMax` let a
 * two-input range control read and write them one at a time — the same shape `DateFilter` uses. That
 * is what keeps such a control stateless: clearing the upper box leaves the lower one alone, so there
 * is no draft copy in component state and nothing to go stale when something else calls
 * `clearFilters()`.
 *
 * ```tsx
 * <input value={filter.min ?? ""} onChange={(e) => filter.setMin(parse(e.target.value))} />
 * <input value={filter.max ?? ""} onChange={(e) => filter.setMax(parse(e.target.value))} />
 * ```
 *
 * For dates use `DateFilter`, which speaks `Date`s and ISO strings; for grouping numbers into named
 * ranges use `BucketFilter`.
 */
export class NumberFilter implements ValueFilter {
  op: NumberOp = "eq";

  /**
   * A single number, or `{ min, max }` for the interval ops — each bound independently optional, so
   * a range control can hold one while the other is still empty.
   */
  operand: number | NumberBounds | undefined;

  /**
   * Whether the operand actually fits the operator. Switching operator without switching operand
   * leaves the filter inactive rather than guessing — a `[60, 80]` pair means nothing to `gte`, and
   * silently taking the first element would filter by something the user never asked for. Use
   * {@link set} to change both at once.
   */
  get active(): boolean {
    const operand = this.operand;
    if (operand === undefined) return false;
    if (!isIntervalOp(this.op)) return typeof operand === "number";
    const bounds = toBounds(operand);
    return bounds !== undefined && (bounds.min !== undefined || bounds.max !== undefined);
  }

  /**
   * The lower bound, for an interval operator. `undefined` for the unary ones, where a UI renders
   * one input rather than two.
   *
   * Named to match `DateFilter`, and present so a range control can drive its inputs straight off
   * the filter — read `min`, write `setMin` — with no draft copy in component state, and therefore
   * nothing to go stale when something else calls `clearFilters()`.
   */
  get min(): number | undefined {
    return isIntervalOp(this.op) ? toBounds(this.operand)?.min : undefined;
  }

  /** The upper bound, for an interval operator. `undefined` for the unary ones. */
  get max(): number | undefined {
    return isIntervalOp(this.op) ? toBounds(this.operand)?.max : undefined;
  }

  /** JSON-serializable state; round-trips through {@link setValue}. */
  get value(): NumberFilterState {
    if (!isIntervalOp(this.op)) {
      return { op: this.op, operand: bound(this.operand) };
    }
    return { op: this.op, operand: this.active ? { ...toBounds(this.operand) } : undefined };
  }

  get condition(): FilterCondition | undefined {
    if (!this.active) return undefined;
    return { op: this.op, value: this.value.operand };
  }

  constructor(options?: NumberFilterOptions) {
    if (options?.op) this.op = options.op;
    if (options?.operand !== undefined) {
      this.operand = toBounds(options.operand) ?? options.operand;
    }

    makeObservable(this, {
      op: observable,
      operand: observable.ref,

      active: computed,
      value: computed,
      condition: computed,

      min: computed,
      max: computed,

      setOp: action.bound,
      setOperand: action.bound,
      setMin: action.bound,
      setMax: action.bound,
      setRange: action.bound,
      set: action.bound,
      setValue: action.bound,
      clear: action.bound,
    });
  }

  /**
   * Numeric strings are accepted, because a column of `"42"` is a data shape rather than a mistake.
   * Anything that isn't a number fails while the filter is active — a blank cell satisfies no
   * comparison, not even `neq`, which would otherwise quietly include every empty row.
   */
  matches(value: unknown): boolean {
    if (!this.active) return true;

    const n = toNumber(value);
    if (n === undefined) return false;

    const operand = this.operand;
    if (isIntervalOp(this.op)) {
      const bounds = toBounds(operand);
      if (!bounds) return true;
      // An open end is simply unbounded, so a half-filled range control means what it looks like it
      // means: only a lower bound reads as "and up".
      const { min, max } = bounds;
      const inclusive = this.op === "between";
      if (min !== undefined && (inclusive ? n < min : n <= min)) return false;
      if (max !== undefined && (inclusive ? n > max : n >= max)) return false;
      return true;
    }
    if (typeof operand !== "number") return true;

    switch (this.op as UnaryNumberOp) {
      case "eq":
        return n === operand;
      case "neq":
        return n !== operand;
      case "gt":
        return n > operand;
      case "lt":
        return n < operand;
      case "gte":
        return n >= operand;
      default:
        return n <= operand;
    }
  }

  /** Change the operator alone. May leave the filter inactive — see {@link active}. */
  setOp(op: NumberOp): void {
    this.op = op;
  }

  setOperand(operand: number | NumberBounds | undefined): void {
    this.operand = toBounds(operand) ?? operand;
  }

  /**
   * Set the lower bound alone, leaving the upper one where it is. A no-op under a unary operator,
   * where a UI renders one input rather than two.
   */
  setMin(min: number | undefined): void {
    if (!isIntervalOp(this.op)) return;
    this.setRange(min, this.max);
  }

  /** Set the upper bound alone, leaving the lower one where it is. */
  setMax(max: number | undefined): void {
    if (!isIntervalOp(this.op)) return;
    this.setRange(this.min, max);
  }

  /** Set both bounds at once. A no-op under a unary operator. Mirrors `DateFilter.setRange`. */
  setRange(min: number | undefined, max: number | undefined): void {
    if (!isIntervalOp(this.op)) return;
    const bounds: NumberBounds = {};
    if (bound(min) !== undefined) bounds.min = bound(min);
    if (bound(max) !== undefined) bounds.max = bound(max);
    this.operand = bounds;
  }

  /** Change operator and operand together, which is what an operator dropdown should do. */
  set(op: UnaryNumberOp, operand?: number): void;
  set(op: IntervalNumberOp, operand?: NumberBounds): void;
  set(op: NumberOp, operand?: number | NumberBounds): void {
    this.op = op;
    this.setOperand(operand);
  }

  /**
   * Restore state from {@link value}. An operand that doesn't fit the operator is dropped rather
   * than trusted, so a snapshot written when the operator was `between` leaves a `gte` inactive
   * instead of comparing against a pair.
   */
  setValue(value?: unknown): void {
    const state = (value ?? {}) as Partial<NumberFilterState>;
    const op = state.op;
    this.op = typeof op === "string" ? op : "eq";
    if (isIntervalOp(this.op)) {
      const bounds = toBounds(state.operand);
      this.operand =
        bounds && (bounds.min !== undefined || bounds.max !== undefined) ? bounds : undefined;
    } else {
      this.operand = bound(state.operand);
    }
  }

  /** Clear the operand. The operator is left alone — it is a choice the user made. */
  clear(): void {
    this.operand = undefined;
  }
}
