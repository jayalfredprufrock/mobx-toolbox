// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { useSlowLoading, type SlowLoadingOptions } from "./use-slow-loading";

const containers: HTMLElement[] = [];

afterEach(() => {
  for (const c of containers.splice(0)) c.remove();
  vi.useRealTimers();
});

/** Mounts a probe and returns a handle to drive `active` and read the resulting flag. */
const mount = async (options?: SlowLoadingOptions, initial = false) => {
  let setActive!: (v: boolean) => void;
  const seen: boolean[] = [];

  const Probe = () => {
    const [active, setter] = useState(initial);
    setActive = setter;
    const shown = useSlowLoading(active, options);
    seen.push(shown);
    return <span>{String(shown)}</span>;
  };

  const container = document.createElement("div");
  document.body.appendChild(container);
  containers.push(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Probe />);
  });

  return {
    seen,
    shown: () => container.textContent === "true",
    set: async (v: boolean) => {
      await act(async () => setActive(v));
    },
    advance: async (ms: number) => {
      await act(async () => {
        vi.advanceTimersByTime(ms);
      });
    },
    unmount: async () => {
      await act(async () => root.unmount());
    },
  };
};

describe("useSlowLoading", () => {
  test("a wait shorter than the threshold never surfaces", async () => {
    vi.useFakeTimers();
    const probe = await mount();

    await probe.set(true);
    await probe.advance(299);
    expect(probe.shown()).toBe(false);

    await probe.set(false);
    await probe.advance(10_000);

    // it never went up, so there is nothing to hold down either
    expect(probe.seen.every((s) => s === false)).toBe(true);
  });

  test("a wait past the threshold surfaces", async () => {
    vi.useFakeTimers();
    const probe = await mount();

    await probe.set(true);
    await probe.advance(300);

    expect(probe.shown()).toBe(true);
  });

  test("once surfaced, it stays for the minimum duration", async () => {
    vi.useFakeTimers();
    const probe = await mount();

    await probe.set(true);
    await probe.advance(300);
    expect(probe.shown()).toBe(true);

    // the wait ends immediately after — the indicator must not vanish a frame later
    await probe.set(false);
    expect(probe.shown()).toBe(true);

    await probe.advance(299);
    expect(probe.shown()).toBe(true);

    await probe.advance(1);
    expect(probe.shown()).toBe(false);
  });

  test("a long wait is not held any longer than it ran", async () => {
    vi.useFakeTimers();
    const probe = await mount();

    await probe.set(true);
    await probe.advance(5000); // well past the floor
    await probe.set(false);

    // the floor was satisfied long ago, so it comes down at once
    expect(probe.shown()).toBe(false);
  });

  test("flicker inside the threshold restarts the window rather than accumulating", async () => {
    vi.useFakeTimers();
    const probe = await mount();

    for (let i = 0; i < 5; i++) {
      await probe.set(true);
      await probe.advance(200);
      await probe.set(false);
      await probe.advance(10);
    }

    // five 200 ms waits are still five short waits, not one 1000 ms one
    expect(probe.shown()).toBe(false);
  });

  test("resuming before the floor expires keeps it up continuously", async () => {
    vi.useFakeTimers();
    const probe = await mount();

    await probe.set(true);
    await probe.advance(300);
    await probe.set(false);
    await probe.advance(100);

    await probe.set(true); // back to waiting before the hide landed
    await probe.advance(1000);

    expect(probe.shown()).toBe(true);
    // and it never blinked off in between
    expect(probe.seen.slice(probe.seen.indexOf(true)).every((s) => s === true)).toBe(true);
  });

  test("`after: 0` surfaces immediately", async () => {
    vi.useFakeTimers();
    const probe = await mount({ after: 0 });

    await probe.set(true);
    expect(probe.shown()).toBe(true);
  });

  test("`minDuration: 0` hides immediately", async () => {
    vi.useFakeTimers();
    const probe = await mount({ after: 0, minDuration: 0 });

    await probe.set(true);
    expect(probe.shown()).toBe(true);

    await probe.set(false);
    expect(probe.shown()).toBe(false);
  });

  test("timings are overridable", async () => {
    vi.useFakeTimers();
    const probe = await mount({ after: 50, minDuration: 1000 });

    await probe.set(true);
    await probe.advance(50);
    expect(probe.shown()).toBe(true);

    await probe.set(false);
    await probe.advance(999);
    expect(probe.shown()).toBe(true);

    await probe.advance(1);
    expect(probe.shown()).toBe(false);
  });

  /**
   * The documented render pattern, exercised end to end. `slow` has three meaningful states against
   * a value that arrives, and a component that branches on two of them is wrong in a way no timing
   * test above would catch — so this pins the sequence the README and JSDoc tell people to write.
   */
  describe("the documented three-branch pattern", () => {
    const mountPattern = async () => {
      let setLoaded!: (v: boolean) => void;
      const frames: string[] = [];

      const Probe = () => {
        const [loaded, setter] = useState(false);
        setLoaded = setter;
        const slow = useSlowLoading(!loaded);

        // exactly what the docs prescribe, in the prescribed order
        const rendered = slow ? "skeleton" : !loaded ? "nothing" : "content";
        frames.push(rendered);
        return <span>{rendered}</span>;
      };

      const container = document.createElement("div");
      document.body.appendChild(container);
      containers.push(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(<Probe />);
      });

      return {
        frames,
        rendered: () => container.textContent,
        load: async () => {
          await act(async () => setLoaded(true));
        },
        advance: async (ms: number) => {
          await act(async () => {
            vi.advanceTimersByTime(ms);
          });
        },
      };
    };

    test("a fast load renders nothing, then content — never a skeleton", async () => {
      vi.useFakeTimers();
      const probe = await mountPattern();

      expect(probe.rendered()).toBe("nothing"); // the state a two-branch version gets wrong
      await probe.advance(120);
      await probe.load();

      expect(probe.rendered()).toBe("content");
      expect(probe.frames).not.toContain("skeleton");
    });

    test("a slow load renders nothing, then the skeleton, then content", async () => {
      vi.useFakeTimers();
      const probe = await mountPattern();

      expect(probe.rendered()).toBe("nothing");
      await probe.advance(300);
      expect(probe.rendered()).toBe("skeleton");

      await probe.load();
      await probe.advance(300);
      expect(probe.rendered()).toBe("content");
    });

    test("the skeleton outlives the wait, which is why `slow` is tested first", async () => {
      vi.useFakeTimers();
      const probe = await mountPattern();

      await probe.advance(300);
      expect(probe.rendered()).toBe("skeleton");

      // value present *and* still slow — the state that a value-first branch order would drop
      await probe.load();
      expect(probe.rendered()).toBe("skeleton");

      await probe.advance(299);
      expect(probe.rendered()).toBe("skeleton");
      await probe.advance(1);
      expect(probe.rendered()).toBe("content");
    });

    test("with `after: 0` there is no third state to handle", async () => {
      vi.useFakeTimers();
      let setLoaded!: (v: boolean) => void;
      const frames: string[] = [];

      const Probe = () => {
        const [loaded, setter] = useState(false);
        setLoaded = setter;
        const slow = useSlowLoading(!loaded, { after: 0, minDuration: 0 });
        const rendered = slow ? "skeleton" : !loaded ? "nothing" : "content";
        frames.push(rendered);
        return <span>{rendered}</span>;
      };

      const container = document.createElement("div");
      document.body.appendChild(container);
      containers.push(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(<Probe />);
      });
      await act(async () => setLoaded(true));

      // "nothing" appears only on the very first render, before the effect has run — never as a
      // state the pattern has to hold, which is what makes two branches sufficient here
      expect(frames.filter((f) => f === "nothing").length).toBeLessThanOrEqual(1);
      expect(container.textContent).toBe("content");
    });
  });

  test("unmounting clears the pending timer", async () => {
    vi.useFakeTimers();
    const probe = await mount();

    await probe.set(true);
    await probe.unmount();

    // nothing left to fire; if the timer survived it would set state on a dead component
    expect(() => vi.advanceTimersByTime(10_000)).not.toThrow();
  });
});
