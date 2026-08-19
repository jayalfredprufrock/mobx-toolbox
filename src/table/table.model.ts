import {
  action,
  comparer,
  computed,
  type IReactionDisposer,
  makeObservable,
  observable,
  reaction,
} from "mobx";
import { ColumnModel } from "./column.model";
import type {
  ColumnDef,
  ColumnSort,
  ColumnsDef,
  ColumnState,
  FilterSource,
  RowData,
  RowId,
  SortDirection,
  TableConfig,
  TableState,
} from "./table.types";

export class TableModel {
  readonly config?: TableConfig<any>;

  rows: RowData[] = [];

  columns = new Map<string, ColumnModel>();
  // column keys in display order; maintained by syncColumns and rearranged by moveColumn
  columnOrder: string[] = [];

  // The def list the columns are built from. Seeded from config.columns and replaced by the
  // What the consumer curated: `config.columns`, replaced by `setColumns`. `undefined` means none
  // were configured, which is what makes `autoColumns` default on. See effectiveDefs.
  private configuredDefs: ColumnsDef<any> | undefined;

  // Columns added at runtime by `addColumn`. Kept apart from `configuredDefs` so adding one never
  // switches auto-generation off.
  private runtimeDefs: ColumnDef<any>[] = [];

  // Keys `removeColumn` took out. A suppression rather than a def-list edit, so a removal survives
  // the next re-derivation instead of being undone by it.
  private suppressedKeys = new Set<string>();

  // client-side filter sources (AND-composed); each exposes a reactive `predicate`. See setFilter.
  filterSources: FilterSource[] = [];

  scrollX = 0;
  scrollY = 0;

  height = 0;
  width = 0;

  // active column sorts in priority order — earlier entries win, later ones break ties
  // (empty = original row order)
  sorts: ColumnSort[] = [];

  // Rows selected via the checkbox column, tracked by row id (see rowIds). Row-scoped state is
  // always stored as ids, never references — `selectedRows` derives the objects back.
  selectedIds = new Set<RowId>();

  // Rows expanded to show a detail panel, tracked by row id like selection. Ephemeral: reset by
  // setRows, preserved by appendRows, excluded from persisted TableState.
  expandedIds = new Set<RowId>();

  // A pending programmatic scroll. The model owns the intent; <Table.Root> executes it against
  // the scroll container and clears it. "end" resolves to the bottom of the content at
  // execution time (the live-tail follow position).
  scrollRequest: { y: number | "end" } | undefined = undefined;

  // The last snapshot given to applyState. Consulted whenever columns (re)sync, so state applied
  // before the columns exist (applyState before the first setRows, factory defs materializing on
  // first data) still lands. Never re-applied to columns that already exist — later user changes win.
  private appliedState: Partial<TableState> | undefined;

  private stateReactionDisposer: IReactionDisposer | undefined;

  // Only set for the getter form of `config.rows`; see activate().
  private rowsReactionDisposer: IReactionDisposer | undefined;

  // Re-derives factory columns once data exists; see activate().
  private columnsReactionDisposer: IReactionDisposer | undefined;

  get rowHeight(): number {
    return this.config?.rowHeight ?? 40;
  }

  get rowOverscan(): number {
    return this.config?.rowOverscan ?? 3;
  }

  get expansionHeight(): number {
    return this.config?.expansionHeight ?? 320;
  }

  get columnOverscan(): number {
    return this.config?.columnOverscan ?? 1;
  }

  // row → id, from config.getRowId; defaults to the row's index in the source array, which is
  // equivalent to reference identity for a static dataset and stable across appendRows
  get rowIds(): Map<RowData, RowId> {
    const getRowId = this.config?.getRowId;
    return new Map(this.rows.map((row, i) => [row, getRowId ? getRowId(row, i) : i]));
  }

  get allColumns(): ColumnModel[] {
    return this.columnOrder.flatMap((key) => {
      const col = this.columns.get(key);
      return col ? [col] : [];
    });
  }

  // hidden columns are excluded from layout and rendering
  get orderedColumns(): ColumnModel[] {
    return this.allColumns.filter((c) => !c.hidden);
  }

