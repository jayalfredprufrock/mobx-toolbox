# @mobx-toolbox/filter

Reactive value filters — a filter is a predicate over one _already-extracted value_, not over a row.

```ts
import {
  SetFilter,
  NumberFilter,
  DateFilter,
  BucketFilter,
} from "@jayalfredprufrock/mobx-toolbox/filter";

const status = new SetFilter({ options: ["open", "closed"] });
status.toggle("open");

tickets.filter((t) => status.matches(t.status));
```

On a table, attach one per column — as a factory when the defs live outside the component, so each
table gets its own and a remount starts clean:

```ts
const columns = [{ key: "status", filter: () => new SetFilter() }];
```

That signature — `matches(value)` rather than `matches(row)` — is the whole design. A filter carries
no accessor, no path string and no row generic, so the same instance works over an array, a MobX
computed, a sidebar rail, or a table column that feeds it the column's own value accessor. The
`table` module consumes these structurally (see `ColumnFilter` there); nothing here imports `table`,
and `table` imports no class from here.

A filter that genuinely needs a whole row is a computed value — project the row down to the value
you want to filter on, then filter that.

## The shared contract

Every filter satisfies `ValueFilter`:

| Member           | Meaning                                                                    |
| ---------------- | -------------------------------------------------------------------------- |
| `active`         | Whether it is narrowing anything. An inactive filter matches everything.   |
| `matches(value)` | Whether one extracted value passes. Always `true` while `active` is false. |
| `clear()`        | Reset to inactive.                                                         |
| `condition`      | Its state as JSON, for a server to apply instead. `undefined` if inactive. |
| `intersecting`   | Whether picking more narrows rather than widens. Only affects counts.      |

`has` / `toggle` / `select` are deliberately **not** on the interface — they belong to a set filter
alone, and a UI that needs them narrows by `instanceof`. Keeping them off is what stops
`ValueFilter` becoming a bag of optional capabilities every consumer has to sniff for.

### Saving and restoring

`value` / `setValue` round-trip through `JSON.stringify`, so filter state can go into storage, a URL,
or a saved view:

```ts
const saved = JSON.stringify(filter.value);
filter.setValue(JSON.parse(saved));
```

`value` is typed per filter; `setValue` takes `unknown` on purpose. What comes back was written by
some earlier version of your app or typed by hand into a URL, so each filter validates it and falls
back to cleared rather than trusting the shape — a `DateFilter` snapshot handed to a `SetFilter`
resets it instead of corrupting it, and unusable entries inside an otherwise valid snapshot are
dropped.

Calling `setValue()` with nothing resets to the default, so it doubles as `clear()` plus a mode reset.

