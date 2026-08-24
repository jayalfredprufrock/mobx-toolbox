# @mobx-toolbox/table

A headless, virtualized data table for MobX + React. The model owns all state — columns, widths, sorting, selection, expansion, the render window — and the components own only structure (grid tracks, sticky pinning, ARIA). Every cosmetic decision is yours.

- **Virtualized both axes.** Only the rows and columns overlapping the viewport reach the DOM.
- **Headless.** The library ships no colors, padding, fonts, or borders. You style through `className`/`style` and a handful of `data-*` hooks.
- **Reactive per cell.** A cell re-renders when the observables _it_ reads change — not when its row or a sibling cell does.

## Setup

```tsx
import { useTable, Table } from "@jayalfredprufrock/mobx-toolbox/table";

function UserTable({ users }) {
  const table = useTable({ rows: users, columns: ["name", "email", "role"] });

  return (
    <Table.Root table={table}>
      <Table.Header>
        {(column) => <Table.ColumnHeader column={column}>{column.title}</Table.ColumnHeader>}
      </Table.Header>
      <Table.Body>
        {(row) => (
          <Table.Row row={row}>
            {(column) => <Table.Cell column={column}>{String(column.getValue(row))}</Table.Cell>}
          </Table.Row>
        )}
      </Table.Body>
    </Table.Root>
  );
}
```

`useTable` creates a `TableModel` once and keeps it across renders. Construct `new TableModel(config)` directly when the table's lifetime is longer than the component's (e.g. a store field).

`<Table.Root>` must be sized by its parent — it fills 100% of it and measures itself. Children render only once a non-zero size is measured.

## The dataset

The config is read once, at construction — **except `rows`**, which `useTable` keeps in sync. It has to: a route's params can change without remounting the page (React reconciles the same component type at the same tree position), so a table that ignored later `rows` would keep rendering the previous org's data.

`rows` takes one of three shapes, and the first two differ in **who decides the dataset changed** — which is what decides when row-keyed state (selection, expansion) resets, since that is `setRows`'s documented job. The third, a **row source**, also carries whether the data is still arriving.

```tsx
// React decides — re-applied when the array identity changes
const rows = useMemo(() => users.filter(isActive), [users]);
useTable({ rows });

// MobX decides — re-applied when the observables the getter read change
useTable({ rows: () => store.filteredRows });
```

| Shape          | Re-applied when                    | Gets it wrong by                                                                                                                                                              |
| -------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `T[]`          | it's a different array than before | rebuilding the array inline each render — every parent render reads as a new dataset (harmless with `getRowId`, since state is intersected; without it, selection is cleared) |
| `() => T[]`    | the observables it _read_ change   | reading something MobX isn't tracking — props, React state, a plain field — in which case it is never re-run and the table silently keeps the first dataset                   |
| `RowSource<T>` | its `value` changes                | nothing much — the table tracks the contents itself                                                                                                                           |

Two more things worth knowing about the getter form: it is captured once, so close over observables rather than render-scoped values, which would go stale; and it must be the _source_ of the rows, not a transform of a prop.

Re-passing the array already in place is a no-op — same array, same dataset — so a re-render never costs you a selection. `rows` is an `observable.ref` either way, so mutating an array in place is invisible to the model; hand over a new one.

### Selection, filtering, and what counts as "selected"

Selection is keyed to a row **existing**, not to it being visible:

- **Filtering something out does not deselect it.** Filters run over `rows` without replacing them, so
  a hidden row is still selected and comes back when the filter changes.
- **A row leaving the dataset does deselect it.** `setRows` intersects selection against the incoming
  rows, so a record that is genuinely gone doesn't linger in the selection.

The two populations are both available, and mixing them up is where the bugs are:

| accessor              | population                        | use it for                          |
| --------------------- | --------------------------------- | ----------------------------------- |
| `selectedRows`        | everything selected, filter aside | a bulk action over the user's picks |
| `visibleSelectedRows` | selection ∩ the filter            | a bulk action over what's on screen |

