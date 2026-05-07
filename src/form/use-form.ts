import type { TObject } from "typebox";
import { useRef } from "react";
import { FormModel } from "./form.model";
import type { FormConfig } from "./form.types";

export const useForm = <T extends TObject = TObject>(
  schema: T,
  config: FormConfig<T>,
): FormModel<T> => {
  const formRef = useRef<FormModel<T>>(undefined);
  if (formRef.current) {
    Object.assign(formRef.current.config, config);
  } else {
    formRef.current = new FormModel<T>(schema, config);
  }

  return formRef.current;
};
