# Requirements: consistent loading-state timing

Hand this to a session working in `mobx-toolbox`. It describes a problem and the constraints around
it. It does **not** prescribe a design — the shape is yours to work out. Suggestions are marked as
such.

---

## Before you start: the working tree is dirty

There is unreleased, uncommitted work in progress. Read it before designing anything, because it
overlaps this task and may already answer part of it:

```
 M src/lazy-observable/index.ts
 M src/model/make-model.ts
 M src/model/use-collection.ts
 M src/react-util/index.ts
?? src/lazy-observable/use-lazy.ts          # useLazy — a component-scoped lazy
?? src/lazy-observable/use-lazy.react.test.tsx
?? src/react-util/useStable.ts              # useMemo replacement React can't discard
?? src/model/model-cache.test.ts
```

Last release is `0.17.0` (`77e5479`). Neither `useLazy` nor `useStable` ships in it. Decide early
whether this work lands on top of that or alongside it.

---

## The problem

Loading UI flashes on fast responses. A request that resolves in 60 ms produces a 60 ms skeleton —
long enough to see, too short to read, and it happens on every navigation. The fix is well
understood (don't show the indicator until the wait crosses a threshold; once shown, keep it up for
a minimum) but the library applies it in exactly one place, inconsistently with the rest.

Three surfaces show loading state today, and they behave differently:

| surface                     | timing behaviour                                 |
| --------------------------- | ------------------------------------------------ |
| `[LOADING]` route component | threshold + minimum duration, implemented inline |
| `LazyObserver`              | none — placeholder renders immediately           |
| `table`                     | no concept of loading at all                     |

A consuming app therefore gets flicker-free loading when the router happens to own the wait, and
raw flicker everywhere else. That inconsistency is the thing to fix; the individual behaviours are
each defensible on their own.

---

## What exists today

**Router** (`src/router/`) — `LOADING_DELAY_MS = 300` and `LOADING_MIN_DURATION_MS = 300`, applied
in the outlet's `load()` with `setTimeout` plus a `hold` option for the first (cold) navigation.
This is the only correct implementation in the codebase and the reference for the behaviour, but it
is private to the router and not reusable.

**`LazyObserver`** (`src/lazy-observable/components/`) — gates on `every(o => o.loaded)` and renders
`placeholder` otherwise; throws on `status === "error"` so errors reach an error boundary. Note the
gate is on `loaded`, not `fetching`: a reload that keeps its value never shows the placeholder. That
means any timing work here applies only to the first load, which is the only case that can flash.

**`table`** (`src/table/`) — `TableConfig` has `rows` (array or tracked getter) and an `empty` slot;
nothing about loading. `src/table/lazy-binding.test.ts` covers driving `rows` from a
`lazyObservableArray` via the getter form, but that is a usage test, not an integration.

