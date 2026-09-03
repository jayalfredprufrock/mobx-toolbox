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
import { TableSearchFilter } from "./search-filter.model";
import type { LazyArray, LazyPages } from "../lazy/lazy";
import type {
  ColumnDef,
  ColumnSort,
  ColumnsDef,
  ColumnState,
  FilterCondition,
  FilterMode,
  RowData,
  RowId,
  SortDirection,
  TableConfig,
  TableQuery,
  TableState,
} from "./table.types";
import { isLazy, isPaged } from "./is-lazy";

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

  /**
   * The built-in cross-column text search. Always present and inert until something is typed, so
   * there is no config to switch it on. See {@link TableSearchFilter}.
   */
  readonly searchFilter: TableSearchFilter = new TableSearchFilter(this);

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
  // setData, preserved by appendRows, excluded from persisted TableState.
  expandedIds = new Set<RowId>();

  // A pending programmatic scroll. The model owns the intent; <Table.Root> executes it against
  // the scroll container and clears it. "end" resolves to the bottom of the content at
  // execution time (the live-tail follow position).
  scrollRequest: { y: number | "end" } | undefined = undefined;

  // The last snapshot given to applyState. Consulted whenever columns (re)sync, so state applied
  // before the columns exist (applyState before the first setData, factory defs materializing on
  // first data) still lands. Never re-applied to columns that already exist — later user changes win.
  private appliedState: Partial<TableState> | undefined;

  private stateReactionDisposer: IReactionDisposer | undefined;

  // Only set for the getter form of `config.rows`; see activate().
  private rowsReactionDisposer: IReactionDisposer | undefined;

  /**
   * The live `data` binding: the lazy or getter currently driving the dataset, if it is one of
   * those. An array is applied outright and leaves nothing to hold.
   *
   * Held here rather than read off `config` because it can be replaced — a keyed collection hands
   * out a *different* lazy per key, so `store.byOrg({ orgId })` is a new lazy whenever `orgId`
   * changes. See {@link setData}.
   */
  private binding:
    | LazyArray<RowData>
    | LazyPages<RowData, TableQuery>
    | (() => RowData[])
    | undefined;

  /**
   * The status a caller supplies for a dataset that cannot describe its own — see
   * {@link UseTableConfig.loading}. Meaningless, and ignored, when {@link TableModel.lazy} is set.
   */
  private givenLoading = false;
  private givenError: unknown = undefined;

  // Re-derives factory columns once data exists; see activate().
  private columnsReactionDisposer: IReactionDisposer | undefined;

  // Only doing anything while `data` is a paged lazy; see activate().
  private queryReactionDisposer: IReactionDisposer | undefined;
  private loadMoreReactionDisposer: IReactionDisposer | undefined;
  private restartReactionDisposer: IReactionDisposer | undefined;

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

  /**
   * Stable ids for rows when no `getRowId` is configured, keyed by the row object itself.
   *
   * Weak, so it never holds a row alive, and it needs no knowledge of what a row *is* — a dataset
   * that hands back the same objects keeps its row-keyed state, and one that rebuilds them drops
   * it. That covers identity-mapped records without the table knowing anything about models.
   */
  private readonly identityIds = new WeakMap<RowData, RowId>();
  private nextIdentityId = 0;

  private identityId(row: RowData): RowId {
    let id = this.identityIds.get(row);
    if (id === undefined) {
      id = this.nextIdentityId++;
      this.identityIds.set(row, id);
    }
    return id;
  }

  /**
   * row → id, from `config.getRowId` when given and from the row's own object identity otherwise.
   *
   * The default used to be the row's *index*, which is only safe while the dataset is re-applied
   * wholesale: a source that replaces its contents in place — which is what a `LazyArray`
   * does — would leave a selected index pointing at whatever row later occupied that slot.
   */
  get rowIds(): Map<RowData, RowId> {
    const getRowId = this.config?.getRowId;
    return new Map(
      this.rows.map((row, i) => [row, getRowId ? getRowId(row, i) : this.identityId(row)]),
    );
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
      this.clientFilteredRows.length * this.rowHeight +
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

  /**
   * Everything narrowing the rows client-side, AND-composed into one predicate: every active
   * client-mode column filter, and the search. `undefined` when nothing is active.
   *
   * One predicate rather than several is the point: "what is hiding my rows" has a single answer.
   */
  get filterPredicate(): ((row: RowData) => boolean) | undefined {
    return this.composePredicate();
  }

  /**
   * The rows this table narrowed itself: `rows` with {@link predicate} applied.
   *
   * "Client" because that is the only half it applies — a server-mode filter was already applied to
   * `rows` before they arrived, so running it again here would filter twice. The pipeline reads
   * `rows` -> `clientFilteredRows` -> `displayRows`, each name saying what that step added.
   *
   * Narrowing happens *over* `rows` rather than replacing them, which is what lets selection survive
   * a filter change and what makes `rows.length` vs this length answer "no data" vs "filtered to
   * nothing".
   */
  get clientFilteredRows(): RowData[] {
    const predicate = this.filterPredicate;
    return predicate ? this.rows.filter(predicate) : this.rows;
  }

  /** Columns the built-in search reads — hidden ones included, since `searchable` describes data. */
  get searchableColumns(): ColumnModel[] {
    return this.allColumns.filter((c) => c.searchable);
  }

  /**
   * The columns whose filter is currently narrowing rows — `.length` is the count a filter chip
   * shows, and the models themselves are what a rail renders removable chips from.
   *
   * **Search is not in here.** It holds a row `predicate` rather than a `ColumnFilter`, belongs to
   * no column, and `clearColumnFilters` does not reset it. The `column` in the name is doing real
   * work — say what you mean at the call site instead:
   *
   * ```ts
   * table.activeColumnFilters.length + (table.searchFilter.active ? 1 : 0); // everything narrowing
   * table.activeColumnFilters.some((c) => c.filterMode === "client"); // what Clear would reset
   * ```
   *
   * Includes hidden and `filterable: false` columns — a filter with no visible control is exactly
   * the one a chip needs to disclose.
   */
  get activeColumnFilters(): ColumnModel[] {
    return this.activeColumnFiltersIn();
  }

  /**
   * The active column filters this table applies itself — what `clearColumnFilters({ mode:
   * "client" })` would reset, and so what a facet rail's Clear should gate on.
   */
  get activeClientColumnFilters(): ColumnModel[] {
    return this.activeColumnFiltersIn("client");
  }

  /** The active column filters the server applied — the ones behind `filterQuery`. */
  get activeServerColumnFilters(): ColumnModel[] {
    return this.activeColumnFiltersIn("server");
  }

  // Each side is its own computed rather than a `.filter()` over the combined list, so reading one
  // never touches the other side's `active` flags — a server toggle can't invalidate a client-count
  // chip. The `&&` short-circuit is what does it.
  private activeColumnFiltersIn(mode?: FilterMode): ColumnModel[] {
    return this.allColumns.filter(
      (column) => (!mode || column.filterMode === mode) && column.filter?.active === true,
    );
  }

  /**
   * The conditions of every active **server-mode** filter, plus the search when it is server-mode
   * too. `undefined` when there are none.
   *
   * Disjoint from `predicate` by construction — a filter is either evaluated here or serialized
   * here, never both — so nothing is double-applied and there is nothing to reconcile.
   *
   * Plain JSON, so it compares with `comparer.structural`: react to it, map the conditions onto
   * your endpoint's shape, refetch, and `setData`. Debouncing and cursor invalidation are yours —
   * the table has no idea what a request costs you.
   *
   * ```ts
   * reaction(
   *   () => table.filterQuery,
   *   (query) => void refetch({ where: query?.map(toClause) }),
   *   { equals: comparer.structural },
   * );
   * ```
   */
  get filterQuery(): FilterCondition[] | undefined {
    const conditions: FilterCondition[] = [];
    for (const column of this.allColumns) {
      const condition = column.filterCondition;
      if (condition) conditions.push(condition);
    }
    const search = this.searchFilter.condition;
    if (search) conditions.push(search);
    return conditions.length > 0 ? conditions : undefined;
  }

  // Rows in display order (filtered, then sorted by the active columns — first non-zero
  // comparison in priority order wins). Comparison goes through each column's value accessor
  // (dot-paths, computed `value` fns) and optional `compare` def — never a raw `row[key]` lookup.
  // Sort keys with no matching column are skipped.
  /**
   * The lazy currently driving the table, or `undefined` if `data` was an array or a getter.
   *
   * Exposed for the one case that cannot be served any other way: a component handed a `TableModel`
   * and nothing else — a generic table wrapper, a toolbar rendered from context — that wants to
   * know whether this dataset can be refreshed and offer a control for it. `table.lazy?.reload()`
   * triggers one, `refreshing` says whether a request is running behind rows already on screen, and
   * `error` alongside `loaded` says how the last one ended.
   *
   * `fetching` covers requests the lazy started by *itself* — revalidating on reobservation, a
   * `reloadEvery` tick — so an indicator reading it is honest about background work. (The warning
   * on the lazy's own `fetching` is narrower than it looks: reading it doesn't mark the lazy
   * *observed*, so it can't keep one alive or trigger a load. A mounted table is already observing
   * its lazy, so reading through here is safe.)
   */
  get lazy(): LazyArray<RowData> | undefined {
    return isLazy(this.binding) ? this.binding : undefined;
  }

  /**
   * The paged lazy driving the table, or `undefined` — the narrower counterpart of {@link lazy}.
   *
   * Exposed for the same reason `lazy` is: a component handed only a `TableModel` — a generic
   * wrapper, a footer rendered from context — can ask whether this dataset has more to fetch and
   * get the real source if it does. `loadingMore`, `hasMore` and `total` are all on it.
   *
   * A paged source is also what {@link mode} infers from, and the only shape the table drives by
   * itself: it pushes {@link query} into it and asks for the next page as the window nears the end.
   */
  get pages(): LazyPages<RowData, TableQuery> | undefined {
    return isPaged(this.binding) ? this.binding : undefined;
  }

  /**
   * Who narrows and orders the rows — see {@link TableConfig.mode}. Explicit config wins;
   * otherwise a paged source means `"server"` and anything else means `"client"`.
   *
   * A getter rather than a constructor-time decision, so `setData` pointing an existing table at a
   * paged source flips its sorting and its columns' filter modes with it.
   */
  get mode(): "client" | "server" {
    return this.config?.mode ?? (this.pages ? "server" : "client");
  }

  /** Resolved {@link TableConfig.sortMode}: `"manual"` under `mode: "server"` unless overridden. */
  get sortMode(): "auto" | "manual" {
    return this.config?.sortMode ?? (this.mode === "server" ? "manual" : "auto");
  }

  /**
   * What a column's `filterMode` falls back to, and what the built-in search's does. Read through
   * by `ColumnModel.filterMode` rather than copied into each column, so it tracks `mode`.
   */
  get filterMode(): FilterMode {
    return this.mode === "server" ? "server" : "client";
  }

  /**
   * Everything a server needs in order to answer for this table — see {@link TableQuery}.
   *
   * **The identity is stable while the contents are**, which is load-bearing rather than an
   * optimization: it is what lets this be a `useEffect` dependency or a query key without a column
   * resize, a scroll, or a selection change issuing a request. That takes structural equality
   * *and* `keepAlive` — mobx applies `equals` only on its cached path, so an unobserved computed
   * would hand back a new object on every read and defeat the whole point.
   *
   * ```tsx
   * const query = table.query;
   * useEffect(() => void refetch(query), [query]);
   * ```
   */
  get query(): TableQuery {
    return {
      filters: this.filterQuery,
      // Only when the table isn't sorting for itself. Under `"auto"` the rows are already in this
      // order, so sending them would ask for work that's done — and would churn this object on
      // every header click for a request that changes nothing.
      sorts: this.sortMode === "manual" ? this.sorts.slice() : [],
    };
  }

  /**
   * What `aria-rowcount` should report: the extent of the dataset, not of what happens to be
   * loaded, plus one for the header row.
   *
   * It matters most for exactly the tables this is about. A virtualized table already tells
   * assistive tech the true extent because only a window is in the DOM — but a paged one had been
   * reporting the rows *fetched so far*, so a screen reader announced "row 30 of 30" about a
   * dataset of four thousand, and the number grew under the user as they scrolled.
   *
   * `-1` is ARIA's own answer for an unknown total, and a cursor-paginated list genuinely has one:
   * there is more, and nothing has said how much. A client-side filter puts us in the same
   * position from the other direction — the server's `total` counts rows this table is hiding — so
   * it falls back rather than reporting a number it knows is wrong.
   */
  get ariaRowCount(): number {
    const source = this.pages;
    if (!source) return this.displayRows.length + 1;
    if (this.filterPredicate === undefined && source.total !== undefined) return source.total + 1;
    return source.hasMore ? -1 : this.displayRows.length + 1;
  }

  /** How many rows one viewport holds, at the fixed row height. */
  get visibleRowCount(): number {
    return Math.max(1, Math.ceil(this.height / this.rowHeight));
  }

  /**
   * How many rows lie below the render window — the distance to the end of the content, in rows.
   *
   * This is the load-more trigger, and it is a **magnitude rather than a threshold** on purpose. A
   * boolean (`nearEnd`) only changes on its edges, so the case that matters most silently stalls:
   * a page lands, a client-side filter rejects most of it, the window is still near the end, the
   * boolean never changed, and nothing asks for the next page. A number moves every time rows
   * arrive, so the same `if` fires again and the list keeps filling until it can't:
   *
   * ```tsx
   * useEffect(() => {
   *   if (table.rowsToEnd < PAGE_SIZE) void loadMore();
   * }, [table.rowsToEnd, table.rows.length]);
   * ```
   *
   * The second dependency covers the one gap a display-row count can't: a page whose rows are
   * *entirely* filtered out doesn't move this at all, and `rows` is the dataset before filtering.
   * Bind `data` to a paged lazy and none of this is yours — the table drives `loadMore()` itself.
   *
   * Measured from the end of the **rendered** window, overscan included, so it is the distance to
   * the end of what has been committed to the DOM. `0` on an empty table, which reads correctly as
   * "nothing below here".
   *
   * Changes at row granularity rather than per scroll frame (the window bounds are integers), so
   * reading it in a render subscribes that component to roughly one update per row scrolled — the
   * cadence `<Table.Body>` already re-renders at.
   */
  get rowsToEnd(): number {
    return this.displayRows.length - 1 - this.lastRenderedIndex;
  }

  /**
   * Nothing has arrived yet and nothing has gone wrong — the state a first-load treatment belongs
   * to, and the one where the empty slot would be a lie.
   *
   * The `error` term is load-bearing. Without it a failed first load reads as loading forever:
   * nothing ever arrives to end it, and `isEmpty` stays `false` too, so the table shows a permanent
   * spinner with no way out. `lazy` removed a property with exactly this bug (its own
   * `loading`, which mishandled a failed first load), and this is the same fix one module over.
   *
   * Deliberately not gated on `fetching`. A source typically defers its first request past the
   * render that observes it, so there is a beat where nothing has arrived and nothing is in flight
   * either; gating on `fetching` would call that beat "not loading" and flash the empty slot before
   * the spinner. Absence of a value with no error to explain it is the honest reading.
   *
   * Only ever a *first* load. A request running behind rows already on screen is not this and has
   * no state here at all: the rows stay rendered and fully interactive, because replacing them to
   * fetch mostly-identical ones would throw away scroll position, column arrangement and selection.
   * Whoever owns the fetching knows a refresh is running — `refreshing` on a lazy, `isFetching` on
   * a query — and can say so somewhere that isn't the rows.
   *
   * Reported for either form of dataset: a lazy works it out itself, and an array or getter is
   * described by the `loading` prop passed to `useTable`. A model given a bare array and never told
   * otherwise has no loading story, and does not invent one.
   */
  get loading(): boolean {
    const lazy = this.lazy;
    if (lazy) return lazy.value === undefined && lazy.error === undefined;
    // No lazy: the caller's own account of it, and only meaningful with nothing to show. Rows on
    // screen mean any request behind them is a refresh, which is not this and has no state here.
    return this.givenLoading && this.rows.length === 0;
  }

  /**
   * The request failed and there is nothing to show for it — the fatal state, and the only one
   * `<Table.Error>` renders for.
   *
   * A failure behind rows that are still on screen is deliberately *not* this. Blanking a working
   * table over a background request would destroy scroll position, column arrangement and selection
   * for something the user never asked for, so a failed refresh leaves this `undefined` and the
   * table carries on showing what it has. Whoever owns the fetching still has that error — on the
   * lazy as `error`, or in hand as the prop they passed — and can surface it somewhere that isn't
   * the rows.
   *
   * Raw passthrough — whatever the lazy was rejected with, or whatever was handed to `useTable` as
   * the `error` prop. Unwrapped and uninterpreted either way.
   */
  get error(): unknown {
    const lazy = this.lazy;
    if (lazy) return lazy.value === undefined ? lazy.error : undefined;
    return this.rows.length === 0 ? this.givenError : undefined;
  }

  /**
   * Supply the status for a dataset that cannot describe its own. Called by `useTable` on every
   * render whose `loading` or `error` prop changed; pointless for a lazy, which is asked directly.
   */
  setStatus(loading: boolean, error: unknown): void {
    this.givenLoading = loading;
    this.givenError = error;
  }

  /**
   * There is genuinely nothing to show — as opposed to nothing *yet*, or nothing *because the
   * request failed*. This is the gate the empty slot uses, and the reason a table over a loading
   * source never claims "no results".
   *
   * A failed first load is excluded for the same reason a running one is: "No results" is a lie
   * about a request that never came back with any. Fixing `loading` without fixing this would only
   * trade a permanent spinner for a permanent — and wrong — empty state.
   */
  get isEmpty(): boolean {
    return !this.loading && this.error === undefined && this.displayRows.length === 0;
  }

  get displayRows(): RowData[] {
    const rows = this.clientFilteredRows;
    // manual mode: sorts is reactive state for the consumer to serialize; rows arrive pre-sorted
    if (this.sortMode === "manual") return rows;
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
    return this.clientFilteredRows.filter((row) => {
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
      this.clientFilteredRows.length > 0 &&
      this.visibleSelectedRows.length >= this.clientFilteredRows.length
    );
  }

  get someRowsSelected(): boolean {
    return this.visibleSelectedRows.length > 0 && !this.allRowsSelected;
  }

  constructor(config?: TableConfig<any>) {
    this.config = config;
    this.configuredDefs = config?.columns;
    // Set before `makeObservable`, alongside the other plain-field seeding: afterwards `binding` is
    // an observable ref, and a bare write to one from the constructor trips `enforceActions: 'always'`
    // on every table built against a getter or lazy. The array form is applied further down instead,
    // through `applyRows`, which is an action and so needs no such care.
    if (config?.data && !Array.isArray(config.data)) {
      this.binding = config.data;
    }

    makeObservable<
      this,
      | "syncColumns"
      | "applyRows"
      | "configuredDefs"
      | "runtimeDefs"
      | "suppressedKeys"
      | "binding"
      | "givenLoading"
      | "givenError"
      | "identityIds"
      | "nextIdentityId"
      | "identityId"
      | "applyFilterState"
      | "activeColumnFiltersIn"
    >(this, {
      rows: observable.ref,
      columns: observable,
      columnOrder: observable.ref,
      configuredDefs: observable.ref,
      runtimeDefs: observable.ref,
      suppressedKeys: observable.ref,
      // Its own observable object, held by reference — mobx must not convert it.
      searchFilter: false,
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
      // Someone else's object, so `ref` rather than `observable` — mobx must not convert what it
      // holds, only track which one is held. Tracking that much matters: `lazy`, and `loading` and
      // `error` through it, all read whichever binding is current, and a keyed collection replaces
      // it (`store.byOrg({ orgId })` is a different lazy per key). Left untracked, swapping to a
      // lazy that has not loaded yet left every one of those computeds holding the previous one's
      // answer until something else happened to invalidate them.
      binding: observable.ref,
      givenLoading: observable,
      givenError: observable.ref,
      setStatus: action.bound,

      // Memoization behind `rowIds`, not state: a WeakMap keyed by row and a counter. Neither is
      // observable, and `identityId` only ever fills a gap in the map.
      identityIds: false,
      nextIdentityId: false,
      identityId: false,

      filterPredicate: computed,
      clientFilteredRows: computed,
      searchableColumns: computed,
      activeColumnFilters: computed,
      activeClientColumnFilters: computed,
      activeServerColumnFilters: computed,
      activeColumnFiltersIn: false,
      filterQuery: computed,
      lazy: computed,
      pages: computed,
      mode: computed,
      sortMode: computed,
      filterMode: computed,
      // Structural *and* kept alive, which together are what make the identity stable — see the
      // getter. `computed.struct` alone is not enough: mobx only applies `equals` on the cached
      // path, and an unobserved computed recomputes on every read and assigns the result
      // unconditionally. So a consumer reading `table.query` outside a reactive context — in an
      // effect, in a query key, in a plain callback — would get a fresh object every time and
      // refetch on every render, which is precisely the case this exists to serve.
      query: computed({ equals: comparer.structural, keepAlive: true }),
      ariaRowCount: computed,
      visibleRowCount: computed,
      rowsToEnd: computed,
      loading: computed,
      error: computed,
      isEmpty: computed,
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
      applyFilterState: action,
      clearColumnFilters: action.bound,
      syncColumns: action,
      setColumns: action.bound,
      addColumn: action.bound,
      removeColumn: action.bound,
      moveColumn: action.bound,
      applyRows: action,
      setData: action.bound,
      appendRows: action.bound,
      setScroll: action.bound,
      scrollToRow: action.bound,
      scrollToTop: action.bound,
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
    });

    // Configured columns don't depend on data, so build them now rather than waiting for rows.
    //
    // Without this there is a window where `columns` is empty: the rows reaction fires immediately
    // but its handler skips an `undefined` value (nothing has arrived yet is not an empty dataset),
    // and the columns reaction isn't immediate — so a lazy that starts empty leaves
    // `column()`, `activeColumnFilters` and `filterQuery` blank until the first response lands.
    // That inverts the dependency for a page that *fetches from* `filterQuery`: its first request,
    // the one the user actually waits on, would go out with no conditions at all.
    //
    // Data-dependent columns are unaffected — `syncColumns` reads `rows.at(0)` only to resolve
    // factory defs, and `autoColumns` goes on waiting for a row exactly as before.
    if (this.configuredDefs) {
      this.syncColumns();
    }
    // the getter and lazy forms were bound above, and are applied by their reaction in activate(), below
    if (Array.isArray(config?.data)) {
      this.applyRows(config.data);
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
    // One reaction for the model's lifetime, reading *through* the binding rather than being built
    // against a fixed one. `binding` is an observable ref, so replacing it re-runs this, which
    // re-tracks against the new binding and drops the old dependency — no disarm/re-arm dance, and
    // no window where a replaced lazy can still write its rows back over the new dataset.
    //
    // A lazy is tracked by the *identity* of its `value`, not a copy of its contents. That is what
    // lets a `LazyArray` — which keeps one array for its lifetime and replaces the
    // contents on each load — be applied exactly once: later loads reach the table's computeds
    // through MobX directly, with no re-application and no copy of every row.
    //
    // A lazy whose `value` is a fresh array each load still works: its identity changes, so the
    // reaction fires and the dataset is re-applied, which is the correct behaviour there.
    if (!this.rowsReactionDisposer) {
      this.rowsReactionDisposer = reaction(
        () => {
          const binding = this.binding;
          if (typeof binding === "function") return binding();
          return isLazy(binding) ? binding.value : undefined;
        },
        // `undefined` means nothing has arrived — or that the dataset is a plain array, which is
        // applied outright and has no binding to read. Either way it is not an empty dataset, so
        // leave the rows alone and let `loading` describe the state.
        (next) => {
          if (next) this.applyRows(next);
        },
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

    // The three reactions below are what "the table drives a paged source itself" is. Each reads
    // *through* `this.pages` rather than closing over a source, exactly as the rows reaction reads
    // through `binding` — so `setData` pointing at a different paged lazy re-targets them, and
    // pointing at an array leaves them inert rather than needing to be torn down.

    // The table owns the query — filters live on columns, sorts on the model, search on the search
    // filter — so the source is downstream of it and this is a push, not a subscription. Immediate,
    // because the first page must go out with the filters a restored snapshot already applied
    // rather than fetching twice.
    if (!this.queryReactionDisposer) {
      this.queryReactionDisposer = reaction(
        () => this.query,
        (query) => {
          // `setQuery` ignores a structurally equal query, so re-targeting at a source that happens
          // to carry the same one costs nothing, and a table with no paged source does nothing at
          // all here.
          this.pages?.setQuery(query);
        },
        { fireImmediately: true },
      );
    }

    // Fetch the next page while fewer than a viewport's worth of rows remain below the window.
    //
    // `pages` is in the tracked expression alongside the distance, and it is the whole reason this
    // keeps working in the case a boolean gets wrong: a page whose rows are all rejected by a
    // client-side filter doesn't move `rowsToEnd` at all, so without a second term the chain would
    // stall one page in. With it, every landed page re-asks the question and the list fills until
    // it reaches the window or runs out.
    //
    // No guard against re-entry is needed: `loadMore()` resolves immediately when there is nothing
    // more and joins a request already in flight rather than starting a second.
    if (!this.loadMoreReactionDisposer) {
      this.loadMoreReactionDisposer = reaction(
        () => {
          const source = this.pages;
          if (!source?.hasMore) return undefined;
          // Not while the last request failed. Retrying on the table's own initiative would mean a
          // request per row scrolled against an endpoint that is already answering with errors —
          // and the user gets no say, because nothing they can see is asking. Recovery is an
          // explicit `loadMore()` from a footer retry, which clears the error and lets this resume.
          if (source.error !== undefined) return undefined;
          // Not until the viewport has been measured. With `height` still 0 there is no answer to
          // "how many rows fit", so every threshold is a guess — and the guess over-fetches,
          // because an unmeasured window looks like it reaches the end of the content. Mirrors
          // `<Table.Root>`, which renders nothing until it has a non-zero size.
          if (!this.height) return undefined;
          return { distance: this.rowsToEnd, pages: source.pages };
        },
        (probe) => {
          if (!probe || probe.distance >= this.visibleRowCount) return;
          // Caught, not `void`ed. The table asked for this page on its own initiative, so there is
          // no caller to reject at — the same reason a lazy's observation-triggered load reports
          // through `error` rather than throwing. The source records the failure on itself
          // (`pages.error`), which is where a footer reads it; leaving the promise unhandled would
          // turn a failed page into an unhandled rejection and, under a strict test runner or a
          // window-level handler, into a crash.
          this.pages?.loadMore().catch(() => {});
        },
        { equals: comparer.structural, fireImmediately: true },
      );
    }

    // A restart is not a growth, and the scroll position belongs to the run that produced the rows
    // it was measured against: a filter change that drops fifty pages to one leaves the user
    // parked past the end, which reads as an empty table and — worse — as "near the end", so the
    // fetch-ahead above would immediately refill everything they just filtered away.
    //
    // `pages` returning to 0 is the source's own restart signal; the array identity is stable by
    // design and so cannot say.
    if (!this.restartReactionDisposer) {
      this.restartReactionDisposer = reaction(
        () => this.pages?.pages === 0,
        (restarted) => {
          if (restarted && this.scrollY > 0) this.scrollToTop();
        },
      );
    }

    const onStateChange = this.config?.onStateChange;
    if (onStateChange && !this.stateReactionDisposer) {
      this.stateReactionDisposer = reaction(() => this.getState(), onStateChange, {
        equals: comparer.structural,
      });
    }
  }

  /**
   * Point the table at a different dataset — a new array, getter or lazy.
   *
   * The one setter, because the three shapes differ only in who decides the rows changed. An array
   * is applied outright; a getter or a lazy becomes the binding a reaction reads through, which is
   * what makes a keyed collection work: `store.byOrg({ orgId })` hands back a different lazy per
   * key, and the table has to follow it rather than keep reading the one it was built with.
   *
   * Row-keyed state is not cleared: rows are intersected, so with `getRowId` configured a row
   * present in both datasets keeps its selection and expansion.
   */
  setData(
    data: RowData[] | (() => RowData[]) | LazyArray<RowData> | LazyPages<RowData, TableQuery>,
  ): void {
    // Nothing to arm or disarm: the rows reaction reads through `binding`, so assigning it is the
    // whole operation. An array clears the binding — there is nothing to read through — and is
    // applied outright.
    if (Array.isArray(data)) {
      this.binding = undefined;
      this.applyRows(data);
      return;
    }
    if (data === this.binding) return;
    this.binding = data;
  }

  /** Drop the model's reactions. Pairs with `activate`. */
  dispose(): void {
    this.queryReactionDisposer?.();
    this.queryReactionDisposer = undefined;
    this.loadMoreReactionDisposer?.();
    this.loadMoreReactionDisposer = undefined;
    this.restartReactionDisposer?.();
    this.restartReactionDisposer = undefined;
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
      const entry: ColumnState = { hidden: col.hidden, pinned: col.pinned };
      if (col.manualWidth !== undefined) entry.width = col.manualWidth;
      columns[col.key] = entry;
    }
    const state: TableState = {
      columnOrder: this.columnOrder.slice(),
      columns,
      sorts: this.sorts.map((s) => ({ ...s })),
    };

    // Only *active* filters get an entry, so the map stays small — but it is always present, even
    // empty, exactly as `columns` and `sorts` are. That is what lets restoring a view saved with
    // nothing filtered actually clear filters applied since; omit it and a snapshot could only ever
    // add them.
    const columnFilters: Record<string, unknown> = {};
    for (const col of this.allColumns) {
      const filter = col.filter;
      if (filter?.active && filter.value !== undefined && filter.setValue) {
        columnFilters[col.key] = filter.value;
      }
    }
    state.columnFilters = columnFilters;
    state.search = this.searchFilter.text;

    return state;
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
    // Present means complete: a filter the map doesn't mention is cleared, which is what makes
    // getState -> applyState exact. Keys with no column yet land when one appears, via
    // applyColumnState — same as column state applied before the first setData.
    if (state.columnFilters) {
      for (const col of this.columns.values()) this.applyFilterState(col);
    }
    if (state.search !== undefined) {
      this.searchFilter.setText(state.search);
    }
  }

  // Restore (or clear) one column's filter from the last applied snapshot. Split out from
  // applyColumnState because it also runs for columns that already exist, where column state
  // deliberately does not — a later user change to hidden/pinned/width outranks the snapshot,
  // whereas re-applying a filter snapshot is the whole point of applying one.
  private applyFilterState(col: ColumnModel): void {
    const columnFilters = this.appliedState?.columnFilters;
    if (!columnFilters) return;
    const filter = col.filter;
    if (!filter?.setValue) return;
    const value = columnFilters[col.key];
    if (value === undefined) filter.clear();
    else filter.setValue(value);
  }

  /** The column under this key, if it exists. */
  column(key: string): ColumnModel | undefined {
    return this.columns.get(key);
  }

  /**
   * `predicate` without the named column's own filter — what that column's facet counts are tallied
   * over, so each option answers "how many rows would this add".
   *
   * Everything else stays in, including the search and page-level sources: a row those already
   * exclude must not be counted, or the tally promises rows the selection could never surface.
   */
  filterPredicateExcluding(key: string): ((row: RowData) => boolean) | undefined {
    return this.composePredicate(key);
  }

  /**
   * Reset every column filter, or only those on one side of the client/server split
   * (`clearColumnFilters({ mode: "client" })`).
   *
   * Leaves the search filter alone — it is the other kind of filter, and the `column` in this name
   * says so. Wiping text the user typed as a side effect would be surprising anyway; clear it
   * explicitly with `searchFilter.clear()`.
   */
  clearColumnFilters(opts?: { mode?: FilterMode }): void {
    const mode = opts?.mode;
    for (const column of this.allColumns) {
      if (mode && column.filterMode !== mode) continue;
      column.filter?.clear();
    }
  }

  // Reading each filter's `active` here tracks it; the returned closure reads the filter's own
  // state when it is invoked inside `clientFilteredRows`, which is tracked there. So a change that leaves
  // `active` alone — swapping one selected value for another — still invalidates the rows.
  private composePredicate(excludeKey?: string): ((row: RowData) => boolean) | undefined {
    const parts: ((row: RowData) => boolean)[] = [];

    for (const column of this.allColumns) {
      if (column.key === excludeKey) continue;
      // a server-mode filter is already applied to `rows`; running it again would filter twice, and
      // for facets it means the cross-filter predicate excludes them for free
      if (column.filterMode === "server") continue;
      const filter = column.filter;
      if (filter?.active) parts.push((row) => filter.matches(column.getValue(row)));
    }

    const search = this.searchFilter.predicate;
    if (search) parts.push(search);

    if (parts.length === 0) return undefined;
    return (row) => parts.every((part) => part(row));
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

    // adding a column means showing it — unless its def says otherwise, which is how a data-only
    // column survives being added at runtime
    const added = this.columns.get(key);
    if (added && added.config.hidden !== true) added.setHidden(false);
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
   * Replace the dataset. Row-keyed state (selection, expansion) is **intersected** against the
   * incoming rows: an id that still resolves to a row survives, and one that does not is dropped.
   * A refresh — a refetch, a poll, an invalidation — therefore arrives without clearing the user's
   * selection, while genuinely switching datasets drops it naturally.
   *
   * What "still resolves" means depends on where the ids come from:
   *
   * - **With `getRowId`** they are derived from the data, so the same record survives even when it
   *   arrives as a different object. That is what a plain-JSON refetch needs.
   * - **Without it** they follow the row's object identity, so state survives for a dataset that
   *   hands back the same objects — anything identity-mapped — and is dropped for one that rebuilds
   *   them, which is the honest answer there.
   *
   * Use `appendRows` to add without resetting. Re-passing the array already in place is a no-op:
   * same array, same dataset. (`rows` is an `observable.ref`, so mutating one in place is invisible
   * either way — hand over a new array to change the data.)
   */
  private applyRows(rows: RowData[]): void {
    if (rows === this.rows) return;
    this.rows = rows;
    this.syncColumns();

    const live = new Set(this.rowIds.values());
    for (const id of this.selectedIds) if (!live.has(id)) this.selectedIds.delete(id);
    for (const id of this.expandedIds) if (!live.has(id)) this.expandedIds.delete(id);
  }

  /** Append rows without resetting row-keyed state — the "load more" path. Existing rows keep
   * their ids either way, so selection survives. */
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

  /**
   * Scroll back to the first row.
   *
   * Called by the model itself when a paged source restarts — a query change, a reload — because
   * a scroll offset measured against fifty pages is meaningless against one, and leaves the user
   * parked past the end of the new results.
   */
  scrollToTop(): void {
    this.scrollRequest = { y: 0 };
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
    for (const row of this.clientFilteredRows) {
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
    const syncedDefs = columnsDef.flatMap((defOrFactory) => {
      if (typeof defOrFactory === "function") {
        if (!firstRow) return [];
        return [defOrFactory(firstRow)].flat();
      }
      return defOrFactory;
    });

    // Keys are derived from the defs rather than from built columns: this runs on every setData and
    // appendRows, and all but the first sync needs a `ColumnModel` only for keys it doesn't already
    // have. `keyOf` is what `fromDef` itself uses to assign the key, so the two cannot disagree.
    // Deduped because a repeated key collapses in `columns` below — leaving it twice in the display
    // order would render that one column twice, under one React key.
    const keys = [...new Set(syncedDefs.map((def) => ColumnModel.keyOf(def)))];
    const syncedKeys = new Set(keys);

    // remove any stale
    for (const key of this.columns.keys()) {
      if (!syncedKeys.has(key)) {
        this.columns.delete(key);
      }
    }

    // add any new columns; freshly created ones pick up persisted state (applyState may have
    // run before they existed — e.g. before the first setData)
    const firstSync = this.columns.size === 0;
    for (const def of syncedDefs) {
      const key = ColumnModel.keyOf(def);
      if (!this.columns.has(key)) {
        const column = ColumnModel.fromDef(this, def);
        this.columns.set(key, column);
        this.applyColumnState(column);
      }
    }

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
    // A snapshot may have been applied before this column existed — before the first setData, or
    // before a factory def had a row to build from — so both halves are re-consulted here.
    this.applyFilterState(col);
    const state = this.appliedState?.columns?.[col.key];
    if (!state) return;
    // Structure outranks a saved view: a column that declares its visibility, pin or width locked
    // is not moved by a snapshot written before that was true. `setHidden`/`setPinned`/
    // `setManualWidth` stay ungated, so a page's own layout logic is never denied — only a stale
    // snapshot is.
    if (col.hideable) col.setHidden(state.hidden);
    if (col.pinnable) col.setPinned(state.pinned);
    if (col.resizable) col.setManualWidth(state.width);
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
