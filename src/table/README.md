# @mobx-toolbox/table

A headless, virtualized data table for MobX + React. The model owns all state — columns, widths, sorting, selection, expansion, the render window — and the components own only structure (grid tracks, sticky pinning, ARIA). Every cosmetic decision is yours.

- **Virtualized both axes.** Only the rows and columns overlapping the viewport reach the DOM.
- **Headless.** The library ships no colors, padding, fonts, or borders. You style through `className`/`style` and a handful of `data-*` hooks.
- **Reactive per cell.** A cell re-renders when the observables _it_ reads change — not when its row or a sibling cell does.

## Setup

```tsx
import { useTable, Table } from "@jayalfredprufrock/mobx-toolbox/table";

function UserTable({ users }) {
  const table = useTable({ data: users, columns: ["name", "email", "role"] });

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

The config is read once, at construction — **except `data`**, `loading` and `error`, which `useTable` keeps in sync. It has to: a route's params can change without remounting the page (React reconciles the same component type at the same tree position), so a table that ignored later `data` would keep rendering the previous org's rows.

`data` takes one of three shapes. Two of them differ in **who decides the dataset changed** — which is what decides when row-keyed state (selection, expansion) resets, since that is `setData`'s documented job. The third, a **lazy**, also carries whether the data is still arriving.

The field is named for what it is rather than for one of its shapes: only the first is literally rows. Whatever you pass, the resolved array is always `table.rows`.

```tsx
// React decides — re-applied when the array identity changes
const rows = useMemo(() => users.filter(isActive), [users]);
useTable({ data: rows });

// MobX decides — re-applied when the observables the getter read change
useTable({ data: () => store.filteredRows });

// the lazy decides — and it also knows whether a request is running
useTable({ data: store.activeUsers });
```

| Shape          | Re-applied when                    | Gets it wrong by                                                                                                                                                              |
| -------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `T[]`          | it's a different array than before | rebuilding the array inline each render — every parent render reads as a new dataset (harmless with `getRowId`, since state is intersected; without it, selection is cleared) |
| `() => T[]`    | the observables it _read_ change   | reading something MobX isn't tracking — props, React state, a plain field — in which case it is never re-run and the table silently keeps the first dataset                   |
| `LazyArray<T>` | its `value` changes                | nothing much — the table tracks the contents itself                                                                                                                           |

Two more things worth knowing about the getter form: it is captured once, so close over observables rather than render-scoped values, which would go stale; and it must be the _source_ of the rows, not a transform of a prop.

Re-passing the array already in place is a no-op — same array, same dataset — so a re-render never costs you a selection. `rows` is an `observable.ref` either way, so mutating an array in place is invisible to the model; hand over a new one.

### Selection, filtering, and what counts as "selected"

Selection is keyed to a row **existing**, not to it being visible:

- **Filtering something out does not deselect it.** Filters run over `rows` without replacing them, so
  a hidden row is still selected and comes back when the filter changes.
- **A row leaving the dataset does deselect it.** `setData` intersects selection against the incoming
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

That distinction only stays decidable while filtering lives **inside** the table (a column's
`filter` or the built-in `search`). Filter outside it —
hand over `data: () => all.filter(pred)` — and the table cannot tell "filtered out" from "deleted",
so neither behaviour is right. Keep `rows` as the dataset and filter through the table.

### Row-keyed state across a refresh

With `getRowId`, `setData` **intersects** selection and expansion against the incoming rows instead of clearing them: ids that still resolve to a row stay, the rest drop. So a refetch, a poll, or a store invalidation arrives without costing the user their selection, while genuinely switching datasets still drops it, because none of the old ids resolve.

Without `getRowId` the ids are row _positions_, which must not silently attach to different rows, so state is cleared outright. **If your rows come from a source that refreshes, configure `getRowId`.**

### Binding to a lazy observable

Hand the lazy over whole:

```tsx
useTable({ data: surveyStore.all, getRowId: (s) => s.id });
```

The table tracks the array's contents itself, so there is no `.slice()` to remember — and this is
the only form that can tell **a first load from an empty result**, which is what drives
[loading, empty and error states](#loading-empty-and-error-states).

The dependency is **type-only**: `table` imports `LazyArray` as a type and never touches
`lazy` at runtime, so handing the table arrays costs you none of that module.

Reading `value` is what marks the lazy observed and starts the fetch — which works even before there
is a value, so the table binding drives the first load.

A getter still works when the rows are _derived_ rather than handed over:

```tsx
useTable({ data: () => store.all.value?.filter(isActive) ?? [], getRowId: (s) => s.id });
```

That produces a new array on each load, so `setData` re-applies the dataset — fine, because with
`getRowId` selection is intersected rather than cleared. It carries no loading information, though,
so `table.loading` stays `false`.

(`table.loading` and `table.error` are the table's own state, unrelated to any property on a lazy —
the table reads `value`, `fetching` and `error` off the source and derives the rest.)

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
const table = useTable({ data: rows, getRowId: (s) => s.id });
```

