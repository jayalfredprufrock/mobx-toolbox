import { useEffect, useRef, useState } from "react";

/**
 * How long something must be loading before an indicator appears. Loads that finish inside this
 * window never render one at all.
 */
export const LOADING_DELAY_MS = 300;

/**
 * Once an indicator is on screen, how long it stays there even if the wait has already ended.
 * Applies only to waits that already crossed {@link LOADING_DELAY_MS} — its whole job is to stop a
 * just-shown indicator vanishing a frame later.
 */
export const LOADING_MIN_DURATION_MS = 300;

export interface SlowLoadingOptions {
  /** Don't surface before the wait has lasted this long. Defaults to {@link LOADING_DELAY_MS}. */
  after?: number;
  /**
   * Once surfaced, stay up at least this long. Defaults to {@link LOADING_MIN_DURATION_MS}.
   */
  minDuration?: number;
}

/**
 * Whether a wait has gone on long enough to be worth telling the user about.
 *
 * Loading UI flashes on fast responses: a request that resolves in 60 ms produces a 60 ms skeleton —
 * long enough to see, too short to read, and it happens on every navigation. This is the standard
 * two-part fix, in one place:
 *
 * - **A threshold.** A wait shorter than `after` never surfaces at all.
 * - **A floor.** Once it has surfaced, it stays for `minDuration`.
 *
 * Both halves are needed. A threshold alone turns a 320 ms wait into a 20 ms flash, which is worse
 * than either extreme.
 *
 * **This returns a third state, and a caller that renders two will be wrong.** The point of the
 * threshold is that there is a window where the wait is real but not yet worth mentioning — so
 * "not slow" does not mean "ready", and the data may still be missing:
 *
 * ```tsx
 * const slow = useSlowLoading(!list.loaded);
 *
 * if (slow) return <Skeleton />;
 * if (!list.loaded) return null; // loading, but too early to say so
 * return <Content rows={list.value} />;
 * ```
 *
 * Both branch orders matter:
 *
 * - `slow` is tested **first** because the floor outlives the wait. Once surfaced, this stays true
 *   for `minDuration` even after the value has landed, and testing the value first would swap the
 *   content in immediately — which is the flash the floor exists to prevent.
 * - The `null` branch is what makes the threshold real. Drop it and the first `after` milliseconds
 *   render the content branch with nothing to put in it.
 *
 * | value    | `slow` | render                              |
 * | -------- | ------ | ----------------------------------- |
 * | missing  | false  | nothing — inside the threshold      |
 * | missing  | true   | the skeleton                        |
 * | present  | true   | the skeleton, held by the floor     |
 * | present  | false  | the content                         |
 *
 * `LazyObserver` and `<Table.Loading>` are this same sequence, already wired up; reach for the hook
 * where a component renders its own skeleton.
 *
 * Plain boolean in, plain boolean out, so it works the same inside an `observer()` and outside one —
 * pass it anything, including a value read from a lazy or a store.
 *
 * `after: 0` surfaces immediately and `minDuration: 0` hides immediately, which together collapse
 * the third state away: with both at zero, `slow` and the wait are the same flag and two branches
 * are enough.
 */
export function useSlowLoading(active: boolean, options?: SlowLoadingOptions): boolean {
  const after = options?.after ?? LOADING_DELAY_MS;
  const minDuration = options?.minDuration ?? LOADING_MIN_DURATION_MS;

  const [shown, setShown] = useState(false);
  const shownAt = useRef(0);

  useEffect(() => {
    if (active) {
      // Already up: the floor below owns when it comes down, so there is nothing to schedule.
      if (shown) return;

      if (after <= 0) {
        shownAt.current = Date.now();
        setShown(true);
        return;
      }

      const timer = setTimeout(() => {
        shownAt.current = Date.now();
        setShown(true);
      }, after);
      // Cleanup on a falling edge cancels the timer, so a wait that ends inside the threshold
      // never surfaces — and a flicker restarts the window rather than accumulating toward it.
      return () => clearTimeout(timer);
    }

    // Never surfaced, so there is nothing to hold on screen.
    if (!shown) return;

    const remaining = shownAt.current + minDuration - Date.now();
    if (remaining <= 0) {
      setShown(false);
      return;
    }

    const timer = setTimeout(() => setShown(false), remaining);
    // If the wait resumes before this fires, the cleanup cancels the hide and the indicator stays
    // up continuously rather than blinking off and on.
    return () => clearTimeout(timer);
  }, [active, shown, after, minDuration]);

  return shown;
}
