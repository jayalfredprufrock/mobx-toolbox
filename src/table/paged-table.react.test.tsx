// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { observer } from "mobx-react-lite";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { lazyPages, type LazyPages } from "../lazy/lazy";
import { SetFilter } from "../filter/set-filter.model";
import { Table } from "./components";
import { useTable } from "./use-table";
import type { TableModel } from "./table.model";
import type { ColumnsDef, TableQuery } from "./table.types";

beforeEach(() => {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
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

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });

interface Survey {
  id: number;
  title: string;
  status: string;
}

const columns: ColumnsDef<Survey> = [
  { key: "title" },
  { key: "status", filter: () => new SetFilter({ options: ["draft", "live"] }) },
];

const api = (total: number) =>
  vi.fn(({ cursor, limit, query }: { cursor?: string; limit: number; query: TableQuery }) => {
    const start = cursor === undefined ? 0 : Number(cursor);
    const items = Array.from({ length: Math.min(limit, total - start) }, (_, i) => ({
      id: start + i,
      title: `s${start + i}`,
      status: (query.filters?.[0]?.value as string[] | undefined)?.[0] ?? "draft",
    }));
    const next = start + items.length;
    return Promise.resolve({ items, cursor: next < total ? String(next) : null, total });
  });

/**
 * The whole point of the table additions: a server-paged table the consumer writes with no
 * reaction, effect, cursor, mode flag or reset of their own. Everything below is driven only by
 * the things a user would actually touch — mounting, a filter toggle, a header click.
 */