  /**
   * Resolved pixel width for every column, distributed across the viewport (`width`).
   * Fixed columns (explicit px or a manual override) claim their width; the rest are flex
   * (`"Nfr"`, default `1fr`) and share the remaining space by weight, clamped to
   * [minWidth, maxWidth] via a freeze-redistribute pass (a column that hits a clamp is frozen
   * and its share is re-split among the others). Any leftover slack — every flex column capped
   * at its max — is absorbed by the last column so the columns always fill the viewport (this
   * also soaks up sub-pixel rounding). When the minimums don't fit, the total exceeds the
   * viewport and the table scrolls horizontally.
   */
  get columnWidths(): Map<ColumnModel, number> {
    const cols = this.orderedColumns;
    const result = new Map<ColumnModel, number>();
    if (cols.length === 0) return result;

    const flex: ColumnModel[] = [];
    let fixedTotal = 0;
    for (const col of cols) {
      if (col.fixedWidth !== undefined) {
        result.set(col, col.fixedWidth);
        fixedTotal += col.fixedWidth;
      } else {
        flex.push(col);
      }
    }

    const free = this.width - fixedTotal;
    const frozen = new Set<ColumnModel>();

    while (frozen.size < flex.length) {
      const active = flex.filter((c) => !frozen.has(c));
      const frozenTotal = flex.reduce(
        (sum, c) => sum + (frozen.has(c) ? (result.get(c) ?? 0) : 0),
        0,
      );
      const remaining = free - frozenTotal;
      const totalGrow = active.reduce((sum, c) => sum + c.grow, 0);

      if (totalGrow <= 0) {
        for (const c of active) result.set(c, c.minWidth);
        break;
      }

      let clamped = false;
      for (const c of active) {
        const share = (remaining * c.grow) / totalGrow;
        if (share < c.minWidth) {
          result.set(c, c.minWidth);
          frozen.add(c);
          clamped = true;
        } else if (share > c.maxWidth) {
          result.set(c, c.maxWidth);
          frozen.add(c);
          clamped = true;
        }
      }

      if (!clamped) {
        for (const c of active) result.set(c, (remaining * c.grow) / totalGrow);
        break;
      }
    }

    // no-gap: absorb any leftover (underfill) into the last column, even past its max
    const used = cols.reduce((sum, c) => sum + (result.get(c) ?? 0), 0);
    const slack = this.width - used;
    if (slack > 0) {
      const sink = cols[cols.length - 1]!;
      result.set(sink, (result.get(sink) ?? 0) + slack);
    }

    return result;
  }

  get virtualWidth(): number {
    return this.orderedColumns.reduce((sum, col) => sum + col.width, 0);
  }

  get virtualHeight(): number {
    return (
      this.filteredRows.length * this.rowHeight +
      this.expandedDisplayIndices.length * this.expansionHeight
    );
  }

  // Display indices of expanded rows, ascending. The expansion geometry below keys off this tiny
  // array (0–few entries), which is what keeps the block math effectively closed-form.
  get expandedDisplayIndices(): number[] {
    if (!this.expandedIds.size) return [];
    const indices: number[] = [];
    this.displayRows.forEach((row, i) => {
      const id = this.rowIds.get(row);
      if (id !== undefined && this.expandedIds.has(id)) indices.push(i);
    });
    return indices;
  }

  get unpinnedColumns(): ColumnModel[] {
    return this.orderedColumns.filter((c) => !c.pinned);
  }

  get firstUnpinnedRenderedIndex(): number {
    const firstVisibleIndex = this.unpinnedColumns.findIndex((col) => col.offset >= this.scrollX);
    return Math.max(0, firstVisibleIndex - this.columnOverscan);
  }

  get lastUnpinnedRenderedIndex(): number {
    const first = this.firstUnpinnedRenderedIndex;
    const maxOffset = this.scrollX + this.width;
    let lastVisibleIndex = this.unpinnedColumns.length - 1;
    for (let i = first; i < this.unpinnedColumns.length; i++) {
      if ((this.unpinnedColumns[i]?.offset ?? 0) >= maxOffset) {
        lastVisibleIndex = i;
        break;
      }
    }
    return Math.min(this.unpinnedColumns.length - 1, lastVisibleIndex + this.columnOverscan);
  }

  // Integer-bound like renderedRows, so horizontal scrolling only re-renders on column boundaries.
  get unpinnedRenderedColumns(): ColumnModel[] {
    return this.unpinnedColumns.slice(
      this.firstUnpinnedRenderedIndex,
      this.lastUnpinnedRenderedIndex + 1,
    );
  }

  get leftPinnedRenderedColumns(): ColumnModel[] {
    return this.orderedColumns.filter((c) => c.pinned === "left");
  }

  get rightPinnedRenderedColumns(): ColumnModel[] {
    return this.orderedColumns.filter((c) => c.pinned === "right").reverse();
  }

