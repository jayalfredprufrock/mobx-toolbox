import { describe, expect, test, vi } from "vite-plus/test";
import * as T from "typebox";
import { LOADED_AT, makeModel } from "./make-model";
import { createStore } from "./make-store";

const PanelSchema = T.Object({
  id: T.Number(),
  name: T.String(),
  updatedAt: T.String(),
});

type Panel = T.Static<typeof PanelSchema>;

const panel = (name: string, updatedAt: string): Panel => ({ id: 1, name, updatedAt });

const T1 = "2026-11-23T10:00:00.000Z";
const T2 = "2026-11-23T10:05:00.000Z";

describe("versionKey", () => {
  test("instantiate skips a payload older than the instance", () => {
    const Model = makeModel(PanelSchema, { keys: ["id"] as const, versionKey: "updatedAt" });
    const current = Model.instantiate(panel("Renamed", T2));

    const result = Model.instantiate(panel("Old name", T1));

    expect(result).toBe(current);
    expect(current.name).toBe("Renamed");
  });

  test("an equal version still applies, as without versionKey", () => {
    const Model = makeModel(PanelSchema, { keys: ["id"] as const, versionKey: "updatedAt" });
    const current = Model.instantiate(panel("A", T1));
    Model.instantiate(panel("B", T1));
    expect(current.name).toBe("B");
  });

  test("a newer version applies", () => {
    const Model = makeModel(PanelSchema, { keys: ["id"] as const, versionKey: "updatedAt" });
    const current = Model.instantiate(panel("A", T1));
    Model.instantiate(panel("B", T2));
    expect(current.name).toBe("B");
  });

  test("a missing version on either side applies", () => {
    const Schema = T.Object({ id: T.Number(), name: T.String(), v: T.Optional(T.Number()) });
    const Model = makeModel(Schema, { keys: ["id"] as const, versionKey: "v" });
    const current = Model.instantiate({ id: 1, name: "A", v: 2 });

    Model.instantiate({ id: 1, name: "B" });
    expect(current.name).toBe("B");

    Model.instantiate({ id: 1, name: "C", v: 1 });
    expect(current.name).toBe("C");
  });

  test("numbers compare numerically", () => {
    const Schema = T.Object({ id: T.Number(), name: T.String(), v: T.Number() });
    const Model = makeModel(Schema, { keys: ["id"] as const, versionKey: "v" });
    const current = Model.instantiate({ id: 1, name: "A", v: 10 });
    Model.instantiate({ id: 1, name: "B", v: 9 });
    expect(current.name).toBe("A");
  });

  test("a skipped payload leaves the load stamp alone", () => {
    const Model = makeModel(PanelSchema, { keys: ["id"] as const, versionKey: "updatedAt" });
    const current = Model.instantiate(panel("A", T2));
    (current as any)[LOADED_AT] = 123;

    Model.instantiate(panel("Old", T1));
    expect((current as any)[LOADED_AT]).toBe(123);
  });

  test("without versionKey, the last payload wins as before", () => {
    const Model = makeModel(PanelSchema, { keys: ["id"] as const });
    const current = Model.instantiate(panel("Renamed", T2));
    Model.instantiate(panel("Old name", T1));
    expect(current.name).toBe("Old name");
    expect(Model.versionOf(current)).toBeUndefined();
  });

  test("versionOf reads the versionKey field off a payload or a model", () => {
    const Model = makeModel(PanelSchema, { keys: ["id"] as const, versionKey: "updatedAt" });
    expect(Model.versionOf(panel("A", T1))).toBe(T1);
    expect(Model.versionOf(Model.instantiate(panel("A", T2)))).toBe(T2);
  });

  test("a subclass can override versionOf to compute the version", () => {
    const Model = makeModel(PanelSchema, { keys: ["id"] as const });
    class Parsed extends Model {
      static override versionOf(source: { updatedAt: string }) {
        return Date.parse(source.updatedAt);
      }
    }
    const current = Parsed.instantiate(panel("A", "2026-11-23T10:05:00Z"));
    // same instant as T1 would be older; offset form, which string comparison gets wrong
    Parsed.instantiate(panel("Old", "2026-11-23T11:00:00+02:00"));
    expect(current.name).toBe("A");
  });

  test("a versionKey that is not a schema field throws when the class is built", () => {
    expect(() =>
      // @ts-expect-error — only schema fields are accepted
      makeModel(PanelSchema, { keys: ["id"] as const, versionKey: "nope" }),
    ).toThrow(/versionKey names "nope"/);
  });

  test("reload skips a late response older than the instance", async () => {
    let respond!: (data: Panel) => void;
    const Model = makeModel(PanelSchema, {
      keys: ["id"] as const,
      versionKey: "updatedAt",
      get: () => new Promise<Panel>((resolve) => (respond = resolve)),
      update: async (_params: { id: number }, body: { name: string }) => panel(body.name, T2),
    });
    const current = Model.instantiate(panel("A", T1));

    const pending = current.reload();
    await current.update({ name: "Renamed" });
    respond(panel("A", T1));
    await pending;

    expect(current.name).toBe("Renamed");
  });

  test("custom actions skip an older response but still notify", async () => {
    const Model = makeModel(PanelSchema, {
      keys: ["id"] as const,
      versionKey: "updatedAt",
      actions: { touch: async () => panel("Old", T1) },
    });
    const onModelEvent = vi.fn();
    const current = Model.instantiate(panel("Current", T2));
    Model.addListener({ onModelEvent });

    await current.touch();

    expect(current.name).toBe("Current");
    expect(onModelEvent).toHaveBeenCalledWith("updated", current);
  });

  test("setData and updateData are not guarded", () => {
    const Model = makeModel(PanelSchema, { keys: ["id"] as const, versionKey: "updatedAt" });
    const current = Model.instantiate(panel("A", T2));

    current.setData(panel("Explicit", T1));
    expect(current.name).toBe("Explicit");

    current.updateData({ name: "Local", updatedAt: T1 });
    expect(current.name).toBe("Local");
  });

  test("a store collection reload keeps the newer instance's fields", async () => {
    const Model = makeModel(PanelSchema, { keys: ["id"] as const, versionKey: "updatedAt" });
    const store = createStore(Model, { collections: { all: async () => [panel("Stale", T1)] } });
    const current = Model.instantiate(panel("Fresh", T2));

    await store.all.getOrLoad();

    expect(store.all.value?.[0]).toBe(current);
    expect(current.name).toBe("Fresh");
  });
});
