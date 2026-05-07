import Schema, { Validator } from "typebox/schema";
import Value from "typebox/value";
import { type Static, type TSchema, Type } from "typebox";
import { makeAutoObservable, toJS } from "mobx";
import type { FormFieldConfig } from "./form.types";

// TODO: should infer required prop
// TODO: should also allow for "id", defaulting to name
// TODO: probably shouldn't assume value is of correct type, maybe unknown?

export class FormFieldModel<T extends TSchema = TSchema> {
  readonly name: string;
  readonly schema: T;
  readonly config: FormFieldConfig<T>;
  readonly validator: Validator<T>;

  value: Static<T> | undefined;
  touched = false;

  get valid(): boolean {
    if (this.value === undefined && Type.IsOptional(this.schema)) return true;
    return this.validator.Check(this.value);
  }

  get errorMessage(): string {
    if (this.valid || !this.touched) return "";
    // TODO: revisit this, now that .Errors returns success/fail
    const [_, errors] = this.validator.Errors(this.value);
    return errors.at(0)?.message ?? "";
  }

  constructor(config: FormFieldConfig<T>) {
    makeAutoObservable(this, {
      name: false,
      schema: false,
      config: false,
      validator: false,
    });

    this.config = config;
    this.name = config.name;
    this.schema = config.schema;
    this.validator = Schema.Compile(this.schema);
    this.setValue(config.initialValue);
  }

  setValue(value?: Static<T>) {
    // TODO: does this still make sense? If value is invalid,
    // then type will be wrong...revisit this
    this.value = Value.Convert(this.schema, value) as Static<T>;
  }

  setTouched(touched: boolean) {
    this.touched = touched;
  }

  reset() {
    this.setTouched(false);
    this.setValue(this.config.initialValue);
  }

  // TODO: this any type is dangerous, need to figure out a good way
  // to make this work OTTB for most form controls, while allowing
  // some kind of escape hatch for special cases
  props(): any {
    return {
      name: this.name,
      onChange: (v?: Static<T>) => this.setValue(v),
      value: this.value,
      onBlur: () => {
        this.setTouched(true);
      },
    };
  }

  toJSON(): Static<T> | undefined {
    return toJS(this.value);
  }
}
