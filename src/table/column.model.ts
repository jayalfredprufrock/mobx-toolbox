import { action, computed, makeObservable, observable } from "mobx";
import type { Facet, SetFilterValue } from "../filter/filter.types";
// Two pure functions, imported from the module rather than the `../filter` barrel so no filter class
// is ever reachable from `src/table/index.ts`. `facetValues` in particular *must* be the same
// function `SetFilter.matches` uses, or the facet list would offer a value that selects no rows.
import { BLANK, facetValues } from "../filter/util";
import type { TableModel } from "./table.model";
import type {
  BaseColumnDef,
  ColumnConfig,
  ColumnDef,
  ColumnFilter,
  RowData,
  SortDirection,
} from "./table.types";
import { compareValues, getPath, titleCase } from "./util";

const DEFAULT_MIN_WIDTH = 120;

/** Key assigned to a selection column when its def doesn't supply one. */
export const SELECTION_COLUMN_KEY = "__selection__";

export class ColumnModel {
  readonly table: TableModel;
  readonly config: ColumnConfig;

  pinned: ColumnConfig["pinned"] = false;

  // Hidden columns are excluded from layout/rendering (see TableModel.orderedColumns).
  hidden = false;

  // Manual override (e.g. drag-to-resize). When set the column is treated as fixed at this width
  // in the distribution; normally unset.
  manualWidth: number | undefined = undefined;

  /** Resolved pixel width — distributed across the viewport by the table (see `columnWidths`). */
  get width(): number {
    return this.table.columnWidths.get(this) ?? 0;
  }

  /** Fixed pixel width when the column isn't flexible (manual override or an explicit number). */
  get fixedWidth(): number | undefined {
    if (this.manualWidth !== undefined) return this.manualWidth;
    return typeof this.config.width === "number" ? this.config.width : undefined;
  }

  /** Flex weight (the `N` in `"Nfr"`); `0` when fixed. An unspecified width means `1fr`. */
  get grow(): number {
    if (this.fixedWidth !== undefined) return 0;
    if (typeof this.config.width === "string") {
      const n = Number.parseFloat(this.config.width);
      return Number.isFinite(n) && n > 0 ? n : 1;
    }
    return 1;
  }

  get minWidth(): number {
    return this.config.minWidth ?? DEFAULT_MIN_WIDTH;
  }

  get maxWidth(): number {
    return this.config.maxWidth ?? Number.POSITIVE_INFINITY;
  }

  get resizable(): boolean {
    return this.config.resizable !== false;
  }

  /** Whether header UIs should offer sorting on this column (selection columns never do). */
  get sortable(): boolean {
    return this.config.sortable !== false && !this.selection;
  }

  /** Whether this is the built-in row-selection column. */
  get selection(): boolean {
    return this.config.selection === true;
  }

  /**
   * True for the innermost pinned column on its side (the one bordering the scrollable area).
   * Consumers hang the pinned boundary shadow off `[data-pinned-edge]` so a group of pinned
   * columns shows a single shadow at the seam.
   */
  get isPinnedEdge(): boolean {
    const siblings = this.pinnedSiblings;
    return siblings ? siblings[siblings.length - 1] === this : false;
  }

  /**
   * True for the outermost pinned column on its side (the one at the viewport edge). Used by the
   * header to round its outer corners so a pinned column doesn't paint a square over the rounded
   * header background. Both rendered pinned arrays are ordered outer-edge-first.
   */
  get isPinnedOuterEdge(): boolean {
    const siblings = this.pinnedSiblings;
    return siblings ? siblings[0] === this : false;
  }

  get offset(): number {
    const colsMap = {
      left: this.table.leftPinnedRenderedColumns,
      right: this.table.rightPinnedRenderedColumns,
      unpinned: this.table.unpinnedColumns,
    };

    const cols = colsMap[this.pinned || "unpinned"];
    return cols.slice(0, cols.indexOf(this)).reduce((sum, c) => sum + c.width, 0);
  }

  get title(): string {
    return this.config.title ?? titleCase(this.config.key);
  }

  /** 1-based visual column position (pinned blocks at the edges) — the aria-colindex value. */
  get ariaColIndex(): number {
    return this.table.visualColumns.indexOf(this) + 1;
  }

