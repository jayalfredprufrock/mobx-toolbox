import { useLayoutEffect, useRef } from "react";

/**
 * Reports an element's **content-box** size whenever it changes, including the initial measurement.
 *
 * Content box means padding, border and scrollbars are all excluded — so a width fed back into
 * layout math can't feed back into its own overflow, and a gutter appearing or disappearing is
 * reported as a real size change. Values are fractional; round at the point of use if you need
 * integers.
 *
 * `onResize` is read through a ref, so passing an inline arrow does not tear down and re-create the
 * observer on every render.
 */
export const useResize = (
  ref: React.RefObject<HTMLElement | null>,
  onResize: (width: number, height: number) => void,
): void => {
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }

    if (typeof ResizeObserver !== "function") {
      // Fallback for environments without ResizeObserver. `clientWidth`/`clientHeight` are the
      // padding box (scrollbars already excluded), so this over-reports by any padding — close
      // enough for a path no supported browser takes.
      const handleResize = () => onResizeRef.current(el.clientWidth, el.clientHeight);
      handleResize();
      window.addEventListener("resize", handleResize);
      return () => window.removeEventListener("resize", handleResize);
    }

    // The initial observation is delivered before the first paint, so no eager measure is needed.
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        onResizeRef.current(entry.contentRect.width, entry.contentRect.height);
      }
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
};
