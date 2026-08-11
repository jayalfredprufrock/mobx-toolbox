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

  /**
   * An error set by hand rather than derived from the schema — typically a server response, or a rule
   * the schema can't express, applied from inside `handleSubmit`. Use `setError`.
   *
   * Distinct from `errorMessage`, which is what to *display*: this one when set, the schema's otherwise.
   */
  error: string | undefined = undefined;

  get valid(): boolean {
    if (this.error) return false;
    if (this.value === undefined && T.IsOptional(this.schema)) return true;
    return this.validator.Check(this.value);
  }

  get errorMessage(): string {
    // Shown regardless of `touched`: it was set deliberately, usually in response to a submit the
    // user just made, and a field like a file picker may never be "touched" at all.
    if (this.error) return this.error;
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
    this.config = config;
    this.name = config.name;
    this.schema = config.schema;
    this.validator = Schema.Compile(this.schema);
    this.value = this.convertValue(config.initialValue);

    makeAutoObservable(this, {
      name: false,
      schema: false,
      config: false,
      validator: false,
    });
  }

  setValue(value?: T.Static<T>) {
    // An edit invalidates a message that described the previous value — otherwise "that username is
    // taken" survives the user typing a different one, and the field stays stuck invalid.
    this.error = undefined;
    // TODO: does this still make sense? If value is invalid,
    // then type will be wrong...revisit this
    this.value = this.convertValue(value);
  }

  /** Set (or with `undefined`, clear) a manual error. Cleared automatically by an edit, a reset, or the next submit. */
  setError(error: string | undefined) {
    this.error = error;
  }

  private convertValue(value: unknown): T.Static<T> | undefined {
    // Value.Convert fabricates zero-values for undefined primitives ("" / 0 / false).
    // Only "" and false faithfully represent an empty control; a fabricated 0 reads
    // as real input (e.g. an epoch-0 date), so everything else stays undefined.
    if (value === undefined && !T.IsString(this.schema) && !T.IsBoolean(this.schema)) {
      return undefined;
    }
    return Value.Convert(this.schema, value) as T.Static<T>;
  }

  setTouched(touched: boolean) {
    this.touched = touched;
  }

  reset() {
    this.setTouched(false);
    this.setError(undefined);
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
