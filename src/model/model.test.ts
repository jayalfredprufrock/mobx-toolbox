import { describe, expect, test, vi } from "vite-plus/test";
import * as T from "typebox";
import { autorun, runInAction } from "mobx";
import { makeModel, makeUnionModel } from "./make-model";
import { makeStore } from "./make-store";

// ---------------------------------------------------------------------------
// Shared schema
// ---------------------------------------------------------------------------

const UserSchema = T.Object({
  id: T.Number(),
  name: T.String(),
  email: T.String(),
});

// ---------------------------------------------------------------------------
// makeModel
// ---------------------------------------------------------------------------

describe("makeModel", () => {
  test("constructor sets schema properties", () => {
    const UserModel = makeModel(UserSchema);
    const user = new UserModel({ id: 1, name: "Alice", email: "alice@example.com" });
    expect(user.id).toBe(1);
    expect(user.name).toBe("Alice");
    expect(user.email).toBe("alice@example.com");
  });

  test("setData replaces fields in place", () => {
    const UserModel = makeModel(UserSchema);
    const user = new UserModel({ id: 1, name: "Alice", email: "alice@example.com" });
    runInAction(() => user.setData({ id: 1, name: "Bob", email: "alice@example.com" }));
    expect(user.name).toBe("Bob");
    expect(user.id).toBe(1);
  });

  test("toJSON returns plain object with schema keys", () => {
    const UserModel = makeModel(UserSchema);
    const user = new UserModel({ id: 1, name: "Alice", email: "alice@example.com" });
    const json = user.toJSON();
    expect(json).toEqual({ id: 1, name: "Alice", email: "alice@example.com" });
    expect(Object.getPrototypeOf(json)).toBe(Object.prototype);
  });

  test("buildParams returns undefined when no keys configured", () => {
    const UserModel = makeModel(UserSchema);
    const user = new UserModel({ id: 1, name: "Alice", email: "alice@example.com" });
    expect(user.buildParams()).toBeUndefined();
  });

  test("buildParams returns key subset when keys configured", () => {
    const UserModel = makeModel(UserSchema, { keys: ["id"] as const });
    const user = new UserModel({ id: 42, name: "Alice", email: "alice@example.com" });
    expect(user.buildParams()).toEqual({ id: 42 });
  });

  test("stores store reference", () => {
    const UserModel = makeModel(UserSchema);
    const store = { remove: vi.fn() };
    const user = new UserModel({ id: 1, name: "Alice", email: "alice@example.com" }, store);
    expect(user.store).toBe(store);
  });

  test("schema is accessible as static property", () => {
    const UserModel = makeModel(UserSchema);
    expect(UserModel.schema).toBe(UserSchema);
  });

  describe("reload", () => {
    test("calls reload fn and updates model", async () => {
      const reloadFn = vi
        .fn()
        .mockResolvedValue({ id: 1, name: "Updated", email: "u@example.com" });
      const UserModel = makeModel(UserSchema, {
        keys: ["id"] as const,
        reload: reloadFn,
      });
      const user = new UserModel({ id: 1, name: "Alice", email: "alice@example.com" });
      await user.reload();
      expect(reloadFn).toHaveBeenCalledWith({ id: 1 });
      expect(user.name).toBe("Updated");
    });

    test("reload without keys calls fn with no params", async () => {
      const reloadFn = vi
        .fn()
        .mockResolvedValue({ id: 1, name: "Updated", email: "u@example.com" });
      const UserModel = makeModel(UserSchema, {
        keys: [] as const,
        reload: reloadFn,
      });
      const user = new UserModel({ id: 1, name: "Alice", email: "alice@example.com" });
      await user.reload();
      expect(reloadFn).toHaveBeenCalledWith();
    });
  });

  describe("update", () => {
    test("calls update fn with body and params, updates model", async () => {
      const updateFn = vi
        .fn()
        .mockResolvedValue({ id: 1, name: "Updated", email: "u@example.com" });
      const UserModel = makeModel(UserSchema, {
        keys: ["id"] as const,
        update: updateFn,
      });
      const user = new UserModel({ id: 1, name: "Alice", email: "alice@example.com" });
      await user.update({ name: "Updated" });
      expect(updateFn).toHaveBeenCalledWith({ id: 1 }, { name: "Updated" });
      expect(user.name).toBe("Updated");
    });
  });

  describe("delete", () => {
    test("calls delete fn and removes model from store", async () => {
      const deleteFn = vi.fn().mockResolvedValue(undefined);
      const removeFn = vi.fn();
      const UserModel = makeModel(UserSchema, {
        keys: ["id"] as const,
        delete: deleteFn,
      });
      const store = { remove: removeFn };
      const user = new UserModel({ id: 1, name: "Alice", email: "alice@example.com" }, store);
      await user.delete();
      expect(deleteFn).toHaveBeenCalledWith({ id: 1 });
      expect(removeFn).toHaveBeenCalledWith(user);
    });

    test("delete without store does not throw", async () => {
      const deleteFn = vi.fn().mockResolvedValue(undefined);
      const UserModel = makeModel(UserSchema, {
        keys: ["id"] as const,
        delete: deleteFn,
      });
      const user = new UserModel({ id: 1, name: "Alice", email: "alice@example.com" });
      await expect(user.delete()).resolves.not.toThrow();
    });
  });

  describe("actions", () => {
    test("custom action calls fn and updates model", async () => {
      const activateFn = vi
        .fn()
        .mockResolvedValue({ id: 1, name: "Alice", email: "alice@example.com" });
      const UserModel = makeModel(UserSchema, {
        keys: ["id"] as const,
        actions: { activate: activateFn },
      });
      const user = new UserModel({ id: 1, name: "Alice", email: "alice@example.com" });
      await (user as any).activate();
      expect(activateFn).toHaveBeenCalledWith({ id: 1 });
    });

    test("action without keys calls fn directly", async () => {
      const activateFn = vi
        .fn()
        .mockResolvedValue({ id: 1, name: "Alice", email: "alice@example.com" });
      const UserModel = makeModel(UserSchema, {
        keys: [] as const,
        actions: { activate: activateFn },
      });
      const user = new UserModel({ id: 1, name: "Alice", email: "alice@example.com" });
      await (user as any).activate({ role: "admin" });
      expect(activateFn).toHaveBeenCalledWith({ role: "admin" });
    });
  });
});

