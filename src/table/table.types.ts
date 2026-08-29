import type { FilterCondition, SetFilterValue } from "../filter/filter.types";

// Re-exported so a consumer reading `table.filterQuery` gets the type from `/table` rather than
// having to reach into `/filter` for it. Type-only, so nothing is pulled into the bundle.
export type { FilterCondition, FilterOp, SetFilterValue } from "../filter/filter.types";

export type RowData = Record<string, any>;
export type TableData = RowData[];

export type DotPath<T> = T extends object
  ? T extends Date | readonly unknown[] | ((...args: any) => any)
    ? never
    : { [K in keyof T & string]: K | `${K}.${DotPath<T[K]>}` }[keyof T & string]
  : never;

export type ColumnDef<T> =
  | DotPath<T>
  | FieldColumnDef<T>
  | ComputedColumnDef<T>
  | SelectionColumnDef;

export type ColumnsDef<T> = (ColumnDef<T> | ((firstRow: T) => ColumnDef<T> | ColumnDef<T>[]))[];

/**
 * Decides what to do with a key found on the first row that no configured column covers. Return a
 * def to configure that column, `true` for the default treatment (the key as a field column), or
 * `false`/`undefined` to leave the key out.
 */
export type AutoColumnFn<T> = (
  key: string,
  value: unknown,
  row: T,
) => ColumnDef<T> | boolean | undefined;

export type RowId = string | number;

/**
 * A dataset that knows whether it is still arriving, and how the last attempt ended.
 *
 * Structural on purpose: `LazyObservableArray` satisfies it, so `rows={list}` works — but `table`
 * declares the shape rather than importing the type, and stays independent of `lazy-observable`.
 * Anything with these properties works, including a hand-rolled object.
 *
 * The three facts are orthogonal, which is why this is not a `status` enum: `value` says whether
 * there is anything to show, `fetching` says whether a request is running, `error` says how the
 * last one ended. A refresh that fails while rows are on screen has all three at once, and every
 * one of them is a true statement about it.
 *
 * `undefined` and `[]` are likewise different answers — "not known yet" versus "there are none" —
 * and that distinction is what lets the table tell a first load from an empty result without the
 * caller wiring it up.
 */
export interface RowSource<T> {
  /** The rows, or `undefined` while nothing has arrived yet. */
  value: T[] | undefined;
  /** Whether a request is in flight — including a refresh that still has rows to show. */
  fetching: boolean;
  /**
   * How the last request ended, or `undefined` if it succeeded (or none has run). Expected to be
   * cleared when a new request starts, so a state derived from it describes the latest attempt
   * rather than the worst one ever seen.
   *
   * A failure does **not** have to clear `value`, and shouldn't: a refresh that fails while rows
   * are on screen keeps showing them, so an error and a readable value coexist. Whether there is a
   * value is exactly what the table uses to decide what a failure means. With none it is fatal —
   * {@link TableModel.error}, the state `<Table.Error>` renders for. With rows still on screen the
   * table deliberately says nothing: they are good rows, and blanking them over a background
   * request would cost more than the failure did. Surfacing *that* one is the caller's, from
   * wherever their fetching already keeps it.
   *
   * Optional, so a source predating this keeps working; a source that never sets it simply never
   * reports an error, exactly as before.
   */
  error?: unknown;
}

