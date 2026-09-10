// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { lazyArray } from "../lazy/lazy";
import { SetFilter } from "../filter/set-filter.model";
import { Table } from "./components";
import { TableModel } from "./table.model";
import { useTable } from "./use-table";
import type { RowData } from "./table.types";

beforeEach(() => {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});

const containers: HTMLElement[] = [];
afterEach(() => {
  for (const c of containers.splice(0)) c.remove();
  vi.useRealTimers();
});

const mount = async (el: React.ReactNode) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  containers.push(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(el);
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

/** A table wired the way a consumer would: both slots rendered unconditionally after the body. */
const Grid = ({ table }: { table: TableModel }) => (
  <Table.Root table={table}>
    <Table.Scroll>
      <Table.Header>{(column) => <Table.ColumnHeader column={column} />}</Table.Header>
      <Table.Body>
        {(row) => (
          <Table.Row row={row}>
            {(column) => <Table.Cell column={column}>{String(column.getValue(row))}</Table.Cell>}
          </Table.Row>
        )}
      </Table.Body>
      <Table.Empty>NOTHING HERE</Table.Empty>
      <Table.Loading>LOADING</Table.Loading>
      <Table.Error>FAILED</Table.Error>
    </Table.Scroll>
  </Table.Root>
);

const sized = (config: ConstructorParameters<typeof TableModel>[0]): TableModel => {
  const table = new TableModel(config);
  table.setWidth(600);
  table.setHeight(120);
  return table;
};

describe("Table.Empty and Table.Loading gate themselves", () => {
  test("a first load shows loading and never the empty slot", async () => {
    vi.useFakeTimers();
    const gate = deferred<RowData[]>();
    const lazy = lazyArray(() => gate.promise);
    const container = await mount(<Grid table={sized({ data: lazy })} />);

    // the wait has not earned an indicator yet, but it is emphatically not "empty"
    expect(container.textContent).not.toContain("NOTHING HERE");
    expect(container.textContent).not.toContain("LOADING");

    await advance(300);
    expect(container.textContent).toContain("LOADING");
    expect(container.textContent).not.toContain("NOTHING HERE");

    gate.resolve([{ id: 1, name: "alpha" }]);
    await act(async () => {});
    await advance(300);

    expect(container.textContent).not.toContain("LOADING");
    expect(container.textContent).not.toContain("NOTHING HERE");
    expect(container.textContent).toContain("alpha");
  });

  test("a settled load with no rows shows the empty slot", async () => {
    const lazy = lazyArray(async () => []);
    const container = await mount(<Grid table={sized({ data: lazy })} />);
    await act(async () => {});

    expect(container.textContent).toContain("NOTHING HERE");
    expect(container.textContent).not.toContain("LOADING");
  });

  test("a fast first load never flashes the loading slot", async () => {
    vi.useFakeTimers();
    const lazy = lazyArray(async () => [{ id: 1, name: "alpha" }]);
    const container = await mount(<Grid table={sized({ data: lazy })} />);

    await act(async () => {});
    await advance(1000);

    expect(container.textContent).not.toContain("LOADING");
    expect(container.textContent).toContain("alpha");
  });

  test("a plain array with rows shows neither slot", async () => {
    const container = await mount(<Grid table={sized({ data: [{ id: 1, name: "alpha" }] })} />);

    expect(container.textContent).not.toContain("LOADING");
    expect(container.textContent).not.toContain("NOTHING HERE");
  });

  test("a plain empty array is empty, since there is no load to wait for", async () => {
    const container = await mount(<Grid table={sized({ data: [] })} />);

    expect(container.textContent).toContain("NOTHING HERE");
    expect(container.textContent).not.toContain("LOADING");
  });

  test("a refresh keeps the rows and shows neither slot", async () => {
    // the second fetch is held open, so the refresh is observably in flight rather than a race
    const second = deferred<RowData[]>();
    let calls = 0;
    const lazy = lazyArray(() => {
      calls++;
      return calls === 1 ? Promise.resolve([{ id: 1, name: "alpha" }]) : second.promise;
    });

    const table = sized({ data: lazy });
    const container = await mount(<Grid table={table} />);
    await act(async () => {});
    expect(container.textContent).toContain("alpha");

    await act(async () => {
      void lazy.reload();
    });

    // rows stay on screen and stay interactive — a refresh is not a load, and the table has no
    // state for it at all; the lazy is where anyone who cares can see one is running
    expect(lazy.refreshing).toBe(true);
    expect(table.loading).toBe(false);
    expect(container.textContent).toContain("alpha");
    expect(container.textContent).not.toContain("LOADING");
    expect(container.textContent).not.toContain("NOTHING HERE");

    second.resolve([{ id: 1, name: "beta" }]);
    await act(async () => {});
    expect(lazy.refreshing).toBe(false);
    expect(container.textContent).toContain("beta");
  });

  test("`sustain={false}` shows the loading slot at once", async () => {
    const gate = deferred<RowData[]>();
    const lazy = lazyArray(() => gate.promise);
    const container = await mount(
      <Table.Root table={sized({ data: lazy })}>
        <Table.Scroll>
          <Table.Loading sustain={false}>LOADING</Table.Loading>
        </Table.Scroll>
      </Table.Root>,
    );

    expect(container.textContent).toContain("LOADING");
    gate.resolve([]);
  });

  test("the empty slot's children still tell the story", async () => {
    // gating is the library's; wording stays the consumer's, including the distinction the
    // gate cannot make — filtered-to-nothing versus nothing at all
    const table = sized({ data: [{ id: 1, name: "alpha" }] });
    table.addColumn({
      key: "_none",
      value: () => "present",
      filter: new SetFilter({ selected: ["absent"] }),
      hidden: true,
      hideable: false,
    });

    const container = await mount(
      <Table.Root table={table}>
        <Table.Scroll>
          <Table.Empty>{table.rows.length > 0 ? "NO MATCHES" : "NOTHING HERE"}</Table.Empty>
        </Table.Scroll>
      </Table.Root>,
    );

    expect(container.textContent).toContain("NO MATCHES");
  });
});

describe("Table.Error gates on a failure with nothing to show", () => {
  test("a failed first load shows the error slot, not a spinner forever", async () => {
    vi.useFakeTimers();
    const gate = deferred<RowData[]>();
    const lazy = lazyArray(() => gate.promise);
    const container = await mount(<Grid table={sized({ data: lazy })} />);

    await advance(300);
    expect(container.textContent).toContain("LOADING");

    await act(async () => {
      gate.reject(new Error("boom"));
    });
    await advance(1000);

    // the whole point: the wait ends, and it ends in something the user can read
    expect(container.textContent).toContain("FAILED");
    expect(container.textContent).not.toContain("LOADING");
    expect(container.textContent).not.toContain("NOTHING HERE");
  });

  test("a failed refresh leaves the rows alone and shows no slot at all", async () => {
    let calls = 0;
    const lazy = lazyArray(() => {
      calls++;
      return calls === 1
        ? Promise.resolve([{ id: 1, name: "alpha" }])
        : Promise.reject(new Error("boom"));
    });

    const table = sized({ data: lazy });
    const container = await mount(<Grid table={table} />);
    await act(async () => {});
    expect(container.textContent).toContain("alpha");

    await act(async () => {
      await lazy.reload().catch(() => undefined);
    });

    // blanking a working table over a background request is the failure mode this gate prevents
    expect(container.textContent).toContain("alpha");
    expect(container.textContent).not.toContain("FAILED");
    expect(container.textContent).not.toContain("LOADING");
    expect(container.textContent).not.toContain("NOTHING HERE");

    // it is still a real failure, still readable where the caller keeps it — the table just
    // declines to render anything about it
    expect(table.error).toBeUndefined();
    expect(lazy.error).toBeInstanceOf(Error);
  });

  test("the error slot receives the error, so the wording can come from it", async () => {
    const lazy = lazyArray(() => Promise.reject(new Error("teapot")));
    const container = await mount(
      <Table.Root table={sized({ data: lazy })}>
        <Table.Scroll>
          <Table.Error>{(error) => `FAILED: ${(error as Error).message}`}</Table.Error>
        </Table.Scroll>
      </Table.Root>,
    );
    await act(async () => {});

    expect(container.textContent).toContain("FAILED: teapot");
    expect(container.querySelector("[data-error]")).not.toBeNull();
  });

  test("a plain array shows no error slot, since there is no failure to know about", async () => {
    const container = await mount(<Grid table={sized({ data: [{ id: 1, name: "alpha" }] })} />);

    expect(container.textContent).not.toContain("FAILED");
  });
});

describe("Table.Overlay is the placement primitive with no gate", () => {
  test("it renders whenever the consumer says so, over a perfectly healthy table", async () => {
    const container = await mount(
      <Table.Root table={sized({ data: [{ id: 1, name: "alpha" }] })}>
        <Table.Scroll>
          <Table.Body>{(row) => <Table.Row row={row}>{() => null}</Table.Row>}</Table.Body>
          <Table.Overlay>SAVE FAILED</Table.Overlay>
        </Table.Scroll>
      </Table.Root>,
    );

    expect(container.textContent).toContain("SAVE FAILED");
  });

  test("it claims none of the table's own markers", async () => {
    const container = await mount(
      <Table.Root table={sized({ data: [{ id: 1, name: "alpha" }] })}>
        <Table.Scroll>
          <Table.Overlay>SAVE FAILED</Table.Overlay>
        </Table.Scroll>
      </Table.Root>,
    );

    // `data-empty` / `data-loading` / `data-error` mean "the table decided this"; a hand-shown
    // overlay has decided nothing, so it carries no claim it can't back up
    expect(container.querySelector("[data-empty]")).toBeNull();
    expect(container.querySelector("[data-loading]")).toBeNull();
    expect(container.querySelector("[data-error]")).toBeNull();
  });
});

describe("the slots gate off the controlled props too", () => {
  /** The controlled wiring end to end: props in, gated slots out, no lazy anywhere. */
  const Controlled = ({
    rows,
    loading,
    error,
  }: {
    rows?: RowData[];
    loading?: boolean;
    error?: unknown;
  }) => {
    const table = useTable({ data: rows, loading, error });
    table.setWidth(600);
    table.setHeight(120);
    return <Grid table={table} />;
  };

  test("loading with no rows shows the loading slot", async () => {
    vi.useFakeTimers();
    const container = await mount(<Controlled rows={[]} loading />);
    await advance(300);

    expect(container.textContent).toContain("LOADING");
    expect(container.textContent).not.toContain("NOTHING HERE");
    expect(container.textContent).not.toContain("FAILED");
  });

  test("an error with no rows shows the error slot", async () => {
    const container = await mount(<Controlled rows={[]} error={new Error("boom")} />);

    expect(container.textContent).toContain("FAILED");
    expect(container.textContent).not.toContain("LOADING");
    expect(container.textContent).not.toContain("NOTHING HERE");
  });

  test("an error behind rows shows no slot at all", async () => {
    const container = await mount(
      <Controlled rows={[{ id: 1, name: "alpha" }]} error={new Error("boom")} />,
    );

    expect(container.textContent).toContain("alpha");
    expect(container.textContent).not.toContain("FAILED");
  });

  test("settled with no rows shows the empty slot", async () => {
    const container = await mount(<Controlled rows={[]} loading={false} />);

    expect(container.textContent).toContain("NOTHING HERE");
    expect(container.textContent).not.toContain("LOADING");
    expect(container.textContent).not.toContain("FAILED");
  });
});

describe("the header's measured height drives overlay placement", () => {
  // the overlay is an out-of-flow anchor — kept out of the scrollport's content height so a hugging
  // root can't size itself from it — with the sized box as its sticky child
  const overlayAnchor = (container: HTMLElement) =>
    container.querySelector("[role=table] > div:last-child") as HTMLElement;
  const overlayBox = (container: HTMLElement) =>
    container.querySelector("[role=table] > div:last-child > div") as HTMLElement;

  const withOverlay = (table: TableModel) => (
    <Table.Root table={table}>
      <Table.Scroll>
        <Table.Header>{(column) => <Table.ColumnHeader column={column} />}</Table.Header>
        <Table.Overlay>SAVE FAILED</Table.Overlay>
      </Table.Scroll>
    </Table.Root>
  );

  test("the overlay starts below the header", async () => {
    const table = sized({ data: [{ id: 1, name: "alpha" }], headerHeight: 44 });

    const container = await mount(withOverlay(table));
    const overlay = overlayBox(container);

    expect(overlay.style.height).toBe("76px"); // 120 - 44
  });

  test("the header defaults to the row height, so an unconfigured table is unchanged", async () => {
    const table = sized({ data: [{ id: 1, name: "alpha" }], rowHeight: 40 });

    const container = await mount(withOverlay(table));

    expect(table.headerHeight).toBe(40);
    expect(overlayBox(container).style.height).toBe("80px"); // 120 - 40
  });

  test("headerHeight: 0 is how a table with no header takes the full height", async () => {
    const table = sized({ data: [{ id: 1, name: "alpha" }], headerHeight: 0 });
    const container = await mount(
      <Table.Root table={table}>
        <Table.Scroll>
          <Table.Overlay>SAVE FAILED</Table.Overlay>
        </Table.Scroll>
      </Table.Root>,
    );
    const overlay = overlayBox(container);

    expect(overlay.style.top).toBe("0px");
    expect(overlay.style.height).toBe("120px");
  });

  test("and it reserves the height anyway when a headerless table doesn't say so", async () => {
    // the accepted cost of declaring the height instead of measuring it. The reservation belongs
    // to the config, so composing without a `<Table.Header>` and leaving `headerHeight` alone
    // insets the overlay by a header that isn't there — misplacing an empty state, which is the
    // whole blast radius: nothing in the virtualization math reads this.
    const table = sized({ data: [{ id: 1, name: "alpha" }] });
    const container = await mount(
      <Table.Root table={table}>
        <Table.Scroll>
          <Table.Overlay>SAVE FAILED</Table.Overlay>
        </Table.Scroll>
      </Table.Root>,
    );
    const overlay = overlayBox(container);

    expect(overlay.style.top).toBe("40px");
    expect(overlay.style.height).toBe("80px");
  });

  test("it clamps at zero rather than going negative in a box shorter than its header", async () => {
    const table = sized({ data: [{ id: 1, name: "alpha" }], headerHeight: 44 });
    table.setHeight(30);

    const container = await mount(withOverlay(table));
    const overlay = overlayBox(container);

    expect(overlay.style.height).toBe("0px");
  });

  test("the reservation is the config's, so dropping the header does not clear it", async () => {
    const table = sized({ data: [{ id: 1, name: "alpha" }], headerHeight: 44 });

    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(withOverlay(table));
    });
    expect(overlayBox(container).style.height).toBe("76px");

    await act(async () => {
      root.render(
        <Table.Root table={table}>
          <Table.Scroll>
            <Table.Overlay>SAVE FAILED</Table.Overlay>
          </Table.Scroll>
        </Table.Root>,
      );
    });

    // nothing reports back from the markup — which is what makes the number right on the first
    // frame, and why a header that comes and goes with a breakpoint wants `headerHeight: 0`
    // rather than a conditional `<Table.Header>`
    expect(table.headerHeight).toBe(44);
    expect(overlayBox(container).style.height).toBe("76px");
  });

  test("Table.Root publishes the header height for consumer CSS", async () => {
    const table = sized({ data: [{ id: 1, name: "alpha" }], headerHeight: 44 });

    const container = await mount(withOverlay(table));
    const viewport = container.querySelector(".table-viewport") as HTMLElement;

    expect(viewport.style.getPropertyValue("--table-header-height")).toBe("44px");
    expect(viewport.style.getPropertyValue("--table-row-height")).toBe("40px");
  });

  test("the header renders at exactly the height it publishes", async () => {
    const table = sized({ data: [{ id: 1, name: "alpha" }], headerHeight: 44 });

    const container = await mount(withOverlay(table));
    const header = container.querySelector(".table-header") as HTMLElement;

    // border-box, so a consumer's own padding comes out of this rather than pushing the rendered
    // header past the number the overlay and the CSS var are both using
    expect(header.style.height).toBe("44px");
    expect(header.style.boxSizing).toBe("border-box");

    // and the row inside carries no height of its own — it stretches into what is left
    const row = header.querySelector("[role=row]") as HTMLElement;
    expect(row.style.height).toBe("");
  });

  // The anchor is absolutely positioned at the top of the scrollport rather than sticky in flow,
  // so the sized box lands `headerHeight` below the scrollport's top edge no matter where the
  // consumer wrote the overlay. As a sticky wrapper it inherited its flow position instead, which
  // put the box at `headerHeight` *past the rows* — a full header height too low even on an empty
  // table, and off-screen entirely once there were rows.
  //
  // happy-dom resolves no layout, so these assert the arithmetic the geometry is built from rather
  // than the geometry itself; the placement was verified in a browser.
  test("the anchor is out of flow at the top of the scrollport, wherever the overlay is written", async () => {
    const table = sized({ data: [{ id: 1, name: "alpha" }], headerHeight: 44 });

    const container = await mount(withOverlay(table));
    const anchor = overlayAnchor(container);

    expect(anchor.style.position).toBe("absolute");
    expect(anchor.style.top).toBe("0px");
    // only the box intercepts, as when the box was the whole of it
    expect(anchor.style.pointerEvents).toBe("none");
    expect(overlayBox(container).style.pointerEvents).toBe("auto");
  });

  test("the box sticks below the header rather than sitting at a flow position", async () => {
    const table = sized({ data: [{ id: 1, name: "alpha" }], headerHeight: 44 });

    const overlay = overlayBox(await mount(withOverlay(table)));

    expect(overlay.style.position).toBe("sticky");
    expect(overlay.style.top).toBe("44px");
  });

  test("the anchor spans the scrollable extent, so the box has room to stay put while scrolling", async () => {
    const data = Array.from({ length: 20 }, (_, i) => ({ id: i, name: `row ${i}` }));
    const table = sized({ data, headerHeight: 44, rowHeight: 40 });

    const container = await mount(
      <Table.Root table={table}>
        <Table.Scroll>
          <Table.Header>{(column) => <Table.ColumnHeader column={column} />}</Table.Header>
          <Table.Body>{(row) => <Table.Row row={row}>{() => null}</Table.Row>}</Table.Body>
          <Table.Overlay>SAVE FAILED</Table.Overlay>
        </Table.Scroll>
      </Table.Root>,
    );

    // 20 * 40 rows + the header — the scrollport's whole content height. A shorter anchor clamps
    // the sticky box and the message drifts up as you approach the bottom.
    expect(table.virtualHeight).toBe(800);
    expect(overlayAnchor(container).style.height).toBe("844px");
  });

  test("and falls back to the measured box when there is no extent, so an empty table gets no scrollbar from it", async () => {
    const table = sized({ data: [], headerHeight: 44 });

    const container = await mount(withOverlay(table));

    // `table.height`, not `height + headerHeight`: the anchor is out of flow, so anything past the
    // measured client box is scrollable overflow the table invented for itself
    expect(table.virtualHeight).toBe(0);
    expect(overlayAnchor(container).style.height).toBe("120px");
  });

  test("placement does not depend on where the overlay is written", async () => {
    const data = Array.from({ length: 20 }, (_, i) => ({ id: i, name: `row ${i}` }));
    const first = sized({ data, headerHeight: 44, rowHeight: 40 });
    const last = sized({ data, headerHeight: 44, rowHeight: 40 });

    const before = await mount(
      <Table.Root table={first}>
        <Table.Scroll>
          <Table.Overlay>SAVE FAILED</Table.Overlay>
          <Table.Header>{(column) => <Table.ColumnHeader column={column} />}</Table.Header>
          <Table.Body>{(row) => <Table.Row row={row}>{() => null}</Table.Row>}</Table.Body>
        </Table.Scroll>
      </Table.Root>,
    );
    const after = await mount(
      <Table.Root table={last}>
        <Table.Scroll>
          <Table.Header>{(column) => <Table.ColumnHeader column={column} />}</Table.Header>
          <Table.Body>{(row) => <Table.Row row={row}>{() => null}</Table.Row>}</Table.Body>
          <Table.Overlay>SAVE FAILED</Table.Overlay>
        </Table.Scroll>
      </Table.Root>,
    );

    const written = (container: HTMLElement) => {
      const box = container.querySelector(
        "[role=table] [style*=sticky][style*=flex]",
      ) as HTMLElement;
      const anchor = box.parentElement as HTMLElement;
      return [anchor.style.position, anchor.style.top, anchor.style.height, box.style.top];
    };

    expect(written(before)).toEqual(written(after));
    expect(written(before)).toEqual(["absolute", "0px", "844px", "44px"]);
  });

  test("headerHeight: 0 publishes 0px", async () => {
    const table = sized({ data: [{ id: 1, name: "alpha" }], headerHeight: 0 });

    const container = await mount(
      <Table.Root table={table}>
        <Table.Scroll>
          <Table.Overlay>SAVE FAILED</Table.Overlay>
        </Table.Scroll>
      </Table.Root>,
    );
    const viewport = container.querySelector(".table-viewport") as HTMLElement;

    expect(viewport.style.getPropertyValue("--table-header-height")).toBe("0px");
  });
});

