// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { useDebouncedCallback } from "./useDebouncedCallback";
import { useDebouncedEffect } from "./useDebouncedEffect";

const containers: HTMLElement[] = [];

afterEach(() => {
  for (const c of containers.splice(0)) c.remove();
});

const mount = async (node: React.ReactNode) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  containers.push(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  return { container, unmount: () => act(async () => root.unmount()) };
};

const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

describe("useDebouncedCallback", () => {
  const setup = async (options: { leading?: boolean; delayMs: number }) => {
    const calls: number[] = [];
    let debounced!: (n: number) => void;

    const Probe = () => {
      debounced = useDebouncedCallback((n: number) => void calls.push(n), [], options);
      return null;
    };

    const view = await mount(<Probe />);
    return { calls, call: (n: number) => debounced(n), ...view };
  };

  test("leading: a burst fires once at the start and once at the end", async () => {
    const { calls, call } = await setup({ leading: true, delayMs: 40 });

    call(1);
    call(2);
    call(3);
    expect(calls).toEqual([1]);

    await wait(80);
    expect(calls).toEqual([1, 3]);
  });

  test("leading: an isolated call after a quiet window fires immediately again", async () => {
    const { calls, call } = await setup({ leading: true, delayMs: 40 });

    call(1);
    expect(calls).toEqual([1]);

    await wait(80);
    call(2);
    // re-armed by the quiet window, rather than waiting out a trailing delay
    expect(calls).toEqual([1, 2]);
  });

  test("trailing only: fires once, after the burst", async () => {
    const { calls, call } = await setup({ delayMs: 40 });

    call(1);
    call(2);
    expect(calls).toEqual([]);

    await wait(80);
    expect(calls).toEqual([2]);
  });

  test("a call pending at unmount never fires", async () => {
    const { calls, call, unmount } = await setup({ delayMs: 40 });

    call(1);
    await unmount();
    await wait(80);

    expect(calls).toEqual([]);
  });
});

describe("useDebouncedEffect", () => {
  test("runs each effect's cleanup before the next run, and the last one on unmount", async () => {
    const log: string[] = [];
    let setValue: (v: string) => void = () => {};

    const Probe = () => {
      const [value, setter] = useState("a");
      setValue = setter;
      useDebouncedEffect(
        () => {
          log.push(`run ${value}`);
          return () => void log.push(`cleanup ${value}`);
        },
        [value],
        { delayMs: 40 },
      );
      return null;
    };

    const { unmount } = await mount(<Probe />);
    // leading by default: the first run doesn't wait
    expect(log).toEqual(["run a"]);

    await act(async () => setValue("b"));
    await act(async () => setValue("c"));
    // the previous run stays in place until its replacement fires
    expect(log).toEqual(["run a"]);

    await wait(80);
    expect(log).toEqual(["run a", "cleanup a", "run c"]);

    await unmount();
    expect(log).toEqual(["run a", "cleanup a", "run c", "cleanup c"]);
  });
});