  get filteredRows(): RowData[] {
    // read each source's reactive predicate; skip sources with none (pass-through)
    const predicates = this.filterSources.flatMap((s) => (s.predicate ? [s.predicate] : []));
    if (!predicates.length) return this.rows;
    return this.rows.filter((r) => predicates.every((p) => p(r)));
  }

  // Rows in display order (filtered, then sorted by the active columns — first non-zero
  // comparison in priority order wins). Comparison goes through each column's value accessor
  // (dot-paths, computed `value` fns) and optional `compare` def — never a raw `row[key]` lookup.
  // Sort keys with no matching column are skipped.
  get displayRows(): RowData[] {
    const rows = this.filteredRows;
    // manual mode: sorts is reactive state for the consumer to serialize; rows arrive pre-sorted
    if (this.config?.sortMode === "manual") return rows;
    const active = this.sorts.flatMap(({ key, direction }) => {
      const col = this.columns.get(key);
      return col ? [{ col, dir: direction === "desc" ? -1 : 1 }] : [];
    });
    if (!active.length) return rows;
    return [...rows].sort((a, b) => {
      for (const { col, dir } of active) {
        const result = col.compareRows(a, b) * dir;
        if (result !== 0) return result;
      }
      return 0;
    });
  }

  get firstRenderedIndex(): number {
    return Math.max(0, this.indexAtOffset(this.scrollY) - this.rowOverscan);
  }

  get lastRenderedIndex(): number {
    const lastVisibleIndex = this.indexAtOffset(this.scrollY + this.height);
    return Math.min(this.displayRows.length - 1, lastVisibleIndex + this.rowOverscan);
  }

  // Windowed rows. Depends only on the integer slice bounds (which change once per crossed row
  // boundary), never on raw scrollY — so scrolling within a row does not invalidate this computed,
  // and the body re-renders per row boundary instead of on every scroll frame.
  get renderedRows(): RowData[] {
    return this.displayRows.slice(this.firstRenderedIndex, this.lastRenderedIndex + 1);
  }

  get virtualOffsetX(): number {
    return this.unpinnedRenderedColumns.at(0)?.offset ?? 0;
  }

  get virtualOffsetY(): number {
    return this.blockOffset(this.firstRenderedIndex);
  }

  get renderedColumns(): ColumnModel[] {
    return [
      ...this.leftPinnedRenderedColumns,
      ...this.unpinnedRenderedColumns,
      ...this.rightPinnedRenderedColumns,
    ];
  }

  // Visible columns in visual (left-to-right) order — pinned blocks at the edges regardless of
  // their position in columnOrder. Backs each column's ariaColIndex.
  get visualColumns(): ColumnModel[] {
    return [
      ...this.leftPinnedRenderedColumns,
      ...this.unpinnedColumns,
      ...this.rightPinnedRenderedColumns.slice().reverse(),
    ];
  }

  // row → display index (post filter/sort); backs each row's aria-rowindex
  get displayRowIndexMap(): Map<RowData, number> {
    return new Map(this.displayRows.map((row, i) => [row, i]));
  }

  /** Whether the table has a selection column (drives aria-multiselectable / aria-selected). */
  get selectable(): boolean {
    return this.allColumns.some((c) => c.selection);
  }

  get gridTemplateColumns(): string {
    const cols: string[] = [];
    cols.push(...this.leftPinnedRenderedColumns.map((c) => `${c.width}px`));
    cols.push(`${this.virtualOffsetX}px`);
    cols.push(...this.unpinnedRenderedColumns.map((c) => `${c.width}px`));
    cols.push(...this.rightPinnedRenderedColumns.map((c) => `${c.width}px`));
    return cols.join(" ");
  }

  /** Whether the viewport is scrolled to (within one row of) the end of the content. */
  get atEnd(): boolean {
    return this.scrollY + this.height >= this.virtualHeight - this.rowHeight;
  }

  /** The selected row objects, in source order. Derived from `selectedIds`, so ids without a
   * matching row (possible only if a consumer mutates `selectedIds` directly) drop out. */
  get selectedRows(): RowData[] {
    const selected: RowData[] = [];
    for (const [row, id] of this.rowIds) {
      if (this.selectedIds.has(id)) selected.push(row);
    }
    return selected;
  }

