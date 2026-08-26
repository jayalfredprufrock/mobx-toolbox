import { action, computed, makeObservable, observable } from "mobx";
import { textMatches } from "../filter/util";
import type { TableModel } from "./table.model";
import type { FilterCondition, FilterMode, RowData } from "./table.types";

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

  /** Who does the searching. See {@link TableConfig.search}. */
  get mode(): FilterMode {
    return this.table.config?.search?.mode ?? "client";
  }

  /**
   * Row predicate, or `undefined` when nothing is typed (the pass-through convention every filter
   * source here follows). A row passes when *any* searchable column matches — OR across columns,
   * unlike the AND across filters.
   */
  get predicate(): ((row: RowData) => boolean) | undefined {
    // server mode: the rows already arrived searched, so matching again here would be applying the
    // same query twice — and per-column `searchable` says nothing about what the server looked at
    if (this.text === "" || this.mode === "server") return undefined;
    const query = this.text;
    const columns = this.table.searchableColumns;
    if (columns.length === 0) return undefined;
    return (row) => columns.some((column) => textMatches(query, column.searchValue(row)));
  }

  /**
   * The query as a `{ op: "search" }` condition for {@link TableModel.filterQuery}, or `undefined`
   * unless the search is server-mode and non-empty. No `field`: it is not tied to one.
   */
  get condition(): FilterCondition | undefined {
    if (this.text === "" || this.mode !== "server") return undefined;
    return { op: "search", value: this.text };
  }

  constructor(table: TableModel) {
    this.table = table;

    makeObservable(this, {
      text: observable,

      active: computed,
      mode: computed,
      predicate: computed,
      condition: computed,

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
