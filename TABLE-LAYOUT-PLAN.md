# Table layout: composable viewport, measured chrome

Implementation plan. Supersedes `TABLE-STATUS-BAR.md`, which correctly diagnosed the problem
(a status bar inside the scrollport can never terminate the vertical scrollbar) but proposed to
solve it with props and arithmetic on `Table.Root`. This solves it by splitting the scrollport into
its own component and letting the browser do the arithmetic.

Net effect on the library: **fewer props, fewer CSS variables, less layout math, one new component.**

## 1. The structural change

`TableRoot` today renders `children` _inside_ `[role=table]`, so nothing a consumer composes can
ever be a sibling of the scroll container. Everything that belongs outside the scrollport — a status
bar, a toolbar, pagination — is therefore unreachable, and the only escape is a `Root` prop per
slot.

Split the two boxes into two components:

```tsx
<Table.Root table={table}>        {/* .table-viewport — flex column, measures nothing itself */}
  <Table.Scroll>                  {/* role=table — the scrollport; measures width + height */}
    <Table.Header>{…}</Table.Header>
    <Table.Body>{…}</Table.Body>
    <Table.Empty>No results</Table.Empty>
  </Table.Scroll>
  <Table.StatusBar>Showing {table.rows.length}</Table.StatusBar>
</Table.Root>
```

Nothing moves between files that doesn't have to. `Table.Scroll` takes, unchanged, everything in
`table-root.tsx` that is about scrolling: `role="table"`, the three `aria-*` attributes, `useScroll`,
the `scrollRequest` reaction, `containerType: scroll-state`, `scrollSnapType`, `scrollPaddingLeft`,
and the `table.width > 0 && table.height > 0` render gate. None of it needs anything `Root` holds
except the model, which is already in context.

## 2. The layout model

**Flex column, not grid.** A grid's `align-content` defaults to stretch, so in fill mode extra space
is distributed across every auto row and the status bar grows with the table. Correcting that needs
`1fr` on the scroll track, which requires `Root` to know which of its children is the scrollport.
In a flex column each child declares its own behaviour and `Root` stays agnostic:

```
.table-viewport   display: flex; flex-direction: column; position: relative;
                  width: 100%; height: 100%; max-height: <maxHeight>;
                  --table-row-height: <rowHeight>px

.table-scroll     flex: 1 1 auto; min-height: 0; overflow: auto; position: relative;
                  --table-scroll-width: <table.width>px

chrome            flex: 0 0 auto   (Table.StatusBar and anything like it)
```

`min-height: 0` on the scrollport is the load-bearing line — flex items default to
`min-height: auto`, which refuses to shrink below content. With it, all four cases fall out of the
browser:

|                         |                                                                            |
| ----------------------- | -------------------------------------------------------------------------- |
| fill, content fits      | free space goes to `flex: 1`; chrome keeps its natural height              |
| fill, content overflows | scrollport shrinks, scrolls; chrome unmoved                                |
| hug (`height: auto`)    | container is the sum of its children — box hugs the rows, bar follows them |
| capped (`max-height`)   | container capped, scrollport absorbs the difference                        |

### The render gate drops its height term

Gating children on `table.width > 0 && table.height > 0` deadlocks once height is measured off the
scrollport: no children means no content, which measures 0, which keeps the gate shut. Today that
can't happen because height comes from a viewport that is `height: 100%` of a sized parent.

Gate on **`width > 0` alone**. It works for the same reason the flex approach does — `Table.Body`'s
spacer is `virtualHeight` (`table.model.ts:258-263`), derived from row count and independent of
`table.height` — so the spacer reports the full content height on the first render even with an
empty window, and the window fills on the next pass. Height bootstraps itself; it just cannot be a
precondition for rendering.

### `maxHeight: ${table.height}px` comes off the scroll container

That one line is what forced everything else in the original proposal. Because JS set the
scrollport's height, JS had to _compute_ it — which meant knowing the header's flow height, the
horizontal scrollbar, and the height of every piece of chrome, none of which JS can see without
being told.

