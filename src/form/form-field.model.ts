import Schema, { Validator } from "typebox/schema";
import * as Value from "typebox/value";
import * as T from "typebox";
import { makeAutoObservable, toJS } from "mobx";
import type { FormFieldConfig } from "./form.types";

// TODO: should infer required prop
// TODO: should also allow for "id", defaulting to name
// TODO: probably shouldn't assume value is of correct type, maybe unknown?

export class FormFieldModel<T extends T.TSchema = T.TSchema> {
  readonly name: string;
  readonly schema: T;
  readonly config: FormFieldConfig<T>;
  readonly validator: Validator<T>;

  value: T.Static<T> | undefined;
  touched = false;

  get valid(): boolean {
    if (this.value === undefined && T.IsOptional(this.schema)) return true;
    return this.validator.Check(this.value);
  }

  get errorMessage(): string {
    if (this.valid || !this.touched) return "";
    // TODO: revisit this, now that .Errors returns success/fail
    const [_, errors] = this.validator.Errors(this.value);
    const error = errors.at(0);

    if (!error) return "";

    if (!T.IsOptional(this.schema) && (this.value === undefined || this.value === "")) {
      return "This field is required.";
    }

    if ("errorMessage" in this.schema) {
      if (typeof this.schema.errorMessage === "string") {
        return this.schema.errorMessage;
      } else if (typeof this.schema.errorMessage === "function") {
        return this.schema.errorMessage(this.value, this.schema);
      }
    }

    if (T.IsString(this.schema) && "format" in this.schema) {
      return `Please enter a valid ${String(this.schema.format)}`;
    }

    return error.message;
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

  setValue(value?: T.Static<T>) {
    // TODO: does this still make sense? If value is invalid,
    // then type will be wrong...revisit this
    this.value = Value.Convert(this.schema, value) as T.Static<T>;
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
      onChange: (v?: T.Static<T>) => this.setValue(v),
      value: this.value,
      onBlur: () => {
        this.setTouched(true);
      },
    };
  }

  toJSON(): T.Static<T> | undefined {
    return toJS(this.value);
  }
}
