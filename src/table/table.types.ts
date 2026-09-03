import type { LazyArray, LazyPages } from "../lazy/lazy";
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

export interface TableConfig<T> {
  /**
   * Where the table's rows come from, in any of three shapes — and they differ in *who decides the
   * rows changed*, which is what decides when row-keyed state resets (see `setData`).
   *
   * Named for what it is rather than for one of its shapes: only the first is literally rows.
   * Whatever you pass, the resolved array is always `table.rows`.
   *
   * **An array** — React decides. `useTable` re-applies it whenever it is a different array than
   * the one last applied, so it must be referentially stable (a MobX `computed`, or `useMemo`).
   * Rebuilding it inline on every render (`data={rows.filter(isActive)}`) reads as a new dataset
   * every time and clears selection with it.
   *
   * **A getter** — MobX decides. `() => store.activeRows` is tracked in a reaction, so it
   * re-applies when the observables it *read* change, on MobX's cadence rather than React's. Two
   * caveats, both silent if missed: the getter must read observables (a getter over React props or
   * state is never re-run, and the table keeps the first dataset forever), and it is captured once
   * — so close over observables, not over render-scoped values, which would go stale.
   *
   * **A lazy** — the lazy decides, and it is the only shape that knows anything beyond the rows
   * themselves. It says whether a request is running and how the last one ended, which is what
   * lets the table tell a first load from an empty result from a failure with nothing to show:
   * see `loading`, `error` and `isEmpty` on the model. A keyed collection works because
   * `store.byOrg({ orgId })` hands back a *different* lazy per key, and the table follows it.
   *
   * With the first two, that same information is yours to supply — see
   * {@link UseTableConfig.loading} and {@link UseTableConfig.error}.
   */
  data?: T[] | (() => T[]) | LazyArray<T> | LazyPages<T, TableQuery>;
  /**
   * Who narrows and orders the rows: this table, or whatever produced them.
   *
   * `"client"` (the default) is the fully-loaded table — it sorts and filters the rows it holds.
   * `"server"` says the rows arrive already narrowed and ordered, and flips three defaults at once:
   *
   * | | `"client"` | `"server"` |
   * | --- | --- | --- |
   * | `sortMode` | `"auto"` — sorted here | `"manual"` — `sorts` is state to send |
   * | each column's `filterMode` | `"client"` | `"server"` — serialized into `filterQuery` |
   * | `search.mode` | `"client"` | `"server"` |
   *
   * They are defaults, not a lock: a column may still say `filterMode: "client"` to narrow what
   * came back, and `sortMode` / `search.mode` override individually.
   *
   * **Inferred when `data` is a paged lazy**, since a table holding one page of fifty thousand rows
   * that sorts what it has is the failure this exists to prevent — it looks like it works. Set it
   * explicitly for any other server-driven dataset: an array you refetch yourself, a query hook.
   *
   * Everything the server needs is then on {@link TableModel.query}, as one structurally-compared
   * object.
   */
  mode?: "client" | "server";
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
   * How the sort list is applied. `"auto"` sorts rows client-side through each column's value
   * accessor / `compare`. `"manual"` treats `sorts` as pure reactive state and leaves row order
   * untouched — send them with the next request instead. The sort state APIs (`setSort`,
   * `clearSort`, `sortDirection`, `sortIndex`) behave identically in both modes, so header sort
   * UIs need no changes.
   *
   * Defaults to `"manual"` under {@link TableConfig.mode} `"server"` and `"auto"` otherwise, so
   * this only needs setting to mix the two — a server-filtered table whose rows all fit, and which
   * would rather sort them here than round-trip.
   */
  sortMode?: "auto" | "manual";
  /** Extra rows rendered above/below the visible window. Default 3. */
  rowOverscan?: number;
  /** Extra columns rendered on either side of the visible window. Default 1. */
  columnOverscan?: number;
  /**
   * Stable row identity, used to key all row-scoped state (selection, expansion) and React row
   * keys. Must be unique per row.
   *
   * Defaults to the row's own **object identity** — one id per distinct row object, held in a
   * `WeakMap` for as long as that object is around. So this is dead config for rows that are
   * identity-mapped model instances: the same record is the same object, and its state survives a
   * reload, an append and a switch between keyed collections for free.
   *
   * Configure it when row objects are **replaced by fresh ones that mean the same row** — a
   * plain-JSON refetch, or a `keys: false` model that is constructed per payload. Without it those
   * rows are new objects with new ids, so `setData` finds none of the old ids and drops the
   * selection with them.
   *
   * For an identity-mapped model, `getRowId: (r) => MyModel.identityKey(r)` is the right spelling
   * rather than `r.id`, which is only there if the schema declared it.
   *
   * ⚠️ Uniqueness is yours to guarantee, and paginated sources are where it breaks: a record
   * returned on two pages produces two rows sharing one id — one React key, and one selection
   * toggle that hits both. Deduplicate at the source (`lazyPages`' `dedupeBy`).
   */
  getRowId?: (row: T, index: number) => RowId;
  /**
   * Configures the built-in cross-column search (`TableModel.search`).
   *
   * `mode: "server"` means the server does the searching: the query stops narrowing rows here and
   * becomes a `{ op: "search" }` entry in `filterQuery` instead. Per-column `searchable` is then
   * irrelevant — the server decides what it searches. Defaults to whichever
   * {@link TableConfig.mode} resolves to.
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
 * What {@link useTable} accepts: everything a {@link TableModel} takes, plus the two status props
 * that stand in for what a lazy would have known by itself.
 *
 * They live here rather than on `TableConfig` because mirroring React state on every render is a
 * thing only a hook can do. A `TableModel` built directly has no render to mirror from, so its
 * answer for a dataset with a loading story is a lazy, which carries its own.
 */
/**
 * The status props that stand in for what a lazy would have known by itself.
 *
 * They exist only on {@link useTable} and not on `TableConfig` because mirroring React state on
 * every render is a thing only a hook can do. A `TableModel` built directly has no render to mirror
 * from, so its answer for a dataset with a loading story is a lazy, which carries its own.
 */
export interface TableStatus {
  /**
   * Whether a request is in flight, for a `data` that cannot say so itself — an array or a getter.
   * **Ignored when `data` is a lazy**, which already knows.
   *
   * What it produces depends on whether there are rows. With none it is a first load, reported as
   * `table.loading`. Behind rows already on screen it is a refresh, which the table deliberately has
   * no state for — the rows stay exactly as they are, and you already know a request is running,
   * since you are the one passing this.
   *
   * Pass it from the first render, not from the first effect. No rows and `loading: false` is a
   * settled empty result by definition, and the table will say so.
   */
  loading?: boolean;
  /**
   * How the last request ended, for a `data` that cannot say so itself. **Ignored when `data` is a
   * lazy.**
   *
   * Read the same way as `loading`: it matters when there are no rows, where it is fatal
   * (`table.error`, what `<Table.Error>` renders) and stops the table reporting a load that will
   * never finish. Behind rows still on screen the table ignores it on purpose — they are good rows,
   * and a failed refresh is not worth blanking them for.
   *
   * Clear it when the next request starts, or the table will keep describing the older failure.
   */
  error?: unknown;
}

/**
 * What {@link useTable} accepts — a `TableConfig`, in one of two combinations that cannot be mixed.
 *
 * A lazy already knows whether a request is running and how the last one ended, so pairing it with
 * `loading` or `error` is a contradiction rather than a preference. Expressed as a union so it is a
 * compile error rather than a prop that silently does nothing: passing both tells you at the call
 * site, which is where the mistake is.
 */
export type UseTableConfig<T> =
  | (TableConfig<T> & { data?: LazyArray<T> | LazyPages<T, TableQuery> } & {
      [K in keyof TableStatus]?: never;
    })
  | (TableConfig<T> & { data?: T[] | (() => T[]) } & TableStatus);

/**
 * Everything a server needs in order to answer for this table: which rows, in what order.
 *
 * Read it as *the work this table is deliberately not doing*. Both halves are already scoped that
 * way, so nothing here duplicates what the table applied itself:
 *
 * - `filters` is {@link TableModel.filterQuery} — only the columns set to `filterMode: "server"`,
 *   plus a server-mode search. A client-side filter narrows `rows` here and never appears.
 * - `sorts` is empty unless `sortMode` is `"manual"`. Under `"auto"` the table has already sorted,
 *   so sending them would ask for work that is done — and would make a client-side sort churn this
 *   object and refetch for nothing.
 *
 * Compared structurally, which is the point of it being one object: its identity is stable while
 * its contents are, so it works directly as a `useEffect` dependency or a query key and a column
 * resize can't trigger a request.
 *
 * ```tsx
 * const query = table.query;
 * useEffect(() => void refetch(query), [query]);
 * ```
 */
export interface TableQuery {
  /** The server-side filter conditions, or `undefined` when none are active. */
  filters: FilterCondition[] | undefined;
  /** The sort list to apply server-side; empty when this table is sorting for itself. */
  sorts: ColumnSort[];
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
 * Structural rather than an `instanceof`: `SetFilter` / `NumberFilter` / `DateFilter` / `TextFilter`
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
  /** See {@link BaseColumnDef.meta}. */
  meta?: ColumnMeta;
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
  /** See BaseColumnDef.filterMode. Defaults to the table's resolved `mode`. */
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

/**
 * Whatever your app knows about a column that the table itself has no use for — the schema field a
 * column was generated from, a unit, a question, a metric definition.
 *
 * Empty by design, and **open for augmentation**: declare what your columns carry and it becomes
 * type-checked at every def and every read of `column.meta`.
 *
 * ```ts
 * declare module "@jayalfredprufrock/mobx-toolbox/table" {
 *   interface ColumnMeta {
 *     question?: SurveyQuestion;
 *   }
 * }
 * ```
 *
 * This exists because a column def could previously say everything about how a column *behaves* and
 * nothing about what it *represents* — so anything rendered about a column rather than about a row
 * had to reconstruct the column's identity from its key, or carry a `Map<key, thing>` alongside the
 * defs. Both re-derive something the def already knew, and the first duplicates the key format,
 * which persisted view state depends on.
 *
 * Spelled `meta` rather than `props` (which is what the equivalent on a filter is called) for two
 * reasons: `column.props` reads as React props on something that is not a component, and this is
 * wider than view concerns — a cell formatting itself from a unit, or a filter reading a choice
 * list, wants the same field.
 *
 * The same rule governs when the library declares a named option instead: only when it *reads* the
 * value, supplies a non-trivial default, or the concept is universal and precisely typable. See
 * {@link SetFilterProps}, which this mirrors.
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmentation point — see above
export interface ColumnMeta {}

export interface BaseColumnDef<T> {
  title?: string;
  /**
   * Application data about this column — see {@link ColumnMeta}. Read through
   * `ColumnModel.meta`, which every render-prop already receives.
   *
   * Unlike `filter`, this **is** re-read from a new def on `setColumns`: what a column represents
   * can legitimately change while its key stays the same (a republished survey rewording a question
   * whose id, and so whose column key, is unchanged). Compared shallowly, so a def rebuilt around
   * the same values is not a change.
   *
   * Excluded from `getState()`: it is structure supplied by the def, not state the user produced,
   * and it may hold things that do not serialize.
   */
  meta?: ColumnMeta;
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
   * Either way the filter survives everything that rebuilds column definitions — `setData`,
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
   * Who applies this column's filter. `"client"` narrows rows here; `"server"` means whoever
   * produced the rows already did.
   *
   * Defaults to whichever {@link TableConfig.mode} resolves to, so a server-driven table needs no
   * per-column annotation — and the default is *resolved through the table* rather than baked in
   * when the column is built, so pointing an existing table at a paged source with `setData` flips
   * its columns with it.
   *
   * The two sets are **disjoint**, which is what makes a mixed table cheap: a server-mode filter is
   * never evaluated client-side, so every filter is applied exactly once, in exactly one place. A
   * server-mode filter contributes to `TableModel.filterQuery` instead of to `predicate`; react to
   * that, refetch, and `setData`. Client filters then narrow the server's results, because the
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
