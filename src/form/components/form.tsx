import { forwardRef } from "react";
import { FormProvider } from "../form.context";
import type { FormModel } from "../form.model";

export interface MobxFormProps extends Omit<
  React.HTMLProps<HTMLFormElement>,
  "form" | "action" | "method"
> {
  form: FormModel<any, any>;
}

export const MobxForm = forwardRef(function MobxForm(
  { form, children, ...formProps }: MobxFormProps,
  ref,
) {
  return (
    // Through `unknown`: relating `FormModel<any>` to the context's `FormModel` makes TS measure the
    // class's variance through TypeBox's `Static`, which is expensive.
    <FormProvider value={form as unknown as FormModel}>
      <form noValidate {...formProps} ref={ref} {...form.props()}>
        {children}
      </form>
    </FormProvider>
  );
});
