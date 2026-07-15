// @vitest-environment happy-dom
import { configure } from "mobx";
import { Observer, observer } from "mobx-react-lite";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";
import { lazyObservable, lazyObservableArray } from "./lazy-observable";

// panelpro client-app runs with strict action enforcement (src/index.tsx)
configure({ enforceActions: "always" });

// Mirrors the two page patterns in panelpro client-app:
// - DistributionsPage: observer() component gating on `.loaded` of two lazies,
//   then rendering a child observer() that reads a third lazy's `.value`.
// - RespondentsPage: plain component with an <Observer> render callback reading `.value`.

const flush = async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
};

const mount = async (el: React.ReactNode) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(el);
  });
  return { container, root };
};

describe("lazyObservable + react rendering", () => {
  it("loads via <Observer> render callback (respondents pattern)", async () => {
    const fetch = vi.fn(async () => [1, 2, 3]);
    const items = lazyObservableArray(fetch);

    const Page = () => (
      <Observer>{() => <div data-testid="len">{items.value.length}</div>}</Observer>
    );

    const { container } = await mount(<Page />);
    await flush();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("3");
  });

  it("a failing gate lazy silently prevents downstream lazies from ever loading", async () => {
    const fetchGate = vi.fn(async () => {
      throw new Error("api blew up");
    });
    const fetchItems = vi.fn(async () => [1, 2, 3]);

    const gate = lazyObservable(fetchGate);
    const items = lazyObservableArray(fetchItems);

    const Table = observer(() => <div>{items.value.length}</div>);
    const Page = observer(() => {
      if (!gate.loaded) return null;
      return <Table />;
    });

    const { container } = await mount(<Page />);
    await flush();
    await flush();

    // The gate fetch ran and failed; status is 'error', so `.loaded` stays false
    // forever, the page stays null, and the downstream loader NEVER fires —
    // with no thrown render error and nothing for an error boundary to catch.
    expect(fetchGate).toHaveBeenCalled();
    expect(gate.error).toBeInstanceOf(Error);
    expect(fetchItems).not.toHaveBeenCalled();
    expect(container.textContent).toBe("");
  });

  it("loads via observer() gated on .loaded (distributions pattern)", async () => {
    const fetchA = vi.fn(async () => "versionA");
    const fetchB = vi.fn(async () => "versionB");
    const fetchItems = vi.fn(async () => [1, 2, 3]);

    const latestVersion = lazyObservable(fetchA);
    const publishedVersion = lazyObservable(fetchB);
    const distributions = lazyObservableArray(fetchItems);

    const Table = observer(() => <div data-testid="len">{distributions.value.length}</div>);

    const Page = observer(() => {
      if (!latestVersion.loaded || !publishedVersion.loaded) return null;
      return <Table />;
    });

    const { container } = await mount(<Page />);
    await flush();
    await flush();

    expect(fetchA).toHaveBeenCalledTimes(1);
    expect(fetchB).toHaveBeenCalledTimes(1);
    expect(fetchItems).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("3");
  });
});
