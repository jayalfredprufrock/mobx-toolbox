import { useLayoutEffect, useRef } from "react";

export interface UseResizeOptions {
  /**
   * Which box to report. Defaults to `"content"`.
   *
   * `"border"` includes padding and border, and is what you want when the number has to account
   * for space a *consumer* controls — measuring an element whose padding is part of the layout
   * budget, for instance. A padding change alters the border-box size, so the observer fires on it
   * and the measurement stays complete with no extra trigger.
   *
   * It still can't see a *margin*, which sits outside the border box. If margins matter, they have
   * to be part of the contract rather than measured.
   */
  box?: "content" | "border";
}

/**
 * Reports an element's size whenever it changes, including the initial measurement.
 *
 * The default content box means padding, border and scrollbars are all excluded — so a width fed
 * back into layout math can't feed back into its own overflow, and a gutter appearing or
 * disappearing is reported as a real size change. Pass `{ box: "border" }` when padding and border
 * should be included instead. Values are fractional; round at the point of use if you need
 * integers.
 *
 * `onResize` is read through a ref, so passing an inline arrow does not tear down and re-create the
 * observer on every render.
 */
export const useResize = (
  ref: React.RefObject<HTMLElement | null>,
  onResize: (width: number, height: number) => void,
  options?: UseResizeOptions,
): void => {
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;

  const box = options?.box ?? "content";

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }

    if (typeof ResizeObserver !== "function") {
      // Fallback for environments without ResizeObserver. `clientWidth`/`clientHeight` are the
      // padding box (scrollbars already excluded), so the content-box path over-reports by any
      // padding — close enough for a path no supported browser takes. `offsetWidth`/`offsetHeight`
      // are the border box exactly.
      const handleResize = () =>
        box === "border"
          ? onResizeRef.current(el.offsetWidth, el.offsetHeight)
          : onResizeRef.current(el.clientWidth, el.clientHeight);
      handleResize();
      window.addEventListener("resize", handleResize);
      return () => window.removeEventListener("resize", handleResize);
    }

    // The initial observation is delivered before the first paint, so no eager measure is needed.
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      if (box === "border") {
        // `borderBoxSize` is an array (one entry per fragment); a non-fragmented element has one.
        // Its inline/block axes map to width/height in the default writing mode. Falling back to
        // the offset dimensions keeps this correct where the observer predates `borderBoxSize`.
        const size = entry.borderBoxSize?.[0];
        onResizeRef.current(size?.inlineSize ?? el.offsetWidth, size?.blockSize ?? el.offsetHeight);
        return;
      }
      onResizeRef.current(entry.contentRect.width, entry.contentRect.height);
    });

    observer.observe(el, box === "border" ? { box: "border-box" } : undefined);
    return () => observer.disconnect();
  }, [ref, box]);
};
