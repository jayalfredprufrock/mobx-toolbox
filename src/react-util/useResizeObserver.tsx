import { useCallback, useLayoutEffect, useRef } from "react";

export const useResizeObserver = (
  ref: React.MutableRefObject<HTMLElement | null>,
  onResize: (width: number, height: number) => void,
): void => {
  const onResizeRef = useRef(onResize);
  const handleResize = useCallback(() => {
    if (ref.current) {
      onResizeRef.current(ref.current.clientWidth, ref.current.clientHeight);
    }
  }, [ref]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }

    handleResize();

    if (typeof ResizeObserver === "function") {
      const resizeObserver = new ResizeObserver(() => handleResize());

      resizeObserver.observe(el);

      return () => resizeObserver.disconnect();
    } else {
      window.addEventListener("resize", handleResize);

      return () => window.window.removeEventListener("resize", handleResize);
    }
  }, [ref, handleResize]);
};
