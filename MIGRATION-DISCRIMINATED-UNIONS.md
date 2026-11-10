# Upgrade prompt: mobx-toolbox — discriminated unions live in the schema

Hand this file to a coding agent working in your repository. It covers the release containing
commits `24085d0`, `ed4401e` and `2f6c044` (the first release after `v1.5.1` to include them). It
has breaking changes to `@jayalfredprufrock/mobx-toolbox`'s `model`, `form` and `util` subpaths,
all about union schemas. **If the project has no `T.Union` passed to `makeUnionModel`,
`FormModel` or `useForm`, and no `<FormWhen>`, nothing here applies; stop and say so.**

The one idea behind every change: a union schema now records its own discriminator, in OpenAPI's
`discriminator: { propertyName }` shape, so nothing else has to be told it again.

```ts
import { DiscriminatedUnion } from "@jayalfredprufrock/mobx-toolbox/util";

const PaymentSchema = DiscriminatedUnion("kind", [Card, Bank]);
```

---

## How to work through this

**Phase 1 — get green, mechanically.** Apply the _Breaking changes_ below, in order, until the
project type-checks and its tests pass. Don't restructure anything while doing this.

**Phase 2 — review, then propose.** _Worth adopting_ and _Code that can now be deleted_ are
optional. Read the affected code, write up a short list (file, change, why, behavioural risk), and
wait for the maintainer to approve before touching anything.

**Watch for silent behaviour changes.** Items marked ⚠️ compile fine and change runtime behaviour.
Check each occurrence by hand — a passing test suite does not prove them right.

### Finding the affected code

```sh
grep -rn "makeUnionModel\|FormWhen\|DiscriminatorKeys" src
grep -rn "T.Union(\|Type.Union(" src
```

For every `T.Union`/`Type.Union` hit, decide whether it reaches `makeModel`/`makeUnionModel`,
`FormModel` or `useForm` as the **root** schema (directly, or through an exported
constant). Only those need changing. Unions used as a field's type, or nested _inside_ another
union, stay as they are.

---

## Breaking changes

### 1. Root union schemas are built with `DiscriminatedUnion`

`T.Union`'s options don't reach its return type, so an annotation written by hand is invisible to
TypeScript. Build every root union with the new builder instead:

```ts
// before
const PaymentSchema = T.Union([Card, Bank]);
// after
import { DiscriminatedUnion } from "@jayalfredprufrock/mobx-toolbox/util";
const PaymentSchema = DiscriminatedUnion("kind", [Card, Bank]);
```

- The first argument is the discriminator: the field every variant types as a `T.Literal` (or a
  union of literals). For a model, it's the string that was passed to `makeUnionModel`. For a form,
  it's the field the old `<FormWhen field="…">` named — or, if there was none, the literal-typed
  field shared by every variant.
- It must be a field of **every leaf variant**; otherwise it's a type error at the builder.
- **Nested unions:** only the root gets the annotation. `DiscriminatedUnion("kind", [Electronic, Manual])`
  where `Electronic = T.Union([Card, Wire])` is correct; don't convert the inner groups.
- **Schemas from handshake:** `DiscriminatedUnion` / `TDiscriminatedUnion` from
  `@jayalfredprufrock/handshake/typebox` produce the same shape and are accepted as-is. If the
  project already gets its union schemas from a handshake contract, use those directly, and
  don't wrap or rebuild them. Don't add a handshake dependency just for this.
- Passing a plain `T.Union` to `makeModel`, `FormModel` or `useForm` is now a type error **and**
  throws at runtime (`…Build it with DiscriminatedUnion(…)`). Any `as any` cast in front of such a
  call hides the type error, so grep those too.

The schema's value is unchanged apart from the extra `discriminator` key, so `T.Static`,
`Value.Check`, and anything serializing the schema (e.g. to OpenAPI) keep working. OpenAPI output
now carries a `discriminator`, which is valid and usually what you want.

### 2. `makeUnionModel` is removed — use `makeModel`

```ts
// before
const PaymentModel = makeUnionModel(PaymentSchema, "kind", { keys: ["id"] });
class Payment extends makeUnionModel(PaymentSchema, "kind") {}
// after (PaymentSchema built per step 1)
const PaymentModel = makeModel(PaymentSchema, { keys: ["id"] });
class Payment extends makeModel(PaymentSchema) {}
```

