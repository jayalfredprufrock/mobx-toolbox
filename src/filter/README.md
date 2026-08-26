# @mobx-toolbox/filter

Reactive value filters — a filter is a predicate over one _already-extracted value_, not over a row.

```ts
import { SetFilter, RangeFilter, TextFilter, BLANK } from "@jayalfredprufrock/mobx-toolbox/filter";

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

Each filter also exposes `value` / `setValue`, which round-trip through `JSON.stringify` so filter
state can be persisted or put in a URL without restructuring anything.

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
all. `RangeFilterOptions` and `TextFilterOptions` therefore don't declare them, so a meaningless
`counts: true` on a range is a compile error rather than a silent no-op.

See `ColumnModel.facets` in the `table` docs for the three cost tiers these select.

## `RangeFilter`

An inclusive numeric range, either bound optional.

```ts
const score = new RangeFilter({ min: 0, max: 100 });
score.setRange(50, undefined); // 50 and up
```

Works over dates as well as numbers — values are coerced through `getTime()`, so a date column and a
numeric column are the same code path and the **bounds stay plain numbers**. That is what lets state
round-trip through JSON with no date-string handling: pass epoch millis for a date column.

Numeric strings are accepted, because a column of `"42"` is a data shape rather than a mistake. A
blank value fails while the filter is active — a missing cell is outside every bound, which is what
a range control implies.

## `TextFilter`

A single-value text filter — the "contains" box that lives on one column.

```ts
const name = new TextFilter({ match: "startsWith" });
name.setText("ab");
```

`match` (`"contains"` default, or `"startsWith"` / `"equals"`) and `caseSensitive` (default `false`)
are configuration rather than state: unlike `matchMode`, they aren't usually handed to the user.

Distinct from a table's cross-column search, which needs every column's accessor at once and so
can't be a value predicate — see `TableSearch` in the `table` docs. Both compare through the same
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

## Handing the work to a server

Every filter can either **evaluate** (`matches`) or **export itself** (`condition`) — the same state,
read two ways. `condition` is a `FilterCondition`: what is being compared, and how.

```ts
const level = new SetFilter({ selected: ["error", "warn"] });
level.condition; // { op: "in", value: ["error", "warn"] }

const score = new RangeFilter({ min: 50 });
score.condition; // { op: "range", value: { min: 50 } }

new TextFilter({ text: "ab", match: "startsWith" }).condition;
// { op: "startsWith", value: "ab" }
```

| Filter        | `op`                                     | `value`             |
| ------------- | ---------------------------------------- | ------------------- |
| `SetFilter`   | `"in"`, or `"all"` under that match mode | the selected values |
| `RangeFilter` | `"range"`                                | `{ min?, max? }`    |
| `TextFilter`  | its `match` — `"contains"` etc.          | the query text      |

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

interface ValueFilter {
  readonly active: boolean;
  matches(value: unknown): boolean;
  clear(): void;
  readonly condition?: FilterCondition | undefined;
  readonly intersecting?: boolean;
}

interface FilterCondition {
  field?: string; // filled in by the caller, not the filter
  op: FilterOp; // "in" | "all" | "range" | "contains" | "startsWith" | "equals" | "search" | string
  value: unknown; // JSON-safe
}

interface Facet {
  value: unknown;
  count?: number;
  blank?: boolean;
}
```

`Facet` is produced by whoever walks the data — see `ColumnModel.facets` in `table`. `count` is
present only when counts were asked for; an absent count means "not counted", never "zero".
`blank` is a render hint (italic "(Blank)", pinned last) so a view never has to compare against the
sentinel itself.
