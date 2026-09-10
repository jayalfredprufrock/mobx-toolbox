// @vitest-environment happy-dom
import { createBrowserHistory, createMemoryHistory } from "history";
import { observable, runInAction } from "mobx";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { routerContext } from "./components/router";
import { makeRoutes } from "./make-routes";
import { RouterStore } from "./router.store";
import { REDIRECT } from "./symbols";
import type { BlockedNavigation, NavigationBlocker } from "./types";
import { useConfirmLeave } from "./use-confirm-leave";
import { useNavigationBlock } from "./use-navigation-block";

const PageA = () => null;

const routes = makeRoutes()({
  index: PageA,
  about: PageA,
  users: { index: PageA },
  old: { [REDIRECT]: "/about" },
});

const DEFAULT_CONFIRM = "Leave this page? Changes you have made may not be saved.";

const containers: HTMLElement[] = [];
const roots: ReturnType<typeof createRoot>[] = [];
let confirmed: boolean;
let confirmCalls: string[];

beforeEach(() => {
  confirmed = true;
  confirmCalls = [];
  window.confirm = (message?: string) => {
    confirmCalls.push(message ?? "");
    return confirmed;
  };
});

afterEach(async () => {
  // unmounted rather than just detached: a still-mounted blocker keeps its
  // `beforeunload` listener on the shared window and bleeds into the next test
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  for (const c of containers.splice(0)) c.remove();
  vi.restoreAllMocks();
});

const mount = async (
  render: () => React.ReactNode,
  {
    entries = ["/"],
    index,
    browser,
  }: { entries?: string[]; index?: number; browser?: boolean } = {},
) => {
  // `beforeunload` is history's own listener now, and only browser history
  // installs one — memory history has no window to prompt in
  const history = browser
    ? createBrowserHistory()
    : createMemoryHistory({ initialEntries: entries, initialIndex: index });
  const router = new RouterStore({ history });
  await router.initialize(routes as any);

  const container = document.createElement("div");
  document.body.appendChild(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);

  const draw = async () => {
    await act(async () => {
      root.render(<routerContext.Provider value={router}>{render()}</routerContext.Provider>);
    });
  };
  await draw();

  return {
    router,
    history,
    rerender: draw,
    unmount: async () => {
      await act(async () => root.unmount());
      roots.splice(roots.indexOf(root), 1);
    },
  };
};

const go = (router: RouterStore, to: string) => router.navigate({ to: to as any });

