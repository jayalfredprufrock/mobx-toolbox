import { IsUnion, type TObject, type TUnion } from "typebox";

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