// ---------------------------------------------------------------------------
// makeUnionModel — discriminated unions
// ---------------------------------------------------------------------------

const PaymentSchema = T.Union([
  T.Object({ kind: T.Literal("card"), id: T.Number(), cardNumber: T.String() }),
  T.Object({ kind: T.Literal("bank"), id: T.Number(), routing: T.String() }),
]);

describe("makeUnionModel", () => {
  test("exposes shared fields and the discriminator", () => {
    const PaymentModel = makeUnionModel(PaymentSchema, "kind");
    const card = new PaymentModel({ kind: "card", id: 1, cardNumber: "4242" });
    expect(card.id).toBe(1);
    expect(card.kind).toBe("card");
    expect(PaymentModel.discriminator).toBe("kind");
  });

  test("is() guards the variant and reveals its fields", () => {
    const PaymentModel = makeUnionModel(PaymentSchema, "kind");
    const model = new PaymentModel({ kind: "card", id: 1, cardNumber: "4242" });
    expect(model.is("card")).toBe(true);
    expect(model.is("bank")).toBe(false);
    if (model.is("card")) {
      expect(model.cardNumber).toBe("4242"); // variant field exposed on the same instance
    } else {
      throw new Error("unreachable");
    }
  });

  test("as() returns the narrowed instance or undefined", () => {
    const PaymentModel = makeUnionModel(PaymentSchema, "kind");
    const model = new PaymentModel({ kind: "bank", id: 2, routing: "021" });
    const bank = model.as("bank");
    expect(bank).toBe(model); // same instance handed back
    expect(bank?.routing).toBe("021");
    expect(model.as("card")).toBeUndefined();
  });

  test("toJSON emits only the active variant's fields", () => {
    const PaymentModel = makeUnionModel(PaymentSchema, "kind");
    // foreign-variant keys exist on the instance (all observable) but are cleaned out
    const card = new PaymentModel({ kind: "card", id: 1, cardNumber: "4242", routing: "x" } as any);
    const json = card.toJSON();
    expect(json).toEqual({ kind: "card", id: 1, cardNumber: "4242" });
    expect("routing" in json).toBe(false);
    expect(Object.getPrototypeOf(json)).toBe(Object.prototype);
  });

  test("setData reactively switches variants and clears the previous variant", () => {
    const PaymentModel = makeUnionModel(PaymentSchema, "kind");
    const model = new PaymentModel({ kind: "card", id: 1, cardNumber: "4242" });

    const seen: (string | undefined)[] = [];
    const dispose = autorun(() => seen.push((model as any).routing));

    runInAction(() => model.setData({ kind: "bank", id: 1, routing: "021" }));
    dispose();

    expect(seen).toEqual([undefined, "021"]); // new variant field reacted
    expect(model.kind).toBe("bank");
    expect((model as any).cardNumber).toBeUndefined(); // previous variant cleared
    expect(model.toJSON()).toEqual({ kind: "bank", id: 1, routing: "021" });
  });

  test("buildParams uses the shared key", () => {
    const PaymentModel = makeUnionModel(PaymentSchema, "kind", { keys: ["id"] as const });
    const card = new PaymentModel({ kind: "card", id: 7, cardNumber: "4242" });
    expect(card.buildParams()).toEqual({ id: 7 });
  });

  test("reload replaces data via the keyed fn", async () => {
    const reloadFn = vi.fn().mockResolvedValue({ kind: "card", id: 1, cardNumber: "9999" });
    const PaymentModel = makeUnionModel(PaymentSchema, "kind", {
      keys: ["id"] as const,
      reload: reloadFn,
    });
    const card = new PaymentModel({ kind: "card", id: 1, cardNumber: "4242" });
    await card.reload();
    expect(reloadFn).toHaveBeenCalledWith({ id: 1 });
    if (card.is("card")) expect(card.cardNumber).toBe("9999");
  });

  test("a subclass can add methods that use the guards", () => {
    const PaymentModel = makeUnionModel(PaymentSchema, "kind");
    class Payment extends PaymentModel {
      describe() {
        if (this.is("card")) return `card ${this.cardNumber}`;
        if (this.is("bank")) return `bank ${this.routing}`;
        return "?";
      }
    }
    expect(new Payment({ kind: "bank", id: 1, routing: "021" }).describe()).toBe("bank 021");
  });

  test("static schema is the union", () => {
    const PaymentModel = makeUnionModel(PaymentSchema, "kind");
    expect(PaymentModel.schema).toBe(PaymentSchema);
  });
});

