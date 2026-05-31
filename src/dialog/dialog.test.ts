import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { autorun, runInAction } from "mobx";
import { DialogModel } from "./dialog.model";
import { DialogStore } from "./dialog.store";

const MockComponent = () => null;

// Stub document and HTMLElement — DialogModel.setState accesses both
// when transitioning to "opening" / "closed".
beforeEach(() => {
  vi.stubGlobal("document", { activeElement: null });
  vi.stubGlobal(
    "HTMLElement",
    class MockHTMLElement {
      focus() {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// DialogModel
// ---------------------------------------------------------------------------

describe("DialogModel", () => {
  let store: DialogStore;

  beforeEach(() => {
    store = new DialogStore();
  });

  test("initializes with closed state by default", () => {
    const dialog = store.add({ component: MockComponent });
    expect(dialog.state).toBe("closed");
  });

  test("respects custom initialState", () => {
    const dialog = store.add({ component: MockComponent, initialState: "opened" });
    expect(dialog.state).toBe("opened");
  });

  test("uses provided id", () => {
    const dialog = store.add({ component: MockComponent, id: "my-dialog" });
    expect(dialog.id).toBe("my-dialog");
  });

  test("auto-generates an id when none is provided", () => {
    const dialog = store.add({ component: MockComponent });
    expect(typeof dialog.id).toBe("string");
    expect(dialog.id.length).toBeGreaterThan(0);
  });

  test("open() transitions to opening", () => {
    const dialog = store.add({ component: MockComponent });
    dialog.open();
    expect(dialog.state).toBe("opening");
  });

  test("open(true) transitions directly to opened", () => {
    const dialog = store.add({ component: MockComponent });
    dialog.open(true);
    expect(dialog.state).toBe("opened");
  });

  test("open() sets openedAt", () => {
    const before = Date.now();
    const dialog = store.add({ component: MockComponent });
    dialog.open();
    expect(dialog.openedAt).toBeGreaterThanOrEqual(before);
  });

  test("close() transitions to closing", () => {
    const dialog = store.add({ component: MockComponent, initialState: "opened" });
    dialog.close();
    expect(dialog.state).toBe("closing");
  });

  test("close(true) transitions directly to closed", () => {
    const dialog = store.add({ component: MockComponent, initialState: "opened" });
    dialog.close(true);
    expect(dialog.state).toBe("closed");
  });

  test("setState is a no-op when transitioning to the current state", () => {
    const dialog = store.add({ component: MockComponent }); // starts "closed"
    dialog.setState("closed"); // same state — no change
    expect(dialog.state).toBe("closed");
  });

  test("removeOnClosed removes dialog from store when closed", () => {
    const dialog = store.add({
      component: MockComponent,
      removeOnClosed: true,
      initialState: "opened",
    });
    expect(store.dialogs.has(dialog.id)).toBe(true);
    dialog.close(true);
    expect(store.dialogs.has(dialog.id)).toBe(false);
  });

  test("removeOnClosed=false keeps dialog in store after close", () => {
    const dialog = store.add({
      component: MockComponent,
      removeOnClosed: false,
      initialState: "opened",
    });
    dialog.close(true);
    expect(store.dialogs.has(dialog.id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DialogStore
// ---------------------------------------------------------------------------

describe("DialogStore", () => {
  let store: DialogStore;

  beforeEach(() => {
    store = new DialogStore();
  });

  test("add() registers dialog in dialogs map", () => {
    const dialog = store.add({ component: MockComponent });
    expect(store.dialogs.has(dialog.id)).toBe(true);
  });

  test("add() sets component reference", () => {
    const dialog = store.add({ component: MockComponent });
    expect(dialog.component).toBe(MockComponent);
  });

  test("open() creates dialog in opening state with removeOnClosed=true", () => {
    const dialog = store.open(MockComponent);
    expect(dialog.state).toBe("opening");
    expect(dialog.config.removeOnClosed).toBe(true);
  });

  test("openDialogs excludes closed dialogs", () => {
    const open = store.add({ component: MockComponent, initialState: "opened" });
    const closed = store.add({ component: MockComponent }); // "closed" by default
    expect(store.openDialogs).toContain(open);
    expect(store.openDialogs).not.toContain(closed);
  });

  test("openDialogs includes dialogs in opening and closing states", () => {
    const opening = store.add({ component: MockComponent, initialState: "opening" });
    const closing = store.add({ component: MockComponent, initialState: "closing" });
    expect(store.openDialogs).toContain(opening);
    expect(store.openDialogs).toContain(closing);
  });

  test("openDialogs sorts by openedAt ascending", () => {
    const d1 = store.add({ component: MockComponent, initialState: "opened" });
    const d2 = store.add({ component: MockComponent, initialState: "opened" });

    runInAction(() => {
      d1.openedAt = 100;
      d2.openedAt = 200;
    });

    expect(store.openDialogs[0]).toBe(d1);
    expect(store.openDialogs[1]).toBe(d2);
  });

  test("activeDialog is the last-opened (highest openedAt) dialog", () => {
    const d1 = store.add({ component: MockComponent, initialState: "opened" });
    const d2 = store.add({ component: MockComponent, initialState: "opened" });

    runInAction(() => {
      d1.openedAt = 100;
      d2.openedAt = 200;
    });

    expect(store.activeDialog).toBe(d2);
  });

  test("activeDialog is undefined when no open dialogs", () => {
    store.add({ component: MockComponent }); // "closed"
    expect(store.activeDialog).toBeUndefined();
  });

  test("close() closes the active dialog", () => {
    const dialog = store.add({ component: MockComponent, initialState: "opened" });
    store.close(true);
    expect(dialog.state).toBe("closed");
  });

  test("close() is a no-op when there is no active dialog", () => {
    expect(() => store.close()).not.toThrow();
  });

  test("openDialogs is reactive", () => {
    const dialog = store.add({ component: MockComponent });
    const lengths: number[] = [];
    const dispose = autorun(() => lengths.push(store.openDialogs.length));

    dialog.open(true);

    dispose();
    expect(lengths).toEqual([0, 1]);
  });

  test("activeDialog is reactive", () => {
    const dialog = store.add({ component: MockComponent });
    const values: (DialogModel | undefined)[] = [];
    const dispose = autorun(() => values.push(store.activeDialog));

    dialog.open(true);
    dialog.close(true);

    dispose();
    expect(values[0]).toBeUndefined();
    expect(values[1]).toBe(dialog);
    expect(values[2]).toBeUndefined();
  });
});
