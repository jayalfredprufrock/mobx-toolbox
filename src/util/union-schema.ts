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
export function flattenVariants(schema: UnionMember): TObject[] {
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
 * Build a {@link DiscriminatedUnionSchema}: a union with the discriminator recorded on it. It's a
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
): DiscriminatedUnionSchema<D, FlattenVariants<V>> {
  return Union(variants.flatMap(flattenVariants), {
    ...options,
    discriminator: { propertyName },
  }) as unknown as DiscriminatedUnionSchema<D, FlattenVariants<V>>;
}

/** The discriminator a schema is annotated with, or `undefined` for a plain union or an object. */
export function discriminatorOf(schema: unknown): string | undefined {
  if (!IsUnion(schema)) return undefined;
  const name = (schema as { discriminator?: { propertyName?: unknown } }).discriminator
    ?.propertyName;
  return typeof name === "string" ? name : undefined;
}

/**
 * Each value the discriminator can take, mapped to the variant it names — the lookup that lets a
 * consumer pick the active variant from one field instead of matching the whole record against the
 * union. Nested unions are flattened. A variant whose discriminator isn't a literal (or a union of
 * literals) has no entry; if two variants claim a value, the later one wins.
 */
export function variantsByTag(schema: UnionSchema, discriminator: string): Map<unknown, TObject> {
  const table = new Map<unknown, TObject>();
  for (const variant of flattenVariants(schema)) {
    const tag = variant.properties[discriminator];
    const literals = tag && IsUnion(tag) ? tag.anyOf : [tag];
    for (const literal of literals) {
      if (literal && IsLiteral(literal)) table.set(literal.const, variant);
    }
  }
  return table;
}
