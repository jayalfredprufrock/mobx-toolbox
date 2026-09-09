import { useCallback } from "react";

/**
 * Combines several refs into one callback ref, so a component can keep its own internal ref while
 * still handing the element to a caller.
 *
 * The point is composition: a component that owns a ref for its own measurement or event wiring
 * can't simply accept a `ref` prop and forward it, because only one can win. Merging lets both
 * hold the same element, which is what makes a component usable as the child of a primitive that
 * needs the DOM node too — `asChild`-style composition being the usual reason.
 *
 * Nulls are skipped, so an optional incoming `ref` needs no guard at the call site. Callback refs
 * get their cleanup handled by React 19's return-value contract; object refs are assigned directly.
 *
 * The merged callback is stable as long as the refs passed in are, so it does not detach and
 * re-attach the element on every render. Pass a stable `ref` from props (React does this already)
 * rather than a fresh inline arrow.
 */
export const useMergedRef = <T>(...refs: (React.Ref<T> | undefined)[]): React.RefCallback<T> =>
  useCallback(
    (node: T | null) => {
      const cleanups: (() => void)[] = [];
      for (const ref of refs) {
        if (!ref) continue;
        if (typeof ref === "function") {
          const cleanup = ref(node);
          if (typeof cleanup === "function") cleanups.push(cleanup);
        } else {
          ref.current = node;
        }
      }
      return () => {
        for (const cleanup of cleanups) cleanup();
      };
    },
    // the ref list *is* the dependency list — a new identity in it should produce a new callback
    refs,
  );
