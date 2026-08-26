import { action, computed, makeObservable, observable } from "mobx";
import { textMatches } from "../filter/util";
import type { TableModel } from "./table.model";
import type { RowData } from "./table.types";

/**
 * The table's built-in cross-column text search.
 *
 * Table-owned rather than a `ColumnFilter`, and that is not an inconsistency: matching one query
 * against *many* columns needs every column's accessor at once, which is the one thing a
 * `matches(value)` predicate structurally cannot do. Everything else about it lines up — it
 * contributes to `table.predicate` exactly like a column filter, and counts toward
 * `activeFilterCount`.
 *
 * Which columns it reads is per-column config (`searchable`), including hidden ones — see
 * {@link BaseColumnDef.searchable}. Comparison goes through the same `textMatches` a `TextFilter`
 * uses, so a per-column "contains" and the search box agree.
 *
 * Debouncing is deliberately not here. Like `onStateChange`, the cadence belongs to whoever owns
 * the input: a client-side search over rows already in memory usually wants none at all.
 */
export class TableSearch {
  readonly table: TableModel;

  /** The query. Not trimmed — a trailing space is a legitimate part of a "contains" query. */
  text = "";

  get active(): boolean {
    return this.text !== "";
  }

  /**
   * Row predicate, or `undefined` when nothing is typed (the pass-through convention every filter
   * source here follows). A row passes when *any* searchable column matches — OR across columns,
   * unlike the AND across filters.
   */
  get predicate(): ((row: RowData) => boolean) | undefined {
    if (this.text === "") return undefined;
    const query = this.text;
    const columns = this.table.searchableColumns;
    if (columns.length === 0) return undefined;
    return (row) => columns.some((column) => textMatches(query, column.searchValue(row)));
  }

  constructor(table: TableModel) {
    this.table = table;

    makeObservable(this, {
      text: observable,

      active: computed,
      predicate: computed,

      setText: action.bound,
      clear: action.bound,
    });
  }

  setText(text: string): void {
    this.text = text;
  }

  /**
   * Clear the query. Note `TableModel.clearFilters()` does *not* call this — wiping text the user
   * typed as a side effect of "clear filters" is more surprising than leaving it.
   */
  clear(): void {
    this.text = "";
  }
}