**A shared store, keyed — per tenant, per parent record:** `collectionMap`. Each key is its own
lazy, so `store.byOrg({ orgId })` hands over a **different** object when `orgId` changes, and the
table re-points at it:

```tsx
const table = useTable({ data: store.byOrg({ orgId }), getRowId: (s) => s.id });
```

Both work through `useTable` without a `useMemo` — passing it in render is fine, because a source is
compared by identity and the keyed map returns the same lazy for the same key.

Two behaviours worth expecting from the keyed form:

- **Returning to a key refetches.** `keepOnUnobserved` defaults to `false`, so a key's list drops its
  rows the moment the table stops reading it. Pass `keepOnUnobserved` on the collection to hold them.
- **Selection is intersected, not carried.** With `getRowId`, an id that still resolves to a row
  survives the switch and one that does not is dropped — so a selection never points at a row from
  the previous key.

Driving a `TableModel` directly rather than through `useTable`? `setData(data)` is the same
re-pointing, for when the binding it was constructed with is no longer the right one.

### Loading, empty and error states

The table derives three states, and they are mutually exclusive by construction — so ordering the
slots that render them is not your problem:

| state                               | `loading` | `error`     | `isEmpty` |
| ----------------------------------- | --------- | ----------- | --------- |
| nothing yet, nothing failed         | `true`    | `undefined` | `false`   |
| the request failed, nothing to show | `false`   | the error   | `false`   |
| settled, zero rows                  | `false`   | `undefined` | `true`    |
| rows present                        | `false`   | `undefined` | `false`   |

`isEmpty` is `false` during a first load _and_ after a failure, so a table never claims "no results"
about rows it is still fetching or never got. `loading` excludes a failure for the same reason: a
failed first load used to leave the spinner up forever, since nothing was ever going to arrive to
take it down.

**A refresh keeps its rows, and the table says nothing about it.** They stay rendered and fully
interactive, because replacing them to fetch mostly-identical rows would throw away scroll position,
column arrangement and selection. A request running behind rows the table already has is not its
business — whoever owns the fetching knows about it (`refreshing` on a lazy, `isFetching` on a
query) and can indicate it somewhere that isn't the rows themselves. Don't dim them, which reads as
_disabled_.

The same goes for a **failed** refresh: `table.error` stays `undefined`, the rows stay put, and the
error is still wherever you keep it. Only a failure with nothing to show is the table's business.

#### Controlled: the same states without a lazy

A lazy works all of this out itself. If your loading state lives outside MobX instead — TanStack
Query, SWR, a plain `useEffect` — pass it and get the identical states:

```tsx
const query = useQuery(...);
const table = useTable({ data: query.data, loading: query.isFetching, error: query.error });
```

Which form you are in is decided by what `data` is: a lazy is authoritative about itself, anything
else needs telling. Rows win when there are any, and `loading`/`error` decide what an empty-looking
dataset means — so `data={[]} loading` is a first load rather than a settled empty result, which is
the "No results" flash a lazy avoids for free.

Pairing a lazy with `loading` or `error` is a **compile error**, not a silently ignored prop. A lazy
already knows, so passing both is a contradiction rather than a preference, and the type says so at
the call site.

Pass `loading` from the first render, not from the first effect: no rows and `loading: false` is a
settled empty result by definition, and the table will say so.

#### Reaching the lazy: `table.lazy`

A component handed a `TableModel` and nothing else — a generic table wrapper, a toolbar rendered
from context — can ask whether its dataset is refreshable, and get the concrete lazy if it is:

```tsx
const RefreshButton = observer(({ table }: { table: TableModel }) => {
  const lazy = table.lazy;
  if (!lazy) return null; // an array or a getter: nothing to refresh, offer nothing

  const failed = lazy.loaded && lazy.error !== undefined;
  return (
    <IconButton
      onClick={() => void lazy.reload().catch(() => toast.error("Couldn't refresh"))}
      data-spinning={lazy.fetching}
      data-error={failed}
    />
  );
});
```

It is the real `LazyArray`, not a structural stand-in, so the whole API is there —
`reload()`, `refreshing`, `invalidate()`, `fetchedAt`.

`fetching` covers requests the lazy started _by itself_ — revalidating on reobservation, a
`reloadEvery` tick — not just ones you triggered, so the indicator is honest about background work.
(The warning on a lazy's own `fetching` is narrower than it looks: reading it doesn't mark the lazy
_observed_, so it can't keep one alive or trigger a load. A mounted table is already observing its
lazy, so reading through here is safe.)

