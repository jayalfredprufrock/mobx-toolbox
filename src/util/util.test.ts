import { describe, expect, test } from "vite-plus/test";
import { autorun, runInAction } from "mobx";
import { mutable } from "./mutable";

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