export interface TableConfig<T> {
  /**
   * The dataset, in either of two shapes — and they differ in *who decides
   * the rows changed*, which is what decides when row-keyed state resets
   * (see `setRows`).
   *
   * **An array** — React decides. `useTable` re-applies it whenever it is a
   * different array than the one last applied, so callers must keep it
   * referentially stable (a MobX `computed`, or `useMemo`). Rebuilding it
   * inline on every render (`rows={data.filter(isActive)}`) reads as a new
   * dataset every time and clears selection with it. Passing a `TableModel`
   * a config directly (no hook) applies the array once, at construction.
   *
   * **A getter** — MobX decides. `() => store.clientFilteredRows` is tracked in a
   * reaction, so it re-applies when the observables it *read* change, on
   * MobX's cadence rather than React's. Two caveats, both silent if missed:
   * the getter must read observables (a getter over React props or state is
   * never re-run, and the table keeps the first dataset forever), and it is
   * captured once — so close over observables, not over render-scoped
   * values, which would go stale.
   *
   * **A row source** — an object with `value`, `fetching` and optionally `error`, which a
   * `LazyObservableArray` satisfies. The table tracks its contents itself, so this form needs no
   * `.slice()`, and the source works out the dataset's state on its own: see `loading`, `isEmpty`
   * and `error` on the model.
   *
   * The first two forms reach those same five states through {@link UseTableConfig.loading} and
   * {@link UseTableConfig.error}, which is the *controlled* form — you keep the status where your
   * fetching already keeps it, and the table derives the rest.
   */
  rows?: T[] | (() => T[]) | RowSource<T>;
  /** Fixed pixel height of every row (the virtualization contract). Default 40. */
  rowHeight?: number;
  /**
   * The curated columns. Read once, at construction — change the set at runtime through the model
   * (`setColumns`, `addColumn`, `removeColumn`), which preserves what the user has done to the
   * columns that survive the change.
   *
   * Configuring these does not stop `autoColumns` from filling in the rest; the two compose.
   */
  columns?: ColumnsDef<T>;
  /**
   * What to do with keys on the first row that `columns` doesn't cover.
   *
   * `true` gives each one a default field column. A function decides per key — return a def to
   * configure it, `true` for the default, `false` to leave it out — which is how you get automatic
   * columns *and* control over them:
   *
   * ```ts
   * autoColumns: (key, value) => {
   *   if (key.startsWith("_")) return false;
   *   if (typeof value === "number") return { key, align: "right" };
   *   return true;
   * };
   * ```
   *
   * Defaults to `true` when `columns` is omitted, so a table with no column config still works, and
   * to `false` when it isn't. Read once, at construction.
   *
   * Auto columns follow the data: they appear as keys appear and go as keys go. Curating a column or
   * removing one no longer switches this off — use an allowlist in the function if you want a fixed
   * set.
   */
  autoColumns?: boolean | AutoColumnFn<T>;
  /**
   * Height (px) of the detail panel below an expanded row. The binary-height contract: a row is
   * `rowHeight` or `rowHeight + expansionHeight`, never measured — panel content taller than
   * this scrolls internally (`<Table.Expansion>` owns that). Default 320.
   */
  expansionHeight?: number;
  /** Whether expanding a row collapses all others. Default "multiple". */
  expandMode?: "single" | "multiple";
  /**
   * How the sort list is applied. `"auto"` (default) sorts rows client-side through each
   * column's value accessor / `compare`. `"manual"` treats `sorts` as pure reactive state and
   * leaves row order untouched — react to `sorts`, refetch server-sorted rows, `setRows`. The
   * sort state APIs (`setSort`, `clearSort`, `sortDirection`, `sortIndex`) behave identically
   * in both modes, so header sort UIs need no changes.
   */
  sortMode?: "auto" | "manual";
  /** Extra rows rendered above/below the visible window. Default 3. */
  rowOverscan?: number;
  /** Extra columns rendered on either side of the visible window. Default 1. */
  columnOverscan?: number;
  /**
   * Stable row identity, used to key all row-scoped state (selection) and React row keys. Must be
   * unique per row. Defaults to the row's index in the source array — stable across `appendRows`,
   * reset (with the rest of row-keyed state) by `setRows`. Provide a business key when row objects
   * may be replaced by fresh instances that mean the same row.
   */
  getRowId?: (row: T, index: number) => RowId;
  /**
   * Configures the built-in cross-column search (`TableModel.search`).
   *
   * `mode: "server"` means the server does the searching: the query stops narrowing rows here and
   * becomes a `{ op: "search" }` entry in `filterQuery` instead. Per-column `searchable` is then
   * irrelevant — the server decides what it searches.
   *
   * Debouncing is deliberately not offered. Like `onStateChange`, the cadence belongs to whoever
   * owns the input.
   */
  search?: { mode?: FilterMode };
  /**
   * Fires whenever persisted table state changes (see `getState`) — including as a result of
   * `applyState`. The snapshot is JSON-serializable; debouncing/storage is the consumer's job.
   */
  onStateChange?: (state: TableState) => void;
}

