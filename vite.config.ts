import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {},
  lint: { options: { typeAware: true, typeCheck: true } },
  pack: {
    minify: true,
    platform: "browser",
    dts: { tsgo: true },
    exports: {
      devExports: true,
    },
    format: "esm",
    sourcemap: true,
    entry: {
      "mobx-dialog": "src/mobx-dialog/index.ts",
      "mobx-form": "src/mobx-form/index.ts",
      "mobx-router": "src/mobx-router/index.ts",
      "mobx-util": "src/mobx-util/index.ts",
      "react-util": "src/react-util/index.ts",
    },
  },
});
