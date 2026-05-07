import { defineConfig } from "vite-plus";
import babel from "@rolldown/plugin-babel";

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
    exports: true,
    format: "esm",
    sourcemap: true,
    entry: {
      dialog: "src/dialog/index.ts",
      form: "src/form/index.ts",
      router: "src/router/index.ts",
      util: "src/util/index.ts",
      "react-util": "src/react-util/index.ts",
    },
    plugins: [
      babel({
        presets: [
          {
            preset: () => ({
              plugins: [["@babel/plugin-proposal-decorators", { version: "2023-11" }]],
            }),
            rolldown: { filter: { code: "@" } },
          },
        ],
      }),
    ],
  },
});