describe("a paged table, end to end", () => {
  const SurveyTable = observer(
    ({
      feed,
      onTable,
    }: {
      feed: LazyPages<Survey, TableQuery>;
      onTable?: (table: TableModel) => void;
    }) => {
      const table = useTable<Survey>({ data: feed, columns });
      onTable?.(table);
      // happy-dom lays nothing out, so stand in for the ResizeObserver
      table.setWidth(600);
      table.setHeight(400);

      return (
        <Table.Root table={table}>
          <Table.Header>
            {(column) => <Table.ColumnHeader column={column}>{column.title}</Table.ColumnHeader>}
          </Table.Header>
          <Table.Body>
            {(row) => (
              <Table.Row row={row}>
                {(column) => (
                  <Table.Cell column={column}>{String(column.getValue(row))}</Table.Cell>
                )}
              </Table.Row>
            )}
          </Table.Body>
          <Table.Gutter>
            {table.pages?.loadingMore
              ? "loading more"
              : table.pages?.hasMore
                ? null
                : `all ${table.pages?.total ?? 0}`}
          </Table.Gutter>
          <Table.Loading>loading</Table.Loading>
          <Table.Empty>no surveys</Table.Empty>
        </Table.Root>
      );
    },
  );

  test("loads, fills the viewport, and reports the end in the gutter", async () => {
    const feed = lazyPages(api(30), { pageSize: 10 });
    const { container } = await mount(<SurveyTable feed={feed} />);
    await settle();

    // three pages of ten: the fetch-ahead kept going until the 10-row window was satisfied, and
    // then until the source ran out
    expect(feed.pages).toBe(3);
    expect(feed.hasMore).toBe(false);
    expect(container.querySelector("[data-table-gutter]")?.textContent).toBe("all 30");
    expect(container.textContent).not.toContain("no surveys");
    expect(container.textContent).not.toContain("loading more");
  });

  test("the gutter sits after the rows in the scroll flow, not over them", async () => {
    const feed = lazyPages(api(15), { pageSize: 10 });
    const { container } = await mount(<SurveyTable feed={feed} />);
    await settle();

    const scroller = container.querySelector('[role="table"]')!;
    const gutter = container.querySelector("[data-table-gutter]") as HTMLElement;
    const body = scroller.querySelector('[role="rowgroup"]')!;

    // a following sibling of the body's flow box, so it lands below the reserved virtual height
    expect(gutter.parentElement).toBe(scroller);
    const children = [...scroller.children];
    const bodyBox = children.find((el) => el.contains(body))!;
    expect(children.indexOf(bodyBox)).toBeLessThan(children.indexOf(gutter));
    // not an overlay: it claims one row's height rather than the viewport's
    expect(gutter.style.height).toBe("40px");

    // sticky on the horizontal axis only — pinned against column scrolling, but scrolling
    // vertically with the content rather than hovering at the bottom of the viewport
    expect(gutter.style.position).toBe("sticky");
    expect(gutter.style.left).toBe("0px");
    expect(gutter.style.top).toBe("");
    expect(gutter.style.bottom).toBe("");
    expect(gutter.style.width).toBe("var(--table-viewport-width)");
  });

  test("the status bar is sticky on both axes and paints above the rows", async () => {
    const feed = lazyPages(api(30), { pageSize: 10 });

    const WithBar = observer(() => {
      const table = useTable<Survey>({ data: feed, columns });
      table.setWidth(600);
      table.setHeight(400);
      return (
        <Table.Root table={table}>
          <Table.Body>{(row) => <Table.Row row={row}>{() => null}</Table.Row>}</Table.Body>
          <Table.Gutter>{table.pages?.loadingMore ? "more…" : "end"}</Table.Gutter>
          <Table.StatusBar height={28}>
            Showing {table.rows.length} of {table.pages?.total}
          </Table.StatusBar>
        </Table.Root>
      );
    });

    const { container } = await mount(<WithBar />);
    await settle();

    const bar = container.querySelector("[data-table-status-bar]") as HTMLElement;
    expect(bar.style.position).toBe("sticky");
    expect(bar.style.left).toBe("0px");
    expect(bar.style.bottom).toBe("0px");
    expect(bar.style.zIndex).toBe("20");
    expect(bar.style.height).toBe("28px");
    expect(bar.style.width).toBe("var(--table-viewport-width)");
    expect(bar.textContent).toBe("Showing 30 of 30");

    // both together is the normal pairing, and the bar comes last so it paints over the rows it
    // overlays while displaced
    const scroller = container.querySelector('[role="table"]')!;
    const gutter = container.querySelector("[data-table-gutter]")!;
    const children = [...scroller.children];
    expect(children.indexOf(gutter)).toBeLessThan(children.indexOf(bar));
    expect(bar.parentElement).toBe(scroller);
  });

  test("maxHeight caps the viewport, so the measured height stays consistent", async () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({
      id: i,
      title: `s${i}`,
      status: "draft",
    }));
    let table!: TableModel;

    const Capped = observer(() => {
      table = useTable<Survey>({ data: rows, columns, rowHeight: 40, rowOverscan: 0 });
      return (
        <Table.Root table={table} maxHeight={300}>
          <Table.Body>{(row) => <Table.Row row={row}>{() => null}</Table.Row>}</Table.Body>
        </Table.Root>
      );
    });

    const { container } = await mount(<Capped />);

    const viewport = container.querySelector(".table-viewport") as HTMLElement;
    const scroller = container.querySelector('[role="table"]') as HTMLElement;

    // the cap lands on the viewport — the box that gets measured — so `table.height` picks it up
    // through the ordinary ResizeObserver path and everything derived from it follows
    expect(viewport.style.maxHeight).toBe("300px");
    // and *not* on the scroll container, which is where `style={{ maxHeight }}` goes: that leaves
    // `table.height` reporting the uncapped height, so the render window, the fetch-ahead
    // threshold and the overlay's size are all computed for a viewport three times too tall
    expect(scroller.style.maxHeight).not.toBe("300px");
    expect(scroller.style.maxHeight).toBe(`${table.height}px`);

    // what the trap looks like, for contrast
    const { container: trap } = await mount(
      <Table.Root table={table} style={{ maxHeight: 300 }}>
        <Table.Body>{(row) => <Table.Row row={row}>{() => null}</Table.Row>}</Table.Body>
      </Table.Root>,
    );
    const trapped = trap.querySelector('[role="table"]') as HTMLElement;
    expect(trapped.style.maxHeight).toBe("300px");
    expect((trap.querySelector(".table-viewport") as HTMLElement).style.maxHeight).toBe("");
  });

  test("the gutter's own style overrides the positioning it ships with", async () => {
    const feed = lazyPages(api(15), { pageSize: 10 });

    const Pinned = observer(() => {
      const table = useTable<Survey>({ data: feed, columns });
      table.setWidth(600);
      table.setHeight(400);
      return (
        <Table.Root table={table}>
          <Table.Body>{(row) => <Table.Row row={row}>{() => null}</Table.Row>}</Table.Body>
          <Table.Gutter style={{ bottom: 0, height: 24 }}>x</Table.Gutter>
        </Table.Root>
      );
    });

    const { container } = await mount(<Pinned />);
    await settle();

    const gutter = container.querySelector("[data-table-gutter]") as HTMLElement;
    expect(gutter.style.bottom).toBe("0px");
    expect(gutter.style.height).toBe("24px");
  });

  test("a filter change requeries from page one with no consumer wiring", async () => {
    const fetch = api(30);
    const feed = lazyPages(fetch, { pageSize: 10 });
    let table!: TableModel;
    await mount(<SurveyTable feed={feed} onTable={(t) => (table = t)} />);
    await settle();

    expect(feed.pages).toBe(3);
    const filter = table.column("status")?.filter as SetFilter;

    // exactly what a header popover does. No reaction, no reset, no cursor on the consumer's part.
    filter.toggle("live");
    await settle();

    expect(fetch.mock.calls.at(-1)![0].query.filters).toEqual([
      { field: "status", op: "in", value: ["live"] },
    ]);
    // page one of the new query, not the page after rows belonging to the old one
    expect(
      fetch.mock.calls.some((c) => c[0].query.filters !== undefined && c[0].cursor === undefined),
    ).toBe(true);
    expect(table.rows.every((r) => r.status === "live")).toBe(true);
    expect(table.rows.length).toBe(30);
  });

  test("a sort goes to the server rather than reordering the rows here", async () => {
    const fetch = api(30);
    const feed = lazyPages(fetch, { pageSize: 10 });
    let table!: TableModel;
    await mount(<SurveyTable feed={feed} onTable={(t) => (table = t)} />);
    await settle();

    expect(table.sortMode).toBe("manual");

    table.setSort("title", "desc");
    await settle();

    expect(fetch.mock.calls.at(-1)![0].query.sorts).toEqual([{ key: "title", direction: "desc" }]);
    // the table did not reorder what it holds: the server's order is the order, and `s10` sorting
    // before `s2` as text is exactly what a client-side sort would have produced instead
    expect(table.displayRows.slice(0, 3).map((r) => r.title)).toEqual(["s0", "s1", "s2"]);
  });

  test("the first page goes out with filters a restored snapshot already applied", async () => {
    const fetch = api(30);
    const feed = lazyPages(fetch, { pageSize: 10 });

    const Restored = observer(() => {
      const table = useTable<Survey>({ data: feed, columns });
      table.setWidth(600);
      table.setHeight(400);
      // applied during the first render, before any request could have gone out
      table.applyState({ columnFilters: { status: { selected: ["live"], matchMode: "any" } } });
      return (
        <Table.Root table={table}>
          <Table.Body>{(row) => <Table.Row row={row}>{() => null}</Table.Row>}</Table.Body>
        </Table.Root>
      );
    });

    await mount(<Restored />);
    await settle();

    // the request the user actually waits on carried the conditions rather than going out bare
    expect(fetch.mock.calls[0]![0].query.filters).toEqual([
      { field: "status", op: "in", value: ["live"] },
    ]);
  });
});