/**
 * What {@link useTable} accepts: everything a {@link TableModel} takes, plus the two React-facing
 * status props that make up the *controlled* form of `rows`.
 *
 * The split is honest rather than cosmetic. `loading` and `error` are mirrored out of React on
 * every render, which is a thing only a hook can do — a `TableModel` built directly has no render
 * to mirror from, so it takes a {@link RowSource} and reads the same three facts off that instead.
 */
export interface UseTableConfig<T> extends TableConfig<T> {
  /**
   * Whether a request is in flight. The controlled counterpart of a source's `fetching`.
   *
   * What it produces depends on whether there are rows. With none it is a first load, and the
   * table reports it as `table.loading`. Behind rows already on screen it is a refresh, which the
   * table deliberately has no state for — the rows stay exactly as they are, and you already know
   * a request is running, since you are the one passing this. You do not have to distinguish the
   * two: passing the one fact you know is enough.
   *
   * Pass it from the first render, not from the first effect. A render with no rows and
   * `loading: false` is a settled empty result by definition, and the table will say so.
   */
  loading?: boolean;
  /**
   * How the last request ended. The controlled counterpart of a source's `error`, and read the
   * same way: it matters when there are no rows, where it is fatal (`table.error`, what
   * `<Table.Error>` renders) and stops the table reporting a load that will never finish.
   *
   * Behind rows that are still on screen the table ignores it on purpose — they are good rows, and
   * a failed refresh is not worth blanking them for. You passed the error in, so you still have it;
   * put it on a refresh control or in a toast, somewhere that isn't the rows.
   *
   * Clear it when the next request starts, or the table will keep describing the older failure.
   */
  error?: unknown;
}

/** Persisted per-column state (see TableState). `width` is the manual resize override; absent = automatic. */
export interface ColumnState {
  hidden: boolean;
  pinned: ColumnPin;
  width?: number;
}

/**
 * JSON-serializable snapshot of what the user has done to the table: column order, per-column
 * visibility/pinning/manual widths, the sort list, active filters and the search query. Ephemeral
 * state (selection, scroll, expansion) is deliberately excluded.
 *
 * Note that `filters` and `search` change far more often than the rest — per keystroke rather than
 * per drag — so `onStateChange` now fires that often too. They are separate top-level keys so a
 * consumer can debounce them apart from the arrangement; debouncing and storage remain its job.
 *
 * Produced by `getState`, restored by `applyState`, observed by `onStateChange`.
 */
export interface TableState {
  columnOrder: string[];
  columns: Record<string, ColumnState>;
  sorts: ColumnSort[];
  /**
   * Per-column filter state, keyed by column key. Only columns whose filter is **active** get an
   * entry, so the map stays small — but `getState` always emits the key, even empty, exactly as it
   * does `columns` and `sorts`.
   *
   * That matters for restoring: the map is a *complete picture*, so `applyState` clears any filter
   * it does not mention. Restoring a view saved with nothing filtered therefore clears filters the
   * user applied since — which is what "restore that view" has to mean. (Omitting the key entirely,
   * as a hand-built partial snapshot may, still leaves filters alone.)
   *
   * Kept apart from `columns` on purpose: filter state churns per keystroke where an arrangement
   * barely churns at all, so a consumer wanting to debounce the two differently can split them
   * without unpicking one object.
   */
  columnFilters?: Record<string, unknown>;
  /** The built-in search query. Always emitted by `getState`, empty string included. */
  search?: string;
}

