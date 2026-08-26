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
 * A dataset that knows whether it is still arriving.
 *
 * Structural on purpose: `LazyObservableArray` satisfies it, so `rows={list}` works — but `table`
 * declares the shape rather than importing the type, and stays independent of `lazy-observable`.
 * Anything with these two properties works, including a hand-rolled object.
 *
 * Two properties are enough because `undefined` and `[]` are different answers: "not known yet"
 * versus "there are none". That distinction is what lets the table tell a first load from an empty
 * result without the caller wiring it up.
 */
export interface RowSource<T> {
  /** The rows, or `undefined` while nothing has arrived yet. */
  value: T[] | undefined;
  /** Whether a request is in flight — including a refresh that still has rows to show. */
  fetching: boolean;
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
   * **A getter** — MobX decides. `() => store.filteredRows` is tracked in a
   * reaction, so it re-applies when the observables it *read* change, on
   * MobX's cadence rather than React's. Two caveats, both silent if missed:
   * the getter must read observables (a getter over React props or state is
   * never re-run, and the table keeps the first dataset forever), and it is
   * captured once — so close over observables, not over render-scoped
   * values, which would go stale.
   *
   * **A row source** — an object with `value` and `fetching`, which a `LazyObservableArray`
   * satisfies. The table tracks its contents itself, so this form needs no `.slice()`, and it is
   * the only one that can tell a first load from an empty result: see `loading`, `refreshing` and
   * `isEmpty` on the model.
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
   * Page-level row filtering — the escape hatch for a dimension with no column behind it. Pass
   * anything exposing a reactive `predicate`; an array is AND-composed.
   *
   * This is *not* where per-column filters go: those are attached to their column defs
   * ({@link BaseColumnDef.filter}) so the table can feed each one the column's own accessor. Both
   * compose into `TableModel.predicate`, along with the built-in search.
   *
   * Filtering runs over `rows` without replacing them, so selection persists. For server-side
   * filtering, react to your controls' state, refetch, and `setRows` — client filters then narrow
   * the server's results with no extra machinery.
   */
  filter?: FilterSource<T> | FilterSource<T>[];
  /**
   * Fires whenever persisted table state changes (see `getState`) — including as a result of
   * `applyState`. The snapshot is JSON-serializable; debouncing/storage is the consumer's job.
   */
  onStateChange?: (state: TableState) => void;
}

/** Persisted per-column state (see TableState). `width` is the manual resize override; absent = automatic. */
export interface ColumnState {
  hidden: boolean;
  pinned: false | "left" | "right";
  width?: number;
}

/**
 * JSON-serializable snapshot of the user-curated table arrangement: column order, per-column
 * visibility/pinning/manual widths, and the sort list. Ephemeral state (selection, scroll) is
 * deliberately excluded, and so — for now — is filter state, even though the table owns filters
 * now: it churns per keystroke where column arrangement barely churns at all, so it wants a
 * separate `filters` key that `onStateChange` consumers can debounce differently. Every filter's
 * `value`/`setValue` already round-trips through JSON, so adding it is additive.
 *
 * Produced by `getState`, restored by `applyState`, observed by `onStateChange`.
 */
export interface TableState {
  columnOrder: string[];
  columns: Record<string, ColumnState>;
  sorts: ColumnSort[];
}

/**
 * The table's contract with any filter implementation: a reactive predicate over rows. Deliberately
 * structural so the table takes on no dependency — a hand-rolled observable object satisfies it.
 * `undefined` predicate = pass-through (no filtering).
 */
export interface FilterSource<T = RowData> {
  readonly predicate?: (row: T) => boolean;
}

/**
 * The table's contract with a *per-column* filter: a reactive predicate over one already-extracted
 * value. The table calls `matches(column.getValue(row))`, so the filter needs no accessor, no path
 * and no row type — which is what makes a computed column filterable with no extra config.
 *
 * Structural for the same reason as {@link RowSource}: `SetFilter` / `RangeFilter` / `TextFilter`
 * from the `filter` subpath satisfy it, but `table` declares the shape rather than importing the
 * classes, so a page's own `new SetFilter()` is the only thing that pulls them into the bundle. A
 * string discriminant (`filter: "set"`) would force a `"set" -> SetFilter` map into the table and
 * defeat exactly that.
 *
 * Not to be confused with {@link FilterSource}, the *row*-level contract behind `config.filter` —
 * that one is for page dimensions with no column behind them, and both compose (see
 * `TableModel.predicate`).
 */
export interface ColumnFilter {
  /** Whether the filter is currently narrowing anything. Inactive filters are skipped entirely. */
  readonly active: boolean;
  matches(value: unknown): boolean;
  clear(): void;
  /** Seeds the facet domain; its presence also selects the no-walk tier. See `ColumnModel.facets`. */
  readonly options?: readonly unknown[];
  /** Whether facets should carry cross-filtered counts — the expensive tier. */
  readonly counts?: boolean;
}

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
  pinned?: false | "left" | "right";
  width?: ColumnWidth;
  minWidth?: number;
  maxWidth?: number;
  resizable?: boolean;
  /** See BaseColumnDef.sortable — advisory flag for header sort UIs. Defaults to true. */
  sortable?: boolean;
  /** Marks the built-in row-selection column (rendered via `<Table.SelectionCell>`). */
  selection?: boolean;
  /** See BaseColumnDef.filter. */
  filter?: ColumnFilter;
  /** See BaseColumnDef.filterable — advisory flag for header filter UIs. Defaults to true. */
  filterable?: boolean;
  /** See BaseColumnDef.filterOption. */
  filterOption?: (value: unknown) => any;
  /** See BaseColumnDef.searchable. Defaults to true. */
  searchable?: boolean | ((row: RowData) => string);
}

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
  pinned?: false | "left" | "right";
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
   * A filter over this column's values. Attach an instance (`filter: new SetFilter()`), not a
   * factory or a discriminant; the table feeds it `getValue(row)`, so it filters a computed column
   * as readily as a field one.
   *
   * The instance survives everything that rebuilds column definitions — `setRows`, `appendRows`,
   * `setColumns` — because `syncColumns` preserves the `ColumnModel` behind an existing key. It does
   * *not* survive `removeColumn`, which destroys the model; the filter type on a key cannot be
   * swapped at runtime, so use `removeColumn` + `addColumn` if you must.
   */
  filter?: ColumnFilter;
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
   * Label for one facet value in a filter UI. Defaults to `String(value)`.
   *
   * Typed `=> any` rather than `=> ReactNode` for the same reason as `render`: nothing in these
   * types imports React.
   */
  filterOption?: (value: unknown) => any;
  /**
   * Whether the built-in cross-column search reads this column, or a text projection to search
   * instead — `searchable: (r) => fmtTime(r.time)` searches a date column as text rather than as
   * epoch millis. Defaults to true.
   *
   * Applies to hidden columns: it describes the data, not what is on screen.
   */
  searchable?: boolean | ((row: T) => string);
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
  pinned?: false | "left" | "right";
  width?: ColumnWidth;
  minWidth?: number;
  maxWidth?: number;
  resizable?: boolean;
}
