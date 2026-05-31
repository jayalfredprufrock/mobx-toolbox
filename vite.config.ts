import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {},
  lint: { options: { typeAware: true, typeCheck: true } },
  pack: {
    minify: false,
    platform: "browser",
    dts: { tsgo: true },
    exports: true,
    format: "esm",
    sourcemap: true,
    entry: {
      dialog: "src/dialog/index.ts",
      form: "src/form/index.ts",
      "lazy-observable": "src/lazy-observable/index.ts",
      model: "src/model/index.ts",
      router: "src/router/index.ts",
      util: "src/util/index.ts",
      "react-util": "src/react-util/index.ts",
    },
  },
});
