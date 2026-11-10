import type { TUnion } from "typebox";
import { Observer } from "mobx-react-lite";
import type { FormModel } from "../form.model";
import type { FormFieldModel } from "../form-field.model";
import type { DiscriminatorValue, FormFields, MatchVariant } from "../form.types";

/** A discriminated-union form schema, with its discriminator's name read off the type. */
type UnionFormSchema<D extends string = string> = TUnion & { discriminator: { propertyName: D } };
type DiscriminatorName<T extends UnionFormSchema> = T["discriminator"]["propertyName"];

export interface FormWhenProps<T extends UnionFormSchema, V extends string> {
  form: FormModel<T>;
  /** Render the children only while the form's discriminator field equals this value. */
  value: V & DiscriminatorValue<T, DiscriminatorName<T>>;
  /** Receives the matching variant's fields. The form itself is already in scope. */
  children: (fields: FormFields<MatchVariant<T, DiscriminatorName<T>, V>>) => React.ReactNode;
}

/**
 * Renders its children only when the form's discriminator field currently holds `value`, passing the
 * fields narrowed to that variant. The discriminator comes from the schema, so only the value is
 * yours to give. Stack one per variant to lay out a discriminated-union form without manual
 * conditionals or casts.
 */
export function FormWhen<T extends UnionFormSchema, V extends string>({
  form,
  value,
  children,
}: FormWhenProps<T, V>) {
  return (
    <Observer>
      {() => {
        // Both casts go through `unknown` (or a widened `children`): relating instantiations of the
        // generic field types makes TS measure FormFieldModel's variance through TypeBox's `Static`,
        // which costs ~400k instantiations.
        const fields = form.rawFields as unknown as Record<string, FormFieldModel>;
        if (fields[form.discriminator!]?.value !== value) return null;
        return <>{(children as (fields: unknown) => React.ReactNode)(fields)}</>;
      }}
    </Observer>
  );
}
