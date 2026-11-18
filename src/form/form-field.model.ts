import Schema, { Validator } from "typebox/schema";
import * as Value from "typebox/value";
import * as T from "typebox";
import { makeAutoObservable, toJS } from "mobx";
import type { FormFieldConfig, StaticOrAny } from "./form.types";

// TODO: should infer required prop
// TODO: should also allow for "id", defaulting to name
// TODO: probably shouldn't assume value is of correct type, maybe unknown?

/**
 * Optional, or a union some member of which is optional — how a field shared by union variants
 * reads when one variant makes it optional and another doesn't (the merged schema is a plain union).
 */
function isOptional(schema: T.TSchema): boolean {
  return T.IsOptional(schema) || (T.IsUnion(schema) && schema.anyOf.some(isOptional));
}

/** A string schema, or a union with one — a field whose control's `""` is a real (if empty) value. */
function isStringy(schema: T.TSchema): boolean {
  return T.IsString(schema) || (T.IsUnion(schema) && schema.anyOf.some(isStringy));
}

/**
 * The keyword that marks an optional field as clearable: emptied, it's submitted as `null` so the
 * server removes the stored value. Recognised by keyword, like `discriminator` — any builder that
 * writes it (handshake's `Clearable`, for one) works. Must be on an optional schema to count, so
 * `T.Required(...)`, which keeps the keyword but drops the optionality, switches it off.
 */
export const CLEARABLE = "x-clearable";

/** An optional schema carrying `x-clearable: true`. */
export function IsClearable(schema: unknown): boolean {
  return (
    T.IsSchema(schema) &&
    T.IsOptional(schema) &&
    (schema as unknown as Record<string, unknown>)[CLEARABLE] === true
  );
}

// Validators for variant schemas, compiled on first use and shared by every form over the same schema.
const variantValidators = new WeakMap<T.TSchema, Validator<T.TSchema, unknown>>();

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

  /**
   * The schema this field is judged against right now. For a field of a discriminated-union form,
   * that's the active variant's own schema for it, so requiredness and constraints follow whichever
   * variant is selected; `null` when the active variant has no such field. Otherwise it's `schema`.
   */
  get activeSchema(): T.TSchema | null {
    return this.config.variantSchema ? this.config.variantSchema() : this.schema;
  }

  private get activeValidator(): Validator<T.TSchema, unknown> | null {
    const schema = this.activeSchema;
    if (schema === null) return null;
    if (schema === this.schema) return this.validator as Validator<T.TSchema, unknown>;
    let validator = variantValidators.get(schema);
    if (!validator) variantValidators.set(schema, (validator = Schema.Compile(schema)));
    return validator;
  }

  get valid(): boolean {
    const schema = this.activeSchema;
    // Not a field of the active variant: it isn't submitted, so nothing about it — not even a stale
    // manual error — can be wrong.
    if (schema === null) return true;
    if (this.error) return false;
    if (this.submitValue === undefined && T.IsOptional(schema)) return true;
    return this.activeValidator!.Check(this.submitValue);
  }

  /** The value differs from `initialValue`. Value-based: undoing an edit makes the field clean again. */
  get dirty(): boolean {
    return !Value.Equal(this.submitValue, this.normalize(this.initialValue));
  }

  /**
   * `value` as it will be submitted: strings trimmed of edge whitespace, passwords excepted, and an
   * empty optional field (`undefined`, or a string that trims to `""`) as `undefined`. Validity,
   * error messages, `dirty` and `toJSON` all read this, so what is validated is what is submitted —
   * while `value` stays exactly what was typed, so the space in "John Smith" survives being typed.
   */
  get submitValue(): V | undefined {
    return this.normalize(this.value);
  }

  /**
   * A field whose schema has `format: "password"`, which is submitted as typed: changing a password
   * silently would lock the user out. Read straight off the schema keyword — no format is registered
   * with TypeBox, so this neither depends on nor changes the app-wide format registry.
   */
  private get isPassword(): boolean {
    return "format" in this.schema && this.schema.format === "password";
  }

  private normalize(value: V | undefined): V | undefined {
    if (typeof value !== "string") return value;
    const normalized = this.isPassword ? value : value.trim();
    // Judged on the active schema, so a field optional in one variant and required in another is
    // empty-means-absent exactly when its optional variant is selected.
    if (normalized === "" && isOptional(this.activeSchema ?? this.schema)) return undefined;
    return normalized as V;
  }

  /**
   * Submitted as `null` when empty, rather than left out: the field is optional and marked
   * `x-clearable`, so emptying it asks the server to remove the stored value. See `IsClearable`.
   */
  get clearable(): boolean {
    return IsClearable(this.activeSchema);
  }

  get errorMessage(): string {
    // Shown regardless of `touched`: it was set deliberately, usually in response to a submit the
    // user just made, and a field like a file picker may never be "touched" at all.
    if (this.error) return this.error;
    if (this.valid || !this.touched) return "";
    const schema = this.activeSchema as any;
    // TODO: revisit this, now that .Errors returns success/fail
    const value = this.submitValue;
    const [_, errors] = this.activeValidator!.Errors(value);
    const error = errors.at(0);

    if (!error) return "";

    if (!T.IsOptional(schema) && (value === undefined || value === "")) {
      return "This field is required.";
    }

    if ("errorMessage" in schema) {
      if (typeof schema.errorMessage === "string") {
        return schema.errorMessage;
      } else if (typeof schema.errorMessage === "function") {
        return schema.errorMessage(value, schema);
      }
    }

    if (T.IsString(schema) && "format" in schema) {
      return `Please enter a valid ${String(schema.format)}`;
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
    // `null` is never converted: Value.Convert turns it into "null", 0 or ["null"]. It survives only
    // where the schema accepts it (a `T.Null()` member, `T.Unknown()`, …); elsewhere it means
    // "no value" — a record loaded with nulls, or a submitted clearable field being rebased.
    if (value === null) return this.validator.Check(null) ? (value as V) : undefined;
    // An emptied control on a non-string field is no value, not a converted one: Convert would turn
    // "" into 0 for a number — which passes as real input, so a required field never reports itself
    // missing — or [""] for an array.
    if (typeof value === "string" && value.trim() === "" && !isStringy(this.schema)) {
      return undefined;
    }
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

  /** `submitValue` as plain data — and `null` for an empty clearable field. */
  toJSON(): V | null | undefined {
    const value = this.submitValue;
    if (value === undefined && this.clearable) return null;
    return toJS(value);
  }
}
