import * as T from "typebox";
import { DiscriminatedUnion } from "./union-schema";

const Cat = T.Object({ id: T.String(), kind: T.Literal("cat"), meow: T.String() });
const Dog = T.Object({ id: T.String(), kind: T.Literal("dog"), bark: T.Number() });
const Fish = T.Object({ id: T.String(), kind: T.Literal("fish") });
const StringTag = T.Object({ id: T.String(), kind: T.String() });
const NoTag = T.Object({ id: T.String() });

void DiscriminatedUnion("kind", [Cat, Dog]);
// @ts-expect-error typo
void DiscriminatedUnion("knd", [Cat, Dog]);
// @ts-expect-error "meow" only exists on the cat variant
void DiscriminatedUnion("meow", [Cat, Dog]);
// @ts-expect-error "id" is shared but not a literal
void DiscriminatedUnion("id", [Cat, Dog]);
// @ts-expect-error one variant lacks the tag
void DiscriminatedUnion("kind", [Cat, NoTag]);
// @ts-expect-error tag isn't a literal in one variant
void DiscriminatedUnion("kind", [Cat, StringTag]);
// @ts-expect-error tag isn't a literal in a nested variant
void DiscriminatedUnion("kind", [T.Union([Cat, StringTag]), Fish]);

// Nested groups read as one flat union.
const Pets = DiscriminatedUnion("kind", [T.Union([Cat, Dog]), Fish]);
void (Pets.anyOf satisfies [typeof Cat, typeof Dog, typeof Fish]);
void ({ id: "p", kind: "dog", bark: 1 } satisfies T.Static<typeof Pets>);
// @ts-expect-error "meow" is not on the dog variant
const _bad: T.Static<typeof Pets> = { id: "p", kind: "dog", bark: 1, meow: "x" };
