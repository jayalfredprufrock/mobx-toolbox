import { describe, expect, test, vi } from "vite-plus/test";
import * as T from "typebox";
import { autorun } from "mobx";
import { makeModel } from "./make-model";
import { makeStore } from "./make-store";

// ---------------------------------------------------------------------------
// Keyed collections: one list per tenant, per parent record, per page — keys
// the store can't know in advance, so each list is built on first use.
// ---------------------------------------------------------------------------

const SurveySchema = T.Object({
  id: T.Number(),
  orgId: T.String(),
  status: T.String(),
  title: T.String(),
});

const setup = () => {
  let rows = [
    { id: 1, orgId: "acme", status: "draft", title: "Alpha" },
    { id: 2, orgId: "acme", status: "published", title: "Beta" },
    { id: 3, orgId: "globex", status: "draft", title: "Gamma" },
  ];

  const api = {
    list: vi.fn((where: { orgId?: string; status?: string }) =>
      Promise.resolve(
        rows
          .filter((r) => !where.orgId || r.orgId === where.orgId)
          .filter((r) => !where.status || r.status === where.status)
          .map((r) => ({ ...r })),
      ),
    ),
    page: vi.fn((page: number) => Promise.resolve(rows.slice(page * 2, page * 2 + 2))),
    remove: vi.fn(({ id }: { id: number }) => {
      rows = rows.filter((r) => r.id !== id);
      return Promise.resolve();
    }),
    create: vi.fn((body: { orgId: string; status: string; title: string }) => {
      const row = { id: rows.length + 10, ...body };
      rows = [...rows, row];
      return Promise.resolve({ ...row });
    }),
  };

  const SurveyModel = makeModel(SurveySchema, {
    keys: ["id"] as const,
    delete: api.remove,
    create: api.create,
  });

  class Surveys extends makeStore(SurveyModel) {
    byOrg = this.collectionMap(["orgId"], ({ orgId }, options) => api.list({ orgId, ...options }));

    byOrgAndStatus = this.collectionMap(["orgId", "status"], ({ orgId, status }) =>
      api.list({ orgId, status }),
    );

    pages = this.collectionMap((page: number) => api.page(page));
  }

  return { api, SurveyModel, Surveys };
};

