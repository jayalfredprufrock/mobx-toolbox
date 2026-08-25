import { autorun } from "mobx";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { lazyObservable, lazyObservableArray, type LazyObservable } from "./lazy-observable";

/**
 * Which predicates are safe to gate a render on.
 *
 * Observation is derived from `value`, `loaded` and `error` — not from `fetching`. So a branch
 * that shows a placeholder while reading *only* `fetching` observes nothing: the lazy is dropped,
 * its load aborted, `fetching` cleared, and the other branch renders again. The cycle sustains
 * itself and hammers the server.
 *
 * These pin which spellings settle and which do not, because the difference is invisible at the
 * call site and the failure mode is a hang rather than an error.
 */

const settle = (): Promise<unknown> => new Promise((r) => setTimeout(r, 60));

/** Well past anything legitimate, so a runaway is unambiguous — and bounded, so it cannot hang. */
const RUNAWAY = 120;

const drive = async (
  lazy: { value: unknown; loaded: boolean; fetching: boolean; refreshing: boolean },
  gate: (l: typeof lazy, placeholder: () => void) => void,
): Promise<{ renders: number; placeholders: number; onScreen: unknown }> => {
  let renders = 0;
  let placeholders = 0;
  const stop = autorun(() => {
    renders++;
    if (renders > RUNAWAY) return;
    gate(lazy, () => placeholders++);
  });
  await settle();
  // Read before disposing: unobserving drops the value (a seeded lazy back to its seed), so
  // anything asserted after `stop()` would be describing the teardown rather than the render.
  const onScreen = Array.isArray(lazy.value) ? [...lazy.value] : lazy.value;
  stop();
  return { renders, placeholders, onScreen };
};

const counting = (
  seed?: unknown[],
): { lazy: ReturnType<typeof lazyObservableArray<number>>; calls: () => number } => {
  let calls = 0;
  const fetch = async (): Promise<number[]> => {
    calls++;
    await new Promise((r) => setTimeout(r, 5));
    return [1, 2];
  };
  const lazy = seed
    ? lazyObservableArray<number>(fetch, { initialValue: seed as number[] })
    : lazyObservableArray<number>(fetch);
  return { lazy, calls: () => calls };
};

describe("gating a placeholder on a lazy", () => {
  test("`fetching` alone is a reload loop", async () => {
    const { lazy, calls } = counting([]);

    const { renders } = await drive(lazy, (l, placeholder) => {
      if (l.fetching) return placeholder();
      void l.value;
    });

    // the bug this whole file exists for: nothing errors, it just never stops
    expect(renders).toBeGreaterThan(RUNAWAY);
    expect(calls()).toBeGreaterThan(10);
  });

  test("`refreshing` is the same question, and settles", async () => {
    const { lazy, calls } = counting([]);

    const { renders, placeholders, onScreen } = await drive(lazy, (l, placeholder) => {
      if (l.refreshing) return placeholder();
      void l.value;
    });

    expect(renders).toBeLessThan(RUNAWAY);
    expect(calls()).toBe(1);
    expect(placeholders).toBe(1); // it really did show, once, while the refresh ran
    expect(onScreen).toEqual([1, 2]); // ...and the fetched rows replaced the seed behind it
  });

  test("`!loaded` settles, and on a seeded lazy never shows at all", async () => {
    const { lazy, calls } = counting([]);

    const { renders, placeholders } = await drive(lazy, (l, placeholder) => {
      if (!l.loaded) return placeholder();
      void l.value;
    });

    expect(renders).toBeLessThan(RUNAWAY);
    expect(calls()).toBe(1);
    // seeded means there is something to show, so the placeholder is correctly dead code
    expect(placeholders).toBe(0);
  });

  test("reading `loaded` and nothing else still drives the load", async () => {
    // `loaded` is an observation source in its own right: a component that never touches `value`
    // still counts as watching, which is what makes the `!loaded` gate above safe.
    const { lazy, calls } = counting();

    const { renders } = await drive(lazy, (l, placeholder) => {
      if (!l.loaded) placeholder();
    });

    expect(renders).toBeLessThan(RUNAWAY);
    expect(calls()).toBe(1);
  });

  test("reading `refreshing` and nothing else still drives the load", async () => {
    // `refreshing` reads whether there is a value *before* it reads `fetching`, so it observes
    // even when it answers false. Written the other way round, a component whose only read is
    // this would short-circuit past the observation source and never load at all.
    const { lazy, calls } = counting();

    const { renders } = await drive(lazy, (l, placeholder) => {
      if (l.refreshing) placeholder();
    });

    expect(renders).toBeLessThan(RUNAWAY);
    expect(calls()).toBe(1);
  });

  test("an unseeded lazy gated on `!loaded` shows the placeholder once", async () => {
    const { lazy, calls } = counting();

    const { renders, placeholders } = await drive(lazy, (l, placeholder) => {
      if (!l.loaded) return placeholder();
      void l.value;
    });

    expect(renders).toBeLessThan(RUNAWAY);
    expect(calls()).toBe(1);
    expect(placeholders).toBe(1);
  });
});