/**
 * The table's contract with a *per-column* filter: a reactive predicate over one already-extracted
 * value. The table calls `matches(column.getValue(row))`, so the filter needs no accessor, no path
 * and no row type — which is what makes a computed column filterable with no extra config.
 *
 * Structural for the same reason as {@link RowSource}: `SetFilter` / `NumberFilter` / `DateFilter` / `TextFilter`
 * from the `filter` subpath satisfy it, but `table` declares the shape rather than importing the
 * classes, so a page's own `new SetFilter()` is the only thing that pulls them into the bundle. A
 * string discriminant (`filter: "set"`) would force a `"set" -> SetFilter` map into the table and
 * defeat exactly that.
 */
export interface ColumnFilter {
  /** Whether the filter is currently narrowing anything. Inactive filters are skipped entirely. */
  readonly active: boolean;
  matches(value: unknown): boolean;
  clear(): void;
  /**
   * Seeds the facet domain; its presence also selects the no-walk tier. See `ColumnModel.facets`.
   *
   * Narrowed to {@link SetFilterValue} because that is what facets actually are: `facetValues`
   * stringifies anything else, so a declared option outside that set could never match a tallied
   * one. Better a compile error than a facet that silently selects nothing.
   */
  readonly options?: readonly SetFilterValue[];
  /** Whether facets should carry cross-filtered counts — the expensive tier. */
  readonly counts?: boolean;
  /**
   * Groups raw values before comparing them (scores into grades). `matches` applies it itself; the
   * table applies it when walking rows for facets, so the list offers projected values rather than
   * raw ones that would select nothing.
   */
  readonly project?: (value: unknown) => unknown;
  /**
   * Whether picking more narrows rather than widens. When true, this column's facet counts are taken
   * against its own selection as well as the other filters — see `ColumnModel.facets`.
   */
  readonly intersecting?: boolean;
  /** JSON-serializable state, persisted into `TableState.filters`. See `ValueFilter.value`. */
  readonly value?: unknown;
  /** Restore state produced by `value`. A filter missing either is not persisted at all. */
  setValue?(value?: unknown): void;
  /**
   * The filter's state as plain JSON, for a column set to `filterMode: "server"`. The table adds
   * the column's `field` and collects these into `TableModel.filterQuery`; it never calls `matches`
   * on such a column.
   */
  readonly condition?: FilterCondition | undefined;
}

/** Where an active filter is applied. See {@link BaseColumnDef.filterMode}. */
export type FilterMode = "client" | "server";

export interface ColumnConfig {
  key: string;
  /** Raw cell value — feeds sorting and the default render. Resolved dot-path for field columns, the `value` fn for computed ones. */
  value: (row: RowData) => unknown;
  render: (row: RowData) => any;
  /** Sort comparator over extracted values. Omitted = default (numeric / chronological / locale string). */
  compare?: (a: any, b: any) => number;
  title?: string;
  /** See BaseColumnDef.order — declarative placement, lower first, default 0. */
  order?: number;
  pinned?: ColumnPin;
  width?: ColumnWidth;
  minWidth?: number;
  maxWidth?: number;
  resizable?: boolean;
  /** See BaseColumnDef.sortable — advisory flag for header sort UIs. Defaults to true. */
  sortable?: boolean;
  /** Marks the built-in row-selection column (rendered via `<Table.SelectionCell>`). */
  selection?: boolean;
  /** See BaseColumnDef.filter — already resolved, so a factory def has been called by `fromDef`. */
  filter?: ColumnFilter;
  /** See BaseColumnDef.filterable — advisory flag for header filter UIs. Defaults to true. */
  filterable?: boolean;
  /** See BaseColumnDef.searchable. Defaults to true. */
  searchable?: boolean | ((row: RowData) => string);
  /** See BaseColumnDef.hidden. Initial value only. */
  hidden?: boolean;
  /** See BaseColumnDef.hideable — advisory for pickers, and proof against a snapshot. */
  hideable?: boolean;
  /** See BaseColumnDef.pinnable — advisory for header UIs, and proof against a snapshot. */
  pinnable?: boolean;
  /** See BaseColumnDef.filterMode. Defaults to "client". */
  filterMode?: FilterMode;
  /** See BaseColumnDef.field. Defaults to `key`. */
  field?: string;
}