// ---------------------------------------------------------------------------
// makeStore
// ---------------------------------------------------------------------------

describe("makeStore", () => {
  const UserModel = makeModel(UserSchema);

  test("works without transform (models are raw schema objects)", async () => {
    const getAllFn = vi.fn().mockResolvedValue([{ id: 1, name: "Alice", email: "a@example.com" }]);
    const UserStore = makeStore(UserSchema, { getAll: getAllFn });
    const store = new UserStore() as any;
    const users = await store.getAll();
    expect(users[0].id).toBe(1);
    expect(users[0].name).toBe("Alice");
  });

  test("remove is a no-op when no getAll configured", () => {
    const UserStore = makeStore(UserSchema, {
      transform(data, store) {
        return new UserModel(data, store);
      },
    });
    const store = new UserStore();
    const user = new UserModel({ id: 1, name: "Alice", email: "a@example.com" });
    expect(() => store.remove(user)).not.toThrow();
  });

  describe("get", () => {
    test("calls get fn and returns transformed model", async () => {
      const getFn = vi.fn().mockResolvedValue({ id: 1, name: "Alice", email: "a@example.com" });
      const UserStore = makeStore(UserSchema, {
        transform(data, store) {
          return new UserModel(data, store);
        },
        get: getFn,
      });
      const store = new UserStore() as any;
      const user = await store.get(1);
      expect(getFn).toHaveBeenCalledWith(1);
      expect(user.id).toBe(1);
      expect(user.name).toBe("Alice");
    });
  });

  describe("getAll / all", () => {
    test("getAll returns lazy array that loads on first access", async () => {
      const getAllFn = vi.fn().mockResolvedValue([
        { id: 1, name: "Alice", email: "a@example.com" },
        { id: 2, name: "Bob", email: "b@example.com" },
      ]);
      const UserStore = makeStore(UserSchema, {
        transform(data, store) {
          return new UserModel(data, store);
        },
        getAll: getAllFn,
      });
      const store = new UserStore() as any;
      const users = await store.getAll();
      expect(getAllFn).toHaveBeenCalledOnce();
      expect(users).toHaveLength(2);
      expect(users[0].name).toBe("Alice");
    });
  });

  describe("create", () => {
    test("calls create fn, transforms result, and prepends to all", async () => {
      const getAllFn = vi
        .fn()
        .mockResolvedValue([{ id: 1, name: "Alice", email: "a@example.com" }]);
      const createFn = vi.fn().mockResolvedValue({ id: 2, name: "Bob", email: "b@example.com" });
      const UserStore = makeStore(UserSchema, {
        transform(data, store) {
          return new UserModel(data, store);
        },
        getAll: getAllFn,
        create: createFn,
      });
      const store = new UserStore() as any;
      await store.getAll();
      const created = await store.create({ name: "Bob", email: "b@example.com" });
      expect(created.id).toBe(2);
      expect(store.all.value[0].id).toBe(2);
    });
  });

  describe("remove", () => {
    test("splices model out of all.value", async () => {
      const getAllFn = vi.fn().mockResolvedValue([
        { id: 1, name: "Alice", email: "a@example.com" },
        { id: 2, name: "Bob", email: "b@example.com" },
      ]);
      const UserStore = makeStore(UserSchema, {
        transform(data, store) {
          return new UserModel(data, store);
        },
        getAll: getAllFn,
      });
      const store = new UserStore() as any;
      const users = await store.getAll();
      store.remove(users[0]);
      expect(store.all.value).toHaveLength(1);
      expect(store.all.value[0].id).toBe(2);
    });
  });
});
