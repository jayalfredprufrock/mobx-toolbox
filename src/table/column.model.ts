import { action, computed, makeObservable, observable } from "mobx";
import type { TableModel } from "./table.model";
import type { BaseColumnDef, ColumnConfig, ColumnDef, RowData, SortDirection } from "./table.types";
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

  // The rendered pinned block this column belongs to (outer-edge-first), or undefined when unpinned.
  private get pinnedSiblings(): ColumnModel[] | undefined {
    if (this.pinned === "left") return this.table.leftPinnedRenderedColumns;
    if (this.pinned === "right") return this.table.rightPinnedRenderedColumns;
    return undefined;
  }

  constructor(table: TableModel, config: ColumnConfig) {
    this.table = table;
    this.config = config;

    makeObservable(this, {
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

  /** Ascending comparison of two rows by this column's extracted values (`compare` def or the default). */
  compareRows(a: RowData, b: RowData): number {
    return (this.config.compare ?? compareValues)(this.getValue(a), this.getValue(b));
  }

  static fromDef(table: TableModel, def: ColumnDef<any>): ColumnModel {
    const normalizedDef = typeof def === "string" ? { key: def } : def;
    const { render, ...config } = normalizedDef as BaseColumnDef<any> & {
      key?: string;
      value?: (row: RowData) => unknown;
      selection?: boolean;
    };
    const key = config.key ?? (config.selection ? SELECTION_COLUMN_KEY : "");
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
