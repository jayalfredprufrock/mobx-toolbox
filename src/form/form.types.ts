import type { Static, TLiteral, TObject, TSchema, TUnion } from "typebox";
import type { FormFieldModel } from "./form-field.model";
import type { UnionVariants as Flat } from "../util/union-schema";
import type { FormModel } from "./form.model";

/** A single object, or a union of objects built with `DiscriminatedUnion`. */
// Spelled out over a plain `TUnion` rather than as `TDiscriminatedUnion<string, UnionMember[]>`: that one's recursive
// member type makes every generic `FormModel<T>` member expensive to resolve. Same shape either way.
export type FormSchema = TObject | (TUnion & { discriminator: { propertyName: string } });

/** `Static<T>`, except `any` stays `any` — so `FormModel<any>` still accepts every form. */
export type StaticOrAny<T extends TSchema> = 0 extends 1 & T ? any : Static<T>;

export interface FormConfig<T extends FormSchema = TObject, V = StaticOrAny<T>> {
  handleSubmit: (data: V) => Promise<unknown>;
  /**
   * Called when `handleSubmit` throws — for a toast, a report to your error tracker, or mapping an API
   * error onto fields with `form.fields.x.setError(...)`.
   *
   * `submitError` is already set by the time this runs, so a handler that wants to own presentation
   * entirely can clear it with `form.setSubmitError(undefined)` and render nothing from the form.
   *
   * Providing this **replaces the default `console.error`**. Without it, the rejection is consumed by
   * the form's own `catch` and a thrown error would otherwise be completely invisible — so if you take
   * over, logging unexpected failures becomes yours too.
   */
  handleError?: (error: unknown, form: FormModel<T, V>) => void;
  // Any field on any variant may be seeded — the merged field map holds them all.
  initialValues?: FormInitialValues<T, V>;
}

export interface FormFieldConfig<T extends TSchema = TSchema, V = StaticOrAny<T>> {
  name: string;
  schema: T;
  initialValue?: V;
  /**
   * For a field of a discriminated-union form: the active variant's schema for this field, or `null`
   * when the active variant doesn't have it. Read reactively. Set by `FormModel`.
   */
  variantSchema?: () => TSchema | null;
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

/** The value type of key `K` across the variants (of the static value `V`) that declare it. */
// `Required`, so an optional field's value is its schema's static type, as `Static<schema>` reads it
// (the optionality is the property's, not the value's).
type ValueAt<V, K extends PropertyKey> = V extends unknown
  ? K extends keyof V
    ? Required<V>[K]
    : never
  : never;

// Outside <FormWhen>, only shared fields are exposed; variant-specific fields
// are reachable through <FormWhen>, which narrows to a single variant.
export type FormFields<T extends FormSchema = TObject, Val = StaticOrAny<T>> =
  T extends TUnion<infer V>
    ? {
        [K in SharedKeys<Flat<V[number]>>]: FormFieldModel<
          VariantSchema<Flat<V[number]>, K>,
          ValueAt<Val, K>
        >;
      }
    : T extends TObject
      ? { [K in keyof T["properties"]]: FormFieldModel<T["properties"][K], ValueAt<Val, K>> }
      : never;

// Every field across every variant, typed by its (possibly unioned) schema — the
// `form.rawFields` escape hatch for reaching variant fields outside <FormWhen>.
export type RawFormFields<T extends FormSchema = TObject, Val = StaticOrAny<T>> =
  T extends TUnion<infer V>
    ? {
        [K in VariantKeys<Flat<V[number]>>]: FormFieldModel<
          VariantSchema<Flat<V[number]>, K>,
          ValueAt<Val, K>
        >;
      }
    : T extends TObject
      ? { [K in keyof T["properties"]]: FormFieldModel<T["properties"][K], ValueAt<Val, K>> }
      : never;

// Every field across all variants is optional, typed by its (possibly unioned) value.
type FormInitialValues<T extends FormSchema, Val = StaticOrAny<T>> =
  T extends TUnion<infer V>
    ? { [K in VariantKeys<Flat<V[number]>>]?: ValueAt<Val, K> }
    : T extends TObject
      ? Partial<Val>
      : never;

// --- discriminated-union variant narrowing (used by <FormWhen>) ---

/** The literal values a given discriminator key can take across all variants. */
export type DiscriminatorValue<T extends TUnion, D extends PropertyKey> =
  T extends TUnion<infer V> ? LiteralValue<Flat<V[number]>, D> : never;

type LiteralValue<O, D extends PropertyKey> = O extends TObject
  ? D extends keyof O["properties"]
    ? O["properties"][D] extends TLiteral<infer L>
      ? L
      : never
    : never
  : never;

/** The variant object whose discriminator `D` equals the literal `V`. */
export type MatchVariant<T extends TUnion, D extends PropertyKey, V> =
  T extends TUnion<infer Vars> ? Distribute<Flat<Vars[number]>, D, V> : never;

type Distribute<O, D extends PropertyKey, V> = O extends TObject
  ? D extends keyof O["properties"]
    ? O["properties"][D] extends TLiteral<infer L>
      ? V extends L
        ? O
        : never
      : never
    : never
  : never;
