import { observable, runInAction } from "mobx";

// mobx's own type for this lives in `mobx/dist`, which mobx 7's `exports` map no longer lets us
// import from — and it's just TypeScript's built-in decorator types, so spell it out here
type ClassAccessorDecorator = (
  value: ClassAccessorDecoratorTarget<any, any>,
  context: ClassAccessorDecoratorContext,
) => ClassAccessorDecoratorResult<any, any> | void;

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
