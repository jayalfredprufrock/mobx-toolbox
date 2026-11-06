import Schema, { Validator } from "typebox/schema";
import * as Value from "typebox/value";
import * as T from "typebox";
import { makeAutoObservable, toJS } from "mobx";
import type { FormFieldConfig, StaticOrAny } from "./form.types";

// TODO: should infer required prop
// TODO: should also allow for "id", defaulting to name
// TODO: probably shouldn't assume value is of correct type, maybe unknown?

export class FormFieldModel<T extends T.TSchema = T.TSchema, V = StaticOrAny<T>> {
  readonly name: string;
  readonly schema: T;
  readonly config: FormFieldConfig<T, V>;
  readonly validator: Validator<T, V>;

  value: V | undefined;
  /**
   * The baseline `dirty` compares against and `reset` restores: `config.initialValue` to begin with,
   * moved by `setInitialValue` — and so by every successful form submit.
   */
  initialValue: V | undefined;
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
    if (this.submitValue === undefined && T.IsOptional(this.schema)) return true;
    return this.validator.Check(this.submitValue);
  }

  /** The value differs from `initialValue`. Value-based: undoing an edit makes the field clean again. */
  get dirty(): boolean {
    return !Value.Equal(this.submitValue, this.normalize(this.initialValue));
  }

  /**
   * `value` as it will be submitted: strings trimmed of edge whitespace. Validity,
   * error messages, `dirty` and `toJSON` all read this, so what is validated is what is submitted —
   * while `value` stays exactly what was typed, so the space in "John Smith" survives being typed.
   */
  get submitValue(): V | undefined {
    return this.normalize(this.value);
  }

  private normalize(value: V | undefined): V | undefined {
    if (typeof value !== "string") return value;
    return value.trim() as V;
  }

  get errorMessage(): string {
    // Shown regardless of `touched`: it was set deliberately, usually in response to a submit the
    // user just made, and a field like a file picker may never be "touched" at all.
    if (this.error) return this.error;
    if (this.valid || !this.touched) return "";
    // TODO: revisit this, now that .Errors returns success/fail
    const value = this.submitValue;
    const [_, errors] = this.validator.Errors(value);
    const error = errors.at(0);

    if (!error) return "";

    if (!T.IsOptional(this.schema) && (value === undefined || value === "")) {
      return "This field is required.";
    }

    if ("errorMessage" in this.schema) {
      if (typeof this.schema.errorMessage === "string") {
        return this.schema.errorMessage;
      } else if (typeof this.schema.errorMessage === "function") {
        return this.schema.errorMessage(value, this.schema);
      }
    }

    if (T.IsString(this.schema) && "format" in this.schema) {
      return `Please enter a valid ${String(this.schema.format)}`;
    }

    return error.message;
  }

  constructor(config: FormFieldConfig<T, V>) {
    this.config = config;
    this.name = config.name;
    this.schema = config.schema;
    // Type-only casts: relating `Validator<T>` for a generic `T` makes TS evaluate TypeBox's
    // `Static` generically, which costs every program importing this module ~600k instantiations.
    this.validator = Schema.Compile(this.schema as T.TSchema) as unknown as Validator<T, V>;
    // Converted like any value, so a string field's baseline is "" rather than `undefined` and an
    // untouched field isn't dirty.
    this.initialValue = this.convertValue(config.initialValue);
    this.value = this.initialValue;

    makeAutoObservable(this, {
      name: false,
      schema: false,
      config: false,
      validator: false,
    });
  }

  setValue(value?: V) {
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

  private convertValue(value: unknown): V | undefined {
    // Value.Convert fabricates zero-values for undefined primitives ("" / 0 / false).
    // Only "" and false faithfully represent an empty control; a fabricated 0 reads
    // as real input (e.g. an epoch-0 date), so everything else stays undefined.
    if (value === undefined && !T.IsString(this.schema) && !T.IsBoolean(this.schema)) {
      return undefined;
    }
    return Value.Convert(this.schema, value) as V;
  }

  setTouched(touched: boolean) {
    this.touched = touched;
  }

  /** Move the baseline without touching the current value. See `setInitialValue` to move both. */
  rebase(value?: V) {
    this.initialValue = this.convertValue(value);
  }

  /** Replace the baseline and reset to it — for values that arrive after the form is created. */
  setInitialValue(value?: V) {
    this.rebase(value);
    this.reset();
  }

  reset() {
    this.setTouched(false);
    this.setError(undefined);
    this.setValue(this.initialValue);
  }

  // TODO: this any type is dangerous, need to figure out a good way
  // to make this work OTTB for most form controls, while allowing
  // some kind of escape hatch for special cases
  props(): any {
    return {
      name: this.name,
      onChange: (v?: V) => this.setValue(v),
      value: this.value,
      onBlur: () => {
        this.setTouched(true);
      },
    };
  }

  toJSON(): V | undefined {
    return toJS(this.submitValue);
  }
}