Delete it and `table.height` becomes a pure output: measured off the scroll container, feeding
nothing back into it. `Table.Body` already renders a fixed `virtualWidth × virtualHeight` spacer with
the window absolutely positioned inside (`table-body.tsx:34`), so the scrollport's content height is
`header + virtualHeight` — independent of `table.height`. No feedback loop, in any of the four cases.

Two incidental improvements: `table.height` is now the scrollport's content box, so it excludes the
horizontal scrollbar (today the viewport's box included that strip), and a consumer who caps
`.table-scroll` directly now gets a _correct_ `table.height` rather than the silent inconsistency
`maxHeight`'s TSDoc currently warns about at `table-root.tsx:22-28`.

## 3. `fitContent` and `minHeight` are not props

Hugging is `height: auto` on the viewport. The empty-state floor is `min-height`. Both are plain CSS
on a box the consumer now owns via `Root`'s `className`/`style`, which after the split land on the
viewport and spread last.

That retires the whole `fitContent` design: no `min()`/`calc()` expression, no header-height term, no
horizontal-scrollbar term, no `--table-scrollbar-width`, and no invented three-row floor for the
empty case. The consumer knows how tall their empty state is; the library doesn't.

The default stays classic — `height: 100%` means fill-your-parent exactly as today, so a bordered
table gets dead space below a short list without opting into anything.

## 4. Measured header, not declared

`<Table.Overlay>` is the only thing inside the scrollport that reads `table.height`
(`table-overlay.tsx:36`), and it currently subtracts two **consumer-declared** variables to find
where the rows start.

Replace both with a border-box `ResizeObserver` on the header div — an element the library already
renders (`table-header.tsx:28`) — reporting `table.setHeaderHeight()`.

- Border box, because `--table-header-gap` is padding and `useResize` reports the content box
  (`useResize.ts:5-9`). A padding change alters the border-box size, so RO fires on it; the
  measurement stays complete with no extra trigger.
- **The header gap must be padding on `.table-header`, not a bottom margin** — a bottom margin sits
  outside the border box and won't be seen. Documented, not enforced.
- Strictly more correct than the status quo: a consumer who renders no header at all currently gets
  `Overlay` reserving `rowHeight` for a header that isn't there. Measured, that's zero.

**Rejected: `offsetTop + offsetHeight`.** `ResizeObserver` reports size, not position, so a bottom
edge has to be read from the DOM — and RO never fires on position changes, so the value goes stale
silently with no signal to re-read it. **Rejected: a `display: flow-root` wrapper** to capture
margins as size. The header is `position: sticky; top: 0` (`table-header.tsx:32`) and sticky is
constrained by its containing block; a wrapper sized to the header makes sticky a no-op.

### `Overlay` stops contributing to content height

In hug mode an in-flow `Overlay` sized from `table.height` would loop: content height includes the
overlay, the overlay is derived from the measured content. It converges on the `min-height` floor,
but over frames.

Fix inside the component: the sticky wrapper becomes `height: 0` and its content moves to an
absolutely positioned child.

```tsx
<div style={{ position: "sticky", left: 0, height: 0, width: "var(--table-scroll-width)" }}>
  <div style={{ position: "absolute", inset: `${table.headerHeight}px 0 auto 0`,
                height: `${Math.max(0, table.height - table.headerHeight)}px`, … }}>
```

Sticky counts as positioned, so the child's containing block is the wrapper: horizontal pinning is
inherited, vertical size comes from two measured numbers, and out-of-flow means zero contribution to
the scrollport's content height. Consumer markup is unchanged.

Pre-existing quirk this neither fixes nor worsens: a hand-shown `<Table.Overlay>` on a _populated_
table sits after the spacer in flow, below the visible area. The gated slots only show when there
are no rows, so it doesn't bite them.

## 5. CSS variable contract

| var                                               | set by                     | after                                                                                                                                                                                                        |
| ------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--table-row-height`                              | library                    | unchanged — exposed for consumers, read by nothing internally                                                                                                                                                |
| `--table-viewport-width` → `--table-scroll-width` | library                    | renamed for accuracy: it holds the _scrollport's_ visible width while `.table-viewport` is the outer box. Read by `table-expansion.tsx:37`, `table-gutter.tsx:84`, `Overlay`; `StatusBar` no longer needs it |
| `--table-header-height`                           | **consumer** → **library** | **inverted**, not deleted: no longer declared by the consumer, now _published_ from the measured value so consumer CSS can use it — insetting a custom scrollbar below the header is the motivating case     |
| `--table-header-gap`                              | **consumer**               | **deleted**                                                                                                                                                                                                  |
| `--table-scrollbar-width`                         | (proposed)                 | never created                                                                                                                                                                                                |
| `--table-pinned-bg`                               | **consumer**               | **stays**                                                                                                                                                                                                    |

Consumer-set measurements: two → zero. What remains is `--table-pinned-bg`, a colour with a working
theme-aware default (`Canvas`), which exists only because that background is an inline style a
consumer's class can't override. Nothing breaks if it's never set.

## 6. Public API

|                    | before                                                             | after                                                                                                                                      |
| ------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `Table.Root` props | `table`, `children`, `className`, `style`, `maxHeight`, `checkbox` | unchanged — but `className`/`style` now land on the viewport                                                                               |
| `Table.Scroll`     | —                                                                  | **new**: `ComponentPropsWithRef<"div">` — full prop spread and a **merged ref**, so a scroll-area primitive can compose onto it (see §6.1) |
| `Table.StatusBar`  | sticky, inside the scrollport                                      | plain flex chrome, outside it; keeps its name and its `height` prop                                                                        |
| model              | `height`, `width`                                                  | `+ headerHeight`, `+ setHeaderHeight`                                                                                                      |
| `useResize`        | content box only                                                   | `+ box: "content" \| "border"`, default `"content"`                                                                                        |
| `react-util`       | —                                                                  | `+ useMergedRef` (~15 lines; nothing in `src/table/components` forwards a ref today)                                                       |

No prop is added to `Root`. Rejected from earlier drafts: `statusBar`, `statusBarHeight`,
`fitContent`, `viewportClassName`, `viewportStyle`, and a `registerChrome`/`chromeHeight` mechanism
in the model — flex subtracts chrome without being told it exists.

### 6.1 Scroll-area interop

Ark UI's `ScrollArea` hides the native scrollbar and renders its own, with anatomy
`Root > Viewport > Content` plus `Scrollbar > Thumb` as a **sibling of the Viewport**. The Viewport
is the scrolling element, and every part supports `asChild`.

That sibling placement is the unlock: a custom scrollbar can be inset below the sticky header,
which a native scrollbar can never do — it belongs to the scrollport and spans its full height by
definition. The inset must go through the `style` prop, not a stylesheet: the machine sets
`top: 0` inline for the vertical orientation (`scroll-area.connect.mjs:151`), and
`mergeProps(machineProps, localProps)` in `scroll-area-scrollbar.js` puts consumer props last, so
`style={{ top: table.headerHeight }}` wins while CSS would lose to the inline value. Combined with the status bar leaving the
scrollport (§1), the vertical scrollbar then spans exactly the row region.

The library implements no scrollbar behaviour. It only needs to not block one:

- **Merged ref + full prop spread on `Table.Scroll`**, so `<ScrollArea.Viewport asChild>` can
  compose onto it. React 19 passes `ref` as an ordinary prop, so no `forwardRef`.
- **Publish `--table-header-height`** from the measured value (§5).

Nothing else. In particular `scrollRequest` does **not** need an `x` axis: a consumer with the
merged ref can write `scrollLeft` directly, and `useScroll` feeds the result back into the model.

Consequences to document rather than fix:

- Hiding the native scrollbar means the scrollport's content box no longer excludes a gutter, so
  `table.width` becomes the full width and columns flow under an overlay scrollbar. To reserve
  space, `padding-inline-end` on `Table.Scroll` reduces the measurement by exactly that much —
  `useResize` reports the content box.
- `Table.Scroll` nested inside a `ScrollArea.Root` is no longer a direct child of the viewport, so
  the flex sizing from §2 moves to the wrapper and `Table.Scroll` becomes `height: 100%`.
- `ScrollArea.Content` sits inside the Viewport, wrapping `Header`/`Body`. Harmless for sticky (the
  nearest scrollport is unchanged) and for the absolute row window (its containing block stays the
  scrollport, or becomes a Content div whose origin coincides). It sets `minWidth: "fit-content"`
  (`scroll-area.connect.mjs:116`) — a _min_, so it cannot shrink the explicitly-sized header or
  spacer, and it resolves to `virtualWidth` whether or not the columns overflow. No conflict.
- A custom horizontal thumb writes `scrollLeft` directly, which the library's
  `scroll-snap-type: x proximity` will then act on. Needs a real test.

**Performance — measured against `@zag-js/scroll-area@1.41.2`** (what `@ark-ui/react@5.37.2`
resolves to in `uri-app`).

`viewport.scroll` dispatches `["setThumbSize", "setScrolling", "setProgrammaticScroll"]` on **every
scroll event**, and nothing is cached:

- `setThumbSize` (`scroll-area.machine.mjs:138-233`) reads `scrollHeight`/`scrollWidth`/
  `clientHeight`/`clientWidth`/`scrollTop`/`scrollLeft` (141-151), calls `getScrollOffset` four
  times — each a `getComputedStyle` (`utils/scroll-offset.mjs`) — at 158-161, reads
  `offsetWidth`/`offsetHeight` six times (164-165, 178, 184, 194-195), and runs `getScrollSides`
  for six more (211). Then four custom-property writes on the viewport (229-232).
- Writes land _between_ reads: `thumb.style.transform` at 181 then `offsetWidth` at 184; transform
  at 187 then `offsetWidth`/`offsetHeight` at 194-195.
- `setScrolling` (240-266) runs `getScrollSides` **again** — the same six reads repeated.

Roughly 25 layout reads plus four style resolutions per scroll event, with intra-handler
read-after-write.

**The thumb itself is fine.** Position is written imperatively (`style.transform`, lines 181/187),
not through React state, so there is no render per frame for the thumb.

**But `cornerSize` is unguarded.** `thumbSize` (168), `hiddenState` (199) and `atSides` (210, 249)
all return the previous value when unchanged; `cornerSize` (192, 196) sets a fresh object literal
with no such guard. Since every sibling is explicitly guarded, `context.set` plainly does not
deep-compare — so a rendered `Corner` churns context every scroll event and re-renders the
ScrollArea subtree per frame (`Root`'s style carries `--corner-width`/`--corner-height`).
**Do not render `ScrollArea.Corner`** — `cornerEl` null skips the whole block (189).

**Net expectation.** Layout reads are cheap when layout is clean, and ours is not guaranteed clean:
`use-scroll.ts` updates synchronously and shifts the row window. Scroll is a continuous event, so
React flushes that commit at default priority — likely after the handlers — making the realistic
cost about one forced layout flush per scroll frame rather than two. Not free on a wide window, not
obviously fatal. Profile for `setThumbSize` plus a layout bar per frame before deciding.

**Fallback if it does show up.** A thumb driven from model state costs zero layout reads and zero
renders: `scrollY`, `virtualHeight`, `height`, `scrollX`, `virtualWidth`, `width` are already
observable, and a MobX `reaction` writing `transform` on a ref needs no scroll listener, no
`getComputedStyle`, and no ResizeObserver. The price is hand-written drag handling. Either choice
leaves this plan unchanged.

**Bonus.** The machine publishes `--scroll-area-overflow-y-start`/`-end` (and `-x-`) on the viewport
(229-232) — scroll offsets in CSS for free, useful for edge fade masks.

## 7. Migration

1. Wrap the contents of every `<Table.Root>` in `<Table.Scroll>`. Mechanical.
2. `<Table.StatusBar>` moves _outside_ `<Table.Scroll>`, as a sibling.
3. `<Table.Empty>` / `<Table.Loading>` / `<Table.Error>` / `<Table.Overlay>` stay inside it.
4. Delete `--table-header-height` and `--table-header-gap` declarations. Confirm the header gap is
   padding on `.table-header` rather than a bottom margin.
5. Rename any read of `--table-viewport-width` to `--table-scroll-width`.
6. ⚠️ **`className`/`style` on `Table.Root` now style the viewport, not the scroll container.** No
   type error and no test failure — check each occurrence by hand. Scrollport styling moves to
   `Table.Scroll`.
7. ⚠️ Hugging behaviour is now `style={{ height: "auto", minHeight: … }}` on `Table.Root`. Anything
   relying on `StatusBar`'s old short-list placement needs it.

## 8. Risks and what CI cannot prove

- **happy-dom lays nothing out.** Tests stub `ResizeObserver` to a no-op and drive `table.setWidth`/
  `setHeight` directly (`table.react.test.tsx:9-25` and the same pattern in three other files), so
  model-side coverage survives intact and `setHeaderHeight` slots into it. But no test can prove the
  scrollport actually shrinks, that `min-height: 0` is doing its job, or that chrome keeps its
  height. Those become browser checks, and this is a real step down from
  `maxHeight: ${table.height}px`, which `paged-table.react.test.tsx:225` can assert as an inline
  style today.
- **`min-height: 0` is load-bearing and overridable.** A consumer `style` on `Table.Scroll` that
  disturbs it produces an uncapped box or a double scrollbar. Layout correctness moves from an inline
  style that always wins into CSS the consumer can reach.
- **A missing `<Table.Scroll>` is a blank table**, silently: no width is measured, so the render gate
  hides everything. `Scroll` publishes a context flag and `Header`/`Body` throw in dev without it.
- **The `Overlay` rewrite is the risk concentrate.** Everything else is a move or a deletion.

## 9. Work plan

**Phase 1 — measured header. ✅ Implemented.** `useResize` border-box option; `headerHeight` + `setHeaderHeight` on
the model; the header's observer; `Overlay` reads it; `--table-header-height` published from the
measured value. Independently shippable, no structural change, and it retires both header variables
as consumer inputs on its own — which is also everything a custom scrollbar needs to inset itself
below the header, so it can land before any decision about scroll areas.

**Phase 2 — the split. ✅ Implemented**, with `StatusBar` pulled forward from Phase 3 (leaving it inside the scrollport for a phase would have shipped a structurally misplaced component). An inverse guard was added alongside the planned one, so both halves of the migration mistake throw. The `--table-viewport-width` → `--table-scroll-width` rename remains in Phase 3.

Original scope: `table-scroll.tsx` with `useMergedRef` and full prop spread; `Root` becomes
the flex viewport; move the scroll concerns across; `Overlay`'s zero-height wrapper; the dev guard.
Absorbs the 33 test mount sites and the 10 README examples.

**Phase 3 — chrome and docs. ✅ Implemented** (`StatusBar` landed in Phase 2). Added beyond the plan: a `.table-scroll` class, so the scrolling box is addressable without `[role=table]`.

Original scope: `StatusBar` rewritten as a flex item; `--table-scroll-width` rename;
README restructure (skeleton, `StatusBar`, `maxHeight` TSDoc, the variable contract at README:1508,
the attribute table at README:1502-1504); `MIGRATION.md` entry.

## 10. Cost

|              |                                                                                                                                                                                                                                                                                           |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Files        | ~15 — new `table-scroll.tsx`; `table-root`, `table-header`, `table-overlay`, `table-status-bar`, `table-gutter`, `table-expansion`, `components/index`, `namespace`, `table.model`, `useResize`, new `react-util/useMergedRef`, 3 react test files, `src/table/README.md`, `MIGRATION.md` |
| Code         | net negative in `src/` (~-60 lines): the flex declaration replaces more arithmetic than it adds. ~50 mechanical edits across tests and docs                                                                                                                                               |
| Session      | ~500–700k tokens, concentrated in `Overlay` and the README restructure                                                                                                                                                                                                                    |
| Verification | `vp check` and `vp test` after each phase. The four layout cases in §2 need a browser; they will be reported as unverified-in-CI rather than claimed green                                                                                                                                |

## 11. Open calls

`Table.Scroll` is settled as the name.

- **Whether `maxHeight` stays a prop.** It becomes redundant — `style={{ maxHeight }}` on the
  viewport is now simply correct, and the trap its TSDoc warns about disappears. Keeping it costs
  nothing and reads as intent; the TSDoc shrinks either way.
