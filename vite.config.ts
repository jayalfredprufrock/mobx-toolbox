import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {},
  lint: { options: { typeAware: true, typeCheck: true } },
  test: {
    setupFiles: ["./test-setup.ts"],
  },
  pack: {
    minify: false,
    // `neutral` rather than `browser` so `process.env.NODE_ENV` survives into the published
    // chunks and a consumer's bundler can strip development-only code. Under `browser`, rolldown
    // rewrites `process.env` in shared chunks — every shape of the guard folds to `true`, so
    // dev-only code would ship permanently enabled. (Entry-only modules such as the router escape
    // that, which is why its boot validation was unaffected.)
    //
    // Nothing is lost here: `neutral` only changes `mainFields` and the resolve conditions, both
    // of which apply to *bundled* dependencies, and every dependency of this package is a peer
    // and therefore external. Output is byte-identical either way. If a dependency is ever
    // bundled rather than externalized, set `resolve.mainFields` explicitly.
    platform: "neutral",
    dts: { tsgo: true },
    exports: true,
    format: "esm",
    sourcemap: true,
    entry: {
      dialog: "src/dialog/index.ts",
      filter: "src/filter/index.ts",
      form: "src/form/index.ts",
      "lazy-observable": "src/lazy-observable/index.ts",
      model: "src/model/index.ts",
      router: "src/router/index.ts",
      table: "src/table/index.ts",
      uploader: "src/uploader/index.ts",
      util: "src/util/index.ts",
      "react-util": "src/react-util/index.ts",
    },
  },
});
