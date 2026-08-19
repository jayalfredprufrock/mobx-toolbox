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
   */
  rows?: T[] | (() => T[]);
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
   * Client-side row filtering. Pass anything exposing a reactive `predicate`; an array is
   * AND-composed (a global search + a filter panel compose without knowing about each other).
   * Filtering runs over `rows` without replacing them, so selection persists. Omit for
   * server-side filtering — react to the source's serialized query and refetch instead.
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
 * visibility/pinning/manual widths, and the sort list. Ephemeral state (selection, scroll) and
 * anything owned elsewhere (filters) is deliberately excluded. Produced by `getState`, restored
 * by `applyState`, observed by `onStateChange`.
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
