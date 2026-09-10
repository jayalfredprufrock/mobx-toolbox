import { useEffect } from "react";
import { useRouter } from "./components/router";
import type { RouterStore } from "./router.store";

const DEFAULT_MESSAGE = "Leave this page? Changes you have made may not be saved.";

/**
 * Native `confirm()` protection against leaving the page, however the user
 * leaves it — links, programmatic navigation, back and forward, and closing
 * or reloading the tab.
 *
 * The deliberately dumb counterpart to `RouterStore.block`: no predicate, no
 * dialog of your own, nothing to keep in step. It protects for as long as it
 * is registered, and returns the disposer.
 *
 * ```ts
 * const dispose = confirmLeave(router);
 * ```
 *
 * It *is* a `block`, so everything documented there applies unchanged. The
 * only thing this trades away is the dialog: the prompts are native chrome,
 * and both ignore `message` in some form — every browser ignores a custom
 * `beforeunload` string, and `confirm()` renders as the browser draws it.
 *
 * The always-true predicate means the browser's own reload prompt is live
 * for as long as this is registered, clean page included. That is the point
 * of the shortcut — there is no state for it to consult — but it is why
 * `useNavigationBlock` is the better default for a form.
 */
export const confirmLeave = (router: RouterStore, message = DEFAULT_MESSAGE): (() => void) =>
  router.block(
    () => true,
    () => window.confirm(message),
  );

/**
 * {@link confirmLeave} for the lifetime of a component — basic unsaved-work
 * protection in one line, with no state to track and no dialog to write.
 *
 * ```tsx
 * useConfirmLeave("Discard your changes?");
 * ```
 *
 * Reach for `useNavigationBlock` instead when the block should follow a
 * predicate or show the app's own dialog — back button included.
 */
export const useConfirmLeave = (message?: string): void => {
  const router = useRouter();

  useEffect(() => confirmLeave(router, message), [router, message]);
};