  /**
   * The selected rows the user can currently see — selection intersected with the filter. The
   * counterpart to `selectedRows`, which spans the whole dataset: selection is keyed to a row
   * *existing*, not to it being visible, so filtering something out does not deselect it.
   *
   * Use this for a bulk action that should only touch what is on screen, and `selectedRows` for one
   * that should touch everything the user has picked.
   */
  get visibleSelectedRows(): RowData[] {
    const ids = this.rowIds;
    return this.filteredRows.filter((row) => {
      const id = ids.get(row);
      return id !== undefined && this.selectedIds.has(id);
    });
  }

  /**
   * Whether every *visible* row is selected — the header checkbox's state. Derived from
   * `visibleSelectedRows` rather than `selectedRows`, so a selection hidden by the filter can't
   * report the header as fully checked when nothing on screen is selected.
   */
  get allRowsSelected(): boolean {
    return (
      this.filteredRows.length > 0 && this.visibleSelectedRows.length >= this.filteredRows.length
    );
  }

  get someRowsSelected(): boolean {
    return this.visibleSelectedRows.length > 0 && !this.allRowsSelected;
  }

  constructor(config?: TableConfig<any>) {
    this.config = config;
    this.configuredDefs = config?.columns;

    makeObservable<this, "syncColumns" | "configuredDefs" | "runtimeDefs" | "suppressedKeys">(
      this,
      {
        rows: observable.ref,
        columns: observable,
        columnOrder: observable.ref,
        configuredDefs: observable.ref,
        runtimeDefs: observable.ref,
        suppressedKeys: observable.ref,
        filterSources: observable.ref,
        scrollX: observable,
        scrollY: observable,
        height: observable,
        width: observable,
        sorts: observable.ref,
        selectedIds: observable.shallow,
        expandedIds: observable.shallow,
        scrollRequest: observable.ref,

        rowIds: computed,
        visibleSelectedRows: computed,
        allColumns: computed,
        orderedColumns: computed,
        columnWidths: computed,
        virtualWidth: computed,
        virtualHeight: computed,
        expandedDisplayIndices: computed,
        unpinnedColumns: computed,
        firstUnpinnedRenderedIndex: computed,
        lastUnpinnedRenderedIndex: computed,
        unpinnedRenderedColumns: computed,
        leftPinnedRenderedColumns: computed,
        rightPinnedRenderedColumns: computed,
        filteredRows: computed,
        displayRows: computed,
        firstRenderedIndex: computed,
        lastRenderedIndex: computed,
        renderedRows: computed,
        virtualOffsetX: computed,
        virtualOffsetY: computed,
        renderedColumns: computed,
        visualColumns: computed,
        displayRowIndexMap: computed,
        selectable: computed,
        gridTemplateColumns: computed,
        atEnd: computed,
        selectedRows: computed,
        allRowsSelected: computed,
        someRowsSelected: computed,

        applyState: action.bound,
        setFilter: action.bound,
        syncColumns: action,
        setColumns: action.bound,
        addColumn: action.bound,
        removeColumn: action.bound,
        moveColumn: action.bound,
        setRows: action.bound,
        appendRows: action.bound,
        setScroll: action.bound,
        scrollToRow: action.bound,
        scrollToEnd: action.bound,
        clearScrollRequest: action.bound,
        setWidth: action.bound,
        setHeight: action.bound,
        setSort: action.bound,
        setSorts: action.bound,
        clearSort: action.bound,
        toggleRow: action.bound,
        selectAllRows: action.bound,
        clearSelection: action.bound,
        toggleRowExpanded: action.bound,
        collapseAllRows: action.bound,
        toggleAllRows: action.bound,
      },
    );

    if (config?.filter) {
      this.setFilter(config.filter);
    }
    // the getter form is applied by its reaction in activate(), below
    if (Array.isArray(config?.rows)) {
      this.setRows(config.rows);
    }
    // registered after initial config so construction itself never fires; structural equality
    // suppresses echoes from unrelated observable churn
    this.activate();
  }

  /**
   * (Re)start the model's reactions. Pairs with `dispose` — `useTable` calls both across
   * effect cycles, so a StrictMode dev remount (mount → cleanup → mount against the same model)
   * re-arms them instead of leaving the surviving model deaf. No-op for a reaction already
   * running, or one the config gives nothing to do.
   */
  activate(): void {
    // A getter `rows` is tracked here rather than read once in the constructor: the model follows
    // whatever observables the getter touches. Ordered before the state reaction so the columns
    // this first materializes are part of that reaction's baseline rather than a change to report.
    const rows = this.config?.rows;
    if (typeof rows === "function" && !this.rowsReactionDisposer) {
      this.rowsReactionDisposer = reaction(
        () => rows(),
        (next) => this.setRows(next),
        { fireImmediately: true },
      );
    }

    // Factory column defs read the first row, which may not exist at construction — rows arriving
    // from a lazy load, or a live observable array whose contents fill in later. Re-syncing when the
    // first row changes materializes those columns as soon as there is data to derive them from.
    // `syncColumns` keeps columns that already exist, so this never disturbs user changes.
    if (!this.columnsReactionDisposer) {
      this.columnsReactionDisposer = reaction(
        () => this.rows.at(0),
        () => this.syncColumns(),
      );
    }

    const onStateChange = this.config?.onStateChange;
    if (onStateChange && !this.stateReactionDisposer) {
      this.stateReactionDisposer = reaction(() => this.getState(), onStateChange, {
        equals: comparer.structural,
      });
    }
  }

