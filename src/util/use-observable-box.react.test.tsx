// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { comparer, reaction, runInAction } from "mobx";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { useObservableBox } from "./use-observable-box";

const containers: HTMLElement[] = [];
afterEach(() => {
  for (const c of containers.splice(0)) c.remove();
});

const render = async (Component: React.FunctionComponent<{ value: any }>, value: any) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  containers.push(container);
  const root = createRoot(container);

  const rerender = async (next: any) => {
    await act(async () => root.render(<Component value={next} />));
  };
  await rerender(value);

  return {
    container,
    rerender,
    unmount: async () => {
      await act(async () => root.unmount());
    },
  };
};

describe("useObservableBox", () => {
  test("a React value becomes something mobx can watch", async () => {
    const seen: string[] = [];
    let stop!: () => void;

    const Probe = ({ value }: { value: { query: string } }) => {
      const box = useObservableBox(value);
      // Set up once, exactly as a component would in an effect.
      stop ??= reaction(
        () => box.get().query,
        (q) => seen.push(q),
      );
      return null;
    };

    const view = await render(Probe, { query: "a" });
    await view.rerender({ query: "b" });
    await view.rerender({ query: "c" });

    expect(seen).toEqual(["b", "c"]);
    stop();
    await view.unmount();
  });

  test("an object rebuilt with the same fields is not a change", async () => {
    const effect = vi.fn();
    let stop!: () => void;

    const Probe = ({ value }: { value: { orgId: string } }) => {
      const box = useObservableBox(value);
      stop ??= reaction(() => box.get(), effect);
      return null;
    };

    // A fresh object literal every render, same contents — shallow comparison sees through it.
    const view = await render(Probe, { orgId: "acme" });
    await view.rerender({ orgId: "acme" });
    await view.rerender({ orgId: "acme" });
    expect(effect).not.toHaveBeenCalled();

    await view.rerender({ orgId: "globex" });
    expect(effect).toHaveBeenCalledTimes(1);

    stop();
    await view.unmount();
  });

  test("a custom comparer handles values nested deeper than a field", async () => {
    const shallowEffect = vi.fn();
    const structuralEffect = vi.fn();
    let stops: (() => void)[] = [];

    const Probe = ({ value }: { value: { filter: { q: string } } }) => {
      const shallowBox = useObservableBox(value);
      const structuralBox = useObservableBox(value, { equals: comparer.structural });
      if (!stops.length) {
        stops = [
          reaction(() => shallowBox.get(), shallowEffect),
          reaction(() => structuralBox.get(), structuralEffect),
        ];
      }
      return null;
    };

    const view = await render(Probe, { filter: { q: "a" } });
    // Same contents, new nested object: shallow sees a change, structural does not.
    await view.rerender({ filter: { q: "a" } });

    expect(shallowEffect).toHaveBeenCalledTimes(1);
    expect(structuralEffect).not.toHaveBeenCalled();

    for (const stop of stops) stop();
    await view.unmount();
  });

  test("the box keeps its identity across renders", async () => {
    const boxes: unknown[] = [];
    const Probe = ({ value }: { value: number }) => {
      boxes.push(useObservableBox(value));
      return null;
    };

    const view = await render(Probe, 1);
    await view.rerender(2);
    await view.rerender(3);

    expect(new Set(boxes).size).toBe(1);
    await view.unmount();
  });

  test("scalars work, and writes from elsewhere are not clobbered by an unchanged render", async () => {
    let box!: ReturnType<typeof useObservableBox<string>>;
    const Probe = ({ value }: { value: string }) => {
      box = useObservableBox(value);
      const [, force] = useState(0);
      // Expose a way to re-render without changing the prop.
      (globalThis as any).__force = () => force((n) => n + 1);
      return null;
    };

    const view = await render(Probe, "a");
    expect(box.get()).toBe("a");

    await view.rerender("b");
    expect(box.get()).toBe("b");

    // A write from mobx's side survives a re-render that didn't change the prop... until the
    // component renders with a prop that no longer matches, which is the intended direction of flow.
    await act(async () => runInAction(() => box.set("mobx")));
    await act(async () => (globalThis as any).__force());
    expect(box.get()).toBe("b");

    await view.unmount();
  });
});