**`lazy-observable`** — already distinguishes `loading` ("nothing to show yet") from `fetching` ("a
request is in flight"), which is the state distinction any solution here will need.

---

## Requirements

### R1 — one timing primitive, public

The threshold/minimum-duration behaviour should exist once, be public API, and be usable directly by
consumers whose components render their own skeletons without going through `LazyObserver` or the
table.

Acceptance:

- A flag that is true for less than the threshold never surfaces as true.
- A flag that crosses the threshold surfaces as true for at least the minimum duration, even if the
  underlying flag clears immediately after.
- Defaults match the router's current constants (300/300) so all three surfaces agree.
- Overridable per call.
- Timers clean up on unmount.

Naming: `useDelayedFlag` was floated and rejected. The module's house style is mechanism-first
(`useDebouncedCallback`, `useDebouncedEffect`, `useMountedState`), and "debounce" would be wrong —
this is a threshold plus a floor, not a debounce. `useSustained(value, { after, minDuration })` is a
suggestion, not a decision.

### R2 — `LazyObserver` uses it

The placeholder should not appear for a wait shorter than the threshold.

Acceptance:

- Fast first load renders no placeholder at all.
- Slow first load renders the placeholder, and it stays for at least the minimum duration.
- A reload that keeps its value still renders children throughout (unchanged).
- Error behaviour unchanged.
- With the tuple form (`observe={[a, b, c]}`), the clock runs off the combined gate — it starts when
  the gate first goes pending and resets when it clears — not per-lazy.

Open: whether this is on by default or opt-in. The tradeoff is that a slow load now renders nothing
for the threshold window instead of a placeholder immediately. Suggestion: default on, because it
matches what `[LOADING]` already does and an app should not behave differently depending on whether
the router or a component owns the wait.

### R3 — the table owns its loading state

A table is the one surface where blanking destroys state the user built: scroll position, column
arrangement, and — since `setRows` with `getRowId` intersects rather than clears — their selection.
Replacing rows with a skeleton in order to fetch mostly-identical rows is a bad trade. It should be
able to keep showing what it has while indicating that a refresh is in flight.

It should also stop consumers hand-rolling the empty-vs-loading distinction. Today a consumer must
write `empty={list.loading ? undefined : <Empty/>}` or their table claims "no results" during the
first fetch. That is a footgun every table author hits once.

Acceptance — four states, distinguished:

| state                                  | expected                                                    |
| -------------------------------------- | ----------------------------------------------------------- |
| nothing loaded yet, request in flight  | loading treatment; **never** the `empty` slot               |
| rows present, request in flight        | rows stay rendered, with an indication a refresh is running |
| request in flight, genuinely zero rows | `empty`                                                     |
| settled, zero rows                     | `empty`                                                     |

Further:

- Stale rows stay interactive — clickable, selectable, sortable. (Suggestion: don't dim them;
  dimming reads as _disabled_.)
- The refresh indication is subject to R1, so a fast refetch does not strobe it.
- Column arrangement, scroll position and selection survive a refetch.

Open: how the table learns it is loading. A tracked getter alongside `rows` (`loading: () =>
list.fetching`) keeps `table` independent of `lazy-observable`; accepting a `LazyObservableArray`
directly as `rows` is more ergonomic and would also remove the `.slice()` requirement consumers
currently need for the getter form to track contents. `model` already depends on `lazy-observable`,
so the coupling would not be unprecedented — but `table` currently does not, and that is worth
preserving if it can be. These are not mutually exclusive.

### R4 — the router consumes the same primitive (if it can)

Once R1 exists, the router's inline implementation is a second copy of the same logic with its own
constants. Folding it in leaves one implementation and one pair of defaults.

Lower priority and explicitly optional: the router's version also handles the cold-navigation `hold`
case, and if that does not fall out of the shared primitive cleanly, leaving the router alone is a
better outcome than contorting the primitive to fit it. Say so if that is what you conclude.

---

## Constraints

- **Both halves are required.** A threshold alone turns a 320 ms wait into a 20 ms flash — the worst
  case of all. The minimum-duration half is what actually removes flashing.
- **Don't regress the `loading` / `fetching` distinction.** It is the right primitive and consumers
  depend on it; this work should make it easier to use, not paper over it.
- **`LazyObserver` throws on error.** Whatever the table does about errors should be a deliberate
  decision, not an accident of divergence — but note the table has no error boundary story today, so
  "nothing" may be the right answer for now.
- Timing values must be overridable. A dashboard tile and a full-page route do not want identical
  thresholds.

---

## Known consumer

`panelpro`'s `uri-app` will adopt this immediately; these are the call sites, useful for checking
the API against real usage:

- `src/components/layout/inbox.tsx` — takes `loading={!list.loaded}` and renders its own skeleton
  rows. This is the R1-only case: no `LazyObserver`, no table.
- `src/routes/org/{studies,surveys}/studies.tsx` — currently `empty={list.loading ? undefined :
<EmptyState/>}`, the exact workaround R3 should remove.
- `src/routes/org/{studies,surveys}/_scope.tsx` — a detail record loaded per route param, rendering
  a `<Skeleton>` crumb label while pending. Also the place that would switch from
  `useMemo(() => lazyObservable(...), [id])` to `useLazy` once that ships — worth confirming
  `useStable`'s "React may discard a `useMemo`" reasoning applies, since that is a live bug in the
  app today.
- `src/routes/org/studies/dashboard.tsx` — `LazyObserver` over per-record stats with a
  `<SkeletonText>` placeholder. The R2 case.

---

## Out of scope

- Any change to how lazies fetch, abort, invalidate, or cache.
- Error rendering and error boundaries generally.
- Skeleton _components_. This is about when an indicator appears, not what it looks like.
- Suspense integration.

---

## Report back with

1. The design you chose for R1 and why that shape over the alternatives.
2. What R2 and R3 cost in API surface, and anything you had to change about existing behaviour.
3. Whether R4 was worth doing, or why not.
4. Anything in the requirements above that turned out to be wrong or not worth having.