Drop the second argument; the config moves up one position. The returned class is identical:
`is`/`as`/`variant`, `Model.discriminator`, `ModelVariant<typeof Payment, "card">`,
`UnionModelConstructor` and `makeStore` all behave as before. Update imports that named
`makeUnionModel`.

### 3. `<FormWhen>` loses its `field` prop

The form knows its discriminator now, so only the value is given:

```tsx
// before
<FormWhen form={form} field="method" value="card">…</FormWhen>
// after
<FormWhen form={form} value="card">…</FormWhen>
```

`value` is still checked against the discriminator's literals. If a `FormWhen` named a field that
_isn't_ the schema's discriminator (it was allowed before, for any literal-typed field), it can't
be expressed this way any more. Rewrite it as a plain conditional on
`form.rawFields.<field>.value`, and list it in your report.

### 4. `DiscriminatorKeys` type is removed

It only typed `FormWhen`'s `field` prop. If project code used it, replace it with the literal
discriminator name, or with `typeof Schema["discriminator"]["propertyName"]`.

---

## ⚠️ Behaviour changes that compile silently

### Union form fields are validated against the active variant

The discriminator field's value now selects the **active variant** (`form.activeVariant`), and
each field is judged against _that variant's own schema_ for it. Previously every field validated
against the loosest schema of any variant and was never individually "required" by the selected
one. Consequences to check:

- A field required by one variant and optional in another now shows `"This field is required."` and
  blocks submit when its variant is selected. Before, it showed nothing at field level. Tests or UI
  that expected no field error there will change.
- A field's constraints (`minLength`, `format`, `errorMessage`, …) come from the active variant's
  definition. Where variants define a shared field differently, the message shown changes with the
  selection.
- A field the active variant doesn't have is always `valid`, **even if a manual `setError` is on it**.
  Code that set errors on another variant's field to block submit no longer blocks it.
- With no variant selected (discriminator empty/unknown), `form.valid` is `false` as before, and
  `form.toJSON()` now returns **every** field's value rather than a `Value.Clean` result.

### `toJSON` on union models and forms picks keys instead of running `Value.Clean`

Both now emit exactly the keys of the variant the discriminator names.

- **Fixed bug:** `Value.Clean` returned its input unchanged when the record matched no variant, so an
  invalid record used to submit another variant's stale fields. It no longer does. If something
  downstream relied on receiving those fields, it now won't.
- **Nested objects are no longer cleaned.** `Value.Clean` also stripped unknown properties _inside_
  nested object fields. Only top-level keys are picked now, as plain `makeModel` has always done. If
  a payload depended on that inner stripping (e.g. an API rejecting extra nested keys), clean that
  field yourself.
- A union model whose discriminator holds a value that isn't in the schema emits every field.

---

## Worth adopting (Phase 2 — propose first)

- **`form.activeVariant`** (the selected variant's `TObject`, or `undefined`) can replace hand-written
  `form.fields.method.value === "card"` checks outside JSX, e.g. to show per-variant hints.
- **`variantsByTag(schema, name)`** and **`discriminatorOf(schema)`** in `/util` replace custom code
  that walks `anyOf` to find a variant by its tag.
- **One schema, three consumers.** If the project defines the same union separately for a handshake
  contract, a model and a form, consolidate on the contract's `DiscriminatedUnion` export.

## Code that can now be deleted (Phase 2 — propose first)

- Per-field "required when variant X" validation done by hand (custom `errorMessage`s, `setError`
  calls in `handleSubmit`, or wrapper validators). The form now does this from the schema. Verify
  that the schema actually expresses the rule (field required in that variant) before deleting.
- Manual payload filtering before `handleSubmit` or after `model.toJSON()` that strips another
  variant's fields.

---

## Report back with

1. What Phase 1 required, file by file, including each schema converted and the discriminator chosen.
2. Each ⚠️ occurrence you found, and how you verified it. In particular: any field-level error that
   newly appears, and any payload that relied on `Value.Clean`'s nested stripping.
3. Any `FormWhen` that keyed on a non-discriminator field, and how you rewrote it.
4. The Phase 2 proposal list, ranked, with anything you decided _against_ and why.
