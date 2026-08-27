import { action, computed, makeObservable, observable } from "mobx";
import type {
  FilterCondition,
  IntervalNumberOp,
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

const isPair = (v: unknown): v is [number, number] =>
  Array.isArray(v) &&
  v.length === 2 &&
  typeof v[0] === "number" &&
  Number.isFinite(v[0]) &&
  typeof v[1] === "number" &&
  Number.isFinite(v[1]);

/**
 * A numeric comparison: an operator plus its operand.
 *
 * The operand's shape follows the operator — a single number for `eq`/`neq`/`gt`/`lt`/`gte`/`lte`,
 * a `[low, high]` pair for the two `between` variants — and the types tie the two together, so a
 * mismatched pair is a compile error at the call site rather than something `active` has to reject.
 *
 * ```ts
 * new NumberFilter({ op: "gte", operand: 60 });
 * new NumberFilter({ op: "between", operand: [60, 80] });
 * ```
 *
 * For dates use `DateFilter`, which speaks `Date`s and ISO strings; for grouping numbers into named
 * ranges use `BucketFilter`.
 */
export class NumberFilter implements ValueFilter {
  op: NumberOp = "eq";

  /** A single number, or `[low, high]` for the interval ops. `undefined` = inactive. */
  operand: number | [number, number] | undefined;

  /**
   * Whether the operand actually fits the operator. Switching operator without switching operand
   * leaves the filter inactive rather than guessing — a `[60, 80]` pair means nothing to `gte`, and
   * silently taking the first element would filter by something the user never asked for. Use
   * {@link set} to change both at once.
   */
  get active(): boolean {
    if (this.operand === undefined) return false;
    return isIntervalOp(this.op) ? isPair(this.operand) : typeof this.operand === "number";
  }

  /** JSON-serializable state; round-trips through {@link setValue}. */
  get value(): NumberFilterState {
    return isIntervalOp(this.op)
      ? { op: this.op, operand: isPair(this.operand) ? [...this.operand] : undefined }
      : { op: this.op, operand: typeof this.operand === "number" ? this.operand : undefined };
  }

  get condition(): FilterCondition | undefined {
    if (!this.active) return undefined;
    return { op: this.op, value: this.value.operand };
  }

  constructor(options?: NumberFilterOptions) {
    if (options?.op) this.op = options.op;
    if (options?.operand !== undefined) {
      this.operand = Array.isArray(options.operand) ? [...options.operand] : options.operand;
    }

    makeObservable(this, {
      op: observable,
      operand: observable.ref,

      active: computed,
      value: computed,
      condition: computed,

      setOp: action.bound,
      setOperand: action.bound,
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
    if (isPair(operand)) {
      const [low, high] = operand;
      return this.op === "between" ? n >= low && n <= high : n > low && n < high;
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

  setOperand(operand: number | [number, number] | undefined): void {
    this.operand = Array.isArray(operand) ? [...operand] : operand;
  }

  /** Change operator and operand together, which is what an operator dropdown should do. */
  set(op: UnaryNumberOp, operand?: number): void;
  set(op: IntervalNumberOp, operand?: [number, number]): void;
  set(op: NumberOp, operand?: number | [number, number]): void {
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
      this.operand = isPair(state.operand) ? [...state.operand] : undefined;
    } else {
      this.operand = typeof state.operand === "number" ? state.operand : undefined;
    }
  }

  /** Clear the operand. The operator is left alone — it is a choice the user made. */
  clear(): void {
    this.operand = undefined;
  }
}
