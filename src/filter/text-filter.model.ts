import { action, computed, makeObservable, observable } from "mobx";
import type {
  FilterCondition,
  TextFilterOptions,
  TextMatchMode,
  ValueFilter,
} from "./filter.types";
import { textMatches } from "./util";

/**
 * A single-value text filter — the "contains" box that lives on one column.
 *
 * Distinct from a table's cross-column search, which needs every column's accessor at once and so
 * cannot be a value predicate. Both go through `textMatches`, so they compare identically.
 *
 * `match` and `caseSensitive` are configuration rather than state: unlike a set filter's
 * `matchMode`, they are not things a UI typically hands to the user.
 */
export class TextFilter implements ValueFilter {
  text = "";

  readonly match: TextMatchMode;
  readonly caseSensitive: boolean;

  get active(): boolean {
    return this.text !== "";
  }

  /** JSON-serializable state; round-trips through {@link setValue}. */
  get value(): string {
    return this.text;
  }

  /**
   * The query as a server condition. The op is the configured `match`, so `"contains"` /
   * `"startsWith"` / `"equals"` carry across unchanged. `undefined` while inactive.
   *
   * `caseSensitive` is deliberately not serialized: it describes how *this* process compares, and
   * a server's collation is its own business.
   */
  get condition(): FilterCondition | undefined {
    if (this.text === "") return undefined;
    return { op: this.match, value: this.text };
  }

  constructor(options?: TextFilterOptions) {
    this.text = options?.text ?? "";
    this.match = options?.match ?? "contains";
    this.caseSensitive = options?.caseSensitive === true;

    makeObservable(this, {
      text: observable,

      active: computed,
      value: computed,
      condition: computed,

      setText: action.bound,
      setValue: action.bound,
      clear: action.bound,
    });
  }

  matches(value: unknown): boolean {
    return textMatches(this.text, value, this.match, this.caseSensitive);
  }

  setText(text: string): void {
    this.text = text;
  }

  setValue(value?: string): void {
    this.text = value ?? "";
  }

  clear(): void {
    this.text = "";
  }
}
