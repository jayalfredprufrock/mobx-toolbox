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
    // the annotation pins `K` to the declared tuple rather than every schema key
    const params: { id: number } = user.buildParams();
    expect(params).toEqual({ id: 42 });
  });

  test("keys infer without `as const`", () => {
    const UserModel = makeModel(UserSchema, { keys: ["id"] });
    const user = new UserModel({ id: 42, name: "Alice", email: "alice@example.com" });
    // the annotation would fail to compile if `K` widened to every schema key
    const params: { id: number } = user.buildParams();
    expect(params).toEqual({ id: 42 });
  });

  test("empty keys read as keyless without `as const`", async () => {
    const updateFn = vi.fn().mockResolvedValue({ id: 1, name: "Bob", email: "a@example.com" });
    const UserModel = makeModel(UserSchema, { keys: [], update: updateFn });
    const user = new UserModel({ id: 1, name: "Alice", email: "a@example.com" });

    // `keys: []` infers as `never[]`, so the empty case is tested through the member type —
    // otherwise the model reads as keyed and `update` loses its body argument
    const params: undefined = user.buildParams();
    await user.update({ name: "Bob" });

    expect(params).toBeUndefined();
    expect(updateFn).toHaveBeenCalledWith({ name: "Bob" });
    expect(user.name).toBe("Bob");
  });

  test("schema is accessible as static property", () => {
    const UserModel = makeModel(UserSchema);
    expect(UserModel.schema).toBe(UserSchema);
  });

  describe("reload", () => {
    test("calls the get fn and updates the model", async () => {
      const getFn = vi.fn().mockResolvedValue({ id: 1, name: "Updated", email: "u@example.com" });
      const UserModel = makeModel(UserSchema, {
        keys: ["id"] as const,
        get: getFn,
      });
      const user = new UserModel({ id: 1, name: "Alice", email: "alice@example.com" });
      await user.reload();
      expect(getFn).toHaveBeenCalledWith({ id: 1 });
      expect(user.name).toBe("Updated");
    });

    test("reload without keys calls the get fn with no params", async () => {
      const getFn = vi.fn().mockResolvedValue({ id: 1, name: "Updated", email: "u@example.com" });
      const UserModel = makeModel(UserSchema, {
        keys: [] as const,
        get: getFn,
      });
      const user = new UserModel({ id: 1, name: "Alice", email: "alice@example.com" });
      await user.reload();
      expect(getFn).toHaveBeenCalledWith();
    });

    test("there is no reload without a get to derive it from", () => {
      const UserModel = makeModel(UserSchema, { keys: ["id"] as const });
      const user = new UserModel({ id: 1, name: "Alice", email: "alice@example.com" });
      expect("reload" in user).toBe(false);
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
    test("calls delete fn and tells every listener", async () => {
      const deleteFn = vi.fn().mockResolvedValue(undefined);
      const onModelEvent = vi.fn();
      const UserModel = makeModel(UserSchema, {
        keys: ["id"] as const,
        delete: deleteFn,
      });
      UserModel.addListener({ onModelEvent });
      const user = new UserModel({ id: 1, name: "Alice", email: "alice@example.com" });

      await user.delete();

      expect(deleteFn).toHaveBeenCalledWith({ id: 1 });
      expect(onModelEvent).toHaveBeenCalledWith("deleted", user);
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

  test("reload replaces data via the keyed get fn", async () => {
    const getFn = vi.fn().mockResolvedValue({ kind: "card", id: 1, cardNumber: "9999" });
    const PaymentModel = makeUnionModel(PaymentSchema, "kind", {
      keys: ["id"] as const,
      get: getFn,
    });
    const card = new PaymentModel({ kind: "card", id: 1, cardNumber: "4242" });
    await card.reload();
    expect(getFn).toHaveBeenCalledWith({ id: 1 });
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

  test("works without transform (built through the model class)", async () => {
    const getAllFn = vi.fn().mockResolvedValue([{ id: 1, name: "Alice", email: "a@example.com" }]);
    const UserStore = makeStore(UserModel, { list: getAllFn });
    const store = new UserStore();
    const users = await store.list.getOrLoad();
    expect(users[0]!.id).toBe(1);
    expect(users[0]!.name).toBe("Alice");
  });

  test("remove is a no-op when the store has no list", () => {
    const UserStore = makeStore(UserModel, {
      transform(data) {
        return new UserModel(data);
      },
    });
    const store = new UserStore();
    const user = new UserModel({ id: 1, name: "Alice", email: "a@example.com" });
    expect(() => store.remove(user)).not.toThrow();
  });

  describe("get", () => {
    test("delegates to the model's static and claims the model", async () => {
      const getFn = vi.fn().mockResolvedValue({ id: 1, name: "Alice", email: "a@example.com" });
      const KeyedUser = makeModel(UserSchema, { keys: ["id"] as const, get: getFn });
      const UserStore = makeStore(KeyedUser, { list: () => Promise.resolve([]) });
      const store = new UserStore();

      const user = await store.get({ id: 1 });

      expect(getFn).toHaveBeenCalledWith({ id: 1 });
      expect(user.name).toBe("Alice");
    });
  });

  describe("list", () => {
    test("getAll returns lazy array that loads on first access", async () => {
      const getAllFn = vi.fn().mockResolvedValue([
        { id: 1, name: "Alice", email: "a@example.com" },
        { id: 2, name: "Bob", email: "b@example.com" },
      ]);
      const UserStore = makeStore(UserModel, {
        transform(data) {
          return new UserModel(data);
        },
        list: getAllFn,
      });
      const store = new UserStore();
      const users = await store.list.getOrLoad();
      expect(getAllFn).toHaveBeenCalledOnce();
      expect(users).toHaveLength(2);
      expect(users[0]!.name).toBe("Alice");
    });
  });

  describe("create", () => {
    test("calls create fn, transforms result, and prepends to all", async () => {
      const getAllFn = vi
        .fn()
        .mockResolvedValue([{ id: 1, name: "Alice", email: "a@example.com" }]);
      const createFn = vi.fn().mockResolvedValue({ id: 2, name: "Bob", email: "b@example.com" });
      const KeyedUser = makeModel(UserSchema, { keys: ["id"] as const, create: createFn });
      const UserStore = makeStore(KeyedUser, { list: getAllFn });
      const store = new UserStore();
      await store.list.getOrLoad();

      const created = await store.create({ name: "Bob", email: "b@example.com" });

      expect(createFn).toHaveBeenCalledWith({ name: "Bob", email: "b@example.com" });
      expect(created.id).toBe(2);
      expect(store.list.value[0]!.id).toBe(2);
    });
  });

  describe("remove", () => {
    test("splices model out of all.value", async () => {
      const getAllFn = vi.fn().mockResolvedValue([
        { id: 1, name: "Alice", email: "a@example.com" },
        { id: 2, name: "Bob", email: "b@example.com" },
      ]);
      const UserStore = makeStore(UserModel, {
        transform(data) {
          return new UserModel(data);
        },
        list: getAllFn,
      });
      const store = new UserStore();
      const users = await store.list.getOrLoad();
      store.remove(users[0]!);
      expect(store.list.value).toHaveLength(1);
      expect(store.list.value[0]!.id).toBe(2);
    });
  });
});

// ---------------------------------------------------------------------------
// Identity map — statics on the model class
// ---------------------------------------------------------------------------

describe("model identity", () => {
  const alice = () => ({ id: 1, name: "Alice", email: "alice@example.com" });

  test("instantiate returns the same instance for the same record", () => {
    const UserModel = makeModel(UserSchema, { keys: ["id"] as const });

    const first = UserModel.instantiate(alice());
    const second = UserModel.instantiate(alice());

    expect(second).toBe(first);
  });

  test("instantiate applies the newer payload to the existing instance", () => {
    const UserModel = makeModel(UserSchema, { keys: ["id"] as const });

    const user = UserModel.instantiate(alice());
    UserModel.instantiate({ id: 1, name: "Renamed", email: "alice@example.com" });

    expect(user.name).toBe("Renamed");
  });

  test("different records get different instances", () => {
    const UserModel = makeModel(UserSchema, { keys: ["id"] as const });

    expect(UserModel.instantiate({ id: 2, name: "Bob", email: "b@example.com" })).not.toBe(
      UserModel.instantiate(alice()),
    );
  });

  test("listeners hear about a create", async () => {
    const UserModel = makeModel(UserSchema, {
      keys: ["id"] as const,
      create: (body: { name: string; email: string }) => Promise.resolve({ id: 1, ...body }),
    });
    const onModelEvent = vi.fn();
    UserModel.addListener({ onModelEvent });

    const created = await UserModel.create({ name: "Alice", email: "a@example.com" });

    expect(onModelEvent).toHaveBeenCalledWith("created", created);
  });

  test("composite keys identify a record", () => {
    const MembershipSchema = T.Object({
      orgId: T.Number(),
      userId: T.Number(),
      role: T.String(),
    });
    const MembershipModel = makeModel(MembershipSchema, { keys: ["orgId", "userId"] as const });

    const first = MembershipModel.instantiate({ orgId: 1, userId: 1, role: "admin" });

    expect(MembershipModel.instantiate({ orgId: 1, userId: 1, role: "member" })).toBe(first);
    expect(MembershipModel.instantiate({ orgId: 2, userId: 1, role: "admin" })).not.toBe(first);
    expect(first.role).toBe("member");
  });

  test("forget makes the next instantiate build a fresh instance", () => {
    const UserModel = makeModel(UserSchema, { keys: ["id"] as const });

    const first = UserModel.instantiate(alice());
    expect(UserModel.forget(first)).toBe(true);

    expect(UserModel.instantiate(alice())).not.toBe(first);
  });

  test("clearIdentity forgets every record", () => {
    const UserModel = makeModel(UserSchema, { keys: ["id"] as const });
    const first = UserModel.instantiate(alice());
    const second = UserModel.instantiate({ id: 2, name: "Bob", email: "b@example.com" });

    UserModel.clearIdentity();

    expect(UserModel.instantiate(alice())).not.toBe(first);
    expect(UserModel.instantiate({ id: 2, name: "Bob", email: "b@example.com" })).not.toBe(second);
  });

  test("identity requires keys and says so", () => {
    const UserModel = makeModel(UserSchema);

    expect(() => UserModel.instantiate(alice())).toThrow(/requires `keys`/);
  });

  test("identityKey can be overridden to scope identity", () => {
    const UserModel = makeModel(UserSchema, { keys: ["id"] as const });
    let tenant = "acme";
    class TenantUser extends UserModel {
      static override identityKey(source: { id: number }) {
        return `${tenant}:${source.id}`;
      }
    }

    const acmeUser = TenantUser.instantiate(alice());
    tenant = "globex";
    const globexUser = TenantUser.instantiate(alice());

    // same id, different tenant — deliberately different instances
    expect(globexUser).not.toBe(acmeUser);
  });

  test("a subclass gets its own registry rather than sharing its parent's", () => {
    const UserModel = makeModel(UserSchema, { keys: ["id"] as const });
    class Admin extends UserModel {}

    const base = UserModel.instantiate(alice());
    const admin = Admin.instantiate(alice());

    expect(admin).not.toBe(base);
    expect(admin).toBeInstanceOf(Admin);
    expect(base).not.toBeInstanceOf(Admin);
  });

  test("delete gives up identity so a recreated record is a fresh instance", async () => {
    const UserModel = makeModel(UserSchema, {
      keys: ["id"] as const,
      delete: vi.fn().mockResolvedValue(undefined),
    });

    const user = UserModel.instantiate(alice());
    await user.delete();

    expect(UserModel.instantiate(alice())).not.toBe(user);
  });

  test("a union model is identity-mapped on its shared key", () => {
    const PaymentSchema = T.Union([
      T.Object({ kind: T.Literal("card"), id: T.Number(), cardNumber: T.String() }),
      T.Object({ kind: T.Literal("bank"), id: T.Number(), routing: T.String() }),
    ]);
    const PaymentModel = makeUnionModel(PaymentSchema, "kind", { keys: ["id"] as const });

    const card = PaymentModel.instantiate({ kind: "card", id: 1, cardNumber: "4242" });
    const same = PaymentModel.instantiate({ kind: "bank", id: 1, routing: "021" });

    expect(same).toBe(card);
    expect(card.is("bank")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Identity through a store
// ---------------------------------------------------------------------------

describe("makeStore with an identity-mapped model", () => {
  const rows = () => [
    { id: 1, name: "Alice", email: "alice@example.com" },
    { id: 2, name: "Bob", email: "bob@example.com" },
  ];

  const makeIdentifiedStore = (data = rows()) => {
    const UserModel = makeModel(UserSchema, {
      keys: ["id"] as const,
      get: (params: { id: number }) => Promise.resolve(data.find((row) => row.id === params.id)!),
      create: (body: { id: number; name: string; email: string }) => Promise.resolve(body),
      update: (params: { id: number }, body: Partial<(typeof data)[number]>) =>
        Promise.resolve({ ...data.find((row) => row.id === params.id)!, ...body }),
    });
    const UserStore = makeStore(UserModel, { list: () => Promise.resolve(data) });
    return new UserStore();
  };

  test("reloading a collection keeps the same model instances", async () => {
    const store = makeIdentifiedStore();
    await store.list.getOrLoad();
    const held = store.list.value[0]!;

    await store.list.reload();

    expect(store.list.value[0]).toBe(held);
    expect(store.list.value).toHaveLength(2);
  });

  test("get returns the instance the collection already holds", async () => {
    const store = makeIdentifiedStore();
    await store.list.getOrLoad();

    expect(await store.get({ id: 1 })).toBe(store.list.value[0]);
  });

  test("an update through one reference is visible through every other", async () => {
    const store = makeIdentifiedStore();
    await store.list.getOrLoad();
    const fromList = store.list.value[0]!;
    const fromGet = await store.get({ id: 1 });

    await fromGet.update({ name: "Renamed" });

    expect(fromList.name).toBe("Renamed");
  });

  test("a reload applies fresh field values to the retained instance", async () => {
    const data = rows();
    const store = makeIdentifiedStore(data);
    await store.list.getOrLoad();
    const held = store.list.value[0]!;

    data[0]!.name = "Changed on the server";
    await store.list.reload();

    expect(held.name).toBe("Changed on the server");
  });

  test("create does not duplicate a record the collection already holds", async () => {
    const store = makeIdentifiedStore();
    await store.list.getOrLoad();
    const existing = store.list.value[0]!;

    const created = await store.create({ id: 1, name: "Alice", email: "alice@example.com" });

    expect(created).toBe(existing);
    expect(store.list.value).toHaveLength(2);
  });

  test("create still prepends a genuinely new record", async () => {
    const store = makeIdentifiedStore();
    await store.list.getOrLoad();

    const created = await store.create({ id: 3, name: "Cara", email: "cara@example.com" });

    expect(store.list.value[0]).toBe(created);
    expect(store.list.value).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// makeStore taking a model class
// ---------------------------------------------------------------------------

describe("makeStore from a model class", () => {
  const rows = () => [
    { id: 1, name: "Alice", email: "alice@example.com" },
    { id: 2, name: "Bob", email: "bob@example.com" },
  ];

  test("identity is wired up without writing a transform", async () => {
    const UserModel = makeModel(UserSchema, { keys: ["id"] as const });
    const data = rows();
    const UserStore = makeStore(UserModel, {
      list: () => Promise.resolve(data),
    });
    const store = new UserStore();

    await store.list.getOrLoad();
    const held = store.list.value[0]!;

    await store.list.reload();
    expect(store.list.value[0]).toBe(held);
  });

  test("the schema comes from the model, so it is declared once", async () => {
    const UserModel = makeModel(UserSchema, { keys: ["id"] as const });
    const UserStore = makeStore(UserModel, { list: () => Promise.resolve(rows()) });
    const store = new UserStore();

    const users = await store.list.getOrLoad();
    expect(users[0]!.name).toBe("Alice");
    expect(users[0]!.toJSON()).toEqual(rows()[0]);
  });

  test("models are wired to the store, so delete removes them from the collection", async () => {
    const deleteFn = vi.fn().mockResolvedValue(undefined);
    const UserModel = makeModel(UserSchema, { keys: ["id"] as const, delete: deleteFn });
    const UserStore = makeStore(UserModel, { list: () => Promise.resolve(rows()) });
    const store = new UserStore();

    await store.list.getOrLoad();
    await store.list.value[0]!.delete();

    expect(deleteFn).toHaveBeenCalledWith({ id: 1 });
    expect(store.list.value).toHaveLength(1);
  });

  test("an explicit transform still wins", async () => {
    const UserModel = makeModel(UserSchema, { keys: ["id"] as const });
    class Admin extends UserModel {
      get label() {
        return `admin:${this.name}`;
      }
    }
    const UserStore = makeStore(UserModel, {
      transform(data) {
        return Admin.instantiate(data);
      },
      list: () => Promise.resolve(rows()),
    });
    const store = new UserStore();

    await store.list.getOrLoad();
    expect(store.list.value[0]!.label).toBe("admin:Alice");
  });

  test("a keyless model class still works, just without identity", async () => {
    const UserModel = makeModel(UserSchema);
    const UserStore = makeStore(UserModel, { list: () => Promise.resolve(rows()) });
    const store = new UserStore();

    await store.list.getOrLoad();
    const held = store.list.value[0]!;
    await store.list.reload();

    expect(store.list.value[0]).not.toBe(held);
    expect(store.list.value[0]!.name).toBe("Alice");
  });

  test("a union model class is accepted too", async () => {
    const PaymentSchema = T.Union([
      T.Object({ kind: T.Literal("card"), id: T.Number(), cardNumber: T.String() }),
      T.Object({ kind: T.Literal("bank"), id: T.Number(), routing: T.String() }),
    ]);
    const PaymentModel = makeUnionModel(PaymentSchema, "kind", { keys: ["id"] as const });
    const PaymentStore = makeStore(PaymentModel, {
      list: () => Promise.resolve([{ kind: "card" as const, id: 1, cardNumber: "4242" }]),
    });
    const store = new PaymentStore();

    await store.list.getOrLoad();
    const payment = store.list.value[0]!;
    expect(payment.is("card") && payment.cardNumber).toBe("4242");
  });

  test("a store with no config exposes only what the model provides", async () => {
    const UserModel = makeModel(UserSchema, {
      keys: ["id"] as const,
      get: (params: { id: number }) => Promise.resolve(rows().find((row) => row.id === params.id)!),
    });
    const UserStore = makeStore(UserModel);
    const store = new UserStore();

    const user = await store.get({ id: 2 });
    expect(user.name).toBe("Bob");
  });
});

// ---------------------------------------------------------------------------
// Static get / create, and reload derived from get
// ---------------------------------------------------------------------------

describe("model statics", () => {
  const alice = { id: 1, name: "Alice", email: "alice@example.com" };

  test("Model.get returns the identity-mapped instance", async () => {
    const getFn = vi.fn().mockResolvedValue(alice);
    const UserModel = makeModel(UserSchema, { keys: ["id"] as const, get: getFn });

    const first = await UserModel.get({ id: 1 });
    const second = await UserModel.get({ id: 1 });

    expect(getFn).toHaveBeenCalledWith({ id: 1 });
    expect(second).toBe(first);
    expect(first.name).toBe("Alice");
  });

  test("Model.get applies a newer payload to the instance already held", async () => {
    let name = "Alice";
    const UserModel = makeModel(UserSchema, {
      keys: ["id"] as const,
      get: ({ id }) => Promise.resolve({ id, name, email: "alice@example.com" }),
    });

    const user = await UserModel.get({ id: 1 });
    name = "Renamed";
    await UserModel.get({ id: 1 });

    expect(user.name).toBe("Renamed");
  });

  test("Model.get passes extra arguments through to the endpoint", async () => {
    const getFn = vi.fn().mockResolvedValue(alice);
    const UserModel = makeModel(UserSchema, { keys: ["id"] as const, get: getFn });

    await UserModel.get({ id: 1 }, { expand: "roles" });

    expect(getFn).toHaveBeenCalledWith({ id: 1 }, { expand: "roles" });
  });

  test("reload is derived from get, so the endpoint is declared once", async () => {
    let name = "Alice";
    const getFn = vi.fn(({ id }: { id: number }) =>
      Promise.resolve({ id, name, email: "alice@example.com" }),
    );
    const UserModel = makeModel(UserSchema, { keys: ["id"] as const, get: getFn });

    const user = UserModel.instantiate(alice);
    name = "Refreshed";
    await user.reload();

    expect(getFn).toHaveBeenCalledWith({ id: 1 });
    expect(user.name).toBe("Refreshed");
  });

  test("Model.create returns an identity-mapped instance", async () => {
    const createFn = vi.fn().mockResolvedValue(alice);
    const UserModel = makeModel(UserSchema, { keys: ["id"] as const, create: createFn });

    const created = await UserModel.create({ name: "Alice", email: "alice@example.com" });

    expect(createFn).toHaveBeenCalledWith({ name: "Alice", email: "alice@example.com" });
    expect(UserModel.instantiate(alice)).toBe(created);
  });

  test("Model.get is typed and returned through the subclass it is called on", async () => {
    const getFn = vi.fn().mockResolvedValue(alice);
    const UserModel = makeModel(UserSchema, { keys: ["id"], get: getFn });
    class Admin extends UserModel {
      get displayName() {
        return `${this.name} (admin)`;
      }
    }

    const admin = await Admin.get({ id: 1 });
    // the annotation would fail to compile if the static hardcoded the base instance
    const displayName: string = admin.displayName;

    expect(admin).toBeInstanceOf(Admin);
    expect(displayName).toBe("Alice (admin)");
  });

  test("Model.create is typed and returned through the subclass it is called on", async () => {
    const createFn = vi.fn().mockResolvedValue(alice);
    const UserModel = makeModel(UserSchema, { keys: ["id"], create: createFn });
    class Admin extends UserModel {
      get displayName() {
        return `${this.name} (admin)`;
      }
    }

    const admin = await Admin.create({ name: "Alice", email: "alice@example.com" });
    const displayName: string = admin.displayName;

    expect(admin).toBeInstanceOf(Admin);
    expect(displayName).toBe("Alice (admin)");
    // the subclass has its own registry, so the base class never hands back this instance
    expect(UserModel.instantiate(alice)).not.toBe(admin);
  });

  test("a listener registered after a model exists still hears about it", async () => {
    const UserModel = makeModel(UserSchema, {
      keys: ["id"] as const,
      get: ({ id }) => Promise.resolve({ ...alice, id }),
      delete: vi.fn().mockResolvedValue(undefined),
    });
    const user = await UserModel.get({ id: 1 });

    const onModelEvent = vi.fn();
    UserModel.addListener({ onModelEvent });
    await user.delete();

    // no ownership involved — the model never held a store reference
    expect(onModelEvent).toHaveBeenCalledWith("deleted", user);
  });

  test("a model fetched before any store existed is still removed from a list on delete", async () => {
    const data = [alice];
    const UserModel = makeModel(UserSchema, {
      keys: ["id"] as const,
      get: ({ id }) => Promise.resolve({ ...alice, id }),
      delete: vi.fn().mockResolvedValue(undefined),
    });
    const UserStore = makeStore(UserModel, { list: () => Promise.resolve(data) });

    // fetched standalone, before the store was even constructed
    const user = await UserModel.get({ id: 1 });
    const store = new UserStore();
    await store.list.getOrLoad();
    expect(store.list.value[0]).toBe(user); // identity, not ownership

    await user.delete();

    expect(store.list.value).toHaveLength(0);
  });
});

describe("create and update body typing", () => {
  const alice = { id: 1, name: "Alice", email: "alice@example.com" };

  test("the body type comes from what you attach, and is enforced", async () => {
    const createFn = vi.fn().mockResolvedValue(alice);
    const UserModel = makeModel(UserSchema, {
      keys: ["id"] as const,
      create: (body: { name: string; password: string }) => createFn(body),
    });

    const created = await UserModel.create({ name: "Alice", password: "hunter2" });

    expect(createFn).toHaveBeenCalledWith({ name: "Alice", password: "hunter2" });
    expect(created.id).toBe(1);
    // @ts-expect-error `password` is required by the attached signature
    void (() => UserModel.create({ name: "Alice" }));
  });

  test("a body sharing no field names with the resource still attaches", async () => {
    // Regression guard: a `Partial<Resource>` default would reject this outright (weak-type rule),
    // and the rejection would cascade — the config falls back to its constraint, taking every
    // generated method with it.
    const signUp = vi.fn().mockResolvedValue(alice);
    const rotate = vi.fn().mockResolvedValue(alice);
    const UserModel = makeModel(UserSchema, {
      keys: ["id"] as const,
      get: (params: { id: number }) => Promise.resolve({ ...alice, id: params.id }),
      create: (body: { inviteToken: string }) => signUp(body),
      update: (params: { id: number }, body: { rotateSecret: boolean }) => rotate(params, body),
    });

    await UserModel.create({ inviteToken: "abc" });
    const user = UserModel.instantiate(alice);
    await user.update({ rotateSecret: true });

    expect(signUp).toHaveBeenCalledWith({ inviteToken: "abc" });
    expect(rotate).toHaveBeenCalledWith({ id: 1 }, { rotateSecret: true });
    // the config did not fall back to its constraint: the generated methods are all still there
    expect(typeof user.update).toBe("function");
    expect(typeof user.reload).toBe("function"); // derived from `get`
  });
});
