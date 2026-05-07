import type { Static, TObject, TSchema } from "typebox";
import type { FormFieldModel } from "./form-field.model";

export interface FormConfig<T extends TObject = TObject> {
  handleSubmit: (data: Static<T>) => Promise<unknown>;
  initialValues?: Partial<Static<T>>;
}

export interface FormFieldConfig<T extends TSchema = TSchema> {
  name: string;
  schema: T;
  initialValue?: Static<T>;
}

export type FormFields<T extends TObject = TObject> = {
  [K in keyof T["properties"]]: FormFieldModel<T["properties"][K]>;
};
