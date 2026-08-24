import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";

/**
 * `RoutePath` is derived from the augmented `MobxRouter["routes"]` — the very
 * object `makeRoutes()` is inferring. So any type reachable from `Routes` that
 * names `RoutePath` makes the `R extends Routes` constraint depend on
 * `typeof routes` while inferring `typeof routes`. The route tree then
 * collapses to `any` with TS7022, and every typed path in the app goes with
 * it. See the note on `RedirectTarget`.
 *
 * The rest of this suite cannot catch that: nothing here augments
 * `MobxRouter`, and doing so would retype every path in every other test
 * file. So this compiles a throwaway fixture — an app-shaped augmentation —
 * in its own program.
 */

const routerDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const tsc = resolve(routerDir, "../../node_modules/.bin/tsc");

/**
 * `entries` land **inside** the augmented route tree, which is what makes the
 * cycle reachable: the constraint check on this object is what has to resolve
 * `RoutePath`, and `RoutePath` is derived from this object. A `[REDIRECT]` in
 * some *other* `makeRoutes()` call resolves fine — by then `typeof routes` is
 * already known — so a fixture that put them there would pass either way.
 */
const fixture = (entries: string, body = "") => `
import { makeRoutes, redirect, REDIRECT } from ${JSON.stringify(join(routerDir, "index"))};
import type { RoutePath } from ${JSON.stringify(join(routerDir, "index"))};

const Page = () => null;

export const routes = makeRoutes()({
  index: Page,
  about: Page,
  org: {
    $orgId: {
      index: Page,
      overview: Page,
    },
  },
${entries}
});

declare module ${JSON.stringify(join(routerDir, "types"))} {
  interface MobxRouter {
    routes: typeof routes;
  }
}

${body}
`;

/**
 * A second fixture for the path-parameterised props. The tree above is deliberately minimal; typed
 * `data` and `context` need loaders, a group, and a level that carries a `[WRAPPER]` while
 * addressing no page of its own.
 */
const propsFixture = (body: string) => `
import { makeRoutes, CONTEXT, LOAD, PAGE, WRAPPER } from ${JSON.stringify(join(routerDir, "index"))};
import type {
  PageProps,
  RouteContextAt,
  RouteDataAt,
  RoutePrefix,
  WrapperProps,
} from ${JSON.stringify(join(routerDir, "index"))};

const C = () => null;

export const routes = makeRoutes()({
  index: { [PAGE]: C },
  login: { [PAGE]: C },
  org: {
    [CONTEXT]: { tenant: "" as string },
    [WRAPPER]: C,
    [LOAD]: async () => ({ orgs: [{ id: "1" }] }),
    $orgId: {
      [LOAD]: async () => ({ org: { id: "1", name: "Acme" } }),
      [WRAPPER]: C,
      settings: { [PAGE]: C, [LOAD]: async () => ({ prefs: { theme: "dark" } }) },
      studies: {
        [LOAD]: async () => ({ studies: [{ id: 1 }] }),
        index: { [PAGE]: C },
        $studyId: { [PAGE]: C, [LOAD]: async () => ({ study: { id: 1, title: "x" } }) },
      },
      _reports: {
        [LOAD]: async () => ({ quota: 10 }),
        [CONTEXT]: { section: "reports" as const },
        exports: { [PAGE]: C, [LOAD]: async () => ({ exports: ["a"] }) },
      },
    },
  },
});

declare module ${JSON.stringify(join(routerDir, "types"))} {
  interface MobxRouter {
    routes: typeof routes;
  }
}

const assignable = <Expected,>(_v: Expected): void => {};
void assignable;

${body}
`;

const tsconfig = JSON.stringify({
  compilerOptions: {
    lib: ["es2022", "DOM", "DOM.Iterable"],
    module: "esnext",
    moduleResolution: "bundler",
    target: "es2022",
    strict: true,
    jsx: "react-jsx",
    noEmit: true,
    skipLibCheck: true,
    esModuleInterop: true,
    noUncheckedIndexedAccess: true,
    types: [],
  },
  include: ["fixture.ts"],
});

/** Compiles a fixture in its own program and returns tsc's diagnostics. */
const compile = (source: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "mobx-router-types-"));
  writeFileSync(join(dir, "fixture.ts"), source);
  writeFileSync(join(dir, "tsconfig.json"), tsconfig);

  try {
    execFileSync(tsc, ["-p", dir], { encoding: "utf8", stdio: "pipe" });
    return "";
  } catch (e) {
    // tsc exits non-zero with diagnostics on stdout
    return String((e as { stdout?: string }).stdout ?? e);
  }
};

const typecheck = (entries: string, body?: string): string => compile(fixture(entries, body));
const typecheckProps = (body: string): string => compile(propsFixture(body));