describe("Table.Scroll is the scrollport, and the parts know which box they belong in", () => {
  const rows = [{ id: 1, name: "alpha" }];

  test("it owns the scroll role, the aria extent and the measured width", async () => {
    const table = sized({ data: rows });
    const container = await mount(
      <Table.Root table={table}>
        <Table.Scroll>
          <Table.Body>{(row) => <Table.Row row={row}>{() => null}</Table.Row>}</Table.Body>
        </Table.Scroll>
      </Table.Root>,
    );

    const viewport = container.querySelector(".table-viewport") as HTMLElement;
    const scroller = container.querySelector('[role="table"]') as HTMLElement;

    expect(scroller.parentElement).toBe(viewport);
    expect(scroller.style.overflow).toBe("auto");
    expect(scroller.style.getPropertyValue("--table-scroll-width")).toBe("600px");
    // the root is a flex column and measures nothing itself
    expect(viewport.style.display).toBe("flex");
    expect(viewport.style.flexDirection).toBe("column");
  });

  test("a part that needs the scrollport says so instead of rendering blank", async () => {
    // without <Table.Scroll> no width is ever measured, so the gate never opens and the table is
    // simply empty — no message, nothing in the DOM, every symptom pointing at the data
    const table = sized({ data: rows });
    await expect(
      mount(
        <Table.Root table={table}>
          <Table.Body>{(row) => <Table.Row row={row}>{() => null}</Table.Row>}</Table.Body>
        </Table.Root>,
      ),
    ).rejects.toThrow(/must be rendered inside <Table.Scroll>/);
  });

  test("and chrome that belongs outside says so too", async () => {
    const table = sized({ data: rows });
    await expect(
      mount(
        <Table.Root table={table}>
          <Table.Scroll>
            <Table.StatusBar>Showing 1</Table.StatusBar>
          </Table.Scroll>
        </Table.Root>,
      ),
    ).rejects.toThrow(/must be rendered outside <Table.Scroll>/);
  });

  test("the render gate waits on width but not on height", async () => {
    // height is the one thing that can't be a precondition: when the root hugs its content, the
    // scrollport's height comes *from* what renders here, so requiring it first would deadlock.
    // The spacer is `virtualHeight`, which depends on the row count, so height bootstraps itself.
    const table = new TableModel({ data: rows });
    table.setWidth(600);
    table.setHeight(0);

    const container = await mount(
      <Table.Root table={table}>
        <Table.Scroll>
          <Table.Header>{(column) => <Table.ColumnHeader column={column} />}</Table.Header>
          <Table.Body>{(row) => <Table.Row row={row}>{() => null}</Table.Row>}</Table.Body>
        </Table.Scroll>
      </Table.Root>,
    );

    expect(container.querySelector("[role=rowgroup]")).not.toBeNull();
    expect(table.virtualHeight).toBeGreaterThan(0);
  });

  test("nothing renders until a width is known", async () => {
    const table = new TableModel({ data: rows });
    table.setHeight(120);

    const container = await mount(
      <Table.Root table={table}>
        <Table.Scroll>
          <Table.Body>{(row) => <Table.Row row={row}>{() => null}</Table.Row>}</Table.Body>
        </Table.Scroll>
      </Table.Root>,
    );

    expect(container.querySelector("[role=rowgroup]")).toBeNull();
  });

  test("chrome renders immediately, without waiting to be measured", async () => {
    // the bar's content doesn't depend on measurement, and gating it would make it pop in a frame
    // late — it is outside the gated box entirely
    const table = new TableModel({ data: rows });

    const container = await mount(
      <Table.Root table={table}>
        <Table.Scroll>
          <Table.Body>{(row) => <Table.Row row={row}>{() => null}</Table.Row>}</Table.Body>
        </Table.Scroll>
        <Table.StatusBar>Showing 1</Table.StatusBar>
      </Table.Root>,
    );

    expect(table.width).toBe(0);
    expect(container.querySelector("[data-table-status-bar]")?.textContent).toBe("Showing 1");
  });

  test("it merges an incoming ref with its own, so a scroll-area can compose onto it", async () => {
    const table = sized({ data: rows });
    let captured: HTMLElement | null = null;

    const container = await mount(
      <Table.Root table={table}>
        <Table.Scroll
          ref={(node: HTMLDivElement | null) => {
            captured = node;
          }}
          data-composed=""
        >
          <Table.Body>{(row) => <Table.Row row={row}>{() => null}</Table.Row>}</Table.Body>
        </Table.Scroll>
      </Table.Root>,
    );

    const scroller = container.querySelector('[role="table"]') as HTMLElement;
    // the caller gets the element, and the component keeps its own hold on it — `setScroll` still
    // being wired is what proves the internal ref survived the merge
    expect(captured).toBe(scroller);
    expect(scroller.dataset.composed).toBe("");
    scroller.scrollTop = 40;
    scroller.dispatchEvent(new Event("scroll"));
    expect(table.scrollY).toBe(40);
  });
});