  get key(): string {
    return this.config.key;
  }

  /** Active sort direction for this column, or undefined when it doesn't participate in the sort. */
  get sortDirection(): SortDirection | undefined {
    return this.table.sorts.find((s) => s.key === this.key)?.direction;
  }

  /** 1-based position in the sort priority (the "1"/"2" badge in multi-sort UIs); undefined when unsorted. */
  get sortIndex(): number | undefined {
    const index = this.table.sorts.findIndex((s) => s.key === this.key);
    return index >= 0 ? index + 1 : undefined;
  }

  /** The filter attached to this column's def, if any. See {@link BaseColumnDef.filter}. */
  get filter(): ColumnFilter | undefined {
    return this.config.filter;
  }

  /**
   * Whether header UIs should offer a filter control. Advisory exactly like `sortable`: the model is
   * never gated, so a `filterable: false` column with an active filter still narrows rows.
   */
  get filterable(): boolean {
    return this.config.filterable !== false && this.config.filter !== undefined && !this.selection;
  }

  /**
   * How a filter UI should label one facet value, if the def says. Callers apply the default
   * themselves: `column.filterOption?.(v) ?? String(v)` — a view often wants its own fallback, and
   * a blank facet is labelled off `facet.blank` rather than off the value.
   */
  get filterOption(): ((value: unknown) => any) | undefined {
    return this.config.filterOption;
  }

  /** Whether the built-in search reads this column. See {@link BaseColumnDef.searchable}. */
  get searchable(): boolean {
    return this.config.searchable !== false && !this.selection;
  }

  /**
   * The value this column's filter compares against — its own `facets` domain, in other words.
   *
   * `[]` when no filter is attached: a distinct-values API for every column would be a different
   * (and much more expensive) feature, and nothing here should be mistaken for one.
   *
   * Three cost tiers, chosen by the filter rather than configured here:
   *
   * | tier | when | walk |
   * | --- | --- | --- |
   * | static | `options` declared, `counts` falsy | none |
   * | values | the default | `rows`, invalidated by `rows` alone |
   * | counted | `counts: true` | `rows` narrowed by every *other* active filter |
   *
   * The walk itself is not what costs — running every other filter per row is, plus the
   * invalidation storm where one toggle dirties every other column's facets. That is what `counts`
   * gates, and why the default tier still populates a checkbox list.
   *
   * Ordering is declared `options` first in declaration order, then discovered values sorted by
   * value, blank last. Insertion order alone would be first-appearance-in-rows, which reshuffles
   * the list every time the table is sorted.
   *
   * Zero-count entries are kept: a popover is exactly where you go to undo an over-narrowed filter.
   * A standing facet rail drops them at the call site —
   * `facets.filter((f) => f.count > 0 || filter.has(f.value))`.
   */
  get facets(): Facet[] {
    const filter = this.config.filter;
    if (!filter) return [];

    const counts = filter.counts === true;
    const tally = this.facetScan;
    const declared = filter.options;

    // static tier: the domain was declared and no counts were asked for, so the rows are never read
    if (!tally) return (declared ?? []).map((value) => ({ value }));

    const facets: Facet[] = [];
    const seen = new Set<SetFilterValue>();

    for (const value of declared ?? []) {
      const key = value as SetFilterValue;
      seen.add(key);
      facets.push(counts ? { value, count: tally.get(key) ?? 0 } : { value });
    }

    const discovered = [...tally.keys()]
      .filter((value) => value !== BLANK && !seen.has(value))
      .sort(compareValues);
    for (const value of discovered) {
      facets.push(counts ? { value, count: tally.get(value) ?? 0 } : { value });
    }

    // blank is offered only where the walk actually found one, so the static tier never shows it
    const blanks = tally.get(BLANK);
    if (blanks !== undefined) {
      facets.push(
        counts ? { value: BLANK, blank: true, count: blanks } : { value: BLANK, blank: true },
      );
    }

    return facets;
  }