describe("refreshing", () => {
  const held = (): { lazy: LazyObservable<number>; resolve: (v: number) => void } => {
    let resolve: ((v: number) => void) | undefined;
    const lazy = lazyObservable<number>(
      () =>
        new Promise<number>((r) => {
          resolve = r;
        }),
    );
    // Indirected on purpose: the executor does not run until the lazy is observed and the fetch is
    // called, so capturing `resolve` at destructuring time would capture `undefined`.
    return { lazy, resolve: (v) => resolve?.(v) };
  };

  test("a first load is fetching but not refreshing", async () => {
    const { lazy } = held();
    const stop = autorun(() => void lazy.value);
    await vi.waitFor(() => expect(lazy.fetching).toBe(true));

    expect(lazy.loaded).toBe(false);
    expect(lazy.refreshing).toBe(false); // there is nothing behind it to refresh
    stop();
  });

  test("a reload behind a value is refreshing", async () => {
    const lazy = lazyObservable(async () => 1, { initialValue: 0 });
    const stop = autorun(() => void lazy.value);
    await vi.waitFor(() => expect(lazy.fetchedAt).toBeDefined());

    expect(lazy.refreshing).toBe(false); // settled
    const reloading = lazy.reload();
    expect(lazy.refreshing).toBe(true); // value still on screen, request in flight

    await reloading;
    expect(lazy.refreshing).toBe(false);
    stop();
  });

  test("the two halves never overlap and cover every fetching state", async () => {
    const { lazy, resolve } = held();
    const stop = autorun(() => void lazy.value);
    await vi.waitFor(() => expect(lazy.fetching).toBe(true));

    const firstLoad = !lazy.loaded && lazy.fetching;
    expect([firstLoad, lazy.refreshing]).toEqual([true, false]);

    resolve(1);
    await vi.waitFor(() => expect(lazy.loaded).toBe(true));
    expect(lazy.fetching).toBe(false);
    expect(lazy.refreshing).toBe(false);
    stop();
  });
});

describe("the development warning", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("names the lazy and the cause when a gate loops", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const named = lazyObservableArray(
      async () => {
        await new Promise((r) => setTimeout(r, 5));
        return [1];
      },
      { initialValue: [], debugName: "surveys" },
    );

    await drive(named, (l, placeholder) => {
      if (l.fetching) return placeholder();
      void l.value;
    });

    expect(warn).toHaveBeenCalledTimes(1); // once, not once per cycle
    const message = warn.mock.calls[0]?.[0] as string;
    expect(message).toContain('"surveys"');
    expect(message).toContain("reload loop");
    expect(message).toContain("refreshing");
  });

  test("stays quiet for a gate that settles", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { lazy } = counting([]);

    await drive(lazy, (l, placeholder) => {
      if (l.refreshing) return placeholder();
      void l.value;
    });

    expect(warn).not.toHaveBeenCalled();
  });

  test("stays quiet through ordinary mount churn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { lazy } = counting([]);

    // ten mount/unmount pairs back to back — far more than StrictMode's double-invoke, and still
    // nothing like a runaway
    for (let i = 0; i < 10; i++) {
      const stop = autorun(() => void lazy.value);
      stop();
    }

    expect(warn).not.toHaveBeenCalled();
  });
});
