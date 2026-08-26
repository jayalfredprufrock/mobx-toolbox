import { autorun } from "mobx";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { RangeFilter } from "./range-filter.model";
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
// RangeFilter
// ---------------------------------------------------------------------------

describe("RangeFilter", () => {
  test("is inactive with neither bound set", () => {
    const filter = new RangeFilter();
    expect(filter.active).toBe(false);
    expect(filter.matches(5)).toBe(true);
    expect(filter.matches(null)).toBe(true);
  });

  test("bounds are inclusive and independently optional", () => {
    expect(new RangeFilter({ min: 2 }).matches(2)).toBe(true);
    expect(new RangeFilter({ min: 2 }).matches(1)).toBe(false);
    expect(new RangeFilter({ max: 2 }).matches(2)).toBe(true);
    expect(new RangeFilter({ max: 2 }).matches(3)).toBe(false);

    const both = new RangeFilter({ min: 2, max: 4 });
    expect([1, 2, 3, 4, 5].filter((n) => both.matches(n))).toEqual([2, 3, 4]);
  });

  test("a blank value is outside every bound while active", () => {
    const filter = new RangeFilter({ min: 0 });
    expect(filter.matches(null)).toBe(false);
    expect(filter.matches(undefined)).toBe(false);
    expect(filter.matches("")).toBe(false);
  });

  test("compares Dates through getTime, so bounds stay plain numbers", () => {
    const filter = new RangeFilter({
      min: new Date("2020-01-01").getTime(),
      max: new Date("2020-12-31").getTime(),
    });
    expect(filter.matches(new Date("2020-06-01"))).toBe(true);
    expect(filter.matches(new Date("2021-06-01"))).toBe(false);
  });

  test("accepts numeric strings", () => {
    const filter = new RangeFilter({ min: 2, max: 4 });
    expect(filter.matches("3")).toBe(true);
    expect(filter.matches("9")).toBe(false);
    expect(filter.matches("abc")).toBe(false);
  });

  test("value round-trips through JSON and omits unset bounds", () => {
    const filter = new RangeFilter({ min: 2 });
    expect(filter.value).toEqual({ min: 2 });

    const json = JSON.parse(JSON.stringify(new RangeFilter({ min: 2, max: 4 }).value));
    const restored = new RangeFilter();
    restored.setValue(json as { min?: number; max?: number });
    expect(restored.value).toEqual({ min: 2, max: 4 });
  });

  test("setRange / clear are reactive", () => {
    const filter = new RangeFilter();
    const seen: boolean[] = [];
    observe(() => seen.push(filter.matches(5)));
    expect(seen).toEqual([true]);

    filter.setRange(0, 3);
    expect(seen.at(-1)).toBe(false);

    filter.clear();
    expect(seen.at(-1)).toBe(true);
    expect(filter.active).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TextFilter
// ---------------------------------------------------------------------------

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
