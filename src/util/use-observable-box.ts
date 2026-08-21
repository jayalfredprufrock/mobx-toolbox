import {
  comparer,
  observable,
  runInAction,
  type IEqualsComparer,
  type IObservableValue,
} from "mobx";
import { useEffect, useRef } from "react";

export interface UseObservableBoxOptions<T> {
  /**
   * How a new value is judged against the one held. Defaults to `comparer.shallow`, which is what
   * makes an object rebuilt on every render — `{ orgId, query }` — count as unchanged while its
   * fields are. Pass `comparer.structural` for values nested deeper than a field, or
   * `comparer.default` to write on every render that isn't referentially equal.
   */
  equals?: IEqualsComparer<T>;
}

/**
 * Mirror a plain React value into an observable box, so mobx code can react to it.
 *
 * React state isn't observable, which leaves a gap wherever the two meet: a `reaction`, an
 * `autorun`, a `computed`, or a lazy observable's `trackDependencies` can't see a value that lives
 * in `useState` or arrives as a prop. This closes it — `useState` stays where it is, and mobx gets
 * something to watch:
 *
 * ```tsx
 * const [query, setQuery] = useState("");
 * const params = useObservableBox({ orgId, query });
 *
 * // ...anywhere mobx is watching:
 * useAutorun(() => console.log(params.get().query));
 * ```
 *
 * The flow is one-way: the box mirrors the value, so writing to it from mobx's side holds only
 * until the next render whose value disagrees. Keep the value where React already keeps it.
 *
 * The box is created once and kept for the component's lifetime, so a reaction holding it stays
 * valid across renders. Two details it settles that are easy to get wrong by hand: the write
 * happens in an effect rather than during render, so the render itself stays free of side effects;
 * and values are compared rather than assigned blindly, so the object literal you rebuild every
 * render doesn't retrigger every reaction that reads it.
 */
export function useObservableBox<T>(
  value: T,
  options?: UseObservableBoxOptions<T>,
): IObservableValue<T> {
  // Built once, via a ref rather than `useMemo` — React documents that as a hint it may discard,
  // and a second box would leave any reaction that captured the first watching a value nothing
  // updates any more. `deep: false`: this mirrors a React value, it does not take ownership of its
  // contents.
  const ref = useRef<IObservableValue<T>>(undefined);
  const box = (ref.current ??= observable.box(value, { deep: false }));

  const equals = options?.equals ?? comparer.shallow;

  // No dependency array: `value` is often rebuilt every render, so the comparison *is* the
  // dependency check — a `deps` argument would only be a second, less reliable spelling of it.
  useEffect(() => {
    if (equals(box.get(), value)) return;
    runInAction(() => box.set(value));
  });

  return box;
}
