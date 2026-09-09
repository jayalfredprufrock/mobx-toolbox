# Table status bar: move it out of the scroll container

Proposal, written from the outside — driven by trying to build a status bar in `panelpro`'s
`uri-app` and finding `<Table.StatusBar>` structurally unable to do it. A working proof of the whole
thing exists app-side in `frontend/uri-app/src/components/data-table.tsx` on the `qr-columns`
branch; this describes what it should look like once the arithmetic lives here instead.

## The problem

`<Table.StatusBar>` renders inside the scroll container. The vertical scrollbar belongs to that
same container, so it spans the container's full height and always continues _past_ the bar. Nothing
the consumer can style reaches it. A divider rule along the bar's top edge stops at
`--table-viewport-width` and the scrollbar carries on below it — the rule reads as running out into
the middle of a scrollbar, because that is exactly what it does.

There is no styling fix. The bar is inside the thing the scrollbar measures.

Worth noting the current docs already describe the gap from the other side. `TableRootProps.maxHeight`
says:

> Fewer rows than the cap still leaves the box at the cap, with empty space below the last row — the
> table fills what it is given. For a bar that follows the rows on a short list, use
> `<Table.StatusBar>`, which sits inside the scroll container and needs none of this.

So today you can have _follows the rows_ (`StatusBar`, inside the scrollport) or _outside the
scrollport_ (`maxHeight` plus your own element below, pinned at a fixed cap). Not both. That is the
missing case.

## Two axes, currently conflated

`StatusBar` couples them because sticky-bottom inside a scrollport happens to land under the last
row when nothing overflows:

|                                     |                                                                                                                  |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **where the bar sits**              | inside the scrollport (overlays rows, scrollbar runs past) · outside it (full width, scrollbar terminates at it) |
| **whether the table hugs its rows** | fixed cap (dead space below a short list) · content cap (box hugs, bar follows the last row)                     |