  // The one pass over the rows behind `facets`. `undefined` marks the static tier — a declared
  // domain with no counts asked for, where there is nothing to discover.
  private get facetScan(): Map<SetFilterValue, number> | undefined {
    const filter = this.config.filter;
    if (!filter) return undefined;
    if (filter.options && !filter.counts) return undefined;

    // The cross-filter deliberately keeps the *other* filters, the search and every page-level
    // `FilterSource`: a row those already exclude must not be counted, or the tally would promise
    // rows that selecting the value could never surface.
    const cross = filter.counts === true ? this.table.predicateExcluding(this.key) : undefined;

    const tally = new Map<SetFilterValue, number>();
    for (const row of this.table.rows) {
      if (cross && !cross(row)) continue;
      for (const value of facetValues(this.config.value(row))) {
        tally.set(value, (tally.get(value) ?? 0) + 1);
      }
    }
    return tally;
  }

  // The rendered pinned block this column belongs to (outer-edge-first), or undefined when unpinned.
  private get pinnedSiblings(): ColumnModel[] | undefined {
    if (this.pinned === "left") return this.table.leftPinnedRenderedColumns;
    if (this.pinned === "right") return this.table.rightPinnedRenderedColumns;
    return undefined;
  }

  constructor(table: TableModel, config: ColumnConfig) {
    this.table = table;
    this.config = config;

    makeObservable<this, "facetScan">(this, {
      pinned: observable,
      hidden: observable,
      manualWidth: observable,

      width: computed,
      fixedWidth: computed,
      grow: computed,
      isPinnedEdge: computed,
      isPinnedOuterEdge: computed,
      offset: computed,
      title: computed,
      ariaColIndex: computed,
      sortDirection: computed,
      sortIndex: computed,
      facets: computed,
      facetScan: computed,

      setPinned: action,
      setManualWidth: action,
      setHidden: action,
    });

    this.setPinned(config.pinned);
  }

  setPinned(pinned: ColumnConfig["pinned"]): void {
    this.pinned = pinned;
  }

  setManualWidth(width: number | undefined): void {
    this.manualWidth = width;
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
  }

  /** Sort by this column — replaces the sort list unless `preserve: true` (see TableModel.setSort). */
  sortBy(direction: SortDirection, opts?: { preserve?: boolean }): void {
    this.table.setSort(this.key, direction, opts);
  }

  /** Remove this column from the sort; other columns' sorts are untouched. */
  clearSort(): void {
    this.table.clearSort(this.key);
  }

  /** Raw cell value for a row — what sorting compares and the default render displays. */
  getValue(row: RowData): unknown {
    return this.config.value(row);
  }

  /**
   * What the built-in search matches this row against: the `searchable` projection when one is
   * given, otherwise the raw cell value.
   */
  searchValue(row: RowData): unknown {
    const searchable = this.config.searchable;
    return typeof searchable === "function" ? searchable(row) : this.config.value(row);
  }

  /** Reset this column's filter, if it has one. A no-op otherwise. */
  clearFilter(): void {
    this.config.filter?.clear();
  }

  /** Ascending comparison of two rows by this column's extracted values (`compare` def or the default). */
  compareRows(a: RowData, b: RowData): number {
    return (this.config.compare ?? compareValues)(this.getValue(a), this.getValue(b));
  }

  /**
   * The key a def will produce, without building the column — what `TableModel` matches defs by
   * (`removeColumn`) and checks for collisions with. Mirrors `fromDef`: a string def is its own
   * key, and a selection def may omit one.
   */
  static keyOf(def: ColumnDef<any>): string {
    if (typeof def === "string") return def;
    const { key, selection } = def as { key?: string; selection?: boolean };
    return key ?? (selection ? SELECTION_COLUMN_KEY : "");
  }

  static fromDef(table: TableModel, def: ColumnDef<any>): ColumnModel {
    const normalizedDef = typeof def === "string" ? { key: def } : def;
    const { render, ...config } = normalizedDef as BaseColumnDef<any> & {
      key?: string;
      value?: (row: RowData) => unknown;
      selection?: boolean;
    };
    const key = ColumnModel.keyOf(def);
    // the raw accessor: computed columns bring their own `value`; field columns resolve the key
    // as a (dot-)path. Selection columns have no value (rendered via <Table.SelectionCell>).
    const value =
      config.value ?? (config.selection ? (): null => null : (row: RowData) => getPath(row, key));

    return new ColumnModel(table, {
      ...config,
      key,
      value,
      // a custom render wins for display; sorting always goes through `value`
      render: render ?? value,
    });
  }
}
