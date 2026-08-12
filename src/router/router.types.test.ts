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

/** Compiles the fixture in its own program and returns tsc's diagnostics. */
const typecheck = (entries: string, body?: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "mobx-router-types-"));
  writeFileSync(join(dir, "fixture.ts"), fixture(entries, body));
  writeFileSync(join(dir, "tsconfig.json"), tsconfig);

  try {
    execFileSync(tsc, ["-p", dir], { encoding: "utf8", stdio: "pipe" });
    return "";
  } catch (e) {
    // tsc exits non-zero with diagnostics on stdout
    return String((e as { stdout?: string }).stdout ?? e);
  }
};

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