describe("collectionMap", () => {
  test("builds one list per key, and hands back the same list every time", async () => {
    const { api, Surveys } = setup();
    const surveys = new Surveys();

    expect(surveys.byOrg({ orgId: "acme" })).toBe(surveys.byOrg({ orgId: "acme" }));
    expect(surveys.byOrg({ orgId: "acme" })).not.toBe(surveys.byOrg({ orgId: "globex" }));

    // Building a list doesn't fetch; a lazy still waits to be asked.
    expect(api.list).not.toHaveBeenCalled();

    await surveys.byOrg({ orgId: "acme" }).getOrLoad();
    expect(surveys.byOrg({ orgId: "acme" }).value!.map((s) => s.title)).toEqual(["Alpha", "Beta"]);

    await surveys.byOrg({ orgId: "globex" }).getOrLoad();
    expect(surveys.byOrg({ orgId: "globex" }).value!.map((s) => s.title)).toEqual(["Gamma"]);

    // acme's list is still loaded — the point of keying rather than refetching one list.
    expect(surveys.byOrg({ orgId: "acme" }).loaded).toBe(true);
  });

  test("only the declared fields select a list, so a whole record works as the key", async () => {
    const { Surveys } = setup();
    const surveys = new Surveys();
    const list = await surveys.byOrg({ orgId: "acme" }).getOrLoad();

    // A model carries every field; only `orgId` is read, so it lands on the same list.
    expect(surveys.byOrg(list[0]!)).toBe(surveys.byOrg({ orgId: "acme" }));
  });

  test("several fields make one key", async () => {
    const { Surveys } = setup();
    const surveys = new Surveys();

    await surveys.byOrgAndStatus({ orgId: "acme", status: "draft" }).getOrLoad();
    expect(surveys.byOrgAndStatus({ orgId: "acme", status: "draft" }).value).toHaveLength(1);

    expect(surveys.byOrgAndStatus({ orgId: "acme", status: "draft" })).not.toBe(
      surveys.byOrgAndStatus({ orgId: "acme", status: "published" }),
    );
  });

  test("a free-form key needs no fields", async () => {
    const { Surveys } = setup();
    const surveys = new Surveys();

    await surveys.pages(0).getOrLoad();
    expect(surveys.pages(0).value).toHaveLength(2);
    expect(surveys.pages(0)).toBe(surveys.pages(0));
    expect(surveys.pages(0)).not.toBe(surveys.pages(1));
  });

  test("keyOf spells a key a map can't hold as it stands", async () => {
    const { api, SurveyModel } = setup();
    class Filtered extends makeStore(SurveyModel) {
      byFilter = this.collectionMap(
        (filter: { orgId: string; status: string }) => api.list(filter),
        {
          keyOf: (filter) => `${filter.orgId}/${filter.status}`,
        },
      );
    }
    const surveys = new Filtered();

    expect(surveys.byFilter({ orgId: "acme", status: "draft" })).toBe(
      surveys.byFilter({ orgId: "acme", status: "draft" }),
    );
    expect(surveys.byFilter({ orgId: "acme", status: "draft" })).not.toBe(
      surveys.byFilter({ orgId: "acme", status: "published" }),
    );
  });

  test("a deletion drops the model from every key's list", async () => {
    const { Surveys } = setup();
    const surveys = new Surveys();
    await surveys.byOrg({ orgId: "acme" }).getOrLoad();
    await surveys.byOrgAndStatus({ orgId: "acme", status: "draft" }).getOrLoad();

    const alpha = surveys.byOrg({ orgId: "acme" }).value!.find((s) => s.title === "Alpha")!;
    await alpha.delete();

    expect(surveys.byOrg({ orgId: "acme" }).value!.map((s) => s.title)).toEqual(["Beta"]);
    expect(surveys.byOrgAndStatus({ orgId: "acme", status: "draft" }).value).toHaveLength(0);
  });

  test("a create marks every key's list stale", async () => {
    const { api, Surveys } = setup();
    const surveys = new Surveys();
    const acme = surveys.byOrg({ orgId: "acme" });
    const globex = surveys.byOrg({ orgId: "globex" });
    const stop = autorun(() => void [acme.value?.slice(), globex.value?.slice()]);
    await vi.waitUntil(() => acme.loaded && globex.loaded);
    api.list.mockClear();

    await surveys.create({ orgId: "acme", status: "draft", title: "Delta" });

    // Both refetch: only the server knows which lists a new record belongs to.
    await vi.waitUntil(() => api.list.mock.calls.length === 2);
    expect(acme.value!.map((s) => s.title)).toEqual(["Alpha", "Beta", "Delta"]);
    stop();
  });

  test("invalidateCollections reaches keyed lists", async () => {
    const { api, Surveys } = setup();
    const surveys = new Surveys();
    const acme = surveys.byOrg({ orgId: "acme" });
    const stop = autorun(() => void acme.value?.slice());
    await vi.waitUntil(() => acme.loaded);
    api.list.mockClear();

    surveys.invalidateCollections();

    await vi.waitUntil(() => api.list.mock.calls.length === 1);
    stop();
  });

  test("an unobserved list holds nothing: the shell is all that is kept", async () => {
    const { api, Surveys } = setup();
    const surveys = new Surveys();
    const acme = surveys.byOrg({ orgId: "acme" });

    const stop = autorun(() => void acme.value?.slice());
    await vi.waitUntil(() => acme.loaded);
    expect(api.list).toHaveBeenCalledTimes(1);

    // Nothing is watching any more: `keepOnUnobserved` is false, so the rows go and the list is
    // back to where it started — holding nothing, which is not the same as holding no rows. The
    // map retains an empty shell, not a cached collection.
    stop();
    expect(acme.value).toBeUndefined();
    expect(acme.loaded).toBe(false);
    expect(acme.fetching).toBe(false);
    expect(acme.fetchedAt).toBeUndefined();

    // Observing again is a fresh request, exactly as a first load is.
    const restart = autorun(() => void acme.value?.slice());
    await vi.waitUntil(() => acme.loaded);
    expect(api.list).toHaveBeenCalledTimes(2);
    restart();
  });

  test("forget drops a key's list and unregisters it", async () => {
    const { Surveys } = setup();
    const surveys = new Surveys();
    const before = surveys.byOrg({ orgId: "acme" });
    await before.getOrLoad();

    expect(surveys.byOrg.forget({ orgId: "acme" })).toBe(true);
    expect(surveys.byOrg.forget({ orgId: "acme" })).toBe(false);

    const after = surveys.byOrg({ orgId: "acme" });
    expect(after).not.toBe(before);
    expect(after.loaded).toBe(false);
    expect(after.fetching).toBe(false);

    // The forgotten list no longer follows the store: a deletion leaves it untouched.
    await after.getOrLoad();
    const model = after.value![0]!;
    surveys.byOrg.clear();
    await model.delete();
    expect(after.value).toContain(model);
  });
});
