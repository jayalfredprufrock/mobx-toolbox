import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";

/**
 * Every `pack` entry must ship a declaration file next to its `.mjs`.
 *
 * TypeScript resolves `mobx-toolbox/<entry>` to `dist/<entry>.mjs` and then looks for
 * `dist/<entry>.d.mts` beside it. When that file is missing the import still *works* — it is just
 * untyped, silently, with no build error on either side. That is how `mobx-toolbox/lazy` shipped
 * typeless: two entries pointed at the same source module, so the declaration step named one and
 * hashed the other into a shared chunk. Nothing failed; consumers just got `any`.
 *
 * Skipped when `dist/` is absent, so a plain `vp test` on a clean checkout stays green — this is a
 * guard on what was built, not a reason to build.
 */
describe("pack entries", () => {
  const config = readFileSync("vite.config.ts", "utf8");
  const entries = [
    ...config.slice(config.indexOf("entry: {")).matchAll(/^\s*"?([a-z-]+)"?:\s*"src\//gm),
  ].map((m) => m[1] as string);

  test("the entry list was parsed at all", () => {
    // a silent parse failure would make every case below vacuously pass
    expect(entries.length).toBeGreaterThan(5);
    expect(entries).toContain("lazy");
  });

  for (const entry of entries) {
    test(`\`${entry}\` ships types beside its bundle`, ({ skip }) => {
      skip(!existsSync(`dist/${entry}.mjs`), "dist/ not built");
      expect(existsSync(`dist/${entry}.d.mts`)).toBe(true);
    });
  }
});