  /** Drop the model's reactions. Pairs with `activate`. */
  dispose(): void {
    this.stateReactionDisposer?.();
    this.stateReactionDisposer = undefined;
    this.rowsReactionDisposer?.();
    this.rowsReactionDisposer = undefined;
    this.columnsReactionDisposer?.();
    this.columnsReactionDisposer = undefined;
  }

  rowId(row: RowData): RowId | undefined {
    return this.rowIds.get(row);
  }

  /** Snapshot of the user-curated arrangement (see `TableState`). JSON-serializable. */
  getState(): TableState {
    const columns: Record<string, ColumnState> = {};
    for (const col of this.allColumns) {
      const entry: ColumnState = { hidden: col.hidden, pinned: col.pinned || false };
      if (col.manualWidth !== undefined) entry.width = col.manualWidth;
      columns[col.key] = entry;
    }
    return {
      columnOrder: this.columnOrder.slice(),
      columns,
      sorts: this.sorts.map((s) => ({ ...s })),
    };
  }

  /**
   * Restore a (possibly partial) snapshot. Keys with no matching column are kept aside and land
   * when a matching column appears (see `appliedState`); columns the snapshot doesn't mention are
   * left as they are, ordered after the snapshot's columns.
   */
  applyState(state: Partial<TableState>): void {
    this.appliedState = { ...this.appliedState, ...state };
    if (state.columns) {
      for (const col of this.columns.values()) this.applyColumnState(col);
    }
    if (state.columnOrder) {
      this.columnOrder = this.mergedOrder(state.columnOrder);
    }
    // stale sort keys are harmless — displayRows skips sorts with no matching column
    if (state.sorts) {
      this.sorts = state.sorts.map((s) => ({ ...s }));
    }
  }

  /** Replace the client-side filter source(s). Pass `undefined` to clear. */
  setFilter(filter: FilterSource | FilterSource[] | undefined): void {
    this.filterSources = filter ? [filter].flat() : [];
  }

  /**
   * Replace the column definitions. Takes over from `config.columns` — and from the
   * derive-from-the-first-row default, so a table that was deriving its columns stops doing so.
   *
   * Columns that survive the change keep everything the user did to them: display position,
   * visibility, pinning and manual width. Columns no longer defined are dropped; their entries in
   * the sort list are left in place but inert (as for any column that disappears), so restoring
   * the column restores its sort.
   */
  setColumns(defs: ColumnsDef<any>): void {
    this.assertUniqueKeys(defs);
    // a full reset of what the user curated: runtime additions and removals go with it
    this.configuredDefs = defs.slice();
    this.runtimeDefs = [];
    this.suppressedKeys = new Set();
    this.syncColumns();
  }

  /**
   * Add one column definition — the runtime counterpart to a `config.columns` entry, for
   * user-curated columns (a picker adding a metric that isn't on the row objects; see
   * `ComputedColumnDef.value`, which can read any observable, not just the row).
   *
   * `index` is the position in the display order; omitted, the column lands last. The column is
   * always shown, even if a persisted snapshot had it hidden — adding a column means showing it.
   *
   * Throws when the key is already taken. Column pickers should offer only what isn't added yet
   * (`table.columns.has(key)`), so a collision here is a bug rather than a user action.
   */
  addColumn(def: ColumnDef<any>, index?: number): void {
    const key = ColumnModel.keyOf(def);

    if (this.suppressedKeys.has(key)) {
      // adding back something `removeColumn` took out: lift the suppression, and only carry the def
      // if nothing already provides one — a configured or auto column comes back on its own
      const next = new Set(this.suppressedKeys);
      next.delete(key);
      this.suppressedKeys = next;
      if (!this.configuredKeys().has(key)) this.runtimeDefs = [...this.runtimeDefs, def];
    } else {
      // a column already under that key — configured, added, or auto — would silently replace it
      if (this.columns.has(key)) {
        throw new Error(`Duplicate table column key "${key}" — column keys must be unique.`);
      }
      this.runtimeDefs = [...this.runtimeDefs, def];
    }

    this.syncColumns();

    this.columns.get(key)?.setHidden(false);
    if (index !== undefined) this.moveColumn(key, index);
  }

