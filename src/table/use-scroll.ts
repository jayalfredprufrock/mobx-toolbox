import { useEffect, useRef } from "react";

/**
 * Reports a scroll container's offsets on every scroll event.
 *
 * `onScroll` is read through a ref so an inline arrow doesn't re-subscribe on every render — the
 * table's root re-renders as the window shifts, and re-attaching the listener each time would be
 * pure waste.
 */
export const useScroll = (
  ref: React.RefObject<HTMLElement | null>,
  onScroll: (x: number, y: number) => void,
): void => {
  const onScrollRef = useRef(onScroll);
  onScrollRef.current = onScroll;

  useEffect(() => {
    const scrollContainer = ref.current;
    if (!scrollContainer) {
      return;
    }

    // No rAF throttle: scroll events already fire once per frame in the rendering step (the same
    // tick as rAF), so coalescing them is redundant. Reading scrollLeft/Top is cheap and doesn't
    // force layout, and setScroll does near-zero work within a row (integer-bound windowing), so we
    // update synchronously — the change lands before paint with no extra scheduling hop or lag.
    const handleScroll = () =>
      onScrollRef.current(scrollContainer.scrollLeft, scrollContainer.scrollTop);

    scrollContainer.addEventListener("scroll", handleScroll, { passive: true });
    return () => scrollContainer.removeEventListener("scroll", handleScroll);
  }, [ref]);
};
