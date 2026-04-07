import { forwardRef } from "react";
import { FormProvider } from "../form.context";
import type { FormModel } from "../form.model";

export interface MobxFormProps extends Omit<
  React.HTMLProps<HTMLFormElement>,
  "form" | "action" | "method"
> {
  form: FormModel<any>;
}

export const MobxForm = forwardRef(function MobxForm(
  { form, children, ...formProps }: MobxFormProps,
  ref,
) {
  return (
    <FormProvider value={form}>
      <form noValidate {...formProps} ref={ref} {...form.props()}>
        {children}
      </form>
    </FormProvider>
  );
});
