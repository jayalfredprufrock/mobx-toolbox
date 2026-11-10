import Schema, { type Validator } from "typebox/schema";
import { IsUnion, Union, type TObject, type TSchema } from "typebox";
import { makeAutoObservable } from "mobx";
import type { FormConfig, FormFields, FormSchema, RawFormFields, StaticOrAny } from "./form.types";
import { FormFieldModel } from "./form-field.model";
import {
  discriminatorOf,
  flattenVariants,
  findVariant,
  type UnionSchema,
} from "../util/union-schema";

// Flatten a schema's fields into a single property map. For a discriminated
// union this merges the properties of every variant — nested unions included, as
// `flattenVariants` collapses them — unioning the schemas of any field that appears
// in more than one variant (which naturally turns the discriminator into a union of
// its literals).
function resolveProperties(schema: TSchema): Record<string, TSchema> {
  if (!IsUnion(schema)) return (schema as TObject).properties;

  const groups: Record<string, TSchema[]> = {};
  for (const variant of flattenVariants(schema as UnionSchema)) {
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
// `field.setError` covers applying API errors to fields, but the caller has to throw afterwards to
// stop `submitted` being set. A dedicated error thrown from handleSubmit — carrying a
// { field: message } map and recognised in the catch — would collapse that into one step and keep it
// out of `submitError`.

export class FormModel<T extends FormSchema = TObject, V = StaticOrAny<T>> {
  /** Shared fields only (for unions); every field for a plain object schema. */
  readonly fields: FormFields<T, V>;
  /** Every field across all variants — escape hatch for reaching variant fields. */
  readonly rawFields: RawFormFields<T, V>;
  readonly config: FormConfig<T, V>;
  readonly schema: T;
  readonly validator: Validator<T, V>;
  /** The union's discriminator field, or `undefined` for an object schema. */
  readonly discriminator: string | undefined;
  private readonly variants: readonly TObject[] | undefined;

  // TODO: maybe refactor into a "state" property?
  submitting = false;
  submitted = false;

  /**
   * Whatever `handleSubmit` last threw. `unknown` rather than `any`: it may be an `Error`, an API
   * error object, or a string, and narrowing at the render site is the only safe way to read it.
   */
  submitError: unknown;

  constructor(schema: T, config: FormConfig<T, V>) {
    this.schema = schema;
    this.config = config;
    // Type-only casts, for the same reason as in FormFieldModel.
    this.validator = Schema.Compile(schema as TSchema) as unknown as Validator<T, V>;

    const root = schema as TSchema;
    if (IsUnion(root)) {
      this.discriminator = discriminatorOf(root);
      if (this.discriminator === undefined) {
        throw new Error(
          `[FormModel] a union schema needs a discriminator, so the form can tell which variant is ` +
            `selected. Build it with \`DiscriminatedUnion("kind", [...])\` rather than \`T.Union([...])\`.`,
        );
      }
      this.variants = flattenVariants(root as UnionSchema);
    }

    makeAutoObservable<this, "variants">(this, {
      fields: false,
      rawFields: false,
      schema: false,
      config: false,
      validator: false,
      discriminator: false,
      variants: false,
    });

    const initialValues = (config as { initialValues?: Record<string, unknown> } | undefined)
      ?.initialValues;
    const fields = Object.entries(resolveProperties(root)).reduce(
      (fields, [fieldName, fieldSchema]) => {
        // An explicit type argument: inferring it through `initialValue?: Static<T>` is expensive.
        fields[fieldName] = new FormFieldModel<TSchema>({
          name: fieldName,
          schema: fieldSchema,
          initialValue: initialValues?.[fieldName],
          // Judged against the active variant's own schema for the field. With no variant selected
          // yet, against the merged one — the discriminator then reports itself as required.
          variantSchema: this.variants
            ? () => {
                const variant = this.activeVariant;
                if (!variant) return fieldSchema;
                return (variant.properties[fieldName] as TSchema | undefined) ?? null;
              }
            : undefined,
        });
        return fields;
      },
      {} as Record<string, FormFieldModel<TSchema>>,
    );

    // `fields` and `rawFields` are the same object; the types differ so that a
    // union form only surfaces shared fields by default.
    this.rawFields = fields as unknown as RawFormFields<T, V>;
    this.fields = fields as unknown as FormFields<T, V>;
  }

  /**
   * For a union form, the variant the discriminator field currently selects; `undefined` until it
   * holds one of the union's values, and always for an object schema.
   */
  get activeVariant(): TObject | undefined {
    if (!this.variants) return undefined;
    const fields = this.rawFields as Record<string, FormFieldModel<TSchema>>;
    return findVariant(
      this.variants,
      this.discriminator!,
      fields[this.discriminator!]?.submitValue,
    );
  }

  get valid(): boolean {
    const fields = Object.values<FormFieldModel<TSchema>>(this.rawFields);
    // A union form's fields each judge themselves against the active variant, and one the variant
    // lacks is never invalid — so a stale error on it can't wedge a submit that doesn't include it.
    if (!fields.every((field) => field.valid)) return false;
    // The whole-object check catches what no single field can: no variant selected yet, and any
    // constraint the schema places on the object itself.
    return this.variants ? this.validator.Check(this.toJSON()) : true;
  }

  /**
   * Any field differs from its baseline. For a union, only fields the active variant has count — an
   * edit to another variant's field is discarded on submit, so switching back leaves the form clean.
   */
  get dirty(): boolean {
    const fields = Object.values<FormFieldModel<TSchema>>(this.fields);
    return fields.some((field) => field.dirty && this.submits(field));
  }

  props(): any {
    return {
      onSubmit: (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();

        // A second submit while one is in flight would call handleSubmit twice — a double-click on
        // the button is enough, since nothing here was checking.
        if (this.submitting) {
          return;
        }

        this.setSubmitError(undefined);
        // `submitted` reports the outcome of the *last* attempt, so a retry must not still claim
        // success while it is in flight.
        this.setSubmitted(false);

        if (!this.validate()) {
          return;
        }

        this.setSubmitting(true);
        const data = this.toJSON() as V;
        this.config
          .handleSubmit(data)
          .then((resp) => {
            this.rebase(data as Record<string, unknown>);
            this.setSubmitted(true);
            return resp;
          })
          .catch((e: unknown) => {
            // Stored *before* handleError runs, so a handler that wants to own presentation
            // entirely can clear it with `form.setSubmitError(undefined)`.
            this.setSubmitError(e);

            if (this.config.handleError) {
              this.config.handleError(e, this);
              return;
            }

            // Nothing is configured to surface this and the catch has already consumed the
            // rejection, so without a log a throw inside handleSubmit — a network failure, or a
            // plain bug — is invisible in development and in production alike.
            console.error(e);
          })
          .finally(() => {
            this.setSubmitting(false);
          });
      },
    };
  }

  setSubmitError(error: unknown): void {
    this.submitError = error;
  }

  protected setSubmitting(submitting: boolean): void {
    this.submitting = submitting;
  }

  protected setSubmitted(submitted: boolean): void {
    this.submitted = submitted;
  }

  /**
   * Replace every field's baseline and reset to it — for initial values that load after the form is
   * created. A full replacement, like `config.initialValues`: fields missing from `values` go blank.
   */
  setInitialValues(values: Partial<V>): void {
    const record = values as Record<string, unknown>;
    for (const field of Object.values<FormFieldModel<TSchema>>(this.fields)) {
      field.setInitialValue(record[field.name]);
    }
    this.setSubmitError(undefined);
    this.setSubmitted(false);
  }

  // After a successful submit the saved values are the new baseline, so the form is clean again —
  // otherwise a dirty-form navigation blocker would block the redirect that follows a save. The
  // submitted snapshot is used rather than live values, so edits made while the submit was in flight
  // stay dirty. Fields absent from it (another variant's) keep their baseline.
  private rebase(data: Record<string, unknown>): void {
    for (const field of Object.values<FormFieldModel<TSchema>>(this.fields)) {
      if (field.name in data) field.rebase(data[field.name]);
    }
  }

  reset(): void {
    this.setSubmitError(undefined);
    // Without this, one successful submit left `submitted` true forever — a "save another" flow
    // would keep reporting success against an empty form.
    this.setSubmitted(false);
    for (const field of Object.values(this.fields)) {
      field.reset();
    }
  }

  validate(): boolean {
    for (const field of Object.values<FormFieldModel<TSchema>>(this.fields)) {
      field.setTouched(true);
      // Each attempt is judged fresh. Without this a manual error would make the form permanently
      // invalid until the user happened to edit that field, so clicking submit again would silently
      // do nothing rather than retrying.
      field.setError(undefined);
    }
    return this.valid;
  }

  // Whether a field is part of what gets submitted: every field of an object form; for a union form,
  // the active variant's fields — or every field while none is selected, so nothing is lost before
  // the user picks one (the submit is blocked until they do).
  private submits(field: FormFieldModel<TSchema>): boolean {
    const variant = this.activeVariant;
    return !variant || field.name in variant.properties;
  }

  toJSON(): Partial<V> {
    const data: Record<string, unknown> = {};
    for (const field of Object.values<FormFieldModel<TSchema>>(this.rawFields)) {
      // Another variant's fields are dropped, so the payload matches the selected variant exactly.
      if (this.submits(field)) data[field.name] = field.toJSON();
    }
    return data as Partial<V>;
  }
}
