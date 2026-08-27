import { autorun } from "mobx";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { BucketFilter, bucketProjection } from "./bucket-filter.model";
import { DateFilter } from "./date-filter.model";
import type { UnaryNumberOp } from "./filter.types";
import { NumberFilter } from "./number-filter.model";
import { SetFilter } from "./set-filter.model";
import { TextFilter } from "./text-filter.model";
import { BLANK, facetValues, isBlank, textMatches } from "./util";

const disposeList: (() => void)[] = [];
const observe = (fn: () => void): void => {
  disposeList.push(autorun(fn));
};
afterEach(() => {
  while (disposeList.length) disposeList.pop()?.();
});

// ---------------------------------------------------------------------------
// blank normalisation
// ---------------------------------------------------------------------------

describe("isBlank", () => {
  test("treats nullish and empty string as blank", () => {
    expect(isBlank(null)).toBe(true);
    expect(isBlank(undefined)).toBe(true);
    expect(isBlank("")).toBe(true);
  });

  test("treats an array contributing nothing as blank", () => {
    // the test is "contributed no non-blank values", not "the raw value is nullish" — otherwise a
    // `tags: []` row is unreachable through the (Blank) facet
    expect(isBlank([])).toBe(true);
    expect(isBlank([null, undefined, ""])).toBe(true);
    expect(isBlank([[], [null]])).toBe(true);
  });

  test("does not treat falsy-but-present values as blank", () => {
    expect(isBlank(0)).toBe(false);
    expect(isBlank(false)).toBe(false);
    expect(isBlank(["a"])).toBe(false);
  });
});

describe("facetValues", () => {
  test("yields the value itself for a scalar", () => {
    expect([...facetValues("a")]).toEqual(["a"]);
    expect([...facetValues(3)]).toEqual([3]);
    expect([...facetValues(false)]).toEqual([false]);
  });

  test("flattens arrays and drops blank entries", () => {
    expect([...facetValues(["a", "b"])]).toEqual(["a", "b"]);
    expect([...facetValues([["a"], ["b", null]])]).toEqual(["a", "b"]);
  });

  test("dedupes", () => {
    expect([...facetValues(["a", "a", "b"])]).toEqual(["a", "b"]);
  });

  test("yields exactly BLANK when nothing non-blank survives", () => {
    for (const value of [null, undefined, "", [], [null, ""]]) {
      expect([...facetValues(value)]).toEqual([BLANK]);
    }
  });

  test("stringifies non-primitives so the domain compares by value", () => {
    // two equal Dates must land on one facet, not two
    const a = new Date("2020-01-01");
    const b = new Date("2020-01-01");
    const values = facetValues([a, b]);
    expect(values.size).toBe(1);
  });
});

