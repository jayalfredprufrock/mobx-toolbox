/**
 * The pre-rename import path, `mobx-toolbox/lazy-observable`.
 *
 * A distinct module rather than a second `pack` entry pointing at `index.ts`: two entries resolving
 * to the *same* source file make the declaration step treat one as the entry and hash the other
 * into a shared chunk, which left `dist/lazy.mjs` with no adjacent `lazy.d.mts` and the new path
 * importing untyped. One file each, one `.d.mts` each.
 *
 * **Delete at 1.0**, with `deprecated.ts` and the `lazy-observable` entry in `vite.config.ts`.
 */
export * from "./index";