const beforeUnload = (): boolean => {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

describe("useNavigationBlock", () => {
  const Designer: React.FC<{ when: () => boolean; onLeave: NavigationBlocker }> = ({
    when,
    onLeave,
  }) => {
    useNavigationBlock(when, onLeave);
    return null;
  };

  test("blocks while the predicate holds, and stops when it drops", async () => {
    const dirty = observable.box(true);
    const onLeave = vi.fn(() => false);
    const { router } = await mount(() => <Designer when={() => dirty.get()} onLeave={onLeave} />);

    await expect(go(router, "/about")).resolves.toBe(false);
    expect(onLeave).toHaveBeenCalledTimes(1);

    runInAction(() => dirty.set(false));

    await expect(go(router, "/about")).resolves.toBe(true);
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  test("reads the latest handler without re-registering", async () => {
    const block = vi.spyOn(RouterStore.prototype, "block");
    let onLeave: NavigationBlocker = () => false;
    const { router, rerender } = await mount(() => (
      <Designer when={() => true} onLeave={onLeave} />
    ));

    await expect(go(router, "/about")).resolves.toBe(false);

    onLeave = () => true;
    await rerender();
    await rerender();

    await expect(go(router, "/about")).resolves.toBe(true);
    expect(block).toHaveBeenCalledTimes(1);
  });

  test("stops blocking on unmount", async () => {
    const { router, unmount } = await mount(() => (
      <Designer when={() => true} onLeave={() => false} />
    ));

    await expect(go(router, "/about")).resolves.toBe(false);

    await unmount();

    await expect(go(router, "/about")).resolves.toBe(true);
  });

  test("prompts on tab close only while the predicate holds", async () => {
    const dirty = observable.box(false);
    await mount(() => <Designer when={() => dirty.get()} onLeave={() => false} />, {
      browser: true,
    });

    // an untouched form gets no "Leave site?" — that is what registration
    // following the predicate buys, since history's own handler cannot ask
    expect(beforeUnload()).toBe(false);

    runInAction(() => dirty.set(true));
    expect(beforeUnload()).toBe(true);

    runInAction(() => dirty.set(false));
    expect(beforeUnload()).toBe(false);
  });

  test("removes the beforeunload listener on unmount", async () => {
    const { unmount } = await mount(() => <Designer when={() => true} onLeave={() => false} />, {
      browser: true,
    });
    expect(beforeUnload()).toBe(true);

    await unmount();
    expect(beforeUnload()).toBe(false);
  });

  test("a predicate MobX cannot see still blocks in-app navigation, but not a pop", async () => {
    // the documented wart of registration-by-reaction: `navigate` reads the
    // predicate at decision time and is unaffected, while the pop and
    // beforeunload halves depend on the reaction seeing it change
    let dirty = false;
    const onLeave = vi.fn(() => false);
    const { router, history } = await mount(
      () => <Designer when={() => dirty} onLeave={onLeave} />,
      { entries: ["/", "/about"], index: 1 },
    );

    dirty = true;

    await expect(go(router, "/users")).resolves.toBe(false);
    expect(onLeave).toHaveBeenCalledTimes(1);

    await act(async () => history.back());
    await vi.waitFor(() => expect(router.activeRoute?.path).toBe(""));
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  describe("the back button", () => {
    const popRouter = async (onLeave: NavigationBlocker, entries = ["/", "/about"], index = 1) =>
      mount(() => <Designer when={() => true} onLeave={onLeave} />, { entries, index });

    test("blocks a pop, and describes it as one", async () => {
      const seen: BlockedNavigation[] = [];
      const { router, history } = await popRouter((navigation) => {
        seen.push(navigation);
        return false;
      });

      await act(async () => history.back());

      expect(seen).toEqual([{ action: "POP", pathname: "/", search: "", href: "/" }]);
      expect(router.location.pathname).toBe("/about");
      expect(router.activeRoute?.path).toBe("about");
    });

    test("lets a consented pop land", async () => {
      const { router, history } = await popRouter(() => true);

      await act(async () => history.back());

      await vi.waitFor(() => expect(router.activeRoute?.path).toBe(""));
      expect(router.location.pathname).toBe("/");
    });

    test("re-arms after a pop it let through", async () => {
      let allow = true;
      const onLeave = vi.fn(() => allow);
      const { router, history } = await popRouter(onLeave, ["/", "/about", "/users"], 2);

      await act(async () => history.back());
      await vi.waitFor(() => expect(router.activeRoute?.path).toBe("about"));

      // the blocker stood down to let the retried pop land; a second back
      // must still be caught
      allow = false;
      await act(async () => history.back());
      expect(onLeave).toHaveBeenCalledTimes(2);
      expect(router.location.pathname).toBe("/about");
    });

    test("ignores a pop that keeps the same pathname", async () => {
      const onLeave = vi.fn(() => false);
      const { router, history } = await popRouter(onLeave, ["/users", "/users?tab=all"], 1);
      expect(router.location.search).toBe("?tab=all");

      await act(async () => history.back());

      await vi.waitFor(() => expect(router.location.search).toBe(""));
      expect(onLeave).not.toHaveBeenCalled();
    });

    test("asks about one pop at a time", async () => {
      const decisions: Array<(allow: boolean) => void> = [];
      const { router, history } = await popRouter(
        () => new Promise<boolean>((resolve) => decisions.push(resolve)),
      );

      await act(async () => history.back());
      expect(decisions).toHaveLength(1);

      // pressing back again while the dialog is open must not open a second
      await act(async () => history.back());
      expect(decisions).toHaveLength(1);

      await act(async () => decisions[0]?.(true));
      await vi.waitFor(() => expect(router.activeRoute?.path).toBe(""));
    });

    test("drops the retry when something else navigated while it was deciding", async () => {
      const decisions: Array<(allow: boolean) => void> = [];
      const { router, history } = await popRouter(({ action }) =>
        action === "POP" ? new Promise<boolean>((resolve) => decisions.push(resolve)) : true,
      );

      await act(async () => history.back());
      expect(decisions).toHaveLength(1);

      // approved and landed while the pop's dialog is still open, which
      // leaves the pop's `go(delta)` addressing an entry the user did not ask for
      await expect(go(router, "/users")).resolves.toBe(true);

      await act(async () => decisions[0]?.(true));

      expect(router.location.pathname).toBe("/users");
      expect(router.activeRoute?.path).toBe("users");
    });
  });
});

describe("both hooks on one page", () => {
  const Designer: React.FC = () => {
    useNavigationBlock(
      () => true,
      () => {
        confirmCalls.push("custom");
        return true;
      },
    );
    useConfirmLeave();
    return null;
  };

  test("asks both about a push, in registration order", async () => {
    const { router } = await mount(() => <Designer />);

    await expect(go(router, "/about")).resolves.toBe(true);

    // legal, and rarely what you want: the custom dialog is answered and
    // then the native one asks again
    expect(confirmCalls).toEqual(["custom", DEFAULT_CONFIRM]);
  });

  test("asks both about a pop too", async () => {
    const { router, history } = await mount(() => <Designer />, {
      entries: ["/", "/about"],
      index: 1,
    });

    await act(async () => history.back());
    await vi.waitFor(() => expect(router.activeRoute?.path).toBe(""));

    // the back button reaches blockers by the same path a link does, so the
    // custom handler gets its say — and its chance to save — here as well
    expect(confirmCalls).toEqual(["custom", DEFAULT_CONFIRM]);
  });
});

describe("useConfirmLeave", () => {
  const Form: React.FC<{ message?: string }> = ({ message }) => {
    useConfirmLeave(message);
    return null;
  };

  test("confirms a link or programmatic navigation", async () => {
    const { router } = await mount(() => <Form message="Discard?" />);

    confirmed = false;
    await expect(go(router, "/about")).resolves.toBe(false);
    expect(router.location.pathname).toBe("/");
    expect(confirmCalls).toEqual(["Discard?"]);

    confirmed = true;
    await expect(go(router, "/about")).resolves.toBe(true);
    expect(router.activeRoute?.path).toBe("about");

    // asked once, not twice: the transition `navigate` approved reaches
    // `history.block` and is retried without a second prompt
    expect(confirmCalls).toEqual(["Discard?", "Discard?"]);
  });

  test("asks once for a navigation that redirects", async () => {
    const { router } = await mount(() => <Form />);

    await expect(go(router, "/old")).resolves.toBe(true);
    await vi.waitFor(() => expect(router.activeRoute?.path).toBe("about"));

    // the user's own hop was asked about; the [REDIRECT] hop it turned into
    // is the app's decision and passes through the history guard silently
    expect(confirmCalls).toHaveLength(1);
  });

  test("confirms the back button", async () => {
    const { router, history } = await mount(() => <Form />, {
      entries: ["/", "/about"],
      index: 1,
    });
    expect(router.activeRoute?.path).toBe("about");

    confirmed = false;
    await act(async () => history.back());
    expect(confirmCalls).toHaveLength(1);
    expect(router.location.pathname).toBe("/about");

    confirmed = true;
    await act(async () => history.back());
    await vi.waitFor(() => expect(router.activeRoute?.path).toBe(""));
  });

  test("re-arms after a pop it let through", async () => {
    const { router, history } = await mount(() => <Form />, {
      entries: ["/", "/about", "/users"],
      index: 2,
    });

    await act(async () => history.back());
    await vi.waitFor(() => expect(router.activeRoute?.path).toBe("about"));
    expect(confirmCalls).toHaveLength(1);

    // the guard stood down to let the retried pop land; a second back must
    // still be caught
    confirmed = false;
    await act(async () => history.back());
    expect(confirmCalls).toHaveLength(2);
    expect(router.location.pathname).toBe("/about");
  });

  test("prompts on tab close", async () => {
    await mount(() => <Form />, { browser: true });
    expect(beforeUnload()).toBe(true);
  });

  test("says nothing about the router's own bookkeeping", async () => {
    const { router } = await mount(() => <Form />, { entries: ["/users"] });

    router.setQueryParam("tab", "all");
    expect(router.query.tab).toBe("all");

    await expect(router.navigate({ to: "/users" as any, search: { tab: "open" } })).resolves.toBe(
      true,
    );
    expect(confirmCalls).toEqual([]);
  });

  test("stops confirming on unmount", async () => {
    const { router, history, unmount } = await mount(() => <Form />, {
      entries: ["/", "/about"],
      index: 1,
    });

    await unmount();
    confirmed = false;

    await expect(go(router, "/users")).resolves.toBe(true);
    await act(async () => history.back());
    await vi.waitFor(() => expect(router.location.pathname).toBe("/about"));
    expect(confirmCalls).toEqual([]);
    expect(beforeUnload()).toBe(false);
  });
});
