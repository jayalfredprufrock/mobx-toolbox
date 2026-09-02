import { describe, expect, test, vi } from "vite-plus/test";
import * as T from "typebox";
import { autorun, isObservableProp, makeObservable, observable, runInAction } from "mobx";
import { LOADED_AT, makeModel, makeUnionModel } from "./make-model";
import { createStore, makeStore } from "./make-store";

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
// makeUnionModel — unions of unions
// ---------------------------------------------------------------------------

const CardSchema = T.Object({ kind: T.Literal("card"), id: T.Number(), cardNumber: T.String() });
const WireSchema = T.Object({ kind: T.Literal("wire"), id: T.Number(), swift: T.String() });
const BankSchema = T.Object({ kind: T.Literal("bank"), id: T.Number(), routing: T.String() });
const CashSchema = T.Object({ kind: T.Literal("cash"), id: T.Number(), note: T.String() });

const ElectronicSchema = T.Union([CardSchema, WireSchema]);
const ManualSchema = T.Union([BankSchema, CashSchema]);
/** Two levels: a union whose every member is itself a union. */
const NestedPaymentSchema = T.Union([ElectronicSchema, ManualSchema]);

describe("makeUnionModel with a union of unions", () => {
  test("makes every nested variant's fields observable", () => {
    const PaymentModel = makeUnionModel(NestedPaymentSchema, "kind");
    const card = new PaymentModel({ kind: "card", id: 1, cardNumber: "4242" });

    // A field from the *other* branch of the nesting has to exist and be observable, or `setData`
    // switching to that variant would not be reactive.
    const seen: (string | undefined)[] = [];
    const dispose = autorun(() => seen.push((card as any).note));
    runInAction(() => card.setData({ kind: "cash", id: 1, note: "petty" }));
    dispose();

    expect(seen).toEqual([undefined, "petty"]);
    expect((card as any).cardNumber).toBeUndefined();
  });

  test("toJSON cleans down to the active variant across nesting levels", () => {
    const PaymentModel = makeUnionModel(NestedPaymentSchema, "kind");
    const wire = new PaymentModel({
      kind: "wire",
      id: 3,
      swift: "DEUTDEFF",
      routing: "021",
      note: "x",
    } as any);
    expect(wire.toJSON()).toEqual({ kind: "wire", id: 3, swift: "DEUTDEFF" });
  });

  test("is()/as() and the identity map work on nested variants", async () => {
    const PaymentModel = makeUnionModel(NestedPaymentSchema, "kind", { keys: ["id"] as const });
    const bank = PaymentModel.instantiate({ kind: "bank", id: 9, routing: "021" });
    expect(bank.is("bank")).toBe(true);
    expect(bank.is("card")).toBe(false);
    if (bank.is("bank")) expect(bank.routing).toBe("021");
    expect(bank.as("cash")).toBeUndefined();
    expect(bank.buildParams()).toEqual({ id: 9 });

    // Same key, so the same instance — the nesting changes nothing about identity.
    expect(PaymentModel.instantiate({ kind: "cash", id: 9, note: "refund" })).toBe(bank);
    expect(bank.kind).toBe("cash");
  });

  test("handles arbitrary depth and object/union siblings", () => {
    // Three levels on one side, a bare object as a direct sibling on the other.
    const DeepSchema = T.Union([T.Union([T.Union([ElectronicSchema]), CashSchema]), BankSchema]);
    const PaymentModel = makeUnionModel(DeepSchema, "kind");
    const cash = new PaymentModel({ kind: "cash", id: 1, note: "petty", swift: "X" } as any);

    // Every leaf, however deep, contributed its properties.
    expect(Object.keys(cash).sort()).toEqual([
      "cardNumber",
      "id",
      "kind",
      "note",
      "routing",
      "swift",
    ]);
    expect(cash.toJSON()).toEqual({ kind: "cash", id: 1, note: "petty" });
  });

  test("a variant reachable through two branches is not duplicated", () => {
    const DupSchema = T.Union([
      T.Union([CardSchema, BankSchema]),
      T.Union([CardSchema, CashSchema]),
    ]);
    const PaymentModel = makeUnionModel(DupSchema, "kind");
    const card = new PaymentModel({ kind: "card", id: 1, cardNumber: "4242" });
    expect(Object.keys(card).sort()).toEqual(["cardNumber", "id", "kind", "note", "routing"]);
    expect(card.toJSON()).toEqual({ kind: "card", id: 1, cardNumber: "4242" });
  });

  test("static schema is the schema as given, nesting intact", () => {
    const PaymentModel = makeUnionModel(NestedPaymentSchema, "kind");
    // Flattening happens where `anyOf` is walked, not by rewriting the schema — so a schema shared
    // with a form or a store is still the same object.
    expect(PaymentModel.schema).toBe(NestedPaymentSchema);
    expect(PaymentModel.schema.anyOf).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// makeStore
// ---------------------------------------------------------------------------

describe("makeStore", () => {
  const UserModel = makeModel(UserSchema);

  test("models are built through the model class", async () => {
    const getAllFn = vi.fn().mockResolvedValue([{ id: 1, name: "Alice", email: "a@example.com" }]);
    const store = createStore(UserModel, { collections: { list: getAllFn } });
    const users = await store.list.getOrLoad();
    expect(users[0]!.id).toBe(1);
    expect(users[0]!.name).toBe("Alice");
  });

  test("remove is a no-op when the store has no list", () => {
    const UserStore = makeStore(UserModel);
    const store = new UserStore();
    const user = new UserModel({ id: 1, name: "Alice", email: "a@example.com" });
    expect(() => store.remove(user)).not.toThrow();
  });

  describe("get", () => {
    test("delegates to the model's static and claims the model", async () => {
      const getFn = vi.fn().mockResolvedValue({ id: 1, name: "Alice", email: "a@example.com" });
      const KeyedUser = makeModel(UserSchema, { keys: ["id"] as const, get: getFn });
      const store = createStore(KeyedUser, { collections: { list: () => Promise.resolve([]) } });

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
      const store = createStore(UserModel, { collections: { list: getAllFn } });
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
      const store = createStore(KeyedUser, {
        optimisticCreate: true,
        collections: { list: getAllFn },
      });
      await store.list.getOrLoad();

      const created = await store.create({ name: "Bob", email: "b@example.com" });

      expect(createFn).toHaveBeenCalledWith({ name: "Bob", email: "b@example.com" });
      expect(created.id).toBe(2);
      expect(store.list.value![0]!.id).toBe(2);
    });
  });

  describe("remove", () => {
    test("splices model out of all.value", async () => {
      const getAllFn = vi.fn().mockResolvedValue([
        { id: 1, name: "Alice", email: "a@example.com" },
        { id: 2, name: "Bob", email: "b@example.com" },
      ]);
      const store = createStore(UserModel, { collections: { list: getAllFn } });
      const users = await store.list.getOrLoad();
      store.remove(users[0]!);
      expect(store.list.value).toHaveLength(1);
      expect(store.list.value![0]!.id).toBe(2);
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

  test("a model with no identity has no identity statics to call", () => {
    const NoConfig = makeModel(UserSchema);
    const OptedOut = makeModel(UserSchema, { keys: false });

    // the @ts-expect-error proves identity is gone from the type; the assertion proves the throw
    // still guards it underneath, for JS consumers and `as any` escapes
    // @ts-expect-error identity statics are not on a model that declared none
    expect(() => NoConfig.instantiate(alice())).toThrow(/no identity/);
    // @ts-expect-error — and `keys: false` means exactly the same thing
    expect(() => OptedOut.instantiate(alice())).toThrow(/no identity/);
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
    return createStore(UserModel, {
      optimisticCreate: true,
      collections: { list: () => Promise.resolve(data) },
    });
  };

  test("reloading a collection keeps the same model instances", async () => {
    const store = makeIdentifiedStore();
    await store.list.getOrLoad();
    const held = store.list.value![0]!;

    await store.list.reload();

    expect(store.list.value![0]).toBe(held);
    expect(store.list.value).toHaveLength(2);
  });

  test("get returns the instance the collection already holds", async () => {
    const store = makeIdentifiedStore();
    await store.list.getOrLoad();

    expect(await store.get({ id: 1 })).toBe(store.list.value![0]);
  });

  test("an update through one reference is visible through every other", async () => {
    const store = makeIdentifiedStore();
    await store.list.getOrLoad();
    const fromList = store.list.value![0]!;
    const fromGet = await store.get({ id: 1 });

    await fromGet.update({ name: "Renamed" });

    expect(fromList.name).toBe("Renamed");
  });

  test("a reload applies fresh field values to the retained instance", async () => {
    const data = rows();
    const store = makeIdentifiedStore(data);
    await store.list.getOrLoad();
    const held = store.list.value![0]!;

    data[0]!.name = "Changed on the server";
    await store.list.reload();

    expect(held.name).toBe("Changed on the server");
  });

  test("create does not duplicate a record the collection already holds", async () => {
    const store = makeIdentifiedStore();
    await store.list.getOrLoad();
    const existing = store.list.value![0]!;

    const created = await store.create({ id: 1, name: "Alice", email: "alice@example.com" });

    expect(created).toBe(existing);
    expect(store.list.value).toHaveLength(2);
  });

  test("create still prepends a genuinely new record", async () => {
    const store = makeIdentifiedStore();
    await store.list.getOrLoad();

    const created = await store.create({ id: 3, name: "Cara", email: "cara@example.com" });

    expect(store.list.value![0]).toBe(created);
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
    const store = createStore(UserModel, {
      collections: { list: () => Promise.resolve(data) },
    });

    await store.list.getOrLoad();
    const held = store.list.value![0]!;

    await store.list.reload();
    expect(store.list.value![0]).toBe(held);
  });

  test("the schema comes from the model, so it is declared once", async () => {
    const UserModel = makeModel(UserSchema, { keys: ["id"] as const });
    const store = createStore(UserModel, { collections: { list: () => Promise.resolve(rows()) } });

    const users = await store.list.getOrLoad();
    expect(users[0]!.name).toBe("Alice");
    expect(users[0]!.toJSON()).toEqual(rows()[0]);
  });

  test("models are wired to the store, so delete removes them from the collection", async () => {
    const deleteFn = vi.fn().mockResolvedValue(undefined);
    const UserModel = makeModel(UserSchema, { keys: ["id"] as const, delete: deleteFn });
    const store = createStore(UserModel, { collections: { list: () => Promise.resolve(rows()) } });

    await store.list.getOrLoad();
    await store.list.value![0]!.delete();

    expect(deleteFn).toHaveBeenCalledWith({ id: 1 });
    expect(store.list.value).toHaveLength(1);
  });

  test("a subclass is used by passing it to the store directly", async () => {
    const UserModel = makeModel(UserSchema, { keys: ["id"] as const });
    class Admin extends UserModel {
      get label() {
        return `admin:${this.name}`;
      }
    }
    const store = createStore(Admin, {
      collections: { list: () => Promise.resolve(rows()) },
    });

    await store.list.getOrLoad();
    expect(store.list.value![0]!.label).toBe("admin:Alice");
  });

  test("a keyless model class still works, just without identity", async () => {
    const UserModel = makeModel(UserSchema);
    const store = createStore(UserModel, { collections: { list: () => Promise.resolve(rows()) } });

    await store.list.getOrLoad();
    const held = store.list.value![0]!;
    await store.list.reload();

    expect(store.list.value![0]).not.toBe(held);
    expect(store.list.value![0]!.name).toBe("Alice");
  });

  test("a union model class is accepted too", async () => {
    const PaymentSchema = T.Union([
      T.Object({ kind: T.Literal("card"), id: T.Number(), cardNumber: T.String() }),
      T.Object({ kind: T.Literal("bank"), id: T.Number(), routing: T.String() }),
    ]);
    const PaymentModel = makeUnionModel(PaymentSchema, "kind", { keys: ["id"] as const });
    const store = createStore(PaymentModel, {
      collections: {
        list: () => Promise.resolve([{ kind: "card" as const, id: 1, cardNumber: "4242" }]),
      },
    });

    await store.list.getOrLoad();
    const payment = store.list.value![0]!;
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
    class UserStore extends makeStore(UserModel) {
      list = this.collection(() => Promise.resolve(data));
    }

    // fetched standalone, before the store was even constructed
    const user = await UserModel.get({ id: 1 });
    const store = new UserStore();
    await store.list.getOrLoad();
    expect(store.list.value![0]).toBe(user); // identity, not ownership

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

// ---------------------------------------------------------------------------
// keys — the three identity modes
// ---------------------------------------------------------------------------

describe("identity modes", () => {
  const SettingsSchema = T.Object({ theme: T.String(), locale: T.String() });
  const settings = () => ({ theme: "dark", locale: "en" });

  describe("keys: [] — a singleton", () => {
    test("get returns the one instance, however many times it is called", async () => {
      const getFn = vi.fn(() => Promise.resolve(settings()));
      const Settings = makeModel(SettingsSchema, { keys: [], get: getFn });

      const first = await Settings.get();
      const second = await Settings.get();

      expect(second).toBe(first);
      expect(getFn).toHaveBeenCalledTimes(2);
      expect(getFn).toHaveBeenCalledWith();
    });

    test("get applies the newer payload to the instance already held", async () => {
      let theme = "dark";
      const Settings = makeModel(SettingsSchema, {
        keys: [],
        get: () => Promise.resolve({ theme, locale: "en" }),
      });

      const s = await Settings.get();
      theme = "light";
      await Settings.get();

      expect(s.theme).toBe("light");
    });

    test("create and instantiate land on the same instance as get", async () => {
      const Settings = makeModel(SettingsSchema, {
        keys: [],
        get: () => Promise.resolve(settings()),
        create: (body: { theme: string }) => Promise.resolve({ ...body, locale: "en" }),
      });

      const fetched = await Settings.get();
      const created = await Settings.create({ theme: "light" });

      expect(created).toBe(fetched);
      expect(Settings.instantiate(settings())).toBe(fetched);
    });

    test("clearIdentity drops the singleton so the next get builds a fresh one", async () => {
      const Settings = makeModel(SettingsSchema, {
        keys: [],
        get: () => Promise.resolve(settings()),
      });

      const first = await Settings.get();
      Settings.clearIdentity();

      expect(await Settings.get()).not.toBe(first);
    });

    test("delete gives up the singleton's identity", async () => {
      const Settings = makeModel(SettingsSchema, {
        keys: [],
        get: () => Promise.resolve(settings()),
        delete: vi.fn().mockResolvedValue(undefined),
      });

      const first = await Settings.get();
      await first.delete();

      expect(await Settings.get()).not.toBe(first);
    });

    test("methods still take no leading params argument", async () => {
      const updateFn = vi.fn().mockResolvedValue({ theme: "light", locale: "en" });
      const Settings = makeModel(SettingsSchema, { keys: [], update: updateFn });
      const s = new Settings(settings());

      const params: undefined = s.buildParams();
      await s.update({ theme: "light" });

      expect(params).toBeUndefined();
      expect(updateFn).toHaveBeenCalledWith({ theme: "light" });
    });
  });

  describe("keys: false — no identity", () => {
    test("get hands back a detached instance rather than throwing", async () => {
      const getFn = vi.fn(() => Promise.resolve(settings()));
      const Settings = makeModel(SettingsSchema, { keys: false, get: getFn });

      const first = await Settings.get();
      const second = await Settings.get();

      expect(first.theme).toBe("dark");
      expect(second).not.toBe(first);
    });

    test("create hands back a detached instance and still announces itself", async () => {
      const Settings = makeModel(SettingsSchema, {
        keys: false,
        create: (body: { theme: string }) => Promise.resolve({ ...body, locale: "en" }),
      });
      const heard: string[] = [];
      Settings.addListener({ onModelEvent: (type) => heard.push(type) });

      const a = await Settings.create({ theme: "light" });
      const b = await Settings.create({ theme: "light" });

      expect(b).not.toBe(a);
      expect(heard).toEqual(["created", "created"]);
    });

    test("no config means exactly what keys: false means", () => {
      const NoConfig = makeModel(SettingsSchema);
      const OptedOut = makeModel(SettingsSchema, { keys: false });

      expect(NoConfig.keys).toBe(false);
      expect(OptedOut.keys).toBe(false);
    });

    test("delete does not reach for the registry", async () => {
      const deleteFn = vi.fn().mockResolvedValue(undefined);
      const Settings = makeModel(SettingsSchema, { keys: false, delete: deleteFn });
      const s = new Settings(settings());

      await expect(s.delete()).resolves.toBeUndefined();
      expect(deleteFn).toHaveBeenCalledWith();
    });
  });

  describe("stores follow the model's declaration", () => {
    test("a singleton model routes its list through identity", async () => {
      const Settings = makeModel(SettingsSchema, { keys: [] });
      const store = createStore(Settings, {
        collections: { list: () => Promise.resolve([settings()]) },
      });

      const rows = await store.list.getOrLoad();

      expect(rows[0]).toBe(Settings.instantiate(settings()));
    });

    test("a model with no identity gets fresh instances per row", async () => {
      const Settings = makeModel(SettingsSchema, { keys: false });
      const store = createStore(Settings, {
        collections: { list: () => Promise.resolve([settings()]) },
      });

      await store.list.getOrLoad();
      const held = store.list.value![0]!;
      await store.list.reload();

      expect(store.list.value![0]).not.toBe(held);
    });
  });
});

// ---------------------------------------------------------------------------
// Observability — the default annotation, its per-field override, and the
// subclass path the override deliberately does not cover
// ---------------------------------------------------------------------------

describe("field observability", () => {
  const TaggedSchema = T.Object({
    id: T.Number(),
    name: T.String(),
    tags: T.Array(T.String()),
  });
  const tagged = () => ({ id: 1, name: "Alice", tags: ["a"] });

  test("every field defaults to observable.ref: reassigning is reactive, mutating is not", () => {
    const Model = makeModel(TaggedSchema, { keys: ["id"] as const });
    const m = new Model(tagged());

    const seen: number[] = [];
    autorun(() => seen.push(m.tags.length));

    runInAction(() => m.tags.push("b")); // in-place — invisible under .ref
    expect(seen).toEqual([1]);

    runInAction(() => (m.tags = ["a", "b", "c"])); // whole-value swap — reactive
    expect(seen).toEqual([1, 3]);
  });

  test("annotations upgrades a single field to deep observable", () => {
    const Model = makeModel(TaggedSchema, {
      keys: ["id"] as const,
      annotations: { tags: observable },
    });
    const m = new Model(tagged());

    const seen: number[] = [];
    autorun(() => seen.push(m.tags.length));
    runInAction(() => m.tags.push("b"));

    expect(seen).toEqual([1, 2]);
    // and it still serializes as plain data, not as an observable array
    expect(m.toJSON()).toEqual({ id: 1, name: "Alice", tags: ["a", "b"] });
  });

  test("fields left out of annotations keep the default", () => {
    const Model = makeModel(TaggedSchema, {
      keys: ["id"] as const,
      annotations: { tags: observable },
    });
    const m = new Model(tagged());

    expect(isObservableProp(m, "name")).toBe(true);
    const seen: string[] = [];
    autorun(() => seen.push(m.name));
    runInAction(() => (m.name = "Bob"));
    expect(seen).toEqual(["Alice", "Bob"]);
  });

  test("annotations: false opts a field out of observability", () => {
    const Model = makeModel(TaggedSchema, {
      keys: ["id"] as const,
      annotations: { tags: false },
    });
    const m = new Model(tagged());

    expect(isObservableProp(m, "tags")).toBe(false);
    expect(m.tags).toEqual(["a"]); // still carries its value, and still serializes
    expect(m.toJSON()).toEqual(tagged());
  });

  test("a variant-specific field of a union may be annotated", () => {
    const Schema = T.Union([
      T.Object({ kind: T.Literal("card"), id: T.Number(), digits: T.Array(T.String()) }),
      T.Object({ kind: T.Literal("bank"), id: T.Number(), routing: T.String() }),
    ]);
    const Model = makeUnionModel(Schema, "kind", {
      keys: ["id"] as const,
      annotations: { digits: observable },
    });
    const m = new Model({ kind: "card", id: 1, digits: ["4"] });

    const card = m.as("card")!;
    const seen: number[] = [];
    autorun(() => seen.push(card.digits.length));
    runInAction(() => card.digits.push("2"));

    expect(seen).toEqual([1, 2]);
  });

  test("naming something that is not a schema field throws when the class is built", () => {
    expect(() =>
      // @ts-expect-error `role` is not a field of this schema
      makeModel(TaggedSchema, { keys: ["id"] as const, annotations: { role: observable } }),
    ).toThrow(/not a field of this schema/);

    // built-in members are not annotatable either — setData stays an action
    expect(() =>
      // @ts-expect-error `setData` is not a schema field
      makeModel(TaggedSchema, { keys: ["id"] as const, annotations: { setData: false } }),
    ).toThrow(/not a field of this schema/);
  });

  test("a subclass annotates its own new members with makeObservable", () => {
    const Model = makeModel(TaggedSchema, { keys: ["id"] as const });
    let computes = 0;

    class Draft extends Model {
      note = "";
      get shout(): string {
        computes++;
        return this.name.toUpperCase();
      }
      constructor(data: ReturnType<typeof tagged>) {
        super(data);
        // annotations only — mobx rejects an options object on an already-observable instance
        makeObservable(this, { note: observable, shout: true, setNote: true });
      }
      setNote(note: string): void {
        this.note = note;
      }
    }

    const d = new Draft(tagged());

    const notes: string[] = [];
    autorun(() => notes.push(d.note));
    d.setNote("hi"); // annotated as an action, so no runInAction needed
    expect(notes).toEqual(["", "hi"]);

    autorun(() => d.shout);
    expect(d.shout).toBe("ALICE");
    expect(d.shout).toBe("ALICE");
    expect(computes).toBe(1); // memoized as a computed, not recomputed per read
  });

  test("a subclass cannot re-annotate a schema field — that is what `annotations` is for", () => {
    const Model = makeModel(TaggedSchema, { keys: ["id"] as const });
    class Deep extends Model {
      constructor(data: ReturnType<typeof tagged>) {
        super(data);
        makeObservable(this, { tags: observable });
      }
    }
    expect(() => new Deep(tagged())).toThrow(/tags/);
  });
});

// ---------------------------------------------------------------------------
// updateData — partial, purely local edits
// ---------------------------------------------------------------------------

describe("updateData", () => {
  const Model = makeModel(UserSchema, { keys: ["id"] as const });
  const alice = () => ({ id: 1, name: "Alice", email: "alice@example.com" });

  test("applies a partial patch, leaving other fields alone", () => {
    const m = Model.instantiate(alice());
    m.updateData({ name: "Bob" });
    expect(m.toJSON()).toEqual({ ...alice(), name: "Bob" });
  });

  test("several fields land as one action, so no reaction sees a torn state", () => {
    const m = new Model(alice());
    const seen: string[] = [];
    const stop = autorun(() => seen.push(`${m.name}/${m.email}`));

    m.updateData({ name: "Bob", email: "bob@example.com" });
    stop();

    expect(seen).toEqual(["Alice/alice@example.com", "Bob/bob@example.com"]);
  });

  test("emits no event, so a store listening for updates keeps its lists", () => {
    const events: string[] = [];
    Model.addListener({ onModelEvent: (type) => events.push(type) });

    const m = Model.instantiate(alice());
    m.updateData({ name: "Bob" });

    expect(events).toEqual([]);
  });

  test("does not refresh the load stamp — the record now disagrees with the server", () => {
    const m = new Model(alice());
    const stamp = (m as any)[LOADED_AT];
    m.updateData({ name: "Bob" });
    expect((m as any)[LOADED_AT]).toBe(stamp);
  });

  test("an identity key is not patchable", () => {
    const m = Model.instantiate(alice());
    // @ts-expect-error `id` is an identity key
    expect(() => m.updateData({ id: 99 })).toThrow(/identifies which record this is/);
    // the record is still filed under, and reachable by, its real key
    expect(Model.peek({ id: 1 })).toBe(m);
    // and `buildParams` still addresses the right server record
    expect(m.buildParams()).toEqual({ id: 1 });
  });

  test("a rejected patch applies nothing at all", () => {
    const m = new Model(alice());
    const patch = { name: "Bob", id: 99 } as Record<string, unknown>;
    expect(() => (m as any).updateData(patch)).toThrow(/identifies which record this is/);
    // the valid key was checked, not applied — an action batches, it does not roll back
    expect(m.name).toBe("Alice");
  });

  test("a field outside the schema is a type error, and inert if one slips past", () => {
    const m = new Model(alice());
    // @ts-expect-error `role` is not a schema field
    m.updateData({ role: "admin" });
    // deliberately unguarded: nothing downstream is fooled, `toJSON` simply ignores it
    expect(m.toJSON()).toEqual(alice());
  });

  test("a model with no identity can patch every field", () => {
    const Free = makeModel(UserSchema, { keys: false });
    const m = new Free(alice());
    m.updateData({ id: 99, name: "Bob" }); // no identity map to desync
    expect(m.id).toBe(99);
  });
});

describe("updateData on a union", () => {
  const PaymentSchema = T.Union([
    T.Object({ kind: T.Literal("card"), id: T.Number(), digits: T.String(), label: T.String() }),
    T.Object({ kind: T.Literal("bank"), id: T.Number(), routing: T.String(), label: T.String() }),
  ]);
  const Payment = makeUnionModel(PaymentSchema, "kind", { keys: ["id"] as const });
  const card = () => ({ kind: "card", id: 1, digits: "4242", label: "Visa" }) as const;

  test("a shared field is patchable without narrowing", () => {
    const p = new Payment(card());
    p.updateData({ label: "Personal" });
    expect(p.label).toBe("Personal");
  });

  test("a variant field is unreachable until narrowed", () => {
    const p = new Payment(card());

    // Compile-time guard only: `digits` really is a field of the active variant, so the runtime
    // check has no reason to object. The type is what makes you prove the variant first.
    // @ts-expect-error `digits` is not a shared field, so it is not reachable un-narrowed
    p.updateData({ digits: "1111" });

    const asCard = p.as("card");
    expect(asCard).toBeDefined();
    asCard!.updateData({ digits: "2222" });
    expect(asCard!.digits).toBe("2222");
  });

  test("the other variant's fields stay out of reach even once narrowed", () => {
    const asCard = new Payment(card()).as("card")!;
    // @ts-expect-error `routing` belongs to the bank variant
    asCard.updateData({ routing: "0000" });
    // deliberately unguarded at runtime: `toJSON` strips fields outside the active variant, which
    // is what its `Value.Clean` is already there for
    expect(asCard.toJSON()).toEqual(card());
  });

  test("`is` narrowing reveals the same fields as `as`", () => {
    const p = new Payment(card());
    if (p.is("card")) {
      p.updateData({ digits: "9999" });
      expect(p.digits).toBe("9999");
    } else {
      throw new Error("expected the card variant");
    }
  });

  test("the discriminator is not patchable", () => {
    const p = new Payment(card());
    // @ts-expect-error changing variant is a whole-record replacement, not a patch
    expect(() => p.updateData({ kind: "bank" })).toThrow(/identifies which record this is/);
  });

  test("fields of two variants cannot be mixed in one patch", () => {
    const asCard = new Payment(card()).as("card")!;
    // @ts-expect-error `routing` is not a field of the card variant
    asCard.updateData({ digits: "1111", routing: "2" });
    // the type is the guard; the stray field never reaches a payload
    expect(asCard.toJSON()).toEqual({ ...card(), digits: "1111" });
  });

  test("the discriminator is guarded at runtime, since a bad one invalidates the payload", () => {
    const p = new Payment(card());
    // types cannot see inside a widened object, which is what this check is for: without it
    // `toJSON` would emit `kind: "bank"` still carrying the card's fields
    const patch = { kind: "bank" } as Record<string, unknown>;
    expect(() => (p as any).updateData(patch)).toThrow(/identifies which record this is/);
    expect(p.toJSON()).toEqual(card());
  });

  test("a record patched after a variant switch patches the new variant", () => {
    const p = new Payment(card());
    runInAction(() => p.setData({ kind: "bank", id: 1, routing: "0000", label: "Chase" }));

    p.as("bank")!.updateData({ routing: "9999" });
    expect(p.toJSON()).toEqual({ kind: "bank", id: 1, routing: "9999", label: "Chase" });
  });

  test("toJSON follows the narrowing, as updateData's patch does", () => {
    const p = new Payment(card());

    // un-narrowed, the result is the whole union, so a variant-only field is not reachable —
    // the value is there at runtime, which is the point: only the type was hiding it
    // @ts-expect-error `digits` is not on every variant
    expect(p.toJSON().digits).toBe("4242");

    // narrowed, it is exactly that variant
    const json = p.as("card")!.toJSON();
    expect(json.digits).toBe("4242");

    // and the narrowed result satisfies the variant type in full
    const asVariant: { kind: "card"; id: number; digits: string; label: string } = json;
    expect(asVariant.kind).toBe("card");
  });

  test("toJSON narrows through `is` too", () => {
    const p = new Payment(card());
    if (p.is("card")) {
      expect(p.toJSON().digits).toBe("4242");
    } else {
      throw new Error("expected the card variant");
    }
  });

  test("a patched union still serializes as its own variant only", () => {
    const p = new Payment(card());
    p.as("card")!.updateData({ digits: "1111" });
    expect(p.toJSON()).toEqual({ kind: "card", id: 1, digits: "1111", label: "Visa" });
  });
});
