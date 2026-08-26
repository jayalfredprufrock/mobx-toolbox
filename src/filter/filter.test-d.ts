/**
 * Compile-time assertions for the filter contracts. The file passing `vp check` *is* the test.
 *
 * Two things are worth pinning down at the type level rather than at runtime:
 *
 * 1. Faceting is a set-filter concept. A `counts: true` on a numeric range has no meaning, and the
 *    whole reason `options`/`counts` live in `SetFilterOptions` instead of on the column def is that
 *    it makes the meaningless combination a type error instead of a silent no-op.
 * 2. `table` must never need to import a filter class. It declares `ColumnFilter` structurally, so
 *    if these classes drift out of that shape it has to be a compile error here — nothing at runtime
 *    would notice until a column silently stopped filtering.
 */
import type { ColumnFilter } from "../table/table.types";
import type { FilterCondition } from "./filter.types";
import { RangeFilter } from "./range-filter.model";
import { SetFilter } from "./set-filter.model";
import { TextFilter } from "./text-filter.model";

const assignableTo = <Expected>(_value: Expected): void => {};

// --- every filter satisfies the table's structural contract ----------------

assignableTo<ColumnFilter>(new SetFilter());
assignableTo<ColumnFilter>(new RangeFilter());
assignableTo<ColumnFilter>(new TextFilter());

// --- faceting belongs to SetFilter alone -----------------------------------

assignableTo<SetFilter>(new SetFilter({ options: ["a", "b"], counts: true, multiValue: true }));

// @ts-expect-error -- a numeric range has no discrete domain to count
new RangeFilter({ counts: true });
// @ts-expect-error -- nor one to enumerate
new RangeFilter({ options: [1, 2] });
// @ts-expect-error -- nor is a range multi-valued; there is no any/all to offer
new RangeFilter({ multiValue: true });
// @ts-expect-error -- free text has no enumerable domain either
new TextFilter({ counts: true });
// @ts-expect-error
new TextFilter({ options: ["a"] });

// --- every filter can serialize itself for a server ------------------------

assignableTo<FilterCondition | undefined>(new SetFilter().condition);
assignableTo<FilterCondition | undefined>(new RangeFilter().condition);
assignableTo<FilterCondition | undefined>(new TextFilter().condition);

// `field` is filled in by whoever knows the wire name — a filter never sets it
assignableTo<{ field?: string; op: string; value: unknown }>({ op: "in", value: [] });

// --- the set domain is JSON-safe by construction ---------------------------

assignableTo<SetFilter>(new SetFilter({ selected: ["a", 1, true] }));
// @ts-expect-error -- an object would not survive JSON round-tripping, nor compare by value
new SetFilter({ selected: [{ id: 1 }] });