`allRowsSelected` / `someRowsSelected` — the header checkbox's state — derive from
`visibleSelectedRows`, so a selection hidden behind a filter can never report the header as fully
checked while nothing on screen is selected. `selectAllRows` and `toggleAllRows` likewise operate on
the visible rows.

The ecosystem is genuinely split on the first point: TanStack Table persists selection through
filtering ("row selection state can contain row ids that are not present in the `data` array just
fine") and exposes both populations; MUI's Data Grid clears filtered-out rows by default, with
`keepNonExistentRowsSelected` to opt out. This table takes the middle: persist through a _view_
change, prune on a _dataset_ change.

That distinction only stays decidable while filtering lives **inside** the table. Filter outside it —
hand over `rows: () => all.filter(pred)` — and the table cannot tell "filtered out" from "deleted",
so neither behaviour is right. Use `setFilter` / `config.filter` and keep `rows` as the dataset.

### Row-keyed state across a refresh

With `getRowId`, `setRows` **intersects** selection and expansion against the incoming rows instead of clearing them: ids that still resolve to a row stay, the rest drop. So a refetch, a poll, or a store invalidation arrives without costing the user their selection, while genuinely switching datasets still drops it, because none of the old ids resolve.

Without `getRowId` the ids are row _positions_, which must not silently attach to different rows, so state is cleared outright. **If your rows come from a source that refreshes, configure `getRowId`.**

### Binding to a lazy observable

Hand the lazy over whole:

```tsx
useTable({ rows: surveyStore.all, getRowId: (s) => s.id });
```

The table tracks the array's contents itself, so there is no `.slice()` to remember — and this is
the only form that can tell **a first load from an empty result**, which is what drives
[loading and empty states](#loading-and-empty-states).

It is structural, not a dependency: `table` declares the shape it needs and never imports
`lazy-observable`.

```ts
interface RowSource<T> {
  value: T[] | undefined; // undefined while nothing has arrived
  fetching: boolean; // a request is in flight, refreshes included
}
```

A `LazyObservableArray` satisfies it, and so does anything else with those two properties.

Reading `value` is what marks the lazy observed and starts the fetch — which works even before there
is a value, so the table binding drives the first load.

A getter still works when the rows are _derived_ rather than handed over:

```tsx
useTable({ rows: () => store.all.value?.filter(isActive) ?? [], getRowId: (s) => s.id });
```

That produces a new array on each load, so `setRows` re-applies the dataset — fine, because with
`getRowId` selection is intersected rather than cleared. It carries no loading information, though,
so `table.loading` stays `false`.

(`table.loading` and `table.refreshing` are the table's own state, unrelated to any property on a
lazy — the table reads `value` and `fetching` off the source and derives the rest.)

**`getRowId` is worth configuring, but it is no longer the difference between working and not.**
Without it, a row's id is its own object identity — see [row identity](#row-identity) — so anything
identity-mapped keeps its selection across a reload for free.

`src/table/lazy-binding.test.ts` pins these behaviours.

### Rows that take parameters

Two shapes, and which you want depends on where the parameters live.

**Component state — a filter, a search box:** `useCollection` with `params`. One lazy for the
component's lifetime; a param change refetches _inside_ it, so the table keeps the same source and
simply follows its contents:

```tsx
const rows = useCollection(
  SurveyModel,
  ({ orgId }, options) => api.listSurveys({ orgId, ...options }),
  {
    params: { orgId },
  },
);
const table = useTable({ rows, getRowId: (s) => s.id });
```

**A shared store, keyed — per tenant, per parent record:** `collectionMap`. Each key is its own
lazy, so `store.byOrg({ orgId })` hands over a **different** object when `orgId` changes, and the
table re-points at it:

```tsx
const table = useTable({ rows: store.byOrg({ orgId }), getRowId: (s) => s.id });
```

Both work through `useTable` without a `useMemo` — passing it in render is fine, because a source is
compared by identity and the keyed map returns the same lazy for the same key.

Two behaviours worth expecting from the keyed form:

- **Returning to a key refetches.** `keepOnUnobserved` defaults to `false`, so a key's list drops its
  rows the moment the table stops reading it. Pass `keepOnUnobserved` on the collection to hold them.
- **Selection is intersected, not carried.** With `getRowId`, an id that still resolves to a row
  survives the switch and one that does not is dropped — so a selection never points at a row from
  the previous key.

Driving a `TableModel` directly rather than through `useTable`? `setRowSource(rows)` is the same
re-pointing, for when the binding it was constructed with is no longer the right one.

### Loading and empty states

Given a row source, the table distinguishes four states — and the one that used to need hand-wiring
is the first:

| state                                 | `loading` | `refreshing` | `isEmpty` |
| ------------------------------------- | --------- | ------------ | --------- |
| nothing loaded yet, request in flight | `true`    | `false`      | `false`   |
| rows present, request in flight       | `false`   | `true`       | `false`   |
| settled, zero rows                    | `false`   | `false`      | `true`    |
| rows present, idle                    | `false`   | `false`      | `false`   |

`isEmpty` is `false` during a first load, so a table can no longer claim "no results" while it is
still fetching them. Without a row source, `loading` and `refreshing` are always `false` — an array
or a getter carries no notion of loading, and the table does not invent one.

**A refresh keeps its rows.** They stay rendered and fully interactive, because replacing them to
fetch mostly-identical rows would throw away scroll position, column arrangement and selection. Use
`table.refreshing` to indicate it somewhere that isn't the rows themselves — and don't dim them,
which reads as _disabled_.

Everything else (`columns`, `getRowId`, `onStateChange`, `filter`) is captured at construction. Change those through the model — `setFilter`, `applyState` — rather than by re-rendering.

## Columns

`columns` accepts four shapes, mixed freely:

```ts
const table = useTable({
  rows,
  columns: [
    "name", // field column, title-cased header ("Name")
    "owner.email", // dot-path into a nested value
    { key: "role", title: "Access level", width: 160, pinned: "left" },
    { key: "fullName", value: (row) => `${row.first} ${row.last}` }, // computed
    { selection: true }, // the built-in checkbox column
    (firstRow) => Object.keys(firstRow.metrics).map((k) => `metrics.${k}`), // dynamic
  ],
});
```

A function entry is a **factory**: it receives the first row and returns one or more defs, for datasets whose shape is only known at runtime. Factories are skipped while there is no data and re-run on `setRows`/`appendRows`.

`value` feeds sorting and the default render; `render` overrides display only. Sorting therefore always goes through `value`, never a raw `row[key]` lookup.

### `autoColumns` — a column per key you didn't configure

```ts
useTable({
  rows,
  columns: [{ key: "name", width: 240, pinned: "left" }], // the ones you care about
  autoColumns: (key, value) => {
    if (key.startsWith("_") || key === "id") return false; // never show these
    if (typeof value === "number") return { key, width: 100 }; // configure these
    return true; // default treatment for the rest
  },
});
```

Every key on the first row that `columns` doesn't already cover goes through `autoColumns`. Return a
def to configure that column, `true` for the default (the key as a field column), or `false` to leave
it out.

`autoColumns` **defaults to `true` when `columns` is omitted** — so `useTable({ rows })` still gives
you a working table — and to `false` when it isn't. Set it explicitly to get both, which is the point:
configuring one column no longer costs you automatic generation of the rest.

Auto columns follow the data. They appear as keys appear and go as keys go, which is what makes a
table bound to a list that loads _after_ construction fill in its columns when the data arrives. For a
fixed set, use an allowlist inside the function.

### Changing the columns at runtime

```ts
table.setColumns(defs); // replace the curated set
table.addColumn(def, index?); // add one, optionally at a display position
table.removeColumn(key); // take one out
```

Columns that survive a change keep everything the user did to them — display position, visibility,
pinning, manual width. Columns that go leave their sort-list entries in place but inert, so restoring
the column restores its sort.

The three are independent of `autoColumns`, and none of them switch it off:

- `addColumn` adds to a separate list, so auto columns keep being generated alongside it.
- `removeColumn` records a **suppression** rather than editing a def list, so the removal survives
  re-derivation instead of being undone by the next `setRows`.
- `setColumns` is a full reset of the curated set: runtime additions and suppressions go with it. It
  _does_ stop auto-generation, because `autoColumns` defaults to off once columns are configured —
  pass `autoColumns: true` if you want both.

Adding back a suppressed column lifts the suppression rather than duplicating its def. Adding a key
that already has a column throws — two columns cannot share a key, since the second would silently
replace the first.

One thing to know: `removeColumn` destroys the `ColumnModel`, so `addColumn` rebuilds it from the def.
Runtime tweaks to that column (a `setPinned`, a `setManualWidth`) are lost; only a persisted snapshot
is re-applied.

### Ordering

`order` on a def is declarative placement, like CSS `order`: lower comes first, default `0`, and
columns sharing a value keep their relative position — configured columns before auto ones.

```ts
columns: [{ key: "actions", value: renderActions, order: 10 }], // after everything else
autoColumns: (key, value) => ({ key, order: typeof value === "number" ? 5 : 0 }),
```

It decides where a column **lands**, not where it stays. Precedence, strongest first:

1. a persisted snapshot restored through `applyState` — what the user last did
2. anything the user has since dragged (`moveColumn`)
3. `order`
4. the def sequence

Concretely: on the sync where the columns first materialize, `order` sorts them outright. Afterwards
surviving columns stay where they are, and a column appearing later is **inserted** at the position its
`order` implies — immediately before the first column that should come after it — rather than appended.
So `order` is never re-applied over a rearrangement.

For keeping a column at an edge, reach for `pinned` instead. Pinned columns are anchored to their edge
regardless of order, so `{ key: "actions", pinned: "right" }` stays right even after the user
rearranges everything else. `order` is for the unpinned middle, which is the case pinning can't
express.

### Widths

Each column is either **fixed** (`width: 240`) or **flex** (`width: "2fr"`, the default being `"1fr"`). Fixed columns claim their pixels; flex columns split the remainder by weight, clamped to `minWidth` (default 120) and `maxWidth`. A column that hits a clamp freezes and its share is redistributed among the rest.

Leftover slack — every flex column capped at its max — is absorbed by the last column, so the columns always fill the viewport with no gap. When the minimums don't fit, the total exceeds the viewport and the table scrolls horizontally.

`column.setManualWidth(px)` (what `<Table.Resizer>` does) makes a column fixed at that width; `setManualWidth(undefined)` returns it to auto.

### Pinned column arrays are outer-edge-first

`leftPinnedRenderedColumns`, `rightPinnedRenderedColumns`, and `unpinnedColumns` are all filtered
views of one ordered set, so order within each group comes from the same place — `order`, dragging, or
a restored snapshot. Pinning only decides which group a column is in.

Both pinned arrays are ordered **outward-edge first**, which means `rightPinnedRenderedColumns` runs
right-to-left. That is what lets one `offset` calculation serve both sides — it measures from each
group's own edge, spent as `left: offset` or `right: offset`. If you want plain left-to-right, use
`visualColumns`, which is also what `aria-colindex` is derived from.

## Sorting

```tsx
<Table.ColumnHeader column={column}>
  {column.title}
  {column.sortable && (
    <button onClick={() => column.sortBy(column.sortDirection === "asc" ? "desc" : "asc")}>
      {column.sortDirection ?? "—"} {column.sortIndex}
    </button>
  )}
</Table.ColumnHeader>
```

`sorts` is a priority list: earlier entries win, later ones break ties. `setSort(key, dir)` replaces it (single-sort); `setSort(key, dir, { preserve: true })` keeps existing sorts, flipping a column already in the list in place. `column.sortIndex` is the 1-based badge for multi-sort UIs.

`sortable: false` is advisory — it's for hiding header controls. The model's sort APIs are never gated, so `setSort` and `applyState` still work.

For **server-side sorting**, set `sortMode: "manual"`. Sort state behaves identically (so header UIs need no changes) but row order is left untouched — react to `sorts`, refetch, and `setRows`.

## Selection

Add `{ selection: true }` to `columns` and render the two selection parts:

```tsx
<Table.Header>
  {(column) =>
    column.selection ? (
      <Table.SelectionHeaderCell column={column} />
    ) : (
      <Table.ColumnHeader column={column}>{column.title}</Table.ColumnHeader>
    )
  }
</Table.Header>
```

```tsx
{
  (column) =>
    column.selection ? (
      <Table.SelectionCell column={column} row={row} />
    ) : (
      <Table.Cell column={column}>{String(column.getValue(row))}</Table.Cell>
    );
}
```

The default control is a native `<input type="checkbox">`. Register your own once on `<Table.Root checkbox={MyCheckbox}>` (it receives `{ checked, indeterminate?, onChange }`), or pass a render-prop to a single `<Table.SelectionCell>` / `<Table.SelectAll>`.

Selection is keyed by **row id**, not row reference, so it survives sorting, filtering, and `appendRows`. Read it via `table.selectedRows` / `table.selectedIds`.

### Row identity

Row-keyed state — selection, expansion — is keyed by a row id. Where that id comes from decides what
survives a reload.

**Without `getRowId`**, the id is the row's own **object identity**. A dataset that hands back the
same objects keeps its state; one that rebuilds them drops it. That makes the common case work with
no configuration at all, because every identity-mapped record is the same instance each time:

```tsx
// no getRowId: selection follows the record through a refetch, a poll, a re-sort
useTable({ rows: surveyStore.all });
```

**With `getRowId`**, the id comes from the data, so the same _record_ survives even when it arrives
as a **different object** — a plain-JSON refetch, anything not identity-mapped:

```tsx
useTable({ rows, getRowId: (s) => s.id });
```

| your rows are…                        | without `getRowId` | with it  |
| ------------------------------------- | ------------------ | -------- |
| identity-mapped records (same object) | selection survives | survives |
| rebuilt objects for the same records  | selection drops    | survives |

Either way it is never _wrong_: a stale id resolves to nothing rather than to whatever row now sits
in that position.

> The default used to be the row's **index**. That was only safe while the dataset was re-applied
> wholesale — a source that replaces its contents in place, which is what every
> `LazyObservableArray` does, would leave a selected index pointing at whatever row later occupied
> the slot. Object identity has no such failure mode.

#### The same id keys React

`<Table.Body>` keys each row on its row id, so whatever identifies a row for selection also
identifies it to React. That means the id decides how a change to the dataset is _rendered_:

| dataset changes         | with a stable id                      | with an index           |
| ----------------------- | ------------------------------------- | ----------------------- |
| rows reordered          | React **moves** the nodes             | rewrites their contents |
| a row's values change   | that row's node updates               | same                    |
| rows replaced by copies | new nodes (nothing claims they match) | contents rewritten      |

Reusing a node and rewriting its contents is the index-as-key antipattern: it costs focus, caret
position, and any transition mid-flight. Identity ids avoid it without configuration, and `getRowId`
extends the same benefit to records that arrive as new objects.

**One row, twice.** The same object appearing twice in a dataset gets one id for both occurrences
and React warns about the duplicate key. That is inherent to identifying a row by _what it is_ —
`getRowId` has the same problem when it returns the same value twice — so a dataset where a row can
legitimately repeat needs an id that distinguishes the occurrences.

#### Why not sniff for an `id` property

It would be a silent correctness bug waiting to happen: a dataset whose `id` is not unique — or is
an id of something else, a parent, a type — would merge two rows' state with nothing to signal it.
The table has no way to check the guess, and the failure would show up as a mysteriously shared
selection. Object identity is always true, and `getRowId` is there for when you want value identity
and can say so.

## Expansion

Render a detail panel as a sibling right after the row, gated on `isRowExpanded`:

```tsx
<Table.Body>
  {(row) => (
    <>
      <Table.Row row={row} onClick={() => table.toggleRowExpanded(row)}>
        {(column) => <Table.Cell column={column}>{String(column.getValue(row))}</Table.Cell>}
      </Table.Row>
      {table.isRowExpanded(row) && (
        <Table.Expansion row={row}>
          <OrderDetail order={row} />
        </Table.Expansion>
      )}
    </>
  )}
</Table.Body>
```

Panel height is the fixed `expansionHeight` (default 320) — never measured, which is what keeps virtualization closed-form. Taller content scrolls inside the panel. Set `expandMode: "single"` to make expanding one row collapse the others.

## Filtering

Pass anything exposing a reactive `predicate`; an array is AND-composed, so a global search box and a filter panel compose without knowing about each other.

```ts
class Search {
  term = "";
  constructor() {
    makeAutoObservable(this);
  }
  get predicate() {
    return this.term ? (row) => row.name.includes(this.term) : undefined;
  }
}

useTable({ rows, filter: [new Search(), statusFilter] });
```

Filtering runs over `rows` without replacing them, so selection persists through it. For server-side filtering, omit `filter` and refetch instead.

## Persisting the arrangement

`getState()` returns a JSON-serializable snapshot of the _user-curated_ arrangement: column order, per-column visibility/pinning/manual widths, and the sort list. Ephemeral state (selection, scroll, expansion) is deliberately excluded.

```ts
const table = useTable({
  rows,
  onStateChange: (state) => localStorage.setItem("users.table", JSON.stringify(state)),
});

useMountEffect(() => {
  const saved = localStorage.getItem("users.table");
  if (saved) table.applyState(JSON.parse(saved));
});
```

`applyState` accepts partial snapshots and tolerates drift: keys with no matching column are held aside and applied if that column later appears (so restoring before the first `setRows` works), and columns the snapshot doesn't mention keep their state, ordered after the ones it does. Debouncing and storage are yours.

## Scrolling

```ts
table.scrollToRow(row); // row's block top to the viewport top
table.scrollToRow(row, "bottom"); // its block end to the viewport bottom
table.scrollToEnd(); // resolved at execution time — the live-tail follow position
table.atEnd; // within one row of the end (e.g. to decide whether to keep following)
```

The model records the intent; `<Table.Root>` executes it against the scroll container.

## Styling

The library sets only structural CSS. Hook your styles onto:

| Hook                                   | Where                | Meaning                                           |
| -------------------------------------- | -------------------- | ------------------------------------------------- |
| `[data-pinned="left"\|"right"]`        | header + body cells  | The cell is pinned to that side                   |
| `[data-pinned-edge]`                   | header + body cells  | Innermost pinned cell — hang the seam shadow here |
| `[data-pinned-corner="left"\|"right"]` | header + body cells  | Outermost pinned cell — round its outer corner    |
| `[data-selected]` / `[data-expanded]`  | body rows            | Row is selected / expanded                        |
| `[data-expansion]`                     | expansion row + cell | The detail panel                                  |
| `[data-empty]`                         | empty surface        | The empty state                                   |
| `[data-resizing]`                      | `.column-resizer`    | A resize drag is in progress                      |
| `.table-header`, `.table-viewport`     | structure            | The sticky header group / outer wrapper           |

Pinned cells must be opaque because they overlap scrolling ones. Set `--table-pinned-bg` to your surface color (it defaults to the system `Canvas`), and override it inside the header to match a header background.

The library reads `--table-viewport-width` (set by `<Table.Root>`) for the pieces that pin horizontally, and exposes `--table-row-height`. `<Table.Empty>` also honors `--table-header-height` / `--table-header-gap` when computing its height.

## Empty and loading slots

Both gate themselves. Render them after `<Table.Body>` and they appear only when they should:

```tsx
<Table.Body>{...}</Table.Body>
<Table.Empty>{table.rows.length ? "No matches" : "No users yet"}</Table.Empty>
<Table.Loading><Skeleton /></Table.Loading>
```

The library decides **when**; you decide **what**. That split is the point: the gate can't know
whether "empty" means no data or a filter that matched nothing, so that distinction lives in the
children — where it costs no API.

**Telling "no data" from "filtered to nothing"** is `rows` versus `displayRows`. `rows` is the
dataset _before_ filtering, and inside `<Table.Empty>` there is nothing on screen by definition — so
any rows at all mean the filter is what emptied it:

| `rows.length` | means                                       |
| ------------- | ------------------------------------------- |
| `0`           | there is no data                            |
| `> 0`         | there is data, and the filter hid all of it |

There is no `isFiltered` flag on purpose. It would have to pick between "a filter is configured" and
"a filter is currently excluding rows", and only the second is the question being asked here —
which `rows.length` already answers exactly, without the ambiguity.

One case it can't answer: if your filtering happens **server-side**, the rows never arrive in the
first place, so `rows.length` is `0` and the slot reads as "no data". Track the query yourself
there — the table only knows about the filters it was given.

`<Table.Empty>` shows only when `table.isEmpty`, so it stays out of the way during a first load.
`<Table.Loading>` shows only when `table.loading`, and only once the wait has lasted long enough to
be worth mentioning — a fast load renders nothing at all rather than flashing a skeleton. Pass
`sustain={false}` to show it immediately, or `sustain={{ after: 100 }}` to retune it; the timing is
[`useSlowLoading`](../util/README.md#useslowloading).

Both own placement only — filling the viewport below the sticky header and pinning horizontally.
Cosmetics are yours; `data-empty` and `data-loading` are the styling hooks.

## Resizing

Drop a `<Table.Resizer>` inside a header cell. It handles the drag (on the correct edge for right-pinned columns), and double-click resets the column to automatic width.

```tsx
<Table.ColumnHeader column={column}>
  {column.title}
  {column.resizable && <Table.Resizer column={column} />}
</Table.ColumnHeader>
```

## API notes

`TableModel` state worth reading in an `observer`:

| Member                                  | Description                              |
| --------------------------------------- | ---------------------------------------- |
| `rows` / `filteredRows` / `displayRows` | source → filtered → filtered + sorted    |
| `renderedRows` / `renderedColumns`      | the current window                       |
| `allColumns` / `orderedColumns`         | every column / the visible ones in order |
| `selectedRows` / `selectedIds`          | selection                                |
| `sorts`                                 | the sort priority list                   |
| `virtualWidth` / `virtualHeight`        | full scroll extent                       |

Mutations all go through actions: `setRows`, `appendRows`, `setFilter`, `setSort`/`setSorts`/`clearSort`, `toggleRow`/`selectAllRows`/`toggleAllRows`/`clearSelection`, `toggleRowExpanded`/`collapseAllRows`, `moveColumn`, `applyState`, `scrollToRow`/`scrollToEnd`.

`ColumnModel`: `key`, `title`, `width`, `pinned`, `hidden`, `sortDirection`, `sortIndex`, `sortable`, `resizable`, `getValue(row)`, `setPinned`, `setHidden`, `setManualWidth`, `sortBy`, `clearSort`.

When you build the model yourself rather than via `useTable`, call `dispose()` to drop the model's reactions — `onStateChange`, and the one tracking a getter `rows` — and `activate()` to re-arm them. A `TableModel` built directly with an **array** `rows` applies it once, at construction: identity-based syncing is `useTable`'s job, so update it with `setRows`. The getter form needs no such help; it tracks its source wherever the model lives.
