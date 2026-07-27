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

Omit `columns` entirely and the table derives one per key of the first row.

A function entry is a **factory**: it receives the first row and returns one or more defs, for datasets whose shape is only known at runtime. Factories are skipped while there is no data and re-run on `setRows`/`appendRows`.

`value` feeds sorting and the default render; `render` overrides display only. Sorting therefore always goes through `value`, never a raw `row[key]` lookup.

### Widths

Each column is either **fixed** (`width: 240`) or **flex** (`width: "2fr"`, the default being `"1fr"`). Fixed columns claim their pixels; flex columns split the remainder by weight, clamped to `minWidth` (default 120) and `maxWidth`. A column that hits a clamp freezes and its share is redistributed among the rest.

Leftover slack — every flex column capped at its max — is absorbed by the last column, so the columns always fill the viewport with no gap. When the minimums don't fit, the total exceeds the viewport and the table scrolls horizontally.

`column.setManualWidth(px)` (what `<Table.Resizer>` does) makes a column fixed at that width; `setManualWidth(undefined)` returns it to auto.

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

By default a row's id is its index in the source array — stable across `appendRows`, and reset by `setRows` along with the rest of row-keyed state. Pass `getRowId` when a refetch may replace row objects that mean the same row:

```ts
useTable({ rows, getRowId: (row) => row.id });
```

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

## Empty state

The library never decides what "empty" means — no rows and filtered-to-nothing are different stories, and only you know the wording and recovery actions:

```tsx
{
  table.displayRows.length === 0 && (
    <Table.Empty>{table.rows.length ? "No matches" : "No users yet"}</Table.Empty>
  );
}
```

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

When you build the model yourself rather than via `useTable`, call `dispose()` to drop the `onStateChange` reaction, and `activate()` to re-arm it.
