import type { TUnion } from "typebox";
import { Observer } from "mobx-react-lite";
import type { FormModel } from "../form.model";
import type { FormFieldModel } from "../form-field.model";
import type {
  DiscriminatorKeys,
  DiscriminatorValue,
  FormFields,
  MatchVariant,
} from "../form.types";

export interface FormWhenProps<T extends TUnion, D extends DiscriminatorKeys<T>, V extends string> {
  form: FormModel<T>;
  /** The discriminator field name. */
  field: D;
  /** Render the children only while the discriminator field equals this value. */
  value: V & DiscriminatorValue<T, D>;
  /** Receives the matching variant's fields. The form itself is already in scope. */
  children: (fields: FormFields<MatchVariant<T, D, V>>) => React.ReactNode;
}

/**
 * Renders its children only when the form's discriminator field currently holds
 * `value`, passing the fields narrowed to that variant. Stack one per variant to
 * lay out a discriminated-union form without manual conditionals or casts.
 */
export function FormWhen<T extends TUnion, D extends DiscriminatorKeys<T>, V extends string>({
  form,
  field,
  value,
  children,
}: FormWhenProps<T, D, V>) {
  return (
    <Observer>
      {() => {
        const fields = form.rawFields as Record<string, FormFieldModel>;
        if (fields[field as string]?.value !== value) return null;
        return <>{children(fields as unknown as FormFields<MatchVariant<T, D, V>>)}</>;
      }}
    </Observer>
  );
}
