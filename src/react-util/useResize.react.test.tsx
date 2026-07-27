// @vitest-environment happy-dom
import { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { useResize } from "./useResize";

// A controllable ResizeObserver: every instance registers itself so a test can drive the callback
// with whatever contentRect it wants, and assert how many observers were created.
interface FakeObserver {
  target: Element | undefined;
  emit: (width: number, height: number) => void;
  disconnected: boolean;
}
let observers: FakeObserver[] = [];

beforeEach(() => {
  observers = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private readonly self: FakeObserver;

      constructor(callback: ResizeObserverCallback) {
        this.self = {
          target: undefined,
          disconnected: false,
          emit: (width, height) => {
            callback([{ contentRect: { width, height } } as ResizeObserverEntry], this as never);
          },
        };
        observers.push(this.self);
      }

      observe(target: Element): void {
        this.self.target = target;
      }

      unobserve(): void {}

      disconnect(): void {
        this.self.disconnected = true;
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const mount = async (el: React.ReactNode) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(el);
  });
  return { container, root };
};

describe("useResize", () => {
  test("reports the observed element's content-box size", async () => {
    const onResize = vi.fn();
    const Box = () => {
      const ref = useRef<HTMLDivElement>(null);
      useResize(ref, onResize);
      return <div ref={ref} data-testid="box" />;
    };

    const { container } = await mount(<Box />);
    expect(observers).toHaveLength(1);
    expect(observers[0]!.target).toBe(container.querySelector("[data-testid=box]"));

    // fractional values are passed through untouched — the caller rounds if it needs to
    await act(async () => {
      observers[0]!.emit(640.5, 480);
    });
    expect(onResize).toHaveBeenCalledWith(640.5, 480);
  });

  test("always calls the latest callback, not the one from the first render", async () => {
    const calls: string[] = [];

    const Box = () => {
      const ref = useRef<HTMLDivElement>(null);
      const [label, setLabel] = useState("first");
      // a fresh inline closure every render, capturing the current label
      useResize(ref, (width) => calls.push(`${label}:${width}`));
      return (
        <div ref={ref}>
          <button type="button" onClick={() => setLabel("second")}>
            relabel
          </button>
        </div>
      );
    };

    const { container } = await mount(<Box />);
    await act(async () => {
      observers[0]!.emit(100, 0);
    });

    await act(async () => {
      container.querySelector("button")!.click();
    });
    await act(async () => {
      observers[0]!.emit(200, 0);
    });

    expect(calls).toEqual(["first:100", "second:200"]);
  });

  test("an inline callback does not re-create the observer on re-render", async () => {
    const Box = () => {
      const ref = useRef<HTMLDivElement>(null);
      const [n, setN] = useState(0);
      useResize(ref, () => {});
      return (
        <div ref={ref}>
          <button type="button" onClick={() => setN(n + 1)}>
            {n}
          </button>
        </div>
      );
    };

    const { container } = await mount(<Box />);
    expect(observers).toHaveLength(1);

    await act(async () => {
      container.querySelector("button")!.click();
    });
    await act(async () => {
      container.querySelector("button")!.click();
    });

    expect(observers).toHaveLength(1);
    expect(observers[0]!.disconnected).toBe(false);
  });

  test("disconnects on unmount", async () => {
    const Box = () => {
      const ref = useRef<HTMLDivElement>(null);
      useResize(ref, () => {});
      return <div ref={ref} />;
    };

    const { root } = await mount(<Box />);
    await act(async () => {
      root.unmount();
    });

    expect(observers[0]!.disconnected).toBe(true);
  });

  test("falls back to window resize events when ResizeObserver is unavailable", async () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const onResize = vi.fn();

    const Box = () => {
      const ref = useRef<HTMLDivElement>(null);
      useResize(ref, onResize);
      return <div ref={ref} />;
    };

    await mount(<Box />);
    // measured eagerly on mount, since there is no observer to deliver an initial entry
    expect(onResize).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(onResize).toHaveBeenCalledTimes(2);
  });
});
