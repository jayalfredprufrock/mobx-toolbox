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

type FC<P> = (props: P) => unknown;

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

/**
 * Fold several cases into one program.
 *
 * Every assertion here is a compile-time one, so cases that all expect a clean compile can share a
 * single `tsc` — and they should: spawning one per case costs ~2.3s each, which for a suite this
 * size dominates the entire test run.
 *
 * Each case becomes a labelled block. The label keeps a diagnostic's line pointing at the case that
 * broke, and the block scope lets cases reuse names like `page` without colliding.
 *
 * Cases expecting a *failing* compile cannot be folded in — one error would mask every other case —
 * so those stay on their own.
 */
const batched = (cases: ReadonlyArray<{ name: string; body: string }>): string =>
  cases
    .map(
      ({ name, body }) =>
        `// \u2500\u2500 ${name} \u2500\u2500\n{\n${body.replace(/\bexport (const|type) /g, "$1 ")}\n}`,
    )
    .join("\n\n");

describe.skipIf(!existsSync(tsc))(
  "route definitions under an augmented MobxRouter",
  () => {
    // One program: every entry below lands in the same tree, which is if anything a stronger test
    // of the self-reference than checking them one at a time. TS7022 / TS2456 in the output means
    // the route object resolved to `any`.
    test("redirects and groups in the tree keep it inferable, and paths stay narrowed", () => {
      const diagnostics = typecheck(
        `
  old: { [REDIRECT]: "/about" },
  moved: { [REDIRECT]: { to: "/about", replace: true } },
  legacy: {
    [REDIRECT]: (route) => ({
      to: "/org/:orgId/overview",
      params: { orgId: route.params.orgId },
    }),
  },
  surveys: {
    _list: {
      index: Page,
      published: Page,
    },
    $surveyId: { index: Page },
  },`,
        `
      // ── a group adds no segment of its own ──
      export const grouped = "/surveys/published" satisfies RoutePath;
      export const groupIndex = "/surveys" satisfies RoutePath;
      export const sibling = "/surveys/:surveyId" satisfies RoutePath;
      // @ts-expect-error — the group key appears in no path
      export const literal = "/surveys/_list/published" satisfies RoutePath;

      // ── the augmentation narrows RoutePath to this app's own paths ──
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
const contextFixture = (augmentation: string, entries: string, body = "") => `
import { makeRoutes, CONTEXT, GUARD, LOAD, PAGE } from ${JSON.stringify(join(routerDir, "index"))};
import type { Guard, Loader, RoutePath } from ${JSON.stringify(join(routerDir, "index"))};

const C = () => null;

${augmentation}

export const routes = makeRoutes()({
  [CONTEXT]: { public: false as boolean },
  index: { [PAGE]: C },
  login: { [PAGE]: C },
  org: { $orgId: { index: { [PAGE]: C }, overview: { [PAGE]: C } } },
${entries}
});

declare module ${JSON.stringify(join(routerDir, "types"))} {
  interface MobxRouter {
    routes: typeof routes;
  }
}

// if anything above made the tree self-referential, this collapses to \`any\` and TS7022 fires
export const stillTyped = "/org/:orgId/overview" satisfies RoutePath;

${body}
`;

const AUGMENT = `
declare module ${JSON.stringify(join(routerDir, "types"))} {
  interface MobxRouterContext {
    public: boolean;
    tenant: string;
  }
}
`;

const typecheckContext = (augmentation: string, entries: string, body = ""): string =>
  compile(contextFixture(augmentation, entries, body));

/**
 * The single-file fixtures above cannot catch the cycle that matters: in a real app the route tree
 * *imports* the page components, and the components' props read back through
 * `MobxRouter["routes"]`. Whether that closes depends on whether the component's own type has to be
 * inferred — which is the difference between annotating the const and annotating the parameter.
 *
 * These compile a multi-file app, one file per page, the way it is actually laid out.
 */
const multiFileApp = (dir: string, style: "annotated" | "inline", pages: number): void => {
  const idx = JSON.stringify(join(routerDir, "index"));
  const typesMod = JSON.stringify(join(routerDir, "types"));

  writeFileSync(join(dir, "fc.ts"), `export type FC<P> = (props: P) => unknown;\n`);

  for (let i = 1; i <= pages; i++) {
    const body =
      style === "annotated"
        ? `import type { FC } from "./fc";
import type { PageProps } from ${idx};
export const Page${i}: FC<PageProps<"/org/:orgId/s${i}">> = ({ route }) =>
  route.params.orgId + String(route.data.d${i});
`
        : `import type { PageProps } from ${idx};
export const Page${i} = ({ route }: PageProps<"/org/:orgId/s${i}">) =>
  route.params.orgId + String(route.data.d${i});
`;
    writeFileSync(join(dir, `page${i}.ts`), body);
  }

  const imports = Array.from(
    { length: pages },
    (_, i) => `import { Page${i + 1} } from "./page${i + 1}";`,
  ).join("\n");
  const leaves = Array.from(
    { length: pages },
    (_, i) =>
      `      s${i + 1}: { [PAGE]: Page${i + 1} as any, [LOAD]: async () => ({ d${i + 1}: ${i + 1} }) },`,
  ).join("\n");

  writeFileSync(
    join(dir, "routes.ts"),
    `import { makeRoutes, LOAD, PAGE } from ${idx};
import type { RoutePath } from ${idx};
${imports}
const C = () => null;
export const routes = makeRoutes()({
  index: { [PAGE]: C },
  org: { $orgId: { [LOAD]: async () => ({ org: 1 }),
${leaves}
  } },
});
declare module ${typesMod} { interface MobxRouter { routes: typeof routes } }
// if the tree collapsed to \`any\`, this stops being checked and TS7022 fires above
export const canary = "/org/:orgId/s1" satisfies RoutePath;
`,
  );

  writeFileSync(join(dir, "tsconfig.json"), tsconfig.replace('"fixture.ts"', '"*.ts"'));
};

const compileApp = (style: "annotated" | "inline", pages: number): string => {
  const dir = mkdtempSync(join(tmpdir(), "mobx-router-app-"));
  multiFileApp(dir, style, pages);
  try {
    execFileSync(tsc, ["-p", dir], { encoding: "utf8", stdio: "pipe" });
    return "";
  } catch (e) {
    return String((e as { stdout?: string }).stdout ?? e);
  }
};

describe.skipIf(!existsSync(tsc))(
  "typed props across files, the way an app is laid out",
  () => {
    test("annotating the const holds, however many components use it", () => {
      // five is the interesting count: one component compiles under either form, and it is the
      // second and later that the parameter-annotated version cannot survive
      expect(compileApp("annotated", 5)).toBe("");
    });

    test("annotating the parameter closes the cycle and collapses the tree", () => {
      // Pinned deliberately. This is the form that reads most naturally, compiles in a single file,
      // and takes the whole route tree down in a real one — so the docs steer away from it, and
      // this is what stops the examples drifting back.
      const diagnostics = compileApp("inline", 2);
      expect(diagnostics).toMatch(/TS7022|TS2456|TS2502/);
    });

    test("a makePage(path, component) helper is a dead end, not an alternative", () => {
      const dir = mkdtempSync(join(tmpdir(), "mobx-router-app-"));
      multiFileApp(dir, "annotated", 1);
      writeFileSync(
        join(dir, "page1.ts"),
        `import type { PageProps, RoutePath } from ${JSON.stringify(join(routerDir, "index"))};
const makePage = <P extends RoutePath>(_path: P, c: (p: PageProps<P>) => unknown) => c;
export const Page1 = makePage("/org/:orgId/s1", ({ route }) => route.params.orgId);
`,
      );
      let out = "";
      try {
        execFileSync(tsc, ["-p", dir], { encoding: "utf8", stdio: "pipe" });
      } catch (e) {
        out = String((e as { stdout?: string }).stdout ?? e);
      }
      // `<P extends RoutePath>` is itself a circular constraint
      expect(out).toMatch(/TS2313|TS7022|TS2456/);
    });
  },
  180_000,
);

describe.skipIf(!existsSync(tsc))(
  "context typed by augmentation",
  () => {
    test("guards and loaders read the augmented context, and the tree stays inferable", () => {
      expect(
        typecheckContext(
          AUGMENT,
          // inside the routes literal: this is the placement that would reintroduce the
          // self-reference if the shape came from anywhere near `MobxRouter["routes"]`
          `  [GUARD]: async (route) => {
    const p: boolean = route.context.public;
    const t: string = route.context.tenant;
    void [p, t];
  },
  [LOAD]: async (route) => ({ len: route.context.tenant.length }),`,
          `
      // \u2500\u2500 a wrong type on a known key is caught \u2500\u2500
      export const g1: Guard = async (route) => {
        // @ts-expect-error \`public\` is a boolean
        const p: string = route.context.public;
        void p;
      };

      // \u2500\u2500 an undeclared key is caught \u2500\u2500
      export const g2: Guard = async (route) => {
        // @ts-expect-error never declared on the context
        void route.context.nope;
      };

      // \u2500\u2500 a loader sees it too \u2500\u2500
      export const l1: Loader = async (route) => ({ t: route.context.tenant.length });
    `,
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

/**
 * Every case here expects a clean compile, so they run as one program — see {@link batched}.
 * A regression reports the file and line, and the labelled block above it names the case.
 */
const PROP_CASES = [
  {
    name: "params come from the path",
    body: `
      export const page: FC<PageProps<"/org/:orgId/studies/:studyId">> = (props) => {
        assignable<string>(props.route.params.orgId);
        assignable<string>(props.route.params.studyId);
        // @ts-expect-error — not a param on this path
        props.route.params.nope;
      };`,
  },
  {
    name: "data merges every loader at and above the path, and no others",
    body: `
      export const page: FC<PageProps<"/org/:orgId/studies/:studyId">> = (props) => {
        assignable<{ id: number; title: string }>(props.route.data.study);   // own level
        assignable<{ id: number }[]>(props.route.data.studies);              // parent
        assignable<{ id: string; name: string }>(props.route.data.org);      // grandparent
        assignable<{ id: string }[]>(props.route.data.orgs);                 // above that
        // @ts-expect-error — a sibling branch's loader is not in force here
        props.route.data.prefs;
      };`,
  },
  {
    name: "an index page picks up its own level's loader, not its children's",
    body: `
      export const page: FC<PageProps<"/org/:orgId/studies">> = (props) => {
        assignable<{ id: number }[]>(props.route.data.studies);
        assignable<{ id: string; name: string }>(props.route.data.org);
        // @ts-expect-error — the $studyId child is a descendant, not an ancestor
        props.route.data.study;
      };`,
  },
  {
    name: "a group contributes config without contributing a segment",
    body: `
      export const page: FC<PageProps<"/org/:orgId/exports">> = (props) => {
        assignable<string[]>(props.route.data.exports);                  // the page's own
        assignable<number>(props.route.data.quota);                      // the group's
        assignable<{ id: string; name: string }>(props.route.data.org);  // above the group
        assignable<"reports">(props.route.context.section);
      };`,
  },
  {
    name: "context accumulates the same way data does",
    body: `
      export const page: FC<PageProps<"/org/:orgId/settings">> = (props) => {
        assignable<string>(props.route.context.tenant);
        assignable<{ theme: string }>(props.route.data.prefs);
      };
      export type Ctx = RouteContextAt<"/org/:orgId/settings">;
      export type Data = RouteDataAt<"/org/:orgId/settings">;`,
  },
  {
    name: "a path with no loaders above it has no data",
    body: `
      export const page: FC<PageProps<"/login">> = (props) => {
        // @ts-expect-error — nothing is loaded anywhere on this path
        props.route.data.anything;
      };`,
  },
  {
    name: "a wrapper sits on a prefix, and sees only the data guaranteed there",
    body: `
      export const wrapper: FC<WrapperProps<"/org/:orgId">> = (props) => {
        assignable<string>(props.route.params.orgId);
        assignable<{ id: string; name: string }>(props.route.data.org);
        assignable<{ id: string }[]>(props.route.data.orgs);
        // @ts-expect-error — a descendant's loader is not guaranteed at a prefix
        props.route.data.studies;
      };
      export const prefix: RoutePrefix = "/org/:orgId";`,
  },
  {
    // The shape this exists for: a shell over an inbox + detail pane, reading the detail's param to
    // highlight a row. Sound because params are strings and the set is knowable from the tree.
    name: "a wrapper also sees descendant params, as optional",
    body: `
      export const wrapper: FC<WrapperProps<"/org/:orgId/studies">> = (props) => {
        assignable<string>(props.route.params.orgId);               // at this level: required
        assignable<string | undefined>(props.route.params.studyId); // a descendant's: optional
      };`,
  },
  {
    name: "a descendant param is not required at the wrapper's level",
    body: `
      export const wrapper: FC<WrapperProps<"/org/:orgId/studies">> = (props) => {
        // @ts-expect-error the URL may stop at /org/:orgId/studies, so it can be absent
        assignable<string>(props.route.params.studyId);
      };`,
  },
  {
    name: "a param from an unrelated branch is not offered",
    body: `
      export const wrapper: FC<WrapperProps<"/org/:orgId/studies">> = (props) => {
        // @ts-expect-error :studyId is under studies; nothing else is
        props.route.params.somethingElse;
      };`,
  },
  {
    name: "a page still gets exact params — a descendant's is not in scope",
    body: `
      export const page: FC<PageProps<"/org/:orgId/studies">> = (props) => {
        assignable<string>(props.route.params.orgId);
        // @ts-expect-error the page at this path matched without it
        props.route.params.studyId;
      };`,
  },
  {
    name: "descendant params reach through a group",
    body: `
      export const wrapper: FC<WrapperProps<"/org/:orgId">> = (props) => {
        assignable<string>(props.route.params.orgId);
        assignable<string | undefined>(props.route.params.studyId);
      };`,
  },
  {
    name: "a prefix that addresses no page is rejected as a page path",
    body: `
      // @ts-expect-error — /org/:orgId addresses no page, so it is not a RoutePath
      export const page: FC<PageProps<"/org/:orgId">> = () => {};`,
  },
  {
    name: "mistyped paths are compile errors",
    body: `
      // @ts-expect-error — typo in a segment
      export const a: FC<PageProps<"/org/:orgId/studys/:studyId">> = () => {};
      // @ts-expect-error — wrong param name
      export const b: FC<PageProps<"/org/:orgId/studies/:id">> = () => {};
      // @ts-expect-error — not a path in this tree at all
      export const c: FC<PageProps<"/nope">> = () => {};
      // @ts-expect-error — a wrapper prefix must still be a real prefix
      export const d: FC<WrapperProps<"/org/:orgId/nope">> = () => {};`,
  },
  {
    name: "omitting the path keeps the untyped Route, so existing code is unaffected",
    body: `
      export const page = (props: PageProps) => {
        assignable<Record<string, any>>(props.route.params);
        assignable<Record<string, any>>(props.route.data);
      };
      export const wrapper = (props: WrapperProps) => {
        assignable<Record<string, any>>(props.route.data);
        assignable<React.ReactNode>(props.children);
      };`,
  },
] as const;

describe.skipIf(!existsSync(tsc))(
  "path-parameterised route props",
  () => {
    test("params, data and context resolve against the tree — every case in PROP_CASES", () => {
      expect(typecheckProps(batched(PROP_CASES))).toBe("");
    });
  },
  120_000,
);
