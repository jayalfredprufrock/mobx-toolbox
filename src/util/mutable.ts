import { observable, runInAction } from "mobx";
import type { ClassAccessorDecorator } from "mobx/dist/types/decorator_fills";

export const mutable: ClassAccessorDecorator = (accessor) => {
  const boxedValues = new WeakMap();

  return {
    get() {
      let boxedValue = boxedValues.get(this);
      if (!boxedValue) {
        const value = accessor.get.call(this);
        boxedValue = observable.box(value);
        boxedValues.set(this, boxedValue);
      }

      return boxedValue.get();
    },
    set(value) {
      let boxedValue = boxedValues.get(this);
      if (!boxedValue) {
        boxedValue = observable.box(value);
        boxedValues.set(this, boxedValue);
      }

      runInAction(() => boxedValue.set(value));
    },
  };
};