describe("textMatches", () => {
  test("an empty query matches everything", () => {
    expect(textMatches("", "anything")).toBe(true);
    expect(textMatches("", null)).toBe(true);
  });

  test("contains is the default and is case-insensitive", () => {
    expect(textMatches("OO", "foobar")).toBe(true);
    expect(textMatches("zz", "foobar")).toBe(false);
  });

  test("honours match mode", () => {
    expect(textMatches("foo", "foobar", "startsWith")).toBe(true);
    expect(textMatches("bar", "foobar", "startsWith")).toBe(false);
    expect(textMatches("foobar", "foobar", "equals")).toBe(true);
    expect(textMatches("foo", "foobar", "equals")).toBe(false);
  });

  test("honours caseSensitive", () => {
    expect(textMatches("OO", "foobar", "contains", true)).toBe(false);
    expect(textMatches("oo", "foobar", "contains", true)).toBe(true);
  });

  test("stringifies non-strings and treats nullish as empty", () => {
    expect(textMatches("23", 1234)).toBe(true);
    expect(textMatches("x", null)).toBe(false);
  });

  test("does not trim — a trailing space is part of the query", () => {
    expect(textMatches("foo ", "foo bar")).toBe(true);
    expect(textMatches("foo ", "foobar")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SetFilter
// ---------------------------------------------------------------------------

describe("SetFilter", () => {
  test("is inactive and matches everything with nothing selected", () => {
    const filter = new SetFilter();
    expect(filter.active).toBe(false);
    expect(filter.matches("a")).toBe(true);
    expect(filter.matches(null)).toBe(true);
  });

  test("matches a scalar against the selection", () => {
    const filter = new SetFilter({ selected: ["a", "b"] });
    expect(filter.active).toBe(true);
    expect(filter.selectedCount).toBe(2);
    expect(filter.matches("a")).toBe(true);
    expect(filter.matches("c")).toBe(false);
  });

  test("matchMode any matches an array overlapping the selection", () => {
    const filter = new SetFilter({ selected: ["a"] });
    expect(filter.matches(["a", "z"])).toBe(true);
    expect(filter.matches(["y", "z"])).toBe(false);
  });

  test("matchMode all requires every selection to be present", () => {
    const filter = new SetFilter({ selected: ["a", "b"], matchMode: "all" });
    expect(filter.matches(["a", "b", "c"])).toBe(true);
    expect(filter.matches(["a"])).toBe(false);
    // the scalar trap the multiValue hint exists to prevent
    expect(filter.matches("a")).toBe(false);
  });

  test("BLANK is an ordinary selection, so blank rows are reachable", () => {
    const filter = new SetFilter({ selected: [BLANK] });
    expect(filter.matches(null)).toBe(true);
    expect(filter.matches([])).toBe(true);
    expect(filter.matches("")).toBe(true);
    expect(filter.matches("a")).toBe(false);
  });

  test("toggle / has / select / clear", () => {
    const filter = new SetFilter();
    filter.toggle("a");
    expect(filter.has("a")).toBe(true);
    filter.toggle("a");
    expect(filter.has("a")).toBe(false);

    filter.select(["a", "b"]);
    expect(filter.selectedCount).toBe(2);
    filter.select();
    expect(filter.active).toBe(false);

    filter.select(["a"]);
    filter.clear();
    expect(filter.active).toBe(false);
  });

  test("clear leaves matchMode alone — it is a mode the user chose", () => {
    const filter = new SetFilter({ selected: ["a"], matchMode: "all" });
    filter.clear();
    expect(filter.matchMode).toBe("all");
  });

  test("value round-trips through JSON", () => {
    const filter = new SetFilter({ selected: ["a", BLANK], matchMode: "all" });
    const json = JSON.parse(JSON.stringify(filter.value)) as typeof filter.value;

    const restored = new SetFilter();
    restored.setValue(json);
    expect([...restored.selected]).toEqual(["a", BLANK]);
    expect(restored.matchMode).toBe("all");
  });

  test("setValue with nothing resets to the default", () => {
    const filter = new SetFilter({ selected: ["a"], matchMode: "all" });
    filter.setValue();
    expect(filter.active).toBe(false);
    expect(filter.matchMode).toBe("any");
  });

  test("options and counts are config, not state", () => {
    const bare = new SetFilter();
    expect(bare.options).toBeUndefined();
    expect(bare.counts).toBe(false);

    const configured = new SetFilter({ options: ["a", "b"], counts: true });
    expect(configured.options).toEqual(["a", "b"]);
    expect(configured.counts).toBe(true);
  });

  test("multiValue is declared config and gates nothing", () => {
    expect(new SetFilter().multiValue).toBe(false);

    const multi = new SetFilter({ multiValue: true });
    expect(multi.multiValue).toBe(true);

    // advisory, like `sortable`/`filterable` on a column: the model is never gated by it
    const scalar = new SetFilter({ selected: ["a", "b"] });
    scalar.setMatchMode("all");
    expect(scalar.matchMode).toBe("all");

    // and it does not change matching either way — arrays are flattened regardless
    expect(new SetFilter({ selected: ["a"] }).matches(["a", "b"])).toBe(true);
    expect(new SetFilter({ selected: ["a"], multiValue: true }).matches(["a", "b"])).toBe(true);
  });

  test("selection and matchMode are reactive", () => {
    const filter = new SetFilter();
    const seen: boolean[] = [];
    observe(() => seen.push(filter.matches(["a", "b"])));
    expect(seen).toEqual([true]);

    filter.select(["a"]);
    expect(seen).toEqual([true, true]);

    filter.setMatchMode("all");
    filter.select(["a", "z"]);
    expect(seen.at(-1)).toBe(false);
  });

  test("swapping one selected value for another is observed", () => {
    // same size, so `active` never changes — the case a naive dependency on `active` would miss
    const filter = new SetFilter({ selected: ["a"] });
    const seen: boolean[] = [];
    observe(() => seen.push(filter.matches("b")));
    expect(seen).toEqual([false]);

    filter.select(["b"]);
    expect(seen).toEqual([false, true]);
  });
});

// ---------------------------------------------------------------------------
// DateFilter
// ---------------------------------------------------------------------------

describe("DateFilter", () => {
  const jan1 = Date.UTC(2020, 0, 1);
  const jun1 = Date.UTC(2020, 5, 1);
  const dec31 = Date.UTC(2020, 11, 31);

  test("is inactive with neither bound set", () => {
    const filter = new DateFilter();
    expect(filter.active).toBe(false);
    expect(filter.matches(jun1)).toBe(true);
    expect(filter.matches(null)).toBe(true);
  });

  test("accepts Dates, ISO strings and epoch numbers as bounds", () => {
    // the three shapes a date column actually arrives in, interchangeably
    for (const min of [new Date(jan1), "2020-01-01T00:00:00.000Z", jan1, jan1 / 1000]) {
      const filter = new DateFilter({ min });
      expect(filter.value).toEqual({ min: jan1 });
    }
  });

  test("compares against all three shapes too", () => {
    const filter = new DateFilter({ min: "2020-01-01", max: "2020-12-31" });
    expect(filter.matches(new Date(jun1))).toBe(true);
    expect(filter.matches(jun1)).toBe(true);
    expect(filter.matches(jun1 / 1000)).toBe(true);
    expect(filter.matches("2020-06-01")).toBe(true);
    expect(filter.matches("2021-06-01")).toBe(false);
  });

  test("reads a bare number as seconds or milliseconds by magnitude", () => {
    const filter = new DateFilter({ min: jan1, max: dec31 });
    // the same instant, either unit
    expect(filter.matches(jun1)).toBe(true);
    expect(filter.matches(Math.floor(jun1 / 1000))).toBe(true);
    // and a numeric string, which is how a timestamp survives JSON as text
    expect(filter.matches(String(jun1))).toBe(true);
  });

  test("unit pins the interpretation when guessing would be wrong", () => {
    // 2 milliseconds after the epoch — auto would read it as 2 seconds
    expect(new DateFilter({ min: 2, unit: "ms" }).value).toEqual({ min: 2 });
    expect(new DateFilter({ min: 2, unit: "s" }).value).toEqual({ min: 2000 });
    expect(new DateFilter({ min: 2 }).value).toEqual({ min: 2000 });
  });

  test("bounds are inclusive and independently optional", () => {
    expect(new DateFilter({ min: jun1 }).matches(jun1)).toBe(true);
    expect(new DateFilter({ min: jun1 }).matches(jan1)).toBe(false);
    expect(new DateFilter({ max: jun1 }).matches(jun1)).toBe(true);
    expect(new DateFilter({ max: jun1 }).matches(dec31)).toBe(false);
  });

  test("a blank or unparseable value is outside every range while active", () => {
    const filter = new DateFilter({ min: jan1 });
    expect(filter.matches(null)).toBe(false);
    expect(filter.matches("")).toBe(false);
    expect(filter.matches("not a date")).toBe(false);
    expect(filter.matches(new Date("nonsense"))).toBe(false);
  });

  test("value round-trips through JSON as plain millis", () => {
    const filter = new DateFilter({ min: "2020-01-01", max: new Date(dec31) });
    const json = JSON.parse(JSON.stringify(filter.value)) as { min?: number; max?: number };
    expect(json).toEqual({ min: jan1, max: dec31 });

    const restored = new DateFilter();
    restored.setValue(json);
    expect(restored.value).toEqual({ min: jan1, max: dec31 });
  });

  test("range hands back Dates for a picker", () => {
    const filter = new DateFilter({ min: jan1 });
    expect(filter.range.min?.getTime()).toBe(jan1);
    expect(filter.range.max).toBeUndefined();
  });

  test("setRange / clear are reactive", () => {
    const filter = new DateFilter();
    const seen: boolean[] = [];
    observe(() => seen.push(filter.matches(jun1)));
    expect(seen).toEqual([true]);

    filter.setRange(undefined, "2020-01-31");
    expect(seen.at(-1)).toBe(false);

    filter.clear();
    expect(seen.at(-1)).toBe(true);
    expect(filter.active).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// NumberFilter
// ---------------------------------------------------------------------------

describe("NumberFilter", () => {
  test("is inactive without an operand", () => {
    const filter = new NumberFilter({ op: "gte" });
    expect(filter.active).toBe(false);
    expect(filter.matches(5)).toBe(true);
  });

  test("every unary operator", () => {
    const cases: [UnaryNumberOp, number[]][] = [
      ["eq", [5]],
      ["neq", [1, 3, 7, 9]],
      ["gt", [7, 9]],
      ["gte", [5, 7, 9]],
      ["lt", [1, 3]],
      ["lte", [1, 3, 5]],
    ];
    for (const [op, expected] of cases) {
      const filter = new NumberFilter({ op, operand: 5 });
      expect({ op, kept: [1, 3, 5, 7, 9].filter((n) => filter.matches(n)) }).toEqual({
        op,
        kept: expected,
      });
    }
  });

  test("between is inclusive, betweenExclusive is not", () => {
    const inc = new NumberFilter({ op: "between", operand: [3, 7] });
    expect([1, 3, 5, 7, 9].filter((n) => inc.matches(n))).toEqual([3, 5, 7]);

    const exc = new NumberFilter({ op: "betweenExclusive", operand: [3, 7] });
    expect([1, 3, 5, 7, 9].filter((n) => exc.matches(n))).toEqual([5]);
  });

  test("a blank value satisfies no comparison, not even neq", () => {
    // otherwise "not 5" would quietly include every empty row
    const filter = new NumberFilter({ op: "neq", operand: 5 });
    expect(filter.matches(null)).toBe(false);
    expect(filter.matches("")).toBe(false);
    expect(filter.matches(undefined)).toBe(false);
  });

  test("accepts numeric strings", () => {
    const filter = new NumberFilter({ op: "gte", operand: 5 });
    expect(filter.matches("7")).toBe(true);
    expect(filter.matches("1")).toBe(false);
    expect(filter.matches("abc")).toBe(false);
  });

  test("an operand that does not fit the operator leaves it inactive", () => {
    const filter = new NumberFilter({ op: "between", operand: [3, 7] });
    expect(filter.active).toBe(true);

    // switching operator alone: guessing which end of the pair to keep would filter by something
    // the user never asked for
    filter.setOp("gte");
    expect(filter.active).toBe(false);
    expect(filter.matches(1)).toBe(true);

    filter.set("gte", 5);
    expect(filter.active).toBe(true);
    expect(filter.matches(1)).toBe(false);
  });

  test("value round-trips through JSON, both shapes", () => {
    for (const filter of [
      new NumberFilter({ op: "lte", operand: 5 }),
      new NumberFilter({ op: "betweenExclusive", operand: [3, 7] }),
    ]) {
      const json = JSON.parse(JSON.stringify(filter.value)) as unknown;
      const restored = new NumberFilter();
      restored.setValue(json);
      expect(restored.value).toEqual(filter.value);
      expect(restored.active).toBe(true);
    }
  });

  test("setValue drops an operand that does not fit the restored operator", () => {
    const filter = new NumberFilter();
    filter.setValue({ op: "gte", operand: [3, 7] });
    expect(filter.op).toBe("gte");
    expect(filter.active).toBe(false);
  });

  test("clear keeps the operator", () => {
    const filter = new NumberFilter({ op: "gte", operand: 5 });
    filter.clear();
    expect(filter.active).toBe(false);
    expect(filter.op).toBe("gte");
  });

  test("condition carries the operator through to a server", () => {
    expect(new NumberFilter({ op: "lte", operand: 5 }).condition).toEqual({
      op: "lte",
      value: 5,
    });
    expect(new NumberFilter({ op: "between", operand: [3, 7] }).condition).toEqual({
      op: "between",
      value: [3, 7],
    });
    expect(new NumberFilter({ op: "gte" }).condition).toBeUndefined();
  });

  test("is reactive", () => {
    const filter = new NumberFilter({ op: "gte" });
    const seen: boolean[] = [];
    observe(() => seen.push(filter.matches(5)));
    expect(seen).toEqual([true]);

    filter.setOperand(7);
    expect(seen.at(-1)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BucketFilter
// ---------------------------------------------------------------------------

describe("BucketFilter", () => {
  const grades = [
    { label: "A", min: 90 },
    { label: "B", min: 80, max: 90 },
    { label: "C", min: 70, max: 80 },
    { label: "D", min: 60, max: 70 },
    { label: "F", max: 60 },
  ];

  test("derives its domain from the bucket labels, in order", () => {
    const filter = new BucketFilter({ buckets: grades });
    expect(filter.options).toEqual(["A", "B", "C", "D", "F"]);
    expect(filter.labels).toEqual(["A", "B", "C", "D", "F"]);
  });

  test("matches a raw number against the selected labels", () => {
    const filter = new BucketFilter({ buckets: grades, selected: ["B"] });
    expect(filter.matches(85)).toBe(true);
    expect(filter.matches(80)).toBe(true);
    // upper bounds are exclusive, so 90 is an A and adjacent buckets never both claim a number
    expect(filter.matches(90)).toBe(false);
    expect(filter.matches(42)).toBe(false);
  });

  test("open-ended buckets at either end", () => {
    const filter = new BucketFilter({ buckets: grades, selected: ["A", "F"] });
    expect(filter.matches(1000)).toBe(true);
    expect(filter.matches(-5)).toBe(true);
    expect(filter.matches(75)).toBe(false);
  });

  test("bucketOf reports which bucket a value fell in", () => {
    const filter = new BucketFilter({ buckets: grades });
    expect(filter.bucketOf(85)?.label).toBe("B");
    expect(filter.bucketOf(59)?.label).toBe("F");
    expect(filter.bucketOf(null)).toBeUndefined();
  });

  test("a blank stays blank rather than falling into the bottom bucket", () => {
    // a missing score is not a low one
    const filter = new BucketFilter({ buckets: grades, selected: ["F"] });
    expect(filter.matches(null)).toBe(false);
    expect(filter.matches("")).toBe(false);

    const blanks = new BucketFilter({ buckets: grades, selected: [BLANK] });
    expect(blanks.matches(null)).toBe(true);
    expect(blanks.matches(30)).toBe(false);
  });

  test("is a SetFilter, so an existing checkbox UI narrows to it", () => {
    const filter = new BucketFilter({ buckets: grades });
    expect(filter).toBeInstanceOf(SetFilter);

    filter.toggle("A");
    expect(filter.has("A")).toBe(true);
    expect(filter.selectedCount).toBe(1);
    expect(filter.value).toEqual({ selected: ["A"], matchMode: "any" });
  });

  test("serializes the labels, not the ranges", () => {
    const filter = new BucketFilter({ buckets: grades, selected: ["B", "C"] });
    expect(filter.condition).toEqual({ op: "in", value: ["B", "C"] });

    const restored = new BucketFilter({ buckets: grades });
    restored.setValue(JSON.parse(JSON.stringify(filter.value)) as unknown);
    expect(restored.matches(85)).toBe(true);
    expect(restored.matches(95)).toBe(false);
  });

  test("bucketProjection is usable on its own", () => {
    const grade = bucketProjection(grades);
    expect([95, 85, 75, 65, 55].map(grade)).toEqual(["A", "B", "C", "D", "F"]);
  });

  test("a value outside every bucket keeps itself rather than vanishing", () => {
    const sparse = bucketProjection([{ label: "mid", min: 10, max: 20 }]);
    expect(sparse(15)).toBe("mid");
    expect(sparse(99)).toBe(99);
  });
});

describe("TextFilter", () => {
  test("is inactive with no text", () => {
    const filter = new TextFilter();
    expect(filter.active).toBe(false);
    expect(filter.matches("anything")).toBe(true);
  });

  test("contains, case-insensitive, by default", () => {
    const filter = new TextFilter({ text: "OO" });
    expect(filter.active).toBe(true);
    expect(filter.matches("foobar")).toBe(true);
    expect(filter.matches("bar")).toBe(false);
  });

  test("honours match and caseSensitive config", () => {
    expect(new TextFilter({ text: "foo", match: "startsWith" }).matches("foobar")).toBe(true);
    expect(new TextFilter({ text: "foo", match: "equals" }).matches("foobar")).toBe(false);
    expect(new TextFilter({ text: "OO", caseSensitive: true }).matches("foobar")).toBe(false);
  });

  test("value round-trips and setText is reactive", () => {
    const filter = new TextFilter();
    const seen: boolean[] = [];
    observe(() => seen.push(filter.matches("foobar")));
    expect(seen).toEqual([true]);

    filter.setText("zz");
    expect(seen.at(-1)).toBe(false);

    expect(filter.value).toBe("zz");
    const restored = new TextFilter();
    restored.setValue(filter.value);
    expect(restored.text).toBe("zz");

    filter.clear();
    expect(filter.active).toBe(false);
  });
});
