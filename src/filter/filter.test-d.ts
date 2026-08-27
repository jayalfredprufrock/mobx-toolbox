/**
 * Compile-time assertions for the filter contracts. The file passing `vp check` *is* the test.
 *
 * Two things are worth pinning down at the type level rather than at runtime:
 *
 * 1. Faceting is a set-filter concept. A `counts: true` on a numeric range has no meaning, and the
 *    whole reason `options`/`counts` live in `SetFilterOptions` instead of on the column def is that
 *    it makes the meaningless combination a type error instead of a silent no-op.
 * 3. View props are open for augmentation, so declaring what your components need is checked at
 *    every construction site.
 * 2. `table` must never need to import a filter class. It declares `ColumnFilter` structurally, so
 *    if these classes drift out of that shape it has to be a compile error here — nothing at runtime
 *    would notice until a column silently stopped filtering.
 */
import type { ColumnModel } from "../table/column.model";
import type { ColumnFilter } from "../table/table.types";
import type { FilterCondition, SetFilterProps, SetFilterValue } from "./filter.types";
import { BucketFilter } from "./bucket-filter.model";
import { DateFilter } from "./date-filter.model";
import { NumberFilter } from "./number-filter.model";
import { SetFilter } from "./set-filter.model";
import { TextFilter } from "./text-filter.model";

const assignableTo = <Expected>(_value: Expected): void => {};

// --- props are open for augmentation ---------------------------------------
//
// Declaring what your components need makes it type-checked at every construction site and every
// read. This block *is* the test: it compiles only if the merge works.

declare module "./filter.types" {
  interface SetFilterProps {
    renderOption?: (value: SetFilterValue) => string;
  }
  interface NumberFilterProps {
    unit?: string;
  }
}

assignableTo<SetFilter>(
  new SetFilter({ props: { renderOption: (v: SetFilterValue) => String(v) } }),
);
assignableTo<NumberFilter>(new NumberFilter({ op: "gte", props: { unit: "ms" } }));

// a bucket filter's props extend a set filter's, so a popover narrowing by `instanceof SetFilter`
// reads them through the same shape
assignableTo<SetFilterProps>(new BucketFilter({ buckets: [{ label: "A" }] }).props);

// @ts-expect-error -- undeclared props are still rejected, which is what makes augmenting worth it
new SetFilter({ props: { notDeclared: true } });
// @ts-expect-error -- and each filter has its own shape
new NumberFilter({ op: "gte", props: { renderOption: (v: string) => v } });

// --- every filter satisfies the table's structural contract ----------------

assignableTo<ColumnFilter>(new SetFilter());
assignableTo<ColumnFilter>(new DateFilter());
assignableTo<ColumnFilter>(new TextFilter());

// --- faceting belongs to SetFilter alone -----------------------------------

assignableTo<SetFilter>(new SetFilter({ options: ["a", "b"], counts: true, multiValue: true }));

// @ts-expect-error -- a numeric range has no discrete domain to count
new DateFilter({ counts: true });
// @ts-expect-error -- nor one to enumerate
new DateFilter({ options: [1, 2] });
// @ts-expect-error -- nor is a range multi-valued; there is no any/all to offer
new DateFilter({ multiValue: true });
// @ts-expect-error -- free text has no enumerable domain either
new TextFilter({ counts: true });
// @ts-expect-error
new TextFilter({ options: ["a"] });

// --- every filter can serialize itself for a server ------------------------

assignableTo<FilterCondition | undefined>(new SetFilter().condition);
assignableTo<FilterCondition | undefined>(new DateFilter().condition);
assignableTo<FilterCondition | undefined>(new TextFilter().condition);

// `field` is filled in by whoever knows the wire name — a filter never sets it
assignableTo<{ field?: string; op: string; value: unknown }>({ op: "in", value: [] });

// --- a facet is usable without casts, which is the point of narrowing it ----

declare const column: ColumnModel;
declare const setFilter: SetFilter;

for (const facet of column.facets) {
  // each of these needed an `as SetFilterValue` while Facet.value was `unknown`
  setFilter.toggle(facet.value);
  assignableTo<boolean>(setFilter.has(facet.value));
  assignableTo<string>(String(facet.value));
  setFilter.props.renderOption?.(facet.value);
}

// @ts-expect-error -- a declared option outside the facet domain could never match a tallied one
assignableTo<ColumnFilter["options"]>([{ id: 1 }]);

// --- the set domain is JSON-safe by construction ---------------------------

assignableTo<SetFilter>(new SetFilter({ selected: ["a", 1, true] }));
// @ts-expect-error -- an object would not survive JSON round-tripping, nor compare by value
new SetFilter({ selected: [{ id: 1 }] });