Separating them makes both designs expressible, and the second axis is what keeps this from
breaking traditional bordered tables — see [Classic tables](#classic-tables).

## The change

### 1. `Table.Root` renders the bar, as a sibling of the scroll container

It cannot be a child component. `TableRoot` renders `children` _inside_ `[role=table]`, so nothing
passed through the children list can ever be the scroll container's sibling. It has to be a prop.

```tsx
export interface TableRootProps {
  // …
  /** Rendered below the scroll container, inside the viewport. Full viewport width — the vertical
   *  scrollbar gutter included, since this sits outside the scrollport. */
  statusBar?: React.ReactNode;
  /** Vertical space to reserve for `statusBar`, in px. This is the **total** — margins included, so
   *  make the number match what your element actually occupies. Defaults to `rowHeight`. */
  statusBarHeight?: number;
}
```

```tsx
<div
  ref={viewportRef}
  className="table-viewport"
  style={
    {
      /* … */
    }
  }
>
  <div
    ref={scrollContainerRef}
    role="table"
    style={
      {
        /* … */
      }
    }
  >
    {table.width > 0 && table.height > 0 && children}
  </div>
  {statusBar !== undefined && (
    <div className="table-status-bar" style={{ height: `${barHeight}px` }}>
      {statusBar}
    </div>
  )}
</div>
```

Deliberately a plain block: no `position`, no `z-index`, no background. Nothing scrolls behind it,
so it needs none of the three. Consumers style it through `.table-status-bar`.

Don't gate it on `table.width > 0 && table.height > 0` the way `children` are — the bar's content
doesn't depend on measurement and gating it just makes it pop in a frame late.

### 2. Reserve its height at the measurement site

One subtraction, in the one place that makes everything else correct:

```ts
const barHeight = statusBar === undefined ? 0 : (statusBarHeight ?? table.rowHeight);
useResize(viewportRef, (_width, height) => table.setHeight(height - barHeight));
```

`table.height` then _is_ the row area, so `maxHeight: ${table.height}px` on the scroll container
needs no `calc`, and the render window, the auto-fetch threshold and `<Table.Overlay>` stay right
with no changes at all. This is `maxHeight`'s own stated principle applied one layer down: measure
the already-reduced box and nothing downstream has to know.

Note `useResize` reports the **content box**, so a consumer's border and padding on
`.table-viewport` are already excluded and the subtraction composes with them correctly.

No feedback loop — `barHeight` is a number the consumer passes, not something measured off a box
whose size depends on `table.height`.

### 3. `fitContent` for the hugging behavior

This is what `StatusBar` currently gives you as a side effect of being inside the scrollport, and it
should be its own opt-in:

```tsx
/** Cap the viewport at the height of its own content instead of letting it fill its parent, so a
 *  short list leaves no dead space and `statusBar` follows the last row. */
fitContent?: boolean;
```

**Express it in CSS, not JS.** The content height depends on the header's flow height, which
includes the consumer's `--table-header-gap` padding — unreadable from JS without measuring the
header (which `Root` has no ref to). But `min()` and `calc()` read those vars natively, and
`<Table.Overlay>` already reads exactly these two:

```ts
// on .table-viewport
maxHeight: fitContent
  ? `min(${maxHeight ? `${maxHeight}px` : "100%"}, calc(
        var(--table-header-height, ${table.rowHeight}px)
      + var(--table-header-gap, 0px)
      + ${table.virtualHeight}px
      + ${table.virtualWidth > table.width ? `var(--table-scrollbar-width, 0px)` : "0px"}
      + ${barHeight}px))`
  : maxHeight === undefined ? undefined : `${maxHeight}px`,
```

Four things about that expression:

- `height: 100%` with a `max-height` already resolves to the smaller of the two, so the
  ResizeObserver reports the hugged height and the existing mechanism carries it the rest of the way.
- The horizontal-scrollbar term is required. That scrollbar lives inside the scroll container below
  the rows, so capping at the content height without it leaves the rows one scrollbar too tall for
  their box and summons a _vertical_ scrollbar to explain the difference. Gate it on
  `virtualWidth > width` in JS since CSS can't ask.
- `barHeight` is inside the sum because the viewport's content box has to hold the bar too. It then
  comes straight back off in `setHeight`, which is what leaves `table.height` meaning the row area.
- **Skip the fit entirely when `clientFilteredRows.length === 0`.** `<Table.Overlay>` sizes itself
  from `table.height`, so hugging a rowless content height collapses the empty / loading / error
  message to nothing. This is the one edge that bit the app-side proof; it needs to be in here, not
  in every consumer.

With this, the library computes the content height exactly and consumers stop restating
`--table-header-gap` and the scrollbar size as JS constants (which the proof has to do, and which is
its ugliest part).

One addition to the documented var contract: `--table-scrollbar-width` would be new. The README
currently lists only `--table-header-height` / `--table-header-gap` as consumer-set vars the library
honors (via `<Table.Empty>`), so this makes a third — with a `0px` fallback, which is the right
default for a consumer who hasn't reserved a gutter.

## Classic tables

Moving the bar out _helps_ traditional bordered designs — it's the current placement that fights
them.

A bordered table needs one outline containing header + rows + status bar. With the bar outside the
scroll container, `.table-viewport` contains exactly those three, so the outline goes there and
`border-radius` + `overflow: hidden` clips the scroll container's top corners and the bar's bottom
corners together. With the bar _inside_ the scrollport you get the worse version of everything above:
the bar stops short of the outline's right edge, its bottom corners can't round to match the outline
because it's a sticky element mid-box, and the scrollbar runs past it to the outline's inner edge.

The short-list behaviors do conflict — ours wants the bar to follow the last row, a bordered table
wants it pinned at the bottom of the box with dead space above. That's exactly why `fitContent` is
opt-in: **the default is the classic behavior**, which is also what `maxHeight` already documents.

## Breaking change

Relocating `StatusBar` breaks the case its own docs advertise. Its behavior table promises
"fewer rows than fit → directly under the last row", and outside-the-scrollport in a full-height
viewport puts it at the bottom instead. Migration note should read:

> `<Table.StatusBar>` has moved out of the scroll container and is now `<Table.Root>`'s `statusBar`
> prop. Pass `fitContent` to keep the previous short-list behavior.

Whether to keep the old component alongside is a judgement call, but there's not much of a case for
it: outside-the-scrollport delivers all three rows of `StatusBar`'s behavior table _and_ full-bleed
width _and_ a scrollbar that terminates at the bar, while dropping the opaque mask, the `z-index`
and the sticky positioning. The one thing only the inside version can do is float _over_ rows, and
nothing appears to want that.

Leaves the name `Table.Footer` free for a column-aligned summary row, which is where "footer" belongs
(`<tfoot>` semantics). The two don't compete for a slot: a summary row _must_ be inside the scrollport
to scroll horizontally with its columns, and the status bar must be outside it. The full stack reads
header (inside, sticky top) → rows → `Table.Footer` (inside, sticky bottom, column-aligned) →
horizontal scrollbar → status bar (outside, chrome).

## Worth doing at the same time

`TableRootProps.className` and `style` both land on the **scroll container**; the viewport gets a
hardcoded `className="table-viewport"` and an inline style object. So a bordered design can only
reach the outer box through that global class — fine for one design system, awkward for per-table
variants. A viewport-level `className` (`viewportClassName`? or move `className` out and give the
scroll container its own) would round this out, and the outline case is the first real demand for it.

## Verification

The cases that actually distinguish this from what's there now:

- [ ] Long list — vertical scrollbar terminates at the bar's top edge, not past it.
- [ ] Short list, `fitContent` — bar sits directly under the last row, no dead space.
- [ ] Short list, no `fitContent` — bar at the bottom of the box, dead space above. (Classic.)
- [ ] Wide columns, short list — the horizontal scrollbar term is right, i.e. no phantom vertical
      scrollbar. Also confirm whether `scrollbar-gutter: stable` reserves the _block-end_ edge in
      Chrome; if it does the term is unconditional rather than gated on `virtualWidth > width`.
      (Unresolved in the proof.)
- [ ] Empty / loading / error with `fitContent` on — message keeps its full height.
- [ ] Bar full width, gutter included — the rule reaches the viewport edge, not `--table-viewport-width`.
- [ ] Consumer border + padding on `.table-viewport` — scroll container and bar both fit inside it.
- [ ] Paged source — `rowsToEnd` / auto-fetch still fire correctly against the reduced `table.height`.
