import type { InferLazyObservable, LazyObservable, LazyObservableArray } from "../lazy-observable";
import { observer } from "mobx-react-lite";
import type React from "react";
import { useSlowLoading, type SlowLoadingOptions } from "../../util/use-slow-loading";

function ThrowError({ error }: { error: unknown }): never {
  throw error;
}

type LO = LazyObservable | LazyObservableArray;

type ObserveTuple<O extends LO[]> = {
  [K in keyof O]: InferLazyObservable<O[K]>;
};

export interface LazyObserverBaseProps {
  placeholder?: React.ReactNode;
  /**
   * Hold the `placeholder` back until the wait is long enough to be worth showing, and then keep it
   * up long enough to read — see `useSlowLoading`. On by default, so a fast load renders no
   * placeholder at all rather than flashing one.
   *
   * The clock runs off the *combined* gate, not per-lazy: it starts when the first value is missing
   * and resets once they are all present.
   *
   * Pass `false` to render the placeholder the instant anything is missing, or an object to override
   * the timings — a dashboard tile and a full-page route need not agree.
   */
  sustain?: boolean | SlowLoadingOptions;
}

export interface LazyObserverTupleProps<O extends LO[]> extends LazyObserverBaseProps {
  observe: [...O];
  children: (...value: ObserveTuple<O>) => React.ReactNode;
}

export interface LazyObserverSingleProps<O extends LO> extends LazyObserverBaseProps {
  observe: O;
  children: (value: InferLazyObservable<O>) => React.ReactNode;
}

const NEVER: SlowLoadingOptions = { after: 0, minDuration: 0 };

const LazyObserverImpl = observer(function LazyObserverImpl(props: {
  observe: LO | LO[];
  placeholder?: React.ReactNode;
  sustain?: boolean | SlowLoadingOptions;
  children: (...values: any[]) => React.ReactNode;
}) {
  const { observe, placeholder, sustain, children } = props;
  const lazies = [observe].flat() as LO[];

  // Reading `loaded` is also what registers observation, so this gate is what drives the loads.
  const pending = !lazies.every((o) => o.loaded);

  // A failure only reaches the boundary when there is nothing to render. A refresh that fails while
  // a value is on screen keeps that screen: throwing there would destroy working data over a
  // background request, and the error stays readable on the lazy for anyone who wants to surface it.
  const fatal = lazies.find((o) => o.error !== undefined && !o.loaded);

  const showPlaceholder = useSlowLoading(
    pending,
    sustain === false ? NEVER : sustain === true || sustain === undefined ? undefined : sustain,
  );

  if (fatal) return <ThrowError error={fatal.error} />;
  // The placeholder outranks the children, not just the pending state: once it is up it stays for
  // its minimum duration even though the value has already landed. Swapping to content the instant
  // the data arrives is the flash this exists to prevent.
  if (showPlaceholder) return placeholder;
  // Pending, but not for long enough to be worth mentioning — render nothing rather than flash.
  if (pending) return null;
  return children(...lazies.map((o) => o.value));
});

/**
 * Renders `children` once every observed lazy holds a value, a `placeholder` while they don't, and
 * re-throws a failure that leaves nothing to render so an error boundary can take over.
 *
 * Two behaviours worth knowing, both aimed at not destroying a screen that is working:
 *
 * - The gate is `loaded`, not `fetching`. A reload that keeps its value renders `children`
 *   throughout, so a refresh never blanks the page.
 * - Only a failure with **nothing loaded** is thrown. A failed refresh keeps rendering the value it
 *   still has.
 */
export const LazyObserver = LazyObserverImpl as {
  <O extends LO[]>(props: LazyObserverTupleProps<O>): React.ReactNode;
  <O extends LazyObservable>(props: LazyObserverSingleProps<O>): React.ReactNode;
};