describe.skipIf(!existsSync(tsc))(
  "route definitions under an augmented MobxRouter",
  () => {
    test("a [REDIRECT] string in the tree does not make it self-referential", () => {
      // TS7022 / TS2456 here mean the route object resolved to `any`
      expect(typecheck(`  old: { [REDIRECT]: "/about" },`)).toBe("");
    });

    test("a [REDIRECT] options object in the tree does not make it self-referential", () => {
      expect(typecheck(`  moved: { [REDIRECT]: { to: "/about", replace: true } },`)).toBe("");
    });

    test("a [REDIRECT] function in the tree does not make it self-referential", () => {
      expect(
        typecheck(`
  legacy: {
    [REDIRECT]: (route) => ({
      to: "/org/:orgId/overview",
      params: { orgId: route.params.orgId },
    }),
  },`),
      ).toBe("");
    });

    test("a route group in the tree neither adds a segment nor breaks inference", () => {
      const diagnostics = typecheck(
        `
  surveys: {
    _list: {
      index: Page,
      published: Page,
    },
    $surveyId: { index: Page },
  },`,
        `
      export const grouped = "/surveys/published" satisfies RoutePath;
      export const groupIndex = "/surveys" satisfies RoutePath;
      export const sibling = "/surveys/:surveyId" satisfies RoutePath;
      // @ts-expect-error — the group key appears in no path
      export const literal = "/surveys/_list/published" satisfies RoutePath;
    `,
      );

      expect(diagnostics).toBe("");
    });

    test("the augmentation still narrows RoutePath to the app's own paths", () => {
      const diagnostics = typecheck(
        `  old: { [REDIRECT]: "/about" },`,
        `
      export const known = "/org/:orgId/overview" satisfies RoutePath;
      export const withParams = redirect({ to: "/org/:orgId/overview", params: { orgId: "7" } });
      // @ts-expect-error — not a path in this route tree
      export const unknown = "/nope" satisfies RoutePath;
      // @ts-expect-error — a dynamic path requires params at real call sites
      export const missingParams = redirect({ to: "/org/:orgId/overview" });
    `,
      );

      // an unsatisfied @ts-expect-error reports too, so this fails in both
      // directions: paths going unchecked, and valid paths being rejected
      expect(diagnostics).toBe("");
    });
  },
  120_000,
);

/**
 * A guard or loader cannot name a path-derived type — both live inside the object `makeRoutes()` is
 * inferring, and the computed types derive from that same object. `MobxRouterContext` is a
 * standalone interface, so it reaches the one place the computed types can't. These pin that it
 * types the context *and* that it does not reintroduce the self-reference.
 */
const contextFixture = (augmentation: string, body: string) => `
import { makeRoutes, CONTEXT, GUARD, LOAD, PAGE } from ${JSON.stringify(join(routerDir, "index"))};
import type { RoutePath } from ${JSON.stringify(join(routerDir, "index"))};

const C = () => null;

${augmentation}

export const routes = makeRoutes()({
  [CONTEXT]: { public: false as boolean },
  index: { [PAGE]: C },
  login: { [PAGE]: C },
  org: { $orgId: { index: { [PAGE]: C }, overview: { [PAGE]: C } } },
${body}
});

declare module ${JSON.stringify(join(routerDir, "types"))} {
  interface MobxRouter {
    routes: typeof routes;
  }
}

// if anything above made the tree self-referential, this collapses to \`any\` and TS7022 fires
export const stillTyped = "/org/:orgId/overview" satisfies RoutePath;
`;

const AUGMENT = `
declare module ${JSON.stringify(join(routerDir, "types"))} {
  interface MobxRouterContext {
    public: boolean;
    tenant: string;
  }
}
`;

const typecheckContext = (augmentation: string, body: string): string =>
  compile(contextFixture(augmentation, body));

describe.skipIf(!existsSync(tsc))(
  "context typed by augmentation",
  () => {
    test("a guard reads the augmented context, and the tree stays inferable", () => {
      expect(
        typecheckContext(
          AUGMENT,
          `  [GUARD]: async (route) => {
    const p: boolean = route.context.public;
    const t: string = route.context.tenant;
    void [p, t];
  },`,
        ),
      ).toBe("");
    });

    test("a loader reads it too", () => {
      expect(
        typecheckContext(
          AUGMENT,
          `  [LOAD]: async (route) => ({ len: route.context.tenant.length }),`,
        ),
      ).toBe("");
    });

    test("a wrong type on a known key is caught", () => {
      expect(
        typecheckContext(
          AUGMENT,
          `  [GUARD]: async (route) => {
    // @ts-expect-error \`public\` is a boolean
    const p: string = route.context.public;
    void p;
  },`,
        ),
      ).toBe("");
    });

    test("an undeclared key is caught", () => {
      expect(
        typecheckContext(
          AUGMENT,
          `  [GUARD]: async (route) => {
    // @ts-expect-error never declared on the context
    void route.context.nope;
  },`,
        ),
      ).toBe("");
    });

    test("without the augmentation the context stays untyped, as before", () => {
      expect(
        typecheckContext(
          "",
          `  [GUARD]: async (route) => {
    const anything: string = route.context.whatever;
    void anything;
  },`,
        ),
      ).toBe("");
    });

    test("a path-derived type in a guard still collapses the tree — the reason this exists", () => {
      // not a regression: the self-reference is structural. This pins *why* the augmentation
      // route is the one that works, so nobody 'fixes' it by reaching for the computed types.
      const diagnostics = typecheckContext(
        AUGMENT,
        `  [GUARD]: async (route: import(${JSON.stringify(join(routerDir, "index"))}).RouteAt<"/">) => {
    void route.context;
  },`,
      );
      expect(diagnostics).toMatch(/TS7022|TS2456|TS2502/);
    });
  },
  120_000,
);

