import Format from "typebox/format";
import { type Static, type TObject, type TSchema } from "typebox";
import { makeAutoObservable } from "mobx";
import type { FormConfig, FormFields } from "./form.types";
import { FormFieldModel } from "./form-field.model";

// should these be here?
Format.Set("password", () => true);
Format.Set("phone", () => true);

/*
SetErrorFunction((param) => {
  const { schema, value } = param;

  const message =
    typeof schema.errorMessage === "function" ? schema.errorMessage(param) : schema.errorMessage;

  if (message !== undefined) return message;

  if ((value === undefined || value === "") && !TypeGuard.IsOptional(schema)) {
    return "This field is required.";
  }

  if (Type.IsString(schema)) {
    if (Schema.IsFormat(schema) && schema.format === "email")
      return "Please enter a valid email address.";
  }

  return DefaultErrorFunction(param);
});
*/

// consider using enumerable to allow spreading of
// field model instead of calling props() unless we need
// to pass data to props...

// TODO:
// handleSubmit should catch a special MobxFormError
// that can set field-level errors from an API response

export class FormModel<T extends TObject = TObject> {
  readonly fields: FormFields<T>;
  readonly config: FormConfig<T>;
  readonly schema: T;

  // TODO: maybe refactor into a "state" property?
  submitting = false;
  submitted = false;

  // TODO: what should this type be? should it be generic?
  submitError: any;

  constructor(schema: T, config: FormConfig<T>) {
    this.schema = schema;
    this.config = config;

    makeAutoObservable(this, { fields: false, schema: false, config: false });

    this.fields = Object.entries(schema.properties).reduce(
      (fields, [fieldName, fieldSchema]) => {
        fields[fieldName] = new FormFieldModel({
          name: fieldName,
          schema: fieldSchema,
          initialValue: config?.initialValues?.[fieldName],
        });
        return fields;
      },
      {} as Record<string, FormFieldModel<TSchema>>,
    ) as FormFields<T>;
  }

  get valid(): boolean {
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
    return Object.values(this.fields).reduce(
      (fields, field) => {
        fields[field.name] = field.value;
        return fields;
      },
      {} as Partial<Static<T>>,
    );
  }
}
