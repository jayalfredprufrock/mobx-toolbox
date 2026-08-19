import { describe, expect, test } from "vite-plus/test";
import { autorun, runInAction } from "mobx";
import { mutable } from "./mutable";
import { WeakRefMap } from "./weak-ref-map";

// ---------------------------------------------------------------------------
// mutable decorator — tested programmatically since the test transform does
// not support the `accessor` keyword; the decorator is exercised by calling
// it directly with a plain accessor descriptor.
// ---------------------------------------------------------------------------

describe("mutable", () => {
  const makeInstance = (initialValue: number) => {
    // Simulate what TypeScript emits for `@mutable accessor count = initialValue`
    let backingValue = initialValue;
    const rawAccessor = {
      get(this: object) {
        return backingValue;
      },
      set(this: object, v: number) {
        backingValue = v;
      },
    };

    const decoratedAccessor = mutable(rawAccessor as any, {} as any)!;
    const instance = {};
    const get = () => decoratedAccessor.get!.call(instance) as number;
    const set = (v: number) => decoratedAccessor.set!.call(instance, v);
    return { get, set };
  };

  test("reads the initial value via backing accessor", () => {
    const { get } = makeInstance(7);
    expect(get()).toBe(7);
  });

  test("set updates the value", () => {
    const { get, set } = makeInstance(0);
    runInAction(() => set(42));
    expect(get()).toBe(42);
  });

  test("value is reactive — autorun re-runs on change", () => {
    const { get, set } = makeInstance(0);
    const values: number[] = [];
    const dispose = autorun(() => values.push(get()));

    runInAction(() => set(10));
    runInAction(() => set(20));

    dispose();
    expect(values).toEqual([0, 10, 20]);
  });

  test("each instance has its own observable box", () => {
    const a = makeInstance(1);
    const b = makeInstance(2);

    runInAction(() => a.set(99));

    expect(a.get()).toBe(99);
    expect(b.get()).toBe(2);
  });

  test("autorun does not re-run when an unrelated instance changes", () => {
    const a = makeInstance(0);
    const b = makeInstance(0);
    let runs = 0;
    const dispose = autorun(() => {
      void a.get();
      runs++;
    });

    runInAction(() => b.set(100)); // change b, not a

    dispose();
    expect(runs).toBe(1); // only initial run
  });
});

// ---------------------------------------------------------------------------
// WeakRefMap — collection itself is not asserted (finalization is
// non-deterministic); the bookkeeping around it is.
// ---------------------------------------------------------------------------

describe("WeakRefMap", () => {
  test("returns the same instance for a key", () => {
    const map = new WeakRefMap<number, { id: number }>();
    const value = { id: 1 };
    expect(map.add(1, value)).toBe(value);
    expect(map.get(1)).toBe(value);
    expect(map.has(1)).toBe(true);
  });

  test("misses report undefined rather than throwing", () => {
    const map = new WeakRefMap<number, { id: number }>();
    expect(map.get(99)).toBeUndefined();
    expect(map.has(99)).toBe(false);
  });

  test("adding the same value twice is a no-op", () => {
    const map = new WeakRefMap<number, { id: number }>();
    const value = { id: 1 };
    map.add(1, value);
    expect(map.add(1, value)).toBe(value);
    expect(map.get(1)).toBe(value);
  });

  test("replacing a key keeps the newest value", () => {
    const map = new WeakRefMap<number, { id: number; tag: string }>();
    const first = { id: 1, tag: "first" };
    const second = { id: 1, tag: "second" };
    map.add(1, first);
    map.add(1, second);
    expect(map.get(1)).toBe(second);
  });

  test("delete removes the entry immediately", () => {
    const map = new WeakRefMap<number, { id: number }>();
    map.add(1, { id: 1 });
    expect(map.delete(1)).toBe(true);
    expect(map.get(1)).toBeUndefined();
    expect(map.delete(1)).toBe(false);
  });

  test("clear forgets every entry", () => {
    const map = new WeakRefMap<number, { id: number }>();
    const held = { id: 1 };
    map.add(1, held);
    map.add(2, { id: 2 });
    map.clear();
    expect(map.get(1)).toBeUndefined();
    expect(map.get(2)).toBeUndefined();
    // the value itself is untouched, it is simply no longer identity-mapped
    expect(held.id).toBe(1);
  });

  test("a key can be re-added after being deleted", () => {
    const map = new WeakRefMap<number, { id: number }>();
    map.add(1, { id: 1 });
    map.delete(1);
    const fresh = { id: 1 };
    map.add(1, fresh);
    expect(map.get(1)).toBe(fresh);
  });
});
