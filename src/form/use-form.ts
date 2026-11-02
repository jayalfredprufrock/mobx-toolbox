import type { TObject } from "typebox";
import { useRef } from "react";
import { FormModel } from "./form.model";
import type { FormConfig, FormSchema } from "./form.types";

export const useForm = <T extends FormSchema = TObject>(
  schema: T,
  // `NoInfer`: `T` comes from `schema` alone. Otherwise TypeScript also infers `T` back out of
  // `handleSubmit`'s `data` param, relating `Static<T>` to `Static<T>` alias-to-alias, which makes
  // it compute the variance of TypeBox's `StaticType` (~1M instantiations and hundreds of
  // depth-limit hits with typebox >= 1.3, whose `StaticDependent` relates `StaticType`s generically).
  config: NoInfer<FormConfig<T>>,
): FormModel<T> => {
  const formRef = useRef<FormModel<T>>(undefined);
  if (formRef.current) {
    Object.assign(formRef.current.config, config);
  } else {
    formRef.current = new FormModel<T>(schema, config);
  }

  return formRef.current;
};