  /**
   * Remove the column with this key. A no-op when no def matches — including for columns produced
   * by a factory def, whose keys aren't known until they're built: hide those
   * (`ColumnModel.setHidden`) or replace the list with `setColumns`.
   *
   * Removal drops the column's live state but not any *persisted* state for it, so a later
   * `addColumn` with the same key restores the pinning and width the user had given it.
   */
  removeColumn(key: string): void {
    if (!this.columns.has(key)) return;
    this.suppressedKeys = new Set(this.suppressedKeys).add(key);
    this.runtimeDefs = this.runtimeDefs.filter((def) => ColumnModel.keyOf(def) !== key);
    this.syncColumns();
  }

  /** Move a column to a new index in the display order. */
  moveColumn(key: string, toIndex: number): void {
    const from = this.columnOrder.indexOf(key);
    if (from < 0) return;
    const order = this.columnOrder.slice();
    order.splice(from, 1);
    order.splice(Math.max(0, Math.min(order.length, toIndex)), 0, key);
    this.columnOrder = order;
  }

  /**
   * Replace the dataset. What happens to row-keyed state (selection, expansion) depends on where
   * the ids come from:
   *
   * - **With `getRowId`** the ids are derived from the data, so they survive a new array: state is
   *   intersected against the incoming rows, keeping ids that still resolve and dropping the rest.
   *   That is what lets a refresh — a refetch, a poll, an invalidation — arrive without clearing
   *   the user's selection, while genuinely switching datasets still drops it naturally.
   * - **Without `getRowId`** the ids are positions, which must not silently attach to different
   *   rows, so state is cleared outright.
   *
   * Use `appendRows` to add without resetting. Re-passing the array already in place is a no-op:
   * same array, same dataset. (`rows` is an `observable.ref`, so mutating one in place is invisible
   * either way — hand over a new array to change the data.)
   */
  setRows(rows: RowData[]): void {
    if (rows === this.rows) return;
    this.rows = rows;
    this.syncColumns();

    if (!this.config?.getRowId) {
      this.selectedIds.clear();
      this.expandedIds.clear();
      return;
    }

    const live = new Set(this.rowIds.values());
    for (const id of this.selectedIds) if (!live.has(id)) this.selectedIds.delete(id);
    for (const id of this.expandedIds) if (!live.has(id)) this.expandedIds.delete(id);
  }

  /** Append rows without resetting row-keyed state — the "load more" path. Existing rows keep
   * their positions, so default (index) ids stay stable and selection survives. */
  appendRows(rows: RowData[]): void {
    this.rows = [...this.rows, ...rows];
    this.syncColumns();
  }

  setScroll(x: number, y: number): void {
    this.scrollX = x;
    this.scrollY = y;
  }

  /** Content offset of a display index's block top (row plus any expansion panels above it). */
  blockOffset(index: number): number {
    return index * this.rowHeight + this.expandedAbove(index) * this.expansionHeight;
  }

  /** Scroll so the row's block top lands at the viewport top, or its block end at the bottom. */
  scrollToRow(row: RowData, align: "top" | "bottom" = "top"): void {
    const index = this.displayRowIndexMap.get(row);
    if (index === undefined) return;
    if (align === "top") {
      this.scrollRequest = { y: this.blockOffset(index) };
      return;
    }
    const id = this.rowIds.get(row);
    const expanded = id !== undefined && this.expandedIds.has(id);
    const blockEnd =
      this.blockOffset(index) + this.rowHeight + (expanded ? this.expansionHeight : 0);
    this.scrollRequest = { y: Math.max(0, blockEnd - this.height) };
  }

  /** Scroll to the very end of the content. */
  scrollToEnd(): void {
    this.scrollRequest = { y: "end" };
  }

  clearScrollRequest(): void {
    this.scrollRequest = undefined;
  }

  setWidth(width: number): void {
    this.width = width;
  }

  setHeight(height: number): void {
    this.height = height;
  }

