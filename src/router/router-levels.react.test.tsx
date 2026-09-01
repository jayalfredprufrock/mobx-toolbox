// @vitest-environment happy-dom
import { createMemoryHistory } from "history";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { Router } from "./components/router";
import { makeRoutes } from "./make-routes";
import { RouterStore } from "./router.store";
import { LOAD, LOADING, PAGE, WRAPPER } from "./symbols";
import type { LoadingProps, PageProps, WrapperProps } from "./types";

const containers: HTMLElement[] = [];

afterEach(() => {
  for (const c of containers.splice(0)) c.remove();
});

const mount = async (routes: any, initialPath: string) => {
  const history = createMemoryHistory({ initialEntries: [initialPath] });
  const router = new RouterStore({ history });
  // not awaited: one test mounts a [LOAD] that never resolves, and the
  // cold-load [LOADING] state is the subject there
  void router.initialize(routes);

  const container = document.createElement("div");
  document.body.appendChild(container);
  containers.push(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Router store={router} />);
  });

  return { router, container };
};

// Each level reports its own pattern — the thing a breadcrumb needs and
// that a wrapper previously had to hardcode.
const Scope = ({ level, children }: WrapperProps) => (
  <div>
    <span data-level={level.index}>{level.pattern ?? "(not navigable)"}</span>
    {children}
  </div>
);

const patterns = (container: HTMLElement) =>
  [...container.querySelectorAll("span")].map((el) => el.textContent);

describe("route levels reach the components that render at them", () => {
  test("[WRAPPER]s and the page each receive their own level", async () => {
    const Page = ({ level }: PageProps) => <span>{level.pattern}</span>;
    const routes = makeRoutes()({
      [WRAPPER]: Scope,
      index: Page,
      org: {
        // no index — this level addresses no page of its own
        [WRAPPER]: Scope,
        $orgId: {
          [WRAPPER]: Scope,
          index: Page,
          surveys: { index: Page },
        },
      },
    });

    const { container } = await mount(routes, "/org/7/surveys");
    expect(patterns(container)).toEqual([
      "/",
      "(not navigable)",
      "/org/:orgId",
      "/org/:orgId/surveys",
    ]);
  });

  test("the pattern a wrapper reports is the one it can navigate to", async () => {
    const Page = () => null;
    let seen: string | undefined;
    const Capture = ({ level, children }: WrapperProps) => {
      seen = level.pattern;
      return children;
    };
    const routes = makeRoutes()({
      index: Page,
      org: { $orgId: { [WRAPPER]: Capture, index: Page } },
    });

    const { router } = await mount(routes, "/org/7");
    expect(seen).toBe("/org/:orgId");

    await act(async () => {
      await router.navigate({ to: seen as any, params: { orgId: "9" } } as any);
    });
    expect(router.activeRoute?.params).toEqual({ orgId: "9" });
  });

  test("a [LOADING] component receives the level of the slot it fills", async () => {
    let seen: string | undefined;
    const Skeleton = ({ level }: LoadingProps) => {
      seen = level.pattern;
      return <span>SKELETON</span>;
    };
    const routes = makeRoutes()({
      [LOADING]: Skeleton,
      reports: {
        index: {
          [LOAD]: () => new Promise(() => {}), // never resolves — holds the slot
          [PAGE]: () => <span>REPORTS</span>,
        },
      },
    });

    const { container } = await mount(routes, "/reports");
    // past the debounce, the [LOADING] component is on screen
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });

    expect(container.textContent).toBe("SKELETON");
    expect(seen).toBe("/reports");
  });

  test("a group's [WRAPPER] renders in the chain for its children only", async () => {
    const Chrome = ({ children }: WrapperProps) => (
      <div>
        <span>CHROME</span>
        {children}
      </div>
    );
    const routes = makeRoutes()({
      surveys: {
        _list: {
          [WRAPPER]: Chrome,
          published: () => <span>PUBLISHED</span>,
        },
        $surveyId: { index: () => <span>DETAIL</span> },
      },
    });

    const { router, container } = await mount(routes, "/surveys/published");
    expect(container.textContent).toBe("CHROMEPUBLISHED");

    // the sibling outside the group renders without the chrome, with no
    // render-time conditional inside the wrapper to make it so
    await act(async () => {
      await router.navigate({ to: "/surveys/:surveyId", params: { surveyId: "42" } });
    });
    expect(container.textContent).toBe("DETAIL");
  });
});
