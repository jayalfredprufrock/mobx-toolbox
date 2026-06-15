import * as Format from "typebox/format";
import * as Value from "typebox/value";
import Schema, { type Validator } from "typebox/schema";
import { IsUnion, Union, type Static, type TObject, type TSchema } from "typebox";
import { makeAutoObservable } from "mobx";
import type { FormConfig, FormFields, FormSchema, RawFormFields } from "./form.types";
import { FormFieldModel } from "./form-field.model";

// should these be here?
Format.Set("password", () => true);
Format.Set("phone", () => true);

// Flatten a schema's fields into a single property map. For a discriminated
// union this merges the properties of every variant, unioning the schemas of
// any field that appears in more than one variant (which naturally turns the
// discriminator into a union of its literals).
function resolveProperties(schema: FormSchema): Record<string, TSchema> {
  if (!IsUnion(schema)) return schema.properties;

  const groups: Record<string, TSchema[]> = {};
  for (const variant of schema.anyOf) {
    for (const [key, propSchema] of Object.entries((variant as TObject).properties)) {
      (groups[key] ??= []).push(propSchema as TSchema);
    }
  }

  const merged: Record<string, TSchema> = {};
  for (const [key, schemas] of Object.entries(groups)) {
    const distinct = [...new Map(schemas.map((s) => [JSON.stringify(s), s])).values()];
    merged[key] = distinct.length === 1 ? distinct[0]! : Union(distinct);
  }
  return merged;
}

// consider using enumerable to allow spreading of
// field model instead of calling props() unless we need
// to pass data to props...

// TODO:
// handleSubmit should catch a special MobxFormError
// that can set field-level errors from an API response

export class FormModel<T extends FormSchema = TObject> {
  /** Shared fields only (for unions); every field for a plain object schema. */
  readonly fields: FormFields<T>;
  /** Every field across all variants — escape hatch for reaching variant fields. */
  readonly rawFields: RawFormFields<T>;
  readonly config: FormConfig<T>;
  readonly schema: T;
  readonly validator: Validator<T>;

  // TODO: maybe refactor into a "state" property?
  submitting = false;
  submitted = false;

  // TODO: what should this type be? should it be generic?
  submitError: any;

  constructor(schema: T, config: FormConfig<T>) {
    this.schema = schema;
    this.config = config;
    this.validator = Schema.Compile(schema);

    makeAutoObservable(this, {
      fields: false,
      rawFields: false,
      schema: false,
      config: false,
      validator: false,
    });

    const initialValues = config?.initialValues as Record<string, unknown> | undefined;
    const fields = Object.entries(resolveProperties(schema)).reduce(
      (fields, [fieldName, fieldSchema]) => {
        fields[fieldName] = new FormFieldModel({
          name: fieldName,
          schema: fieldSchema,
          initialValue: initialValues?.[fieldName],
        });
        return fields;
      },
      {} as Record<string, FormFieldModel<TSchema>>,
    );

    // `fields` and `rawFields` are the same object; the types differ so that a
    // union form only surfaces shared fields by default.
    this.rawFields = fields as unknown as RawFormFields<T>;
    this.fields = fields as unknown as FormFields<T>;
  }

  get valid(): boolean {
    // A union form can't be validated field-by-field — fields belonging to the
    // inactive variant would fail — so validate the assembled object instead.
    if (IsUnion(this.schema)) {
      return this.validator.Check(this.toJSON());
    }
    return Object.values(this.fields).every((field) => field.valid);
  }

  props(): any {
    return {
      onSubmit: (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();

        this.setSubmitError(undefined);

        if (!this.validate()) {
          return;
        }

        this.setSubmitting(true);
        this.config
          .handleSubmit(this.toJSON() as Static<T>)
          .then((resp) => {
            this.setSubmitted(true);
            return resp;
          })
          .catch((e) => {
            this.setSubmitError(e);
          })
          .finally(() => {
            this.setSubmitting(false);
          });
      },
    };
  }

  setSubmitError(error: any): void {
    this.submitError = error;
  }

  protected setSubmitting(submitting: boolean): void {
    this.submitting = submitting;
  }

  protected setSubmitted(submitted: boolean): void {
    this.submitted = submitted;
  }

  reset(): void {
    this.setSubmitError(undefined);
    for (const field of Object.values(this.fields)) {
      field.reset();
    }
  }

  validate(): boolean {
    for (const field of Object.values(this.fields)) {
      field.setTouched(true);
    }
    return this.valid;
  }

  toJSON(): Partial<Static<T>> {
    const data = Object.values(this.fields).reduce(
      (fields, field) => {
        fields[field.name] = field.toJSON();
        return fields;
      },
      {} as Record<string, unknown>,
    );

    // Drop fields belonging to the inactive variant so submitted data matches
    // the selected member of the union exactly.
    if (IsUnion(this.schema)) {
      return Value.Clean(this.schema, data) as Partial<Static<T>>;
    }
    return data as Partial<Static<T>>;
  }
}