  /**
   * Set a column's sort. By default the whole sort list is replaced (single-sort behavior).
   * With `preserve: true` existing sorts are kept: a column already in the list changes
   * direction in place (keeping its priority), a new column is appended at the lowest priority.
   */
  setSort(key: string, direction: SortDirection, opts?: { preserve?: boolean }): void {
    if (!opts?.preserve) {
      this.sorts = [{ key, direction }];
      return;
    }
    const sorts = this.sorts.slice();
    const existing = sorts.findIndex((s) => s.key === key);
    if (existing >= 0) sorts[existing] = { key, direction };
    else sorts.push({ key, direction });
    this.sorts = sorts;
  }

  /** Replace the whole sort list at once (restoring a saved view); `setSort` covers per-column interactions. */
  setSorts(sorts: ColumnSort[]): void {
    this.sorts = sorts.map((s) => ({ ...s }));
  }

  /** Remove one column from the sort (later entries move up in priority), or all sorts when no key is given. */
  clearSort(key?: string): void {
    this.sorts = key === undefined ? [] : this.sorts.filter((s) => s.key !== key);
  }

  isRowSelected(row: RowData): boolean {
    const id = this.rowIds.get(row);
    return id !== undefined && this.selectedIds.has(id);
  }

  toggleRow(row: RowData): void {
    const id = this.rowIds.get(row);
    if (id === undefined) return;
    if (this.selectedIds.has(id)) this.selectedIds.delete(id);
    else this.selectedIds.add(id);
  }

  selectAllRows(): void {
    this.selectedIds.clear();
    for (const row of this.filteredRows) {
      const id = this.rowIds.get(row);
      if (id !== undefined) this.selectedIds.add(id);
    }
  }

  clearSelection(): void {
    this.selectedIds.clear();
  }

  toggleAllRows(): void {
    if (this.allRowsSelected) this.clearSelection();
    else this.selectAllRows();
  }

  isRowExpanded(row: RowData): boolean {
    const id = this.rowIds.get(row);
    return id !== undefined && this.expandedIds.has(id);
  }

  toggleRowExpanded(row: RowData): void {
    const id = this.rowIds.get(row);
    if (id === undefined) return;
    if (this.expandedIds.has(id)) {
      this.expandedIds.delete(id);
    } else {
      if (this.config?.expandMode === "single") this.expandedIds.clear();
      this.expandedIds.add(id);
    }
  }

  collapseAllRows(): void {
    this.expandedIds.clear();
  }

  /**
   * The def list to build columns from: the explicit list when there is one, otherwise the first
   * row's keys. Materializing the fallback here is what lets `addColumn`/`removeColumn` build on
   * a derived column set instead of replacing it.
   */
  /**
   * The defs a sync builds from: what the consumer curated, then what was added at runtime, then
   * whatever `autoColumns` makes of the first row's remaining keys — minus anything `removeColumn`
   * suppressed.
   */
  private effectiveDefs(): ColumnsDef<any> {
    const curated = [...(this.configuredDefs ?? []), ...this.runtimeDefs];
    const defs = [...curated, ...this.autoDefs(curated)];
    if (!this.suppressedKeys.size) return defs;
    return defs.filter(
      (def) => typeof def === "function" || !this.suppressedKeys.has(ColumnModel.keyOf(def)),
    );
  }

  /** Defs for first-row keys no curated column covers. Empty unless `autoColumns` is in play. */
  private autoDefs(curated: ColumnsDef<any>): ColumnDef<any>[] {
    // on by default only when nothing was configured — which keys off `configuredDefs`, not the
    // curated list, so `addColumn` cannot turn it off
    const auto = this.config?.autoColumns ?? this.configuredDefs === undefined;
    if (!auto) return [];

    const firstRow = this.rows?.at(0);
    if (!firstRow) return [];

    const covered = new Set(
      curated.filter((def) => typeof def !== "function").map((def) => ColumnModel.keyOf(def)),
    );
    const decide = typeof auto === "function" ? auto : undefined;

    return Object.keys(firstRow).flatMap((key) => {
      if (covered.has(key) || this.suppressedKeys.has(key)) return [];
      if (!decide) return [key];
      const def = decide(key, (firstRow as Record<string, unknown>)[key], firstRow);
      if (def === true) return [key];
      if (!def) return [];
      return [def];
    });
  }

  // Two columns cannot share a key: `columns` is keyed by it, so the second would silently vanish
  // and take its header and cells with it. Loud at the call site that introduced the collision.
  /** Keys the consumer configured, ignoring factory defs, which resolve only at sync time. */
  private configuredKeys(): Set<string> {
    return new Set(
      (this.configuredDefs ?? [])
        .filter((def) => typeof def !== "function")
        .map((def) => ColumnModel.keyOf(def)),
    );
  }

