import {
  IsLiteral,
  IsUnion,
  Union,
  type TLiteral,
  type TObject,
  type TSchema,
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
export function flattenVariants(schema: TSchema): TObject[] {
  const variants: TObject[] = [];
  const visit = (member: TSchema): void => {
    if (IsUnion(member)) for (const nested of member.anyOf) visit(nested);
    else variants.push(member as TObject);
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
export type TDiscriminatedUnion<
  D extends string = string,
  Types extends TSchema[] = TSchema[],
> = TUnion<Types> & { discriminator: { propertyName: D } };

/**
 * A variant list with nested unions spliced in place, as a tuple: the type-level counterpart of
 * `variants.flatMap(flattenVariants)`. A tuple (not `UnionVariants<...>[]`) because TypeBox's
 * `Static` only resolves a union's members from a tuple.
 */
export type FlattenVariants<V extends TSchema[]> = [Extract<V[number], TUnion>] extends [never]
  ? V
  : FlattenInto<V, []>;

/** Tail-recursive (accumulator) so long variant lists don't hit TypeScript's depth limit. */
type FlattenInto<V extends TSchema[], Acc extends TSchema[]> = V extends [
  infer F extends TSchema,
  ...infer R extends TSchema[],
]
  ? FlattenInto<R, F extends TUnion<infer N> ? [...Acc, ...FlattenVariants<N>] : [...Acc, F]>
  : Acc;

/** Keys of an object schema whose property schema is a literal. */
type LiteralKeys<S> =
  S extends TObject<infer P>
    ? { [K in keyof P]: P[K] extends TLiteral ? K : never }[keyof P] & string
    : never;

/** Intersection of a union's members' literal keys: keys that are a literal in EVERY variant. */
type CommonLiteralKeys<S> = (S extends any ? (k: LiteralKeys<S>) => void : never) extends (
  k: infer K,
) => void
  ? K & string
  : never;

/**
 * Build a {@link TDiscriminatedUnion}: a union with the discriminator recorded on it. It's a
 * compile error unless `propertyName` is a `T.Literal` in every (leaf) variant. Variant groups
 * (`T.Union([...])`) are flattened, so the built schema's `anyOf` is always a flat list of objects.
 *
 * ```ts
 * const Payment = DiscriminatedUnion("kind", [Card, Bank]);
 * ```
 */
export function DiscriminatedUnion<
  const V extends UnionMember[],
  D extends CommonLiteralKeys<UnionVariants<V[number]>>,
>(
  propertyName: D,
  variants: [...V],
  options?: TSchemaOptions,
): TDiscriminatedUnion<D, FlattenVariants<V>> {
  return Union(variants.flatMap(flattenVariants), {
    ...options,
    discriminator: { propertyName },
  }) as unknown as TDiscriminatedUnion<D, FlattenVariants<V>>;
}

/** True when `schema` is a union carrying a `discriminator.propertyName`. */
export function IsDiscriminatedUnion(schema: unknown): schema is TDiscriminatedUnion {
  return (
    IsUnion(schema) &&
    typeof (schema as { discriminator?: { propertyName?: unknown } }).discriminator
      ?.propertyName === "string"
  );
}

/**
 * The variant whose discriminator literal equals `value`, or `undefined` when none does. Takes the
 * flat variant list (`flattenVariants(schema)`, worked out once) rather than the schema, so a lookup
 * is a short scan of a handful of literals with nothing allocated.
 */
export function findVariant(
  variants: readonly TObject[],
  discriminator: string,
  value: unknown,
): TObject | undefined {
  return variants.find((variant) => {
    const tag = variant.properties[discriminator];
    return tag !== undefined && IsLiteral(tag) && tag.const === value;
  });
}
