import type { InferLazyObservable, LazyObservable, LazyObservableArray } from "../lazy-observable";
import { Observer } from "mobx-react-lite";
import type React from "react";

type LO = LazyObservable | LazyObservableArray;

type ObserveTuple<O extends LO[]> = {
  [K in keyof O]: InferLazyObservable<O[K]>;
};

export interface LazyObserverBaseProps {
  placeholder?: React.ReactNode;
}

export interface LazyObserverTupleProps<O extends LO[]> extends LazyObserverBaseProps {
  observe: [...O];
  children: (...value: ObserveTuple<O>) => React.ReactNode;
}

export interface LazyObserverSingleProps<O extends LO> extends LazyObserverBaseProps {
  observe: O;
  children: (value: InferLazyObservable<O>) => React.ReactNode;
}

export function LazyObserver<O extends LO[]>(props: LazyObserverTupleProps<O>): React.ReactNode;
export function LazyObserver<O extends LazyObservable>(
  props: LazyObserverSingleProps<O>,
): React.ReactNode;
export function LazyObserver(
  props: LazyObserverTupleProps<any> | LazyObserverSingleProps<any>,
): React.ReactNode {
  const { observe, placeholder, children } = props;
  const observeAsArray = [observe].flat() as LO[];
  return (
    <Observer>
      {() => {
        if (!observeAsArray.every((o) => o.loaded)) return placeholder;
        return (children as any)(...observeAsArray.map((o) => o.value));
      }}
    </Observer>
  );
}
