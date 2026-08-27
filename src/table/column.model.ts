import { action, computed, makeObservable, observable } from "mobx";
import type { Facet, FilterCondition, SetFilterValue } from "../filter/filter.types";
// Two pure functions, imported from the module rather than the `../filter` barrel so no filter class
// is ever reachable from `src/table/index.ts`. `facetValues` in particular *must* be the same
// function `SetFilter.matches` uses, or the facet list would offer a value that selects no rows.
import { BLANK, facetValues } from "../filter/util";
import type { TableModel } from "./table.model";
import type {
  BaseColumnDef,
  ColumnConfig,
  ColumnPin,
  ColumnConfigPatch,
  ColumnDef,
  ColumnFilter,
  FilterMode,
  RowData,
  SortDirection,
} from "./table.types";
import { compareValues, getPath, titleCase } from "./util";

const DEFAULT_MIN_WIDTH = 120;

/** Key assigned to a selection column when its def doesn't supply one. */
export const SELECTION_COLUMN_KEY = "__selection__";

export class ColumnModel {
  readonly table: TableModel;
  /**
   * The resolved column configuration. An `observable.ref` — replaced wholesale by
   * {@link setConfig}, never mutated in place — so every getter over it is genuinely reactive.
   */
  config: ColumnConfig;

  /** Which edge this column is pinned to. Never `undefined` — an unpinned column is `false`. */
  pinned: ColumnPin = false;

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

  /**
   * Whether a column picker should offer to change this column's visibility. See
   * {@link BaseColumnDef.hideable} — it locks `hidden` at its initial value rather than forbidding
   * hiding, and `setHidden` is never gated by it.
   */
  get hideable(): boolean {
    return this.config.hideable !== false;
  }

