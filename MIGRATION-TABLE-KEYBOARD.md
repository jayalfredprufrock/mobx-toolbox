# Upgrade prompt: mobx-toolbox table — keyboard-accessible row details, "selected only" view

Hand this file to a coding agent working in your repository. It covers a release of
`@jayalfredprufrock/mobx-toolbox/table` that fixes keyboard access to row details and adds a
"selected only" view. Nothing here fails to compile — every item is a runtime or accessibility
change, so a passing test suite does not prove the upgrade is done.

---

## How to work through this

1. Search the codebase for each pattern below and list every occurrence.
2. Apply the **Required** changes. They are mechanical.
3. For **Check by hand** items, read the affected code and report what you find before changing
   anything; they depend on intent.
4. Do not restructure table compositions beyond what an item asks for.

---

## Required

### Give every expandable row a `<Table.ExpandToggle>`

**Why:** rows are `div`s. A `<Table.Row onClick={() => table.toggleRowExpanded(row)}>` can't be
focused and doesn't respond to Enter or Space, so keyboard users can't open row details.

**Find:** `toggleRowExpanded` passed to an `onClick` on `<Table.Row>` (or on any non-button
element), and any custom expand control that isn't a `<button>`.

**Change:** add a `<Table.ExpandToggle row={row} />` to the row. Pick the variant by what the
table does today — don't add visible UI the design didn't have:

- **Row click with no visible control (most common):** keep the row `onClick` and render
  `<Table.ExpandToggle row={row} visuallyHidden />` at the start of the first cell. Add a focus
  style on the row, since the button itself is invisible:
  `[role="row"]:has(:focus-visible) { outline: 2px solid …; }`.
- **A visible chevron/button that isn't a real `<button>`:** replace it with a visible
  `<Table.ExpandToggle>`, using a render-prop or the `expandToggle` slot for the design system's
  button.

The toggle stops its own click from bubbling, so it never toggles twice with a row `onClick`.

```tsx
// before
<Table.Row row={row} onClick={() => table.toggleRowExpanded(row)}>
  {(column) => <Table.Cell column={column}>{String(column.getValue(row))}</Table.Cell>}
</Table.Row>

// after — click anywhere still works; keyboard users get a hidden button
<Table.Row row={row} onClick={() => table.toggleRowExpanded(row)}>
  {(column) => (
    <Table.Cell column={column}>
      {column === table.orderedColumns[0] && <Table.ExpandToggle row={row} visuallyHidden />}
      {String(column.getValue(row))}
    </Table.Cell>
  )}
</Table.Row>
```

**Design-system button:** register it once rather than per table:

```tsx
<Table.Root table={table} expandToggle={MyExpandToggle}>
```

`MyExpandToggle` receives `TableExpandToggleProps` — `expanded`, `onClick`, `aria-expanded`,
`aria-controls`, `aria-label`, and `style` (set when `visuallyHidden` is on). Spread them all onto
a real button. A render-prop on
`<Table.ExpandToggle>` works for one-offs.

**Existing custom expand buttons** that are already real `<button>`s with `aria-expanded` may stay.
If they sit inside a row with its own `onClick`, add `event.stopPropagation()` or they toggle twice
— or replace them with `<Table.ExpandToggle>` and a render-prop.

### Don't hand-roll an id on `<Table.Expansion>`'s cell

The panel cell now gets `id={table.expansionId(row)}` so the toggle can reference it. If you were
targeting the panel by an id of your own, use `table.expansionId(row)` instead.

---

## Check by hand

### ⚠️ Rows no longer carry `aria-selected`; the table no longer carries `aria-multiselectable`

Both are only valid under `role="grid"`, and this table is `role="table"`, so assistive tech ignored
them. Selection is announced through the checkbox's `checked` state.

**Find:** CSS selectors, tests and test-library queries using `[aria-selected]`,
`aria-selected="true"`, `{ selected: true }` (Testing Library `getByRole("row", { selected })`) or
`aria-multiselectable`.

**Change:** styling → `[data-selected]` (unchanged, still present). Tests → assert on
`data-selected`, the checkbox's `checked`, or `table.isRowSelected(row)`.

### ⚠️ The selection column now has a value

`column.getValue(row)` on the selection column returns `true`/`false` (whether the row is
selected) instead of `null`, and every selection column carries a built-in `SetFilter`.

**Find:** code that iterates `table.allColumns` / `orderedColumns` and reads `getValue` or
`filter` without skipping `column.selection` — CSV/clipboard export, "active filters" chips, custom
filter panels.

**Change:** usually skip `column.selection` explicitly. An inactive filter contributes nothing to
`activeColumnFilters`, so chip lists only change when the view below is turned on.

### Focus inside a scrolled-away row is lost

Not new, but now documented: rows outside the render window unmount, so a focused checkbox or toggle
whose row scrolls far enough away loses focus to `document.body`. If the app restores focus after
an action on a row, verify the row is still rendered (`table.scrollToRow` first).

---

## Worth adopting

### Replace hand-rolled "selected only" filtering with `setSelectedOnly`

```ts
table.setSelectedOnly(true); // show only selected rows
table.setSelectedOnly(false); // show everything
table.selectedOnly; // state, for a toggle
```

**Find:** `data: () => rows.filter((r) => selected.has(r.id))`, a hidden carrier column whose `value`
reads `isRowSelected`, or similar.

Filtering upstream in `data` makes the table treat hidden rows as deleted: `setData` drops their
expansion state, and the empty state can't tell "nothing selected" from "no data".
`setSelectedOnly` filters inside the table, is always
client-side (even under `mode: "server"`), composes into `filterPredicate`, and is reset by
`clearColumnFilters()`. Propose the change; note that the view is live — unchecking a row while it
is on hides the row immediately.
