import { describe, expect, test, vi } from "vite-plus/test";
import * as T from "typebox";
import { makeModel } from "./make-model";
import { makeStore } from "./make-store";

// ---------------------------------------------------------------------------
// Attaching a strongly typed API client directly to the config. The client's
// signatures are the contract; the library adds no convention of its own beyond
// passing the key params object first.
// ---------------------------------------------------------------------------

const UserSchema = T.Object({ id: T.Number(), name: T.String(), email: T.String() });
type User = T.Static<typeof UserSchema>;

type CreateUserBody = { name: string; email: string; password: string };
type UpdateUserBody = { name?: string; email?: string };

const alice: User = { id: 1, name: "Alice", email: "alice@example.com" };

const makeApi = () => ({
  getUser: vi.fn((_params: { id: number }): Promise<User> => Promise.resolve(alice)),
  listUsers: vi.fn((): Promise<User[]> => Promise.resolve([alice])),
  createUser: vi.fn(
    (body: CreateUserBody): Promise<User> => Promise.resolve({ ...alice, ...body, id: 2 }),
  ),
  updateUser: vi.fn(
    (_params: { id: number }, body: UpdateUserBody): Promise<User> =>
      Promise.resolve({ ...alice, ...body }),
  ),
  deleteUser: vi.fn((_params: { id: number }): Promise<void> => Promise.resolve()),
  activateUser: vi.fn((_params: { id: number }): Promise<User> => Promise.resolve(alice)),
  // a params object with optional extras beyond the key
  getUserExpanded: vi.fn(
    (_params: { id: number; expand?: string }): Promise<User> => Promise.resolve(alice),
  ),
});

const setup = () => {
  const api = makeApi();
  const UserModel = makeModel(UserSchema, {
    keys: ["id"] as const,
    get: api.getUser,
    create: api.createUser,
    update: api.updateUser,
    delete: api.deleteUser,
    actions: { activate: api.activateUser },
  });
  const UserStore = class extends makeStore(UserModel) {
    list = this.collection(api.listUsers, { optimisticCreate: true });
  };
  return { api, UserModel, UserStore };
};

describe("api client passthrough", () => {
  test("statics call the client with exactly its own arguments", async () => {
    const { api, UserModel } = setup();

    const user = await UserModel.get({ id: 1 });
    const created = await UserModel.create({ name: "Bo", email: "b@e.com", password: "pw" });

    expect(api.getUser).toHaveBeenCalledWith({ id: 1 });
    expect(api.createUser).toHaveBeenCalledWith({ name: "Bo", email: "b@e.com", password: "pw" });
    expect(user.name).toBe("Alice");
    expect(created.name).toBe("Bo");
  });

  test("instance methods supply the key params and pass the body through", async () => {
    const { api, UserModel } = setup();
    const user = UserModel.instantiate(alice);

    await user.update({ name: "Renamed" });
    await user.activate();
    await user.reload();

    expect(api.updateUser).toHaveBeenCalledWith({ id: 1 }, { name: "Renamed" });
    expect(api.activateUser).toHaveBeenCalledWith({ id: 1 });
    expect(api.getUser).toHaveBeenCalledWith({ id: 1 });
    expect(user.name).toBe("Alice");
  });

  test("the store delegates to the client through the model", async () => {
    const { api, UserStore } = setup();
    const store = new UserStore();

    const all = await store.list.getOrLoad();
    const created = await store.create({ name: "Bo", email: "b@e.com", password: "pw" });

    expect(api.listUsers).toHaveBeenCalledOnce();
    expect(all).toHaveLength(1);
    expect(store.list.value[0]).toBe(created);
  });

  test("delete goes through the client and leaves the collection", async () => {
    const { api, UserStore } = setup();
    const store = new UserStore();
    await store.list.getOrLoad();
    const user = store.list.value[0]!;

    await user.delete();

    expect(api.deleteUser).toHaveBeenCalledWith({ id: 1 });
    expect(store.list.value).toHaveLength(0);
  });

  test("a params object with optional extras beyond the key still attaches", async () => {
    const api = makeApi();
    const Expanded = makeModel(UserSchema, { keys: ["id"] as const, get: api.getUserExpanded });

    await Expanded.get({ id: 1, expand: "roles" });

    expect(api.getUserExpanded).toHaveBeenCalledWith({ id: 1, expand: "roles" });
  });

  test("update's body is the client's type, not any", () => {
    const { UserModel } = setup();
    const user = UserModel.instantiate(alice);

    // valid bodies compile
    void (() => user.update({ name: "Renamed" }));
    void (() => user.update({ email: "e@example.com" }));
    // @ts-expect-error a field the client's update body does not declare
    void (() => user.update({ nope: true }));
    // @ts-expect-error the wrong type for a field the body does declare
    void (() => user.update({ name: 123 }));
    // @ts-expect-error the params object is supplied by the model, not the caller
    void (() => user.update({ id: 1 }, { name: "x" }));

    expect(user.id).toBe(1);
  });

  test("get and create enforce the client's types too", () => {
    const { UserModel } = setup();

    // @ts-expect-error the client's create body requires `password`
    void (() => UserModel.create({ name: "a", email: "e" }));
    // @ts-expect-error the client's get takes the key params object, not a bare id
    void (() => UserModel.get(1));

    expect(UserModel.keys).toEqual(["id"]);
  });
});
