import {
  IsUnion,
  Union,
  type Static,
  type TObject,
  type TSchemaOptions,
  type TUnion,
} from "typebox";

/**
 * What a union may hold: an object, or another union of the same — so unions compose. Grouping
 * variants and composing the groups (`T.Union([Electronic, Manual])`) is the natural way to build a
 * large union up, and TypeBox supports it: `T.Static` reads a nested union as one flat union of
 * objects, exactly as if it had been written flat.
 */
export type UnionMember = TObject | TUnion<UnionMember[]>;

/** A union of object variants, at any nesting depth. */
export type UnionSchema = TUnion<UnionMember[]>;

/**
 * Every object variant of a union schema, with nested unions flattened away — the type-level
 * counterpart to `flattenVariants`, for the helpers that walk `anyOf` on the type rather than the
 * value. Without it a nested member fails an `extends TObject` test and collapses to `never`,
 * silently dropping that whole branch's fields.
 */
export type UnionVariants<T> =
  T extends TUnion<infer V> ? UnionVariants<V[number]> : T extends TObject ? T : never;

/**
 * Every object variant in a union, with nested unions flattened away.
 *
 * TypeBox does *not* normalize nesting: `T.Union([A, T.Union([B, C])])` keeps two members in
 * `anyOf`, one of which is itself a union. So while the static type flattens to `A | B | C`, code
 * walking `anyOf` has to flatten too — reading `.properties` off a nested union finds nothing and
 * throws. `Value.Check` and `Value.Clean` already recurse, so once the variant list is flat the
 * nesting makes no difference anywhere.
 */
export function flattenVariants(schema: UnionSchema): TObject[] {
  const variants: TObject[] = [];
  const visit = (member: UnionMember): void => {
    if (IsUnion(member)) for (const nested of member.anyOf) visit(nested);
    else variants.push(member);
  };
  visit(schema);
  return variants;
}

/**
 * A union annotated with the property that tells its variants apart, in OpenAPI's
 * `discriminator.propertyName` shape. The name is part of the type, so anything handed the schema —
 * `makeModel`, `FormModel` — knows the discriminator without being told it again.
 *
 * Structural on purpose: a schema from any builder with this shape (handshake's
 * `TDiscriminatedUnion`, for one) is accepted as-is.
 */
export type DiscriminatedUnionSchema<
  D extends string = string,
  V extends UnionMember[] = UnionMember[],
> = TUnion<V> & { discriminator: { propertyName: D } };

/**
 * Build a {@link DiscriminatedUnionSchema}: `T.Union(variants)` with the discriminator recorded on it.
 * `T.Union`'s own options don't reach its return type, which is why this exists — the literal name
 * has to survive into the type for `is`/`as`/`variant` to be typed from the schema alone.
 *
 * ```ts
 * const Payment = DiscriminatedUnion("kind", [Card, Bank]);
 * ```
 */
export function DiscriminatedUnion<
  const V extends UnionMember[],
  D extends keyof Static<TUnion<V>> & string,
>(propertyName: D, variants: [...V], options?: TSchemaOptions): DiscriminatedUnionSchema<D, V> {
  return Union(variants, {
    ...options,
    discriminator: { propertyName },
  }) as DiscriminatedUnionSchema<D, V>;
}

/** The discriminator a schema is annotated with, or `undefined` for a plain union or an object. */
export function discriminatorOf(schema: unknown): string | undefined {
  if (!IsUnion(schema)) return undefined;
  const name = (schema as { discriminator?: { propertyName?: unknown } }).discriminator
    ?.propertyName;
  return typeof name === "string" ? name : undefined;
}
