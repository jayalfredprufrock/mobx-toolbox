import type { Static, TLiteral, TObject, TSchema, TUnion } from "typebox";
import type { FormFieldModel } from "./form-field.model";

export type FormSchema = TObject | TUnion;

export interface FormConfig<T extends FormSchema = TObject> {
  handleSubmit: (data: Static<T>) => Promise<unknown>;
  // Any field on any variant may be seeded — the merged field map holds them all.
  initialValues?: FormInitialValues<T>;
}

export interface FormFieldConfig<T extends TSchema = TSchema> {
  name: string;
  schema: T;
  initialValue?: Static<T>;
}

type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (
  k: infer I,
) => void
  ? I
  : never;

/** Keys present on the variant `O` (a single union member). */
type VariantKeys<O> = O extends TObject ? keyof O["properties"] : never;

/** Keys present on *every* variant — the shared base + discriminator. */
type SharedKeys<O> =
  UnionToIntersection<O extends TObject ? { k: keyof O["properties"] } : never> extends {
    k: infer K extends PropertyKey;
  }
    ? K
    : never;

/** The schema of key `K` across the variants that declare it (unioned when they differ). */
type VariantSchema<O, K extends PropertyKey> = O extends TObject
  ? K extends keyof O["properties"]
    ? O["properties"][K]
    : never
  : never;

/** The static value type of key `K` across the variants that declare it. */
type VariantValue<O, K extends PropertyKey> = O extends TObject
  ? K extends keyof O["properties"]
    ? Static<O["properties"][K]>
    : never
  : never;

// Outside <FormWhen>, only shared fields are exposed; variant-specific fields
// are reachable through <FormWhen>, which narrows to a single variant.
export type FormFields<T extends FormSchema = TObject> =
  T extends TUnion<infer V>
    ? { [K in SharedKeys<V[number]>]: FormFieldModel<VariantSchema<V[number], K>> }
    : T extends TObject
      ? { [K in keyof T["properties"]]: FormFieldModel<T["properties"][K]> }
      : never;

// Every field across every variant, typed by its (possibly unioned) schema — the
// `form.rawFields` escape hatch for reaching variant fields outside <FormWhen>.
export type RawFormFields<T extends FormSchema = TObject> =
  T extends TUnion<infer V>
    ? { [K in VariantKeys<V[number]>]: FormFieldModel<VariantSchema<V[number], K>> }
    : T extends TObject
      ? { [K in keyof T["properties"]]: FormFieldModel<T["properties"][K]> }
      : never;

// Every field across all variants is optional, typed by its (possibly unioned) value.
type FormInitialValues<T extends FormSchema> =
  T extends TUnion<infer V>
    ? { [K in VariantKeys<V[number]>]?: VariantValue<V[number], K> }
    : T extends TObject
      ? Partial<Static<T>>
      : never;

// --- discriminated-union variant narrowing (used by <FormWhen>) ---

/** Keys that are typed as a literal in at least one variant — valid discriminators. */
export type DiscriminatorKeys<T extends TUnion> =
  T extends TUnion<infer V> ? LiteralKeys<V[number]> : never;

type LiteralKeys<O> = O extends TObject
  ? {
      [K in keyof O["properties"]]: O["properties"][K] extends TLiteral ? K : never;
    }[keyof O["properties"]]
  : never;

/** The literal values a given discriminator key can take across all variants. */
export type DiscriminatorValue<T extends TUnion, D extends PropertyKey> =
  T extends TUnion<infer V> ? LiteralValue<V[number], D> : never;

type LiteralValue<O, D extends PropertyKey> = O extends TObject
  ? D extends keyof O["properties"]
    ? O["properties"][D] extends TLiteral<infer L>
      ? L
      : never
    : never
  : never;

/** The variant object whose discriminator `D` equals the literal `V`. */
export type MatchVariant<T extends TUnion, D extends PropertyKey, V> =
  T extends TUnion<infer Vars> ? Distribute<Vars[number], D, V> : never;

type Distribute<O, D extends PropertyKey, V> = O extends TObject
  ? D extends keyof O["properties"]
    ? O["properties"][D] extends TLiteral<infer L>
      ? V extends L
        ? O
        : never
      : never
    : never
  : never;