`lazy.loaded && lazy.error` is the failed-refresh split — rows still on screen, last request failed.
The table itself declines to make that call, which is why `<Table.Error>` stays out of the way for
it. And `reload()` rejects, so `.catch()` is the toast; a background revalidation has no promise to
reject, so if you want those surfaced too, react to `lazy.error` instead.

There is deliberately no `table.refresh()`, no `table.refreshing`, and no refresh error state. Every
one of those would re-derive something the owner of the fetching already has, and the lazy is right
here for the one caller that doesn't.

Everything else (`columns`, `getRowId`, `onStateChange`) is captured at construction. Change those through the model — `setColumns`, `applyState` — rather than by re-rendering. Column filters need none of this: they are instances you hold, so you mutate them directly.

## Columns

`columns` accepts four shapes, mixed freely:

```ts
const table = useTable({
  data: rows,
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

A function entry is a **factory**: it receives the first row and returns one or more defs, for datasets whose shape is only known at runtime. Factories are skipped while there is no data and re-run on `setData`/`appendRows`.

`value` feeds sorting and the default render; `render` overrides display only. Sorting therefore always goes through `value`, never a raw `row[key]` lookup.

### `autoColumns` — a column per key you didn't configure

```ts
useTable({
  data: rows,
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

`autoColumns` **defaults to `true` when `columns` is omitted** — so `useTable({ data: rows })` still gives
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
table.column(key)?.setConfig(patch); // change one column's options in place
```

Columns that survive a change keep everything the user did to them — display position, visibility,
pinning, manual width. Columns that go leave their sort-list entries in place but inert, so restoring
the column restores its sort.

The three are independent of `autoColumns`, and none of them switch it off:

- `addColumn` adds to a separate list, so auto columns keep being generated alongside it.
- `removeColumn` records a **suppression** rather than editing a def list, so the removal survives
  re-derivation instead of being undone by the next `setData`.
- `setColumns` is a full reset of the curated set: runtime additions and suppressions go with it. It
  _does_ stop auto-generation, because `autoColumns` defaults to off once columns are configured —
  pass `autoColumns: true` if you want both.

Adding back a suppressed column lifts the suppression rather than duplicating its def. Adding a key
that already has a column throws — two columns cannot share a key, since the second would silently
replace the first.

One thing to know: `removeColumn` destroys the `ColumnModel`, so `addColumn` rebuilds it from the def.
Runtime tweaks to that column (a `setPinned`, a `setManualWidth`) are lost; only a persisted snapshot
is re-applied.

### Changing one column's options

`setColumns` deliberately **cannot** do this: it keeps the `ColumnModel` behind a key it already has,
so a new def for an existing key is ignored wholesale. That is exactly what preserves the column's
position, width, pinning and filter through a def change — so patching is a separate operation:

```ts
table.column("amount")?.setConfig({ title: "Total", width: 320 });
```

This is how you drive a column option from something the table wasn't constructed with — React state
or a prop, which `useTable` reads only once:

```tsx
useEffect(() => table.column("amount")?.setConfig({ title: label }), [label]);
```

`config` is an `observable.ref` replaced wholesale by the patch, so every getter over it —
`title`, `width`, `sortable`, `filterable`, the lot — is genuinely reactive. Everything the user has
done to the column survives, because `hidden`, `pinned` and `manualWidth` are state rather than
configuration, and so is a filter's selection.

Three options can't be patched, and are compile errors rather than runtime guards:

| Option      | Why                                                                               |
| ----------- | --------------------------------------------------------------------------------- |
| `key`       | identifies the column in `columns`, `columnOrder`, the sort list and any snapshot |
| `filter`    | holds the user's live selection; replacing the instance would silently discard it |
| `selection` | decides which components render the column at all                                 |

To change a filter's _type_, use `removeColumn` + `addColumn`. To change its _state_, set it on the
filter.

One coupling worth knowing: a def with no `render` had it defaulted to `value` when the column was
built, so patching `value` alone changes what is sorted and filtered but not what is displayed. Patch
both to change both.

**Function-valued options are the other route**, and need no patching at all — `value`, `render`,
`compare` and `searchable` are called fresh every time, so closing them over
something observable (see [`useObservableBox`](../util/README.md)) makes them follow it. Reach for
`setConfig` for the scalar options, which have no such escape.

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

### Visibility and pinning

```ts
{ key: "internalId", hidden: true, hideable: false }   // never shown, never offered
{ key: "name", hideable: false }                        // always shown, never offered
{ key: "actions", pinnable: false }
```

Pinning uses `ColumnPin` (`false | "left" | "right"`) — an unpinned column is `false`, never
`undefined`, so `column.pinned === false` is a legal check and `setPinned(false)` is how you unpin.

`hidden` is the _initial_ value; `setHidden` and a snapshot both move it afterwards. `hideable` and
`pinnable` are advisory for pickers and header UIs, exactly like `sortable` and `filterable` — the
setters are never gated, so a page's own responsive layout can hide whatever it likes.

Read `hideable: false` as **locking `hidden` where it starts**, not "cannot be hidden": on a
`hidden: true` column it means always hidden. That pairing is how you declare a column that exists
only to carry a value or a filter (see below).

The one thing they _do_ enforce is that a persisted snapshot cannot override them. `applyState` skips
`hidden` for a non-`hideable` column, `pinned` for a non-`pinnable` one, and `width` for a
non-`resizable` one — structure outranks a saved view written before that was true. Without it, a
stale snapshot could reveal a column you never meant to show.

```tsx
{
  table.allColumns.filter((c) => c.hideable).map((c) => <HideToggle key={c.key} column={c} />);
}
```

### A column that only carries data

A column's `value` fn receives the whole row and is fully reactive — it can read any observable, not
just the row — so a column is also how you attach a predicate that isn't about one field:

```ts
{
  key: "_invalid",
  value: (t) => t.start > t.end,          // any row predicate, incl. cross-column
  filter: () => new SetFilter({ selected: [true] }),
  hidden: true,
  hideable: false,
  filterable: false,
  searchable: false,
  sortable: false,
}
```

It narrows rows without ever being rendered, and nothing can reveal it. Filtering _upstream_ instead
— `data: () => all.filter(pred)` — is the thing to avoid: `setData` then intersects selection against
the smaller set and drops it permanently, because the table cannot tell "filtered out" from
"deleted".

`sortable: false` is advisory — it's for hiding header controls. The model's sort APIs are never gated, so `setSort` and `applyState` still work.

For **server-side sorting**, set `sortMode: "manual"`. Sort state behaves identically (so header UIs need no changes) but row order is left untouched — react to `sorts`, refetch, and `setData`.

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
useTable({ data: surveyStore.all });
```

**With `getRowId`**, the id comes from the data, so the same _record_ survives even when it arrives
as a **different object** — a plain-JSON refetch, anything not identity-mapped:

```tsx
useTable({ data: rows, getRowId: (s) => s.id });
```

| your rows are…                        | without `getRowId` | with it  |
| ------------------------------------- | ------------------ | -------- |
| identity-mapped records (same object) | selection survives | survives |
| rebuilt objects for the same records  | selection drops    | survives |

Either way it is never _wrong_: a stale id resolves to nothing rather than to whatever row now sits
in that position.

> The default used to be the row's **index**. That was only safe while the dataset was re-applied
> wholesale — a source that replaces its contents in place, which is what every
> `LazyArray` does, would leave a selected index pointing at whatever row later occupied
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

Attach a filter to the column it filters. The table feeds it that column's own value accessor, so a
computed column is filterable with no extra config and there are no key-matching conventions to keep
in sync by hand.

```tsx
import { SetFilter, DateFilter, TextFilter } from "@jayalfredprufrock/mobx-toolbox/filter";

// hoisted out of the component, as column defs usually are
const columns: ColumnsDef<User> = [
  { key: "category", filter: () => new SetFilter() },
  { key: "name", value: (u) => `${u.first} ${u.last}`, filter: () => new TextFilter() },
  { key: "score", filter: () => new DateFilter() },
];

const table = useTable({ data: rows, columns });
```

**Use the factory form for defs declared outside the component.** A bare `new SetFilter()` in a
module-level `const` is built once for the module's lifetime, so it is shared by every table built
from those defs and by every mount of the same one: the user's selection survives navigating away
and back, and two tables on screen at once fight over it. `() => new SetFilter()` is called once per
`ColumnModel`, so each table gets its own and a remount starts clean.

Pass an instance when you want exactly that sharing, or when you need a direct reference to drive the
filter from outside the table. Otherwise reach it through `table.column(key)?.filter`, narrowing by
`instanceof`:

```ts
const filter = table.column("category")?.filter;
if (filter instanceof SetFilter) filter.toggle("books");
```

A discriminant (`filter: "set"`) is the one form deliberately unsupported: it would force a
`"set" -> SetFilter` map into the table, so every consumer would ship every filter type. Both
supported forms keep your page's own import as the only thing that pulls one in.

Either way the filter survives everything that rebuilds column defs — `setData`, `appendRows`,
`setColumns` — because `syncColumns` preserves the `ColumnModel` behind a key it already has, and the
factory is not called again for a key that already has one. (Which is also why a new def for an
existing key is ignored wholesale: to swap a filter type at runtime, use `removeColumn` +
`addColumn`.)

Filters are plain value predicates — `matches(value)`, no accessor, no path, no row generic — so the
same instance works over a table column, a sidebar rail or a bare `array.filter`. See
[`filter`](../filter/README.md).

### What narrows the rows

`table.filterPredicate` is the single answer: every active column filter, the built-in search, and any
AND-composed. `undefined` when nothing is active.

| Member                          | Description                                                      |
| ------------------------------- | ---------------------------------------------------------------- |
| `predicate`                     | everything narrowing rows, composed; `undefined` = pass-through  |
| `filterPredicateExcluding(key)` | the same, minus that column's own filter — what facet counts use |
| `activeColumnFilters`           | columns whose filter is narrowing rows; `.length` is the count   |
| `activeClientColumnFilters`     | the subset this table applies itself                             |
| `activeServerColumnFilters`     | the subset behind `filterQuery`                                  |
| `clearColumnFilters(opts?)`     | reset column filters; `{ mode }` clears one side                 |
| `column(key)`                   | the `ColumnModel` under that key                                 |

Filtering runs over `rows` without replacing them, so selection persists through it.

### The two kinds of filter

Two qualifiers, two axes. **`column`** marks members that are column-filter-specific;
**`client`** / **`server`** mark which half of the split something belongs to.

`filterPredicate`, `filterQuery` and `clientFilteredRows` carry no `column` qualifier because the
search filter narrows them too, so `columnFiltered…` would be a false name for any of them. `clientFilteredRows` is qualified on the other axis: it says
this table applied the client half, because a server-mode filter was already applied to `rows` before
they arrived.

There are two kinds of filter, and the qualifier in each name says which:

|                       | what it is                                                 | in `activeColumnFilters` | reset by `clearColumnFilters` |
| --------------------- | ---------------------------------------------------------- | ------------------------ | ----------------------------- |
| **column filters**    | a `ColumnFilter` on a column, matching one extracted value | yes                      | yes                           |
| **the search filter** | one query matched across many columns, so a row predicate  | no                       | no                            |

The unqualified word covers both — `filterPredicate` composes them, and `filterQuery` serializes
whichever run server-side. Anything spelled `column…` is the narrower half, which is why
`clearColumnFilters` leaving the search alone follows from its name rather than being an exception
to remember.

Say which you mean at the call site:

```ts
// everything narrowing the table — the number a chip shows
table.activeColumnFilters.length + (table.searchFilter.active ? 1 : 0);

// exactly what a rail's Clear would reset, so it never offers to undo a server-side window
table.activeClientColumnFilters.length > 0;

// which side emptied the table
table.activeClientColumnFilters.length > 0 || table.searchFilter.active;
```

`activeClientColumnFilters` and `activeServerColumnFilters` are each their own computed rather than a
`.filter()` over the combined list, so reading one never touches the other side's `active` flags — a
server toggle can't invalidate a client-count chip.

Clearing keeps the `{ mode }` option rather than growing matching names, since options objects are how
every other variant here is spelled (`setSort(key, dir, { preserve })`, `clearSort(key?)`).

Returning the columns rather than a count is deliberate — `.length` is the number anyway, and a rail
can render a removable chip per active filter from a model but not from an integer.

`clearColumnFilters()` deliberately leaves `search` alone — wiping text the user typed as a side
effect is more surprising than leaving it (`search.clear()` is explicit).

**A hidden column keeps filtering.** So does a `filterable: false` one. That is intentional — it is
how a filter driven from elsewhere (a sidebar, a route param) works without giving up the column —
and `activeColumnFilters` is the disclosure, the chip that tells the user something is narrowing the
table that they cannot see a control for.

### Header controls

`column.filterable` is advisory in exactly the way `sortable` is: it tells a header UI whether to
draw a funnel, and the model is never gated by it. It defaults to true wherever a `filter` is
attached, and false where none is.

```tsx
<Table.ColumnHeader column={column}>
  {column.title}
  {column.filterable && <FilterPopover column={column} />}
</Table.ColumnHeader>
```

The package ships no filter UI, for the same reason it ships no sort UI: a popover means owning
focus, keyboard and positioning that your design system already owns. What it gives you is
`column.filter` and `column.facets` — plus, on a `SetFilter` itself, `multiValue` (whether offering
the any/all toggle would mean anything) and `props`, which carries whatever your components need. See
[`filter`](../filter/README.md#view-props) for augmenting it, and for the rule on when the library
declares a named option instead.

### Facets

`column.facets` is the value domain to render as a checkbox list — `[]` when the column has no
filter. Three cost tiers, chosen by the filter rather than configured on the column:

| tier    | how                                 | walk                                 | gives                   |
| ------- | ----------------------------------- | ------------------------------------ | ----------------------- |
| static  | `new SetFilter({ options: [...] })` | none                                 | a fixed list, no counts |
| values  | `new SetFilter()` — the default     | `rows`, invalidated by `rows` alone  | a discovered list       |
| counted | `new SetFilter({ counts: true })`   | `rows` × every _other_ active filter | the list plus counts    |

The walk itself is not what costs — running every other filter per row is, plus the invalidation
storm where one toggle dirties every other column's facets. That is what `counts` gates. The default
tier still populates checkboxes, so a bare `new SetFilter()` works.

Ordering is declared `options` first in declaration order, then discovered values sorted by value,
blank last. (Insertion order alone would be first-appearance-in-rows, which reshuffles the list every
time the table is sorted.)

A count means "how many rows carry this value", among rows passing every _other_ filter — so it
previews what picking it gives you. Counts are cross-filtered by every other active filter, never by
the column's own; otherwise the list could never be widened again.

One exception, and it is the filter that decides it: when picking **narrows** rather than widens
(a `SetFilter` in `matchMode: "all"`), that number would describe a question the filter is no longer
asking, promising more rows than ticking the box actually gives. There the count is the size of the
intersection with what is already picked, so it stays exactly predictive — tick it and you get that
many rows. A filter signals this with `intersecting`; the table never interprets match modes itself.

A filter that groups values — a `BucketFilter` over score ranges, say — lists its **projected**
domain here (grades, not every distinct score) while the column goes on showing and sorting the raw
value. The table applies the projection when it walks the rows, which is why `project` is on the
filter contract at all.

Zero-count entries are **kept**, because a popover is exactly where you go to undo an over-narrowed
filter. That matters more than it sounds: a value that appears only in rows the _other_ filters
exclude is still listed, at zero. Without it, ticking a value and then narrowing another column past
it would leave the funnel filtering while its checkbox had vanished from the list — no way to untick
it short of clearing everything.

A standing facet rail that would rather hide them drops them at the call site:

```tsx
facets.filter((f) => (f.count ?? 1) > 0 || filter.has(f.value));
```

```tsx
{
  column.facets.map((facet) => (
    <label key={String(facet.value)}>
      <input
        type="checkbox"
        checked={filter.has(facet.value)}
        onChange={() => filter.toggle(facet.value)}
      />
      {facet.blank ? (
        <em>(Blank)</em>
      ) : (
        (filter.props.renderOption?.(facet.value) ?? String(facet.value))
      )}
      {facet.count !== undefined && <span>{facet.count}</span>}
    </label>
  ));
}
```

`facet.blank` is a render hint, so a view never compares against the blank sentinel itself. Blank is
offered only where the row walk actually found one — the static tier never shows it, with no extra
config.

The search is cross-filtered in too: a row it already excludes must not be tallied, or the count
promises rows the selection could never surface.

### Search

`table.searchFilter` is a `TableSearchFilter` — one query matched across many columns. There is exactly one per table, created with the model and inert until something is typed.

```tsx
<input
  value={table.searchFilter.text}
  onChange={(e) => table.searchFilter.setText(e.target.value)}
/>
```

It is table-owned rather than a `ColumnFilter` because matching one query against _many_ columns needs
every column's accessor at once — the one thing a `matches(value)` predicate structurally cannot do.
Everything else lines up: it joins `predicate` like any column filter and counts toward
`activeColumnFilters`.

Per-column `searchable` decides what it reads, defaulting to true:

```ts
{ key: "secret", searchable: false }                              // never searched
{ key: "joined", searchable: (r) => fmtDate(r.joined) }           // searched as text, not epoch millis
```

Hidden columns are searched: `searchable` describes the data, not what is on screen. Debouncing is
deliberately not built in — like `onStateChange`, the cadence belongs to whoever owns the input, and
a client-side search over rows already in memory usually wants none.

### Server-side filtering

Set `filterMode: "server"` on a column and its filter stops narrowing rows here. Instead it
serializes into `table.filterQuery` for you to send onward.

```ts
const table = useTable({
  data: rows,
  columns: [
    { key: "time", filter: () => new DateFilter(), filterMode: "server", field: "created_at" },
    { key: "level", filter: () => new SetFilter({ options: LEVELS }), filterMode: "server" },
    { key: "message", filter: () => new TextFilter() }, // client-side, over what came back
  ],
});

reaction(
  () => table.filterQuery,
  (query) => void refetch({ where: query?.map(toClause) }).then((r) => table.setData(r)),
  { equals: comparer.structural },
);
```

The two sets are **disjoint**, and that is what makes a mixed table cheap: a server-mode filter is
never evaluated client-side, so every filter is applied exactly once, in exactly one place. There is
no double-filtering and nothing to reconcile. `predicate` holds the client half, `filterQuery` the
server half, and `activeClientColumnFilters` / `activeServerColumnFilters` split them — they all narrow the table, just in different
places.

Applying client filters _on top of_ server results needs no new machinery either: the table filters
over `rows` without replacing them, so `setData(serverResults)` followed by a client filter is the
behaviour you already have.

`filterQuery` is a `FilterCondition[]` — plain JSON, so it compares with `comparer.structural` and
unrelated churn (sorting, hiding a column) won't fire a refetch.

```ts
{ field: "created_at", op: "range", value: { min: 1700000000, max: 1700086400 } }
{ field: "level",      op: "in",    value: ["error", "warn"] }
{                      op: "search", value: "timeout" }   // no field: not tied to one column
```

`field` is the name the data goes by on the wire, defaulting to the column's `key` — usually right
for a field column and usually wrong for a computed one. The conditions are deliberately not a query
language: they name the comparison and leave the translation to you, so the same column defs work
against REST, a typed POST body, or SQL. See [`filter`](../filter/README.md) for the op table.

**Debouncing and cursor invalidation are yours.** The table has no idea what a request costs you.

Two things change for a server-mode column's facets, both because `rows` are _already narrowed by
that very filter_:

- It **never walks the rows.** A walk would discover only the values that survived the current
  selection, so the list would collapse to what is already chosen and could never be widened again.
  Declare `options` on the filter to give it a domain — without one, its facet list is empty.
- It **never carries counts**, even with `counts: true`. They would be counts of an already-filtered
  set, describing the current selection rather than the alternatives.

Server filters are also excluded from every _other_ column's cross-filter tally, since they are
already applied to `rows`. That falls out of the partition rather than being a special case.

`clearColumnFilters({ mode: "client" })` resets one side and leaves the other alone, which is what a
"clear filters" button next to a sidebar of server-driven controls usually wants.

The search has its own mode:

```ts
useTable({ data: rows, search: { mode: "server" } });
```

In server mode the query stops narrowing rows and becomes a `{ op: "search" }` condition instead.
Per-column `searchable` then has no effect — the server decides what it searches.

## Columns exist before the data does

Configured columns are built at construction, not when rows first arrive, so `column(key)`,
`activeColumnFilters`, `predicate` and `filterQuery` are all meaningful on the very first render.
That matters most for a page that **fetches from** `filterQuery`: otherwise its first request — the
one the user actually waits on — would go out with no conditions at all.

Columns that genuinely depend on data still wait for it: a factory def resolves against the first
row, and `autoColumns` can't know the keys until one arrives. Both materialize on the first
`setData` and pick up any state already applied.

## Persisting the view

`getState()` returns a JSON-serializable snapshot of what the user has done to the table: column order, per-column visibility/pinning/manual widths, the sort list, active filters and the search query. Ephemeral state (selection, scroll, expansion) is deliberately excluded.

Storage is entirely yours — the library only hands you a snapshot and takes one back.

```ts
const table = useTable({
  data: rows,
  onStateChange: (state) => localStorage.setItem("users.table", JSON.stringify(state)),
});

useMountEffect(() => {
  const saved = localStorage.getItem("users.table");
  if (saved) table.applyState(JSON.parse(saved));
});
```

`applyState` accepts partial snapshots and tolerates drift: keys with no matching column are held aside and applied if that column later appears (so restoring before the first `setData` works), and columns the snapshot doesn't mention keep their state, ordered after the ones it does. Debouncing and storage are yours.

### Filters and search in the snapshot

```jsonc
{
  "columnOrder": ["name", "category"],
  "columns": { "category": { "hidden": false, "pinned": false } },
  "sorts": [{ "key": "name", "direction": "asc" }],
  "columnFilters": { "category": { "selected": ["books"], "matchMode": "any" } },
  "search": "ada",
}
```

`columnFilters` is keyed by column key and holds each filter's own `value`. Only **active** filters get an entry, so the map stays small — but the key is always emitted, even empty, exactly as `columns` and `sorts` are. That is deliberate: the map is a _complete picture_, so `applyState` clears any filter it doesn't mention. Restoring a view saved with nothing filtered therefore clears filters applied since, which is what "restore that view" has to mean. (A hand-built partial snapshot that omits `columnFilters` entirely still leaves filters alone.)

They are separate top-level keys rather than folded into `columns` because they churn on a completely different cadence — per keystroke, against per-drag — so you can debounce them apart without unpicking one object:

```ts
onStateChange: (state) => {
  const { columnFilters, search, ...arrangement } = state;
  saveArrangement(arrangement);
  saveFiltersDebounced({ columnFilters, search });
};
```

⚠️ **`onStateChange` now fires on every keystroke** in the search box and on every filter toggle. If you write to `localStorage` straight from it, debounce first.

Restoring is tolerant of state that has been sitting in storage across app versions, or typed into a URL by hand: each filter validates what it's given and falls back to cleared rather than trusting the shape. A snapshot whose column now holds a different _kind_ of filter resets that filter instead of corrupting it, and entries for columns that no longer exist are ignored.

A filter can only be persisted if it exposes both `value` and `setValue` — the built-ins all do. A custom `ColumnFilter` offering neither is simply skipped; offering only one would be saveable but never restorable, so it's skipped too.

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

## Empty, loading and error slots

All three gate themselves. Render them after `<Table.Body>` and they appear only when they should —
and never two at once, since the states they read are mutually exclusive:

```tsx
<Table.Body>{...}</Table.Body>
<Table.Empty>{table.rows.length ? "No matches" : "No users yet"}</Table.Empty>
<Table.Loading><Skeleton /></Table.Loading>
<Table.Error>{(error) => <Retry error={error} />}</Table.Error>
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
which `rows.length` already answers exactly, without the ambiguity. (`activeColumnFilters` answers the
_first_ question, which is a different job: it is the chip telling a user something is narrowing the
table, including from a control they cannot see.)

One case it can't answer: if your filtering happens **server-side**, the rows never arrive in the
first place, so `rows.length` is `0` and the slot reads as "no data". Track the query yourself
there — the table only knows about the filters it was given.

`<Table.Empty>` shows only when `table.isEmpty`, so it stays out of the way during a first load.
`<Table.Loading>` shows only when `table.loading`, and only once the wait has lasted long enough to
be worth mentioning — a fast load renders nothing at all rather than flashing a skeleton. Pass
`sustain={false}` to show it immediately, or `sustain={{ after: 100 }}` to retune it; the timing is
[`useSlowLoading`](../util/README.md#useslowloading).

`<Table.Error>` shows only when `table.error` — a failure that left nothing to show. A failed
_refresh_ renders nothing here on purpose: blanking a working table over a background request costs
more than the failure did. Its children may be a render prop, called with whatever the request
failed with, so the wording can come from the error itself.

All three own placement only — filling the viewport below the sticky header and pinning
horizontally. Cosmetics are yours; `data-empty`, `data-loading` and `data-error` are the styling
hooks.

### `<Table.Overlay>`

The placement primitive the three gated slots are built from, with no gate of its own. The
positioning is the hard part; deciding whether to show a message about a failed save is an `if`:

```tsx
{
  saveError && <Table.Overlay>Couldn't save changes</Table.Overlay>;
}
```

It carries no data attribute — `data-empty` and friends mean "the table decided this", and a
hand-shown overlay hasn't earned that claim. Pass your own if you want a styling hook.

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

| Member                                        | Description                               |
| --------------------------------------------- | ----------------------------------------- |
| `rows` / `clientFilteredRows` / `displayRows` | as fetched → client-filtered → + sorted   |
| `renderedRows` / `renderedColumns`            | the current window                        |
| `allColumns` / `orderedColumns`               | every column / the visible ones in order  |
| `selectedRows` / `selectedIds`                | selection                                 |
| `sorts`                                       | the sort priority list                    |
| `predicate` / `activeColumnFilters`           | what is narrowing rows, and which columns |
| `getState()` / `applyState()`                 | snapshot the view, restore it             |
| `filterQuery`                                 | the server half, as plain JSON conditions |
| `search`                                      | the built-in cross-column search          |
| `virtualWidth` / `virtualHeight`              | full scroll extent                        |

Mutations all go through actions: `setData`, `appendRows`, `clearColumnFilters`, `setSort`/`setSorts`/`clearSort`, `toggleRow`/`selectAllRows`/`toggleAllRows`/`clearSelection`, `toggleRowExpanded`/`collapseAllRows`, `moveColumn`, `applyState`, `scrollToRow`/`scrollToEnd`.

`ColumnModel`: `key`, `title`, `width`, `pinned`, `hidden`, `sortDirection`, `sortIndex`, `sortable`, `resizable`, `getValue(row)`, `setPinned`, `setHidden`, `setManualWidth`, `sortBy`, `clearSort`, `setConfig`, plus the filtering surface — `filter`, `filterable`, `facets`, `filterMode`, `field`, `filterCondition`, `searchable`, `searchValue(row)`, `clearFilter()`.

### Lifecycle: `dispose()` and `activate()`

When you build the model yourself rather than via `useTable`, `dispose()` drops its three reactions
— the one reading rows through `data`, the one re-deriving factory columns once a first row exists,
and `onStateChange` — and `activate()` re-arms them. They are the _only_ pair that controls this:
`setData` re-points the dataset and nothing else.

**`dispose()` is not just hygiene.** The rows reaction reads a lazy's `value`, and `value` is one of
the lazy's observation sources — so an undisposed table keeps its lazy **observed**. The lazy then
never drops its value, and if it was built with `reloadEvery` it goes on polling. A table that
unmounts without disposing leaves a lazy quietly fetching forever for a screen nobody is looking at.
The reaction stays reachable from the store that owns the lazy, so nothing collects it either.

`activate()` exists as its pair mainly for React StrictMode, which runs mount → cleanup → mount
against the _same_ surviving model; a cleanup-only effect would leave the second mount deaf. That is
why `useTable` calls `activate()` on mount rather than relying on the constructor's call. (`uploader`
uses the identical pair, for the same reason.)

A `TableModel` built directly with an **array** `data` applies it once, at construction:
identity-based syncing is `useTable`'s job, so update it with `setData`. The getter and lazy forms
need no such help; they track wherever the model lives.