  /** Whether a header UI should offer to pin this column. See {@link BaseColumnDef.pinnable}. */
  get pinnable(): boolean {
    return this.config.pinnable !== false;
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

  /**
   * The filter attached to this column's def, if any — already resolved, so a factory def has been
   * called exactly once, when this column was built. See {@link BaseColumnDef.filter}.
   */
  get filter(): ColumnFilter | undefined {
    return this.config.filter;
  }

  /**
   * Whether header UIs should offer a filter control. Advisory exactly like `sortable`: the model is
   * never gated, so a `filterable: false` column with an active filter still narrows rows.
   */
  get filterable(): boolean {
    return this.config.filterable !== false && this.filter !== undefined && !this.selection;
  }

  /**
   * How a filter UI should label one facet value, if the def says. Callers apply the default
   * themselves: `column.filterOption?.(v) ?? String(v)` — a view often wants its own fallback, and
   * a blank facet is labelled off `facet.blank` rather than off the value.
   */
  get filterOption(): ((value: unknown) => any) | undefined {
    return this.config.filterOption;
  }

  /** Who applies this column's filter. See {@link BaseColumnDef.filterMode}. */
  get filterMode(): FilterMode {
    return this.config.filterMode ?? "client";
  }

  /** The name this column's data goes by on the server. Defaults to `key`. */
  get field(): string {
    return this.config.field ?? this.key;
  }

  /**
   * This column's contribution to {@link TableModel.filterQuery} — its filter's condition tagged
   * with `field`. `undefined` unless the column is server-mode with an active filter.
   */
  get filterCondition(): FilterCondition | undefined {
    if (this.filterMode !== "server") return undefined;
    const condition = this.filter?.condition;
    return condition ? { field: this.field, ...condition } : undefined;
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
   * A filter with a `project` (a `BucketFilter`, say) lists its *projected* domain — grades rather
   * than scores — while the column goes on showing and sorting the raw value.
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
   * A count means "how many rows carry this value", among rows passing every *other* filter — so it
   * previews what picking it gives you. Under a set filter's `"all"` mode, where each pick narrows
   * instead of widening, it is the size of the intersection with the current selection instead.
   *
   * Zero-count entries are kept: a popover is exactly where you go to undo an over-narrowed filter.
   * A standing facet rail drops them at the call site —
   * `facets.filter((f) => f.count > 0 || filter.has(f.value))`.
   */
  get facets(): Facet[] {
    const filter = this.filter;
    if (!filter) return [];

    // server mode never counts: `rows` are already narrowed by this very filter, so any tally
    // would describe the current selection rather than what selecting something else would give
    const counts = filter.counts === true && this.filterMode !== "server";
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
    const filter = this.filter;
    if (!filter) return undefined;
    // Server mode is always the static tier. Walking would discover only the values that survived
    // the current selection, so the list would collapse to what is already chosen and could never
    // be widened again. A server-mode filter without `options` therefore has an empty facet list.
    if (this.filterMode === "server") return undefined;
    if (filter.options && !filter.counts) return undefined;

    // The cross-filter deliberately keeps the *other* filters and the search: a row those already
    // exclude must not be counted, or the tally would promise rows that selecting the value could
    // never surface.
    const cross =
      filter.counts === true ? this.table.filterPredicateExcluding(this.key) : undefined;

    // When picks intersect (a set filter in "all" mode) each extra one *narrows*, so a count of
    // "rows carrying this value" answers a question the filter is no longer asking — it would read
    // higher than the row count you actually get. Fold this column's own filter back in, and the
    // count becomes the size of the intersection with what is already picked.
    //
    // Gated on `counts`, not on `cross`: `filterPredicateExcluding` is undefined whenever no *other*
    // filter is active, which is exactly the lone-filter case this still has to cover.
    const intersecting = filter.counts === true && filter.intersecting === true;

    const tally = new Map<SetFilterValue, number>();
    for (const row of this.table.rows) {
      // Every row contributes its *keys* — only the count is gated by the cross-filter. Skipping
      // excluded rows outright would build the domain out of the surviving rows, so a value found
      // only in excluded ones would vanish from the list instead of sitting there at zero. If it
      // were currently selected there would then be no way to untick it short of clearing
      // everything: the funnel still narrows, but the checkbox is gone.
      const raw = this.config.value(row);
      const counted = (!cross || cross(row)) && (!intersecting || filter.matches(raw));
      // `matches` projects internally, so it gets the raw value — but the walk has to project for
      // itself, or the list would offer raw values that select nothing (see ValueFilter.project).
      for (const value of facetValues(filter.project ? filter.project(raw) : raw)) {
        tally.set(value, (tally.get(value) ?? 0) + (counted ? 1 : 0));
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
      config: observable.ref,
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
      filterCondition: computed,

      setPinned: action,
      setManualWidth: action,
      setHidden: action,
      setConfig: action,
    });

    // `config.pinned` is optional; the model's is not, so the default lands here rather than
    // leaving every reader to treat `undefined` and `false` as the same thing.
    this.setPinned(config.pinned ?? false);
    if (config.hidden === true) this.setHidden(true);
  }

  /** Pin to an edge, or `false` to unpin. */
  setPinned(pinned: ColumnPin): void {
    this.pinned = pinned;
  }

  setManualWidth(width: number | undefined): void {
    this.manualWidth = width;
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
  }

  /**
   * Patch this column's configuration — the way to drive a column option from something the table
   * was not constructed with, such as React state or a prop:
   *
   * ```tsx
   * useEffect(() => table.column("amount")?.setConfig({ title: label }), [label]);
   * ```
   *
   * `setColumns` deliberately cannot do this: it preserves the `ColumnModel` behind a key it already
   * has, so a new def for an existing key is ignored wholesale. That is what keeps a column's
   * position, width, pinning and filter through a def change — and it is why patching is a separate
   * operation rather than a side effect of redeclaring.
   *
   * Everything the user has done to the column survives: `hidden`, `pinned` and `manualWidth` are
   * their own state, not configuration. `key`, `filter` and `selection` cannot be patched — see
   * {@link ColumnConfigPatch}.
   *
   * One coupling worth knowing: a def with no `render` had it defaulted to `value` when the column
   * was built, so patching `value` alone changes what is sorted and filtered but not what is
   * displayed. Patch both to change both.
   */
  setConfig(patch: ColumnConfigPatch): void {
    this.config = { ...this.config, ...patch };
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
    this.filter?.clear();
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
    const { render, filter, ...config } = normalizedDef as BaseColumnDef<any> & {
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
      // A factory def is called here and only here. `syncColumns` builds a column only for a key it
      // does not already have, so this runs once per column: each table gets its own filter and a
      // remount starts clean, while `setRows`/`setColumns` — which preserve the `ColumnModel` —
      // leave the user's selection alone.
      filter: typeof filter === "function" ? filter() : filter,
    });
  }
}