describe.skipIf(!existsSync(tsc))(
  "path-parameterised route props",
  () => {
    test("params come from the path", () => {
      expect(
        typecheckProps(`
      export const page = (props: PageProps<"/org/:orgId/studies/:studyId">) => {
        assignable<string>(props.route.params.orgId);
        assignable<string>(props.route.params.studyId);
        // @ts-expect-error — not a param on this path
        props.route.params.nope;
      };
    `),
      ).toBe("");
    });

    test("data merges every loader at and above the path, and no others", () => {
      expect(
        typecheckProps(`
      export const page = (props: PageProps<"/org/:orgId/studies/:studyId">) => {
        assignable<{ id: number; title: string }>(props.route.data.study);   // own level
        assignable<{ id: number }[]>(props.route.data.studies);              // parent
        assignable<{ id: string; name: string }>(props.route.data.org);      // grandparent
        assignable<{ id: string }[]>(props.route.data.orgs);                 // above that
        // @ts-expect-error — a sibling branch's loader is not in force here
        props.route.data.prefs;
      };
    `),
      ).toBe("");
    });

    test("an index page picks up its own level's loader, not its children's", () => {
      expect(
        typecheckProps(`
      export const page = (props: PageProps<"/org/:orgId/studies">) => {
        assignable<{ id: number }[]>(props.route.data.studies);
        assignable<{ id: string; name: string }>(props.route.data.org);
        // @ts-expect-error — the $studyId child is a descendant, not an ancestor
        props.route.data.study;
      };
    `),
      ).toBe("");
    });

    test("a group contributes config without contributing a segment", () => {
      expect(
        typecheckProps(`
      export const page = (props: PageProps<"/org/:orgId/exports">) => {
        assignable<string[]>(props.route.data.exports);                  // the page's own
        assignable<number>(props.route.data.quota);                      // the group's
        assignable<{ id: string; name: string }>(props.route.data.org);  // above the group
        assignable<"reports">(props.route.context.section);
      };
    `),
      ).toBe("");
    });

    test("context accumulates the same way data does", () => {
      expect(
        typecheckProps(`
      export const page = (props: PageProps<"/org/:orgId/settings">) => {
        assignable<string>(props.route.context.tenant);
        assignable<{ theme: string }>(props.route.data.prefs);
      };
      export type Ctx = RouteContextAt<"/org/:orgId/settings">;
      export type Data = RouteDataAt<"/org/:orgId/settings">;
    `),
      ).toBe("");
    });

    test("a path with no loaders above it has no data", () => {
      expect(
        typecheckProps(`
      export const page = (props: PageProps<"/login">) => {
        // @ts-expect-error — nothing is loaded anywhere on this path
        props.route.data.anything;
      };
    `),
      ).toBe("");
    });

    test("a wrapper sits on a prefix, and sees only what is guaranteed there", () => {
      expect(
        typecheckProps(`
      export const wrapper = (props: WrapperProps<"/org/:orgId">) => {
        assignable<string>(props.route.params.orgId);
        assignable<{ id: string; name: string }>(props.route.data.org);
        assignable<{ id: string }[]>(props.route.data.orgs);
        // @ts-expect-error — a descendant's loader is not guaranteed at a prefix
        props.route.data.studies;
      };
      export const prefix: RoutePrefix = "/org/:orgId";
    `),
      ).toBe("");
    });

    test("a prefix that addresses no page is rejected as a page path", () => {
      expect(
        typecheckProps(`
      // @ts-expect-error — /org/:orgId addresses no page, so it is not a RoutePath
      export const page = (_p: PageProps<"/org/:orgId">) => {};
    `),
      ).toBe("");
    });

    test("mistyped paths are compile errors", () => {
      expect(
        typecheckProps(`
      // @ts-expect-error — typo in a segment
      export const a = (_p: PageProps<"/org/:orgId/studys/:studyId">) => {};
      // @ts-expect-error — wrong param name
      export const b = (_p: PageProps<"/org/:orgId/studies/:id">) => {};
      // @ts-expect-error — not a path in this tree at all
      export const c = (_p: PageProps<"/nope">) => {};
      // @ts-expect-error — a wrapper prefix must still be a real prefix
      export const d = (_p: WrapperProps<"/org/:orgId/nope">) => {};
    `),
      ).toBe("");
    });

    test("omitting the path keeps the untyped Route, so existing code is unaffected", () => {
      expect(
        typecheckProps(`
      export const page = (props: PageProps) => {
        assignable<Record<string, any>>(props.route.params);
        assignable<Record<string, any>>(props.route.data);
      };
      export const wrapper = (props: WrapperProps) => {
        assignable<Record<string, any>>(props.route.data);
        assignable<React.ReactNode>(props.children);
      };
    `),
      ).toBe("");
    });
  },
  120_000,
);