A table persists these for you into `TableState.filters` — see the
[table docs](../table/README.md#persisting-the-view). Storage stays the consumer's job either way.

## `SetFilter`

The checkbox-list filter: match a value against a chosen set.

```ts
const category = new SetFilter();
category.toggle("books");
category.matches("books"); // true
category.matches("music"); // false

// arrays are matched by overlap
const tags = new SetFilter({ selected: ["urgent"] });
tags.matches(["urgent", "backlog"]); // true
```

| Member            | Type                                        | Notes                                           |
| ----------------- | ------------------------------------------- | ----------------------------------------------- |
| `selected`        | `Set<SetFilterValue>`                       | Observable. Empty = inactive.                   |
| `selectedCount`   | `number`                                    | What a filter chip shows.                       |
| `matchMode`       | `"any" \| "all"`                            | Observable — see below.                         |
| `has(v)`          | `boolean`                                   |                                                 |
| `toggle(v)`       |                                             |                                                 |
| `select(vs?)`     |                                             | Replace the whole selection; no args clears it. |
| `setMatchMode(m)` |                                             |                                                 |
| `options`         | `readonly SetFilterValue[] \| undefined`    | Declared domain. Config, not state.             |
| `counts`          | `boolean`                                   | Opt into facet counts. Config, not state.       |
| `multiValue`      | `boolean`                                   | Values are arrays. Config, not state.           |
| `intersecting`    | `boolean`                                   | `matchMode === "all"`. Derived, not config.     |
| `value`           | `{ selected: SetFilterValue[]; matchMode }` |                                                 |

`SetFilterValue` is `string | number | boolean` — primitives only, deliberately. The domain has to
survive `JSON.stringify` for state to be persistable, and it has to compare by value for a `Set` to
dedupe it. Anything else a column yields is stringified on the way in, so two equal `Date`s land on
one entry rather than two.

### `matchMode` is state, not config

`"any"` (the default) matches a value that is _any_ of the selections; `"all"` requires every
selection to be present. It is observable rather than constructor-only because a UI can reasonably
offer the toggle.

It is only meaningful for array-valued data. On a scalar, `"all"` with two selections matches
nothing and the list empties out — a dead end with no explanation for whoever clicked it. Declare
`multiValue: true` and offer the toggle only where it does something:

```tsx
{
  filter.multiValue && <MatchModeToggle filter={filter} />;
}
```

`multiValue` is advisory in the way a column's `sortable` and `filterable` are: nothing is gated by
it, and `setMatchMode("all")` still works without it. It also does **not** change matching —
`matches` flattens arrays either way. It exists purely so the decision lives next to the filter's
declaration instead of as a `column.key === "tags"` switch inside a popover.

The mode also changes what a facet count means, which is what `intersecting` exists to tell whoever
is counting. Under `"any"` each pick **widens** the result, so a count answers "how many rows carry
this value". Under `"all"` each pick **narrows** it, so that number would describe a question the
filter is no longer asking — read literally, it promises more rows than ticking the box actually
gives you. The count becomes the size of the intersection with what is already picked instead:

```
tags = ["urgent", "automated", ...]        matchMode: "all", "urgent" picked -> 16 rows

  urgent      16   <- what you have now
  automated    4   <- what you would have if you picked this too
                      (8 rows carry "automated"; only 4 of them also carry "urgent")
```

So under `"all"` a count is exactly predictive: tick the box and you get that many rows. Under
`"any"` it stays the conventional facet number — rows carrying the value, among rows passing every
_other_ filter — which is not the same as "rows this would add". Worth knowing if you put both modes
in one UI.

`intersecting` is a boolean rather than the mode itself so that the rule for deciding it stays here,
with the filter that has the modes. Whoever computes facets never has to know what `"all"` means.

### `options` and `counts`

Both are configuration for whoever computes facets — a list of values with tallies. They live here
rather than on a table column def because faceting is a _set-filter_ concept, not a table one: a
numeric range's equivalent would be a histogram (buckets, not values) and free text has no domain at
all. `DateFilterOptions` and `TextFilterOptions` therefore don't declare them, so a meaningless
`counts: true` on a range is a compile error rather than a silent no-op.

See `ColumnModel.facets` in the `table` docs for the three cost tiers these select.

## `DateFilter`

An inclusive date range, either bound optional.

```ts
const joined = new DateFilter();
joined.setRange("2020-01-01", new Date());
```

It absorbs the three shapes a date column actually arrives in — a hydrated `Date`, an epoch number,
an ISO string — on **both** sides: the values it compares and the bounds you hand it. So the example
above works over a column of unix timestamps, and you never write the same three-branch coercion
again.

| Input            | Read as                                                 |
| ---------------- | ------------------------------------------------------- |
| `Date`           | `getTime()`; an invalid Date matches nothing            |
| `number`         | epoch seconds or milliseconds — see below               |
| all-digit string | the same, since a timestamp often survives JSON as text |
| other string     | `Date.parse`; unparseable matches nothing               |

Bounds are stored as epoch **milliseconds**, which keeps `value` a pair of plain numbers and the JSON
round-trip free of date-string parsing. `range` hands them back as `Date`s for a picker.

### Seconds or milliseconds

A bare number is ambiguous, so `unit` decides. The default, `"auto"`, reads anything below `1e11` as
seconds and the rest as milliseconds. That boundary is 1973 read as milliseconds and the year 5138
read as seconds, so no plausible modern date falls on the wrong side of it.

```ts
new DateFilter({ min: 1_700_000_000 }); // seconds  -> 2023
new DateFilter({ min: 1_700_000_000_000 }); // millis -> the same instant
new DateFilter({ min: 2, unit: "ms" }); // pin it when guessing would be wrong
```

Pin `unit` if your data sits near the epoch, or anywhere a wrong guess would be worse than being
explicit — a silently misread date is a bad failure, and it should not be unfixable.

## `NumberFilter`

A numeric comparison: an operator plus its operand.

```ts
new NumberFilter({ op: "gte", operand: 60 });
new NumberFilter({ op: "between", operand: { min: 60, max: 80 } });
```

| `op`                        | matches                |
| --------------------------- | ---------------------- |
| `eq` / `neq`                | `n === x` / `n !== x`  |
| `gt` / `gte` / `lt` / `lte` | the obvious comparison |
| `between`                   | `x <= n <= y`          |
| `betweenExclusive`          | `x < n < y`            |

The operand's shape follows the operator — a single number for the unary ops, `{ min, max }` for the
two interval ops — and the types tie them together, so `{ op: "eq", operand: { min: 1 } }` is a
compile error rather than something `active` has to reject.

### Interval bounds are independent

Each bound is separately optional, so `{ min: 60 }` is a valid "60 and up" and an open end is simply
unbounded. That is not tidiness — it is what lets a two-input range control read and write the filter
directly, with **no draft state**:

```tsx
<input value={filter.min ?? ""} onChange={(e) => filter.setMin(parse(e.target.value))} />
<input value={filter.max ?? ""} onChange={(e) => filter.setMax(parse(e.target.value))} />
```

`setMin` and `setMax` each leave the other bound alone, so clearing the upper box doesn't wipe the
lower one the user just filled in. Requiring both bounds would force every consumer to mirror the pair
into component state, seed it on mount and reset it on clear — and that copy then goes stale the moment
something else calls `clearColumnFilters()` with the control open. Reading `min`/`max` straight off the
filter has no such path.

The names, and the `{ min, max }` shape, are deliberately the same as `DateFilter`'s, so a range
control written for one reads the other. `setRange(min, max)` sets both at once, as it does there.

`min` and `max` are `undefined` under a unary operator, where a UI renders one input rather than two,
and `setMin`/`setMax`/`setRange` are no-ops there. An absent bound is an absent key, so nothing has to
survive JSON as `null`.

Changing the operator alone can therefore leave the filter **inactive**, which is deliberate: a
`[60, 80]` pair means nothing to `gte`, and silently keeping the first element would filter by
something nobody asked for. An operator dropdown should set both at once:

```ts
filter.set("gte", 60); // operator and operand together
filter.setOp("between"); // inactive until an operand fits
```

Numeric strings are accepted, because a column of `"42"` is a data shape rather than a mistake. A
blank value satisfies **no** comparison while the filter is active — not even `neq`, which would
otherwise quietly include every empty row. `clear()` drops the operand and keeps the operator.

## `BucketFilter`

A set filter over named ranges — pick "B" rather than typing 80 to 90.

```ts
{
  key: "score",
  filter: () => new BucketFilter({
    buckets: [
      { label: "A", min: 90 },
      { label: "B", min: 80, max: 90 },
      { label: "C", min: 70, max: 80 },
      { label: "D", min: 60, max: 70 },
      { label: "F", max: 60 },
    ],
  }),
}
```

The column keeps showing and **sorting the raw value** — 84 still sorts above 81 inside "B" — while
only the filter sees the buckets. That is the whole point of it.

Ranges are `[min, max)`: inclusive lower, exclusive upper, so two adjacent buckets sharing a number
don't both claim it. Omit either bound for an open end. The first matching bucket wins, so
overlapping definitions resolve by declaration order instead of being an error you can't act on.

It **extends `SetFilter`**, which is not an implementation detail but the reason it's cheap: it _is_
a checkbox list, so facets, counts, blanks, match modes and serialization all already apply, and a
popover narrowing by `instanceof SetFilter` renders it with no changes. `options` is derived from the
labels rather than declared twice, so the two can't drift.

A blank stays blank rather than falling into the bottom bucket — a missing score is not a low one —
so it gets its own `(Blank)` facet as usual. A value outside every bucket keeps itself, appearing in
the facet list as the raw number instead of vanishing.

`bucketOf(value)` reports which bucket a value fell in, and `bucketProjection(buckets)` is exported
on its own: the same function labels a value for a cell renderer or a chart legend, and reusing it is
what keeps everything agreeing on which bucket a score is in.

⚠️ Server mode: the condition carries the selected **labels**, which a server can only act on if it
knows the same bucket definitions. Map labels to ranges yourself when building the request, or keep
bucket filters client-side.

### Grouping without buckets

`BucketFilter` is `SetFilter` with one option set, and that option is public:

```ts
new SetFilter({
  options: ["Jan", "Feb", "Mar"],
  project: (v) => MONTHS[new Date(v as string).getMonth()],
});
```

`project` maps a raw value to the value the filter compares. `matches` applies it itself, so callers
pass raw values in. It is on the `ValueFilter` interface because whoever computes facets walks the
data separately and has to project identically — otherwise the list offers raw values that select
nothing, which reads as a broken filter rather than a missing projection.

## `TextFilter`

A single-value text filter — the "contains" box that lives on one column.

```ts
const name = new TextFilter({ match: "startsWith" });
name.setText("ab");
```

`match` (`"contains"` default, or `"startsWith"` / `"equals"`) and `caseSensitive` (default `false`)
are configuration rather than state: unlike `matchMode`, they aren't usually handed to the user.

Distinct from a table's cross-column search, which needs every column's accessor at once and so
can't be a value predicate — see `TableSearchFilter` in the `table` docs. Both compare through the same
`textMatches`, so a per-column "contains" and a search box agree.

## Blanks

Missing and empty values normalise to one sentinel, `BLANK`:

```ts
import { BLANK, isBlank, facetValues } from "@jayalfredprufrock/mobx-toolbox/filter";

const filter = new SetFilter({ selected: [BLANK] });
filter.matches(null); // true
filter.matches([]); // true
filter.matches(""); // true
```

`BLANK` is `""`, and that is the right sentinel _because_ it conflates empty-string with missing —
that is the behaviour a "(Blank)" checkbox is expected to have. A more distinctive sentinel would
preserve a distinction no filter UI has a way to express, and would stop the domain being JSON-safe.

Blanks need **no separate state**: `BLANK` sits inside `selected` like any other value, so `matches`,
`has`, `toggle`, `select`, `value`, `active`, `selectedCount` and `clear` are all unchanged by it,
and "select all" needs no special case.

Two helpers make the rule shareable, which matters more than it looks:

| Helper               | Returns                                            |
| -------------------- | -------------------------------------------------- |
| `isBlank(value)`     | Whether a value counts as missing/empty.           |
| `facetValues(value)` | The set of facet values one raw value contributes. |

`facetValues` flattens arrays, drops blank entries, and yields `{ BLANK }` when nothing non-blank
survives. It is the single definition of the blank rule, used by `SetFilter.matches` _and_ by the
table's facet tally. If those two ever disagreed you would get a facet in the list that selects no
rows — which reads as a broken filter rather than a normalisation bug, and is why this is one
exported function rather than a rule written twice.

Note the test is "contributed no non-blank values", not "the raw value is nullish". An empty array
counts as blank, or a `tags: []` row would be unreachable through the "(Blank)" facet.

## View props

Every filter carries a `props` object for whatever your components need and the filter itself has no
use for — an option label, a unit, an icon. Each class has its own interface, empty by default and
**open for augmentation**:

```ts
declare module "@jayalfredprufrock/mobx-toolbox/filter" {
  interface SetFilterProps {
    renderOption?: (value: SetFilterValue) => ReactNode;
  }
}

new SetFilter({ props: { renderOption: (v) => <Badge value={v} /> } });
```

Once augmented it is checked at every construction site and every read; until then, any `props` you
pass is a type error, which is the point. `SetFilterProps`, `NumberFilterProps`, `DateFilterProps`,
`TextFilterProps`, and `BucketFilterProps` (which extends `SetFilterProps`, so a popover narrowing by
`instanceof SetFilter` reads a bucket filter's props through the same shape). `props` defaults to
`{}`, never `undefined`.

### When the library declares an option instead

`props` is the default answer for anything view-shaped. A named option is only worth declaring when
one of three things holds:

1. **The library reads it.** `hideable` and `pinnable` gate snapshot restore in `applyColumnState`.
2. **It supplies a non-trivial default.** `filterable` is
   `!== false && filter !== undefined && !selection` — a rule a call site should not have to repeat.
3. **The concept is universal and precisely typable.** `multiValue` means one thing for every set
   filter, and is exactly a boolean.

A render function is none of those, which is why there is no `filterOption` on the column def any
more: nothing in the library called it, its `String(value)` fallback lived at the call site anyway,
and "render a value" cannot be typed precisely in a package that imports nothing from React.

## Handing the work to a server

Every filter can either **evaluate** (`matches`) or **export itself** (`condition`) — the same state,
read two ways. `condition` is a `FilterCondition`: what is being compared, and how.

```ts
const level = new SetFilter({ selected: ["error", "warn"] });
level.condition; // { op: "in", value: ["error", "warn"] }

const score = new DateFilter({ min: 50 });
score.condition; // { op: "range", value: { min: 50 } }

new TextFilter({ text: "ab", match: "startsWith" }).condition;
// { op: "startsWith", value: "ab" }
```

| Filter       | `op`                                     | `value`             |
| ------------ | ---------------------------------------- | ------------------- |
| `SetFilter`  | `"in"`, or `"all"` under that match mode | the selected values |
| `DateFilter` | `"range"`                                | `{ min?, max? }`    |
| `TextFilter` | its `match` — `"contains"` etc.          | the query text      |

It is deliberately **not** a query language. `FilterCondition` names the comparison and leaves the
translation to you, so one filter works against a REST endpoint, a typed POST body, or SQL without
knowing which. A raw query-string fragment would presume GET, need hand-rolled escaping, and pin the
filter to one endpoint's shape.

`field` is absent on what a filter produces — a filter doesn't know the name its data goes by on the
wire. Whoever does fills it in; for a table that is the column (`field` on the def, defaulting to
`key`). See `filterMode` and `TableModel.filterQuery` in the [table docs](../table/README.md).

`TextFilter` does not serialize `caseSensitive`: that describes how _this_ process compares, and a
server's collation is its own business.

## `textMatches`

```ts
textMatches(query, value, match?, caseSensitive?): boolean;
```

An empty query matches everything, which is what makes "nothing typed" a pass-through rather than a
special case at every call site. Nothing is trimmed: a trailing space is a legitimate part of a
"contains" query, and trimming here but not there is how the two drift apart.

## Key types

```ts
type SetFilterValue = string | number | boolean;
type SetMatchMode = "any" | "all";
type TextMatchMode = "contains" | "startsWith" | "equals";

type UnaryNumberOp = "eq" | "neq" | "gt" | "lt" | "gte" | "lte";
type IntervalNumberOp = "between" | "betweenExclusive";
type NumberOp = UnaryNumberOp | IntervalNumberOp;

interface NumberBounds {
  min?: number;
  max?: number;
}

type DateUnit = "s" | "ms" | "auto";
type DateLike = Date | number | string;

interface Bucket {
  label: SetFilterValue;
  min?: number; // inclusive
  max?: number; // exclusive
}

interface ValueFilter {
  readonly active: boolean;
  matches(value: unknown): boolean;
  clear(): void;
  readonly value?: unknown;
  setValue?(value?: unknown): void;
  readonly condition?: FilterCondition | undefined;
  readonly project?: (value: unknown) => unknown;
  readonly intersecting?: boolean;
}

interface FilterCondition {
  field?: string; // filled in by the caller, not the filter
  op: FilterOp; // "in" | "all" | "range" | "contains" | "startsWith" | "equals" | "search" | string
  value: unknown; // JSON-safe
}

interface Facet {
  value: SetFilterValue;
  count?: number;
  blank?: boolean;
}
```

`Facet` is produced by whoever walks the data — see `ColumnModel.facets` in `table`. `value` is a
`SetFilterValue` rather than `unknown` because that is what a facet genuinely is —
`facetValues` stringifies anything else — so `filter.toggle(facet.value)` needs no cast. `count` is
present only when counts were asked for; an absent count means "not counted", never "zero".
`blank` is a render hint (italic "(Blank)", pinned last) so a view never has to compare against the
sentinel itself.