  private assertUniqueKeys(defs: ColumnsDef<any>): void {
    const seen = new Set<string>();
    for (const def of defs) {
      // factory defs resolve at sync time, against data this may not have yet
      if (typeof def === "function") continue;
      const key = ColumnModel.keyOf(def);
      if (seen.has(key)) {
        throw new Error(`Duplicate table column key "${key}" — column keys must be unique.`);
      }
      seen.add(key);
    }
  }

  private syncColumns(): void {
    const firstRow = this.rows?.at(0);

    const columnsDef = this.effectiveDefs();

    // the factory form allows for dynamic columns, which use the first
    // row of data to construct the column definition(s)
    const syncedColumns = columnsDef.flatMap((defOrFactory) => {
      if (typeof defOrFactory === "function") {
        if (!firstRow) return [];
        return [defOrFactory(firstRow)].flat().map((def) => ColumnModel.fromDef(this, def));
      }
      return ColumnModel.fromDef(this, defOrFactory);
    });

    const syncedKeys = new Set(syncedColumns.map((c) => c.config.key));

    // remove any stale
    for (const key of this.columns.keys()) {
      if (!syncedKeys.has(key)) {
        this.columns.delete(key);
      }
    }

    // add any new columns; freshly created ones pick up persisted state (applyState may have
    // run before they existed — e.g. before the first setRows)
    const firstSync = this.columns.size === 0;
    for (const column of syncedColumns) {
      if (!this.columns.has(column.config.key)) {
        this.columns.set(column.config.key, column);
        this.applyColumnState(column);
      }
    }

    // Display order. Deduped because a repeated key already collapsed in `columns` above — leaving
    // it twice here would render that one column twice, under one React key.
    const keys = [...new Set(syncedColumns.map((c) => c.config.key))];
    const orderOf = (key: string) => this.columns.get(key)?.config.order ?? 0;

    if (firstSync) {
      // nothing has been rearranged yet, so `order` decides outright. The sort is stable, so columns
      // sharing an `order` keep the def order — configured columns before auto ones.
      this.columnOrder = [...keys].sort((a, b) => orderOf(a) - orderOf(b));
    } else {
      // Surviving columns stay where they are, including wherever the user dragged them. A column
      // appearing now is placed by its `order` rather than appended: immediately before the first
      // column that should come after it.
      const next = this.columnOrder.filter((k) => keys.includes(k));
      for (const key of keys) {
        if (next.includes(key)) continue;
        const at = next.findIndex((k) => orderOf(k) > orderOf(key));
        if (at === -1) next.push(key);
        else next.splice(at, 0, key);
      }
      this.columnOrder = next;
    }

    // A persisted arrangement outranks `order` — it is what the user last did. Applied only on the
    // sync where the columns first materialize; afterwards later rearrangement beats the snapshot.
    if (firstSync && this.appliedState?.columnOrder) {
      this.columnOrder = this.mergedOrder(this.appliedState.columnOrder);
    }
  }

  private applyColumnState(col: ColumnModel): void {
    const state = this.appliedState?.columns?.[col.key];
    if (!state) return;
    col.setHidden(state.hidden);
    col.setPinned(state.pinned);
    col.setManualWidth(state.width);
  }

  // snapshot order first (unknown keys dropped), then current columns the snapshot doesn't know
  private mergedOrder(order: string[]): string[] {
    const known = order.filter((k) => this.columns.has(k));
    const rest = this.columnOrder.filter((k) => !known.includes(k));
    return [...known, ...rest];
  }

  // number of expansion panels fully above the given display index
  private expandedAbove(index: number): number {
    let count = 0;
    for (const i of this.expandedDisplayIndices) {
      if (i < index) count++;
      else break;
    }
    return count;
  }

  /**
   * The display index of the row whose block (row + its expansion panel, if any) contains the
   * vertical content offset `y`. Walks the expanded indices accumulating their extra height —
   * a row scrolled past its own top stays "at" `y` while its panel is in view, so expanded rows
   * render as long as any part of their block does.
   */
  private indexAtOffset(y: number): number {
    const { rowHeight, expansionHeight } = this;
    let extra = 0;
    for (const i of this.expandedDisplayIndices) {
      const panelTop = (i + 1) * rowHeight + extra;
      if (panelTop > y) break;
      if (panelTop + expansionHeight > y) return i;
      extra += expansionHeight;
    }
    return Math.floor((y - extra) / rowHeight);
  }
}