/**
 * What `ColumnModel.setConfig` accepts — everything on {@link ColumnConfig} except the three that
 * cannot be swapped after the fact:
 *
 * - `key` identifies the column in `columns`, `columnOrder`, the sort list and any persisted
 *   snapshot; changing it would orphan all of them.
 * - `filter` holds the user's live selection. Replacing the instance would silently discard it —
 *   set the filter's own state instead, or `removeColumn` + `addColumn` to change its type.
 * - `selection` decides which components render the column at all.
 */
export type ColumnConfigPatch = Partial<Omit<ColumnConfig, "key" | "filter" | "selection">>;

/** Which edge a column is pinned to, or `false` for not pinned. */
export type ColumnPin = false | "left" | "right";

export type ColumnWidth = number | `${number}fr`;

export type SortDirection = "asc" | "desc";

/** One entry in the table's sort priority list. */
export interface ColumnSort {
  key: string;
  direction: SortDirection;
}

export interface BaseColumnDef<T> {
  title?: string;
  render?: (row: T) => any;
  /**
   * Custom sort comparator. Receives the two rows' *extracted* values (the dot-path lookup for
   * field columns, the `value` fn's result for computed ones), not the rows. Return negative /
   * zero / positive as usual; the table handles direction. Defaults to numbers numerically,
   * Dates chronologically, everything else by locale string, nullish first.
   */
  compare?: (a: any, b: any) => number;
  /**
   * Declarative placement, like CSS `order`: lower comes first, default `0`, and columns sharing a
   * value keep their relative position — configured columns before auto ones. It decides where a
   * column *lands*, not where it stays: dragging a column overrides it, and a column appearing later
   * is inserted at the position its `order` implies rather than appended.
   */
  order?: number;
  /** Initial pin side; can also be changed at runtime via ColumnModel.setPinned. */
  pinned?: ColumnPin;
  /**
   * Whether the column starts hidden. Defaults to false.
   *
   * The *initial* value only — `setHidden` and a persisted snapshot both move it afterwards. Pair
   * with `hideable: false` for a column that is only ever there to carry data or a filter.
   */
  hidden?: boolean;
  /**
   * Whether a column picker should offer to change this column's visibility. Defaults to true.
   *
   * Read it as **locking `hidden` at whatever it starts as**, not as "cannot be hidden" — on a
   * `hidden: true` column it means always hidden, which is how you declare a column that exists
   * only to carry a value or a filter.
   *
   * Advisory for UI, like `sortable` and `filterable`: `setHidden` is never gated, so a page's own
   * responsive layout can still hide whatever it likes. What it *does* enforce is that a persisted
   * snapshot cannot override it — structure outranks a stale saved view. See `applyState`.
   */
  hideable?: boolean;
  /**
   * Whether a header UI should offer to pin this column. Defaults to true. Advisory in the same way
   * as `hideable`, and likewise proof against a snapshot.
   */
  pinnable?: boolean;
  /** Fixed pixel width (`number`) or a flex weight (`"Nfr"`). Defaults to `"1fr"`. */
  width?: ColumnWidth;
  /** Minimum width for flex columns (px). Defaults to 120. Ignored for fixed-px columns. */
  minWidth?: number;
  /** Maximum width for flex columns (px). Ignored for fixed-px columns. */
  maxWidth?: number;
  /** Whether the column can be resized by dragging its header edge. Defaults to true. */
  resizable?: boolean;
  /**
   * Whether the column participates in sorting. Defaults to true. Advisory for header UIs
   * (hide the sort controls); the model's sort APIs are not gated, so programmatic
   * `setSort`/`applyState` still work.
   */
  sortable?: boolean;
  /**
   * A filter over this column's values. The table feeds it `getValue(row)`, so it filters a computed
   * column as readily as a field one.
   *
   * **Prefer the factory form** — `filter: () => new SetFilter()` — whenever the column defs live
   * outside the component, which is the usual place to put them:
   *
   * ```ts
   * const columns = [{ key: "category", filter: () => new SetFilter() }];
   * ```
   *
   * A bare instance in a module-level `const` is constructed once for the lifetime of the module, so
   * it is shared by every table built from those defs and by every mount of the same one — the
   * user's selection would survive navigating away and back, and two tables on screen at once would
   * fight over it. The factory is called once per `ColumnModel`, so each table gets its own and a
   * remount starts clean.
   *
   * Pass an instance when you want exactly that sharing, or when you need a direct reference to
   * drive the filter from outside the table (a sidebar control). Otherwise reach it through
   * `table.column(key)?.filter`.
   *
   * A discriminant (`filter: "set"`) is the one form deliberately not supported: it would force a
   * `"set" -> SetFilter` map into the table, so every consumer would ship every filter type.
   *
   * Either way the filter survives everything that rebuilds column definitions — `setRows`,
   * `appendRows`, `setColumns` — because `syncColumns` preserves the `ColumnModel` behind an
   * existing key, and the factory is not called again for a key that already has one. It does *not*
   * survive `removeColumn`, which destroys the model; the filter type on a key cannot be swapped at
   * runtime, so use `removeColumn` + `addColumn` if you must.
   */
  filter?: ColumnFilter | (() => ColumnFilter);
  /**
   * Whether header UIs should offer this column's filter control. Defaults to true wherever a
   * `filter` is attached.
   *
   * Advisory in exactly the way `sortable` is: the model is never gated, so a `filterable: false`
   * column whose filter is active still narrows rows. That is the point — it is how a filter driven
   * from somewhere else (a sidebar, a route param) hides its funnel without giving up the column.
   */
  filterable?: boolean;
  /**
   * Whether the built-in cross-column search reads this column, or a text projection to search
   * instead — `searchable: (r) => fmtTime(r.time)` searches a date column as text rather than as
   * epoch millis. Defaults to true.
   *
   * Applies to hidden columns: it describes the data, not what is on screen.
   */
  searchable?: boolean | ((row: T) => string);
  /**
   * Who applies this column's filter. `"client"` (the default) narrows rows here; `"server"` means
   * whoever produced the rows already did.
   *
   * The two sets are **disjoint**, which is what makes a mixed table cheap: a server-mode filter is
   * never evaluated client-side, so every filter is applied exactly once, in exactly one place. A
   * server-mode filter contributes to `TableModel.filterQuery` instead of to `predicate`; react to
   * that, refetch, and `setRows`. Client filters then narrow the server's results, because the
   * table filters over `rows` without replacing them.
   *
   * Two consequences for facets, both because `rows` here are already narrowed by this very filter:
   * a server-mode column never walks the rows (it would discover only the values that survived the
   * current selection, and the list could never be widened again) and never carries counts (they
   * would be counts of an already-filtered set). Declare `options` on the filter to give it a
   * domain; without one its facet list is empty.
   */
  filterMode?: FilterMode;
  /**
   * The name this column's data goes by on the server — what lands in `FilterCondition.field`.
   * Defaults to `key`, which is usually right for a field column and usually wrong for a computed
   * one.
   */
  field?: string;
}

export interface FieldColumnDef<T> extends BaseColumnDef<T> {
  key: DotPath<T>;
  value?: never;
}

export interface ComputedColumnDef<T> extends BaseColumnDef<T> {
  // `string & {}` (rather than plain `string`) keeps DotPath's literal suggestions in
  // autocomplete while still accepting an arbitrary computed-column key.
  key: string & Record<never, never>;
  value: (row: T) => any;
}

/**
 * The built-in row-selection column. Rendered by `<Table.SelectionCell>` (body) and
 * `<Table.SelectionHeaderCell>` (header), so it needs no `render`/`value`. `key` is optional —
 * the table assigns one when omitted.
 */
export interface SelectionColumnDef {
  selection: true;
  key?: string;
  /** See BaseColumnDef.order — declarative placement, lower first, default 0. */
  order?: number;
  pinned?: ColumnPin;
  hidden?: boolean;
  hideable?: boolean;
  pinnable?: boolean;
  width?: ColumnWidth;
  minWidth?: number;
  maxWidth?: number;
  resizable?: boolean;
}
