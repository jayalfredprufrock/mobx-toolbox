// @vitest-environment happy-dom
import { Component, type ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { lazy } from "./lazy";
import { LazyObserver } from "./components/lazy-observer";

const containers: HTMLElement[] = [];

afterEach(() => {
  for (const c of containers.splice(0)) c.remove();
  vi.useRealTimers();
});

class Boundary extends Component<{ children: ReactNode }, { caught: boolean }> {
  override state = { caught: false };
  static getDerivedStateFromError() {
    return { caught: true };
  }
  override render() {
    return this.state.caught ? <span>BOUNDARY</span> : this.props.children;
  }
}

const mount = async (node: ReactNode) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  containers.push(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  return container;
};

const advance = async (ms: number) => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("LazyObserver — placeholder timing", () => {
  test("a fast load never mounts the placeholder", async () => {
    vi.useFakeTimers();
    let spinnerMounts = 0;
    const Spinner = () => {
      spinnerMounts++;
      return <span>SPINNER</span>;
    };

    const subject = lazy(async () => "done");
    const container = await mount(
      <LazyObserver observe={subject} placeholder={<Spinner />}>
        {(v) => <span>{v}</span>}
      </LazyObserver>,
    );

    await act(async () => {});
    expect(container.textContent).toBe("done");

    // and it stays that way — the threshold passing does not retroactively show anything
    await advance(1000);
    expect(container.textContent).toBe("done");
    expect(spinnerMounts).toBe(0);
  });

  test("a slow load renders the placeholder once past the threshold", async () => {
    vi.useFakeTimers();
    const gate = deferred<string>();
    const subject = lazy(() => gate.promise);

    const container = await mount(
      <LazyObserver observe={subject} placeholder={<span>SPINNER</span>}>
        {(v) => <span>{v}</span>}
      </LazyObserver>,
    );

    await advance(299);
    expect(container.textContent).toBe("");

    await advance(1);
    expect(container.textContent).toBe("SPINNER");
  });

  test("the placeholder stays up for the minimum duration", async () => {
    vi.useFakeTimers();
    const gate = deferred<string>();
    const subject = lazy(() => gate.promise);

    const container = await mount(
      <LazyObserver observe={subject} placeholder={<span>SPINNER</span>}>
        {(v) => <span>{v}</span>}
      </LazyObserver>,
    );

    await advance(300);
    expect(container.textContent).toBe("SPINNER");

    // the value lands a moment later; the spinner must not vanish instantly
    gate.resolve("done");
    await act(async () => {});
    expect(container.textContent).toBe("SPINNER");

    await advance(300);
    expect(container.textContent).toBe("done");
  });

  test("`sustain={false}` renders the placeholder immediately", async () => {
    const gate = deferred<string>();
    const subject = lazy(() => gate.promise);

    const container = await mount(
      <LazyObserver observe={subject} placeholder={<span>SPINNER</span>} sustain={false}>
        {(v) => <span>{v}</span>}
      </LazyObserver>,
    );

    expect(container.textContent).toBe("SPINNER");
    gate.resolve("done");
  });

  test("timings are overridable", async () => {
    vi.useFakeTimers();
    const gate = deferred<string>();
    const subject = lazy(() => gate.promise);

    const container = await mount(
      <LazyObserver
        observe={subject}
        placeholder={<span>SPINNER</span>}
        sustain={{ after: 50, minDuration: 0 }}
      >
        {(v) => <span>{v}</span>}
      </LazyObserver>,
    );

    await advance(50);
    expect(container.textContent).toBe("SPINNER");
  });

  test("with a tuple, the clock runs off the combined gate", async () => {
    vi.useFakeTimers();
    const fast = lazy(async () => "a");
    const slow = deferred<string>();
    const slowLazy = lazy(() => slow.promise);

    const container = await mount(
      <LazyObserver observe={[fast, slowLazy]} placeholder={<span>SPINNER</span>}>
        {(a, b) => (
          <span>
            {a}
            {b}
          </span>
        )}
      </LazyObserver>,
    );

    // the fast one resolving does not restart or satisfy the gate — one is still missing
    await advance(300);
    expect(container.textContent).toBe("SPINNER");

    slow.resolve("b");
    await advance(300);
    expect(container.textContent).toBe("ab");
  });
});

describe("LazyObserver — errors", () => {
  test("a first-load failure reaches the error boundary", async () => {
    const subject = lazy(async () => {
      throw new Error("nope");
    });

    const container = await mount(
      <Boundary>
        <LazyObserver observe={subject} placeholder={<span>SPINNER</span>}>
          {(v) => <span>{String(v)}</span>}
        </LazyObserver>
      </Boundary>,
    );

    await act(async () => {});
    expect(container.textContent).toBe("BOUNDARY");
  });

  test("a failed refresh keeps rendering the value it still has", async () => {
    let calls = 0;
    const subject = lazy(async () => {
      calls++;
      if (calls > 1) throw new Error("offline");
      return "good data";
    });

    const container = await mount(
      <Boundary>
        <LazyObserver observe={subject} placeholder={<span>SPINNER</span>}>
          {(v) => <span>{v}</span>}
        </LazyObserver>
      </Boundary>,
    );

    await act(async () => {});
    expect(container.textContent).toBe("good data");

    await act(async () => {
      await subject.reload().catch(() => {});
    });

    // the screen survives a failed background request — throwing here would destroy working data
    expect(container.textContent).toBe("good data");
    expect(subject.error).toBeInstanceOf(Error);
  });

  test("a refresh keeps rendering children rather than falling back to the placeholder", async () => {
    const gate = deferred<string>();
    let calls = 0;
    const subject = lazy(() => {
      calls++;
      return calls === 1 ? Promise.resolve("first") : gate.promise;
    });

    const container = await mount(
      <LazyObserver observe={subject} placeholder={<span>SPINNER</span>}>
        {(v) => <span>{v}</span>}
      </LazyObserver>,
    );

    await act(async () => {});
    expect(container.textContent).toBe("first");

    await act(async () => {
      void subject.reload();
    });

    // the gate is `loaded`, not `fetching`, so a refresh never blanks the page
    expect(container.textContent).toBe("first");
    gate.resolve("second");
  });
});
