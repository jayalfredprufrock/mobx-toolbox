import { createContext, useContext } from "react";
import type { FormModel } from "./form.model";

export const formContext = createContext<FormModel | undefined>(undefined);
export const useFormContext = () => {
  const context = useContext(formContext);
  if (!context) {
    throw new Error(
      "Form context not available. Make sure you are within the <Form> component or providing the form context manually.",
    );
  }
  return context;
};

export const FormProvider = formContext.Provider;

export const useFormContextIfAvailable = () => useContext(formContext);
