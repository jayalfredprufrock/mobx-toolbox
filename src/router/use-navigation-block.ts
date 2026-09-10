import { useEffect, useRef } from "react";
import { useRouter } from "./components/router";
import type { NavigationBlocker } from "./types";

/**
 * Blocks navigation away from this component while `when` returns `true`,
 * asking `blocker` what to do about each attempt.
 *
 * ```tsx
 * useNavigationBlock(
 *   () => designer.dirty,
 *   async () => {
 *     const choice = await confirmLeave(); // the app's own dialog
 *     if (choice === "save") await designer.save();
 *     return choice !== "stay";
 *   },
 * );
 * ```
 *
 * Only `true` proceeds — `false`, nothing at all, and a throw each keep the
 * user where they are. `RouterStore.block` documents exactly what is and is
 * not covered; the short version is every in-app navigation plus closing the
 * tab, but not the back button (see `useConfirmLeave` for that).
 *
 * Both arguments are read through a ref, so neither has to be stable:
 * passing inline closures re-registers nothing, and the registration lasts
 * the component's lifetime. Blocking follows `when`, not the mount, so a
 * clean form is as good as no blocker at all — including for the
 * `beforeunload` prompt.
 */
export const useNavigationBlock = (when: () => boolean, blocker: NavigationBlocker): void => {
  const router = useRouter();

  // written during render like `useStable` does: what the effect below reads
  // is always the latest pair, so a dialog closure never goes stale
  const latest = useRef({ when, blocker });
  latest.current = { when, blocker };

  useEffect(
    () =>
      router.block(
        () => latest.current.when(),
        (navigation) => latest.current.blocker(navigation),
      ),
    [router],
  );
};
