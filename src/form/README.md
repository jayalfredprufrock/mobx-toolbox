# @mobx-toolbox/form

MobX-powered form state management for React. Built on TypeBox for schema-driven validation and value coercion.

## Setup

```tsx
import { useForm, MobxForm } from "@jayalfredprufrock/mobx-toolbox/form";
import * as T from "typebox";

const LoginSchema = T.Object({
  email: T.String({ format: "email" }),
  password: T.String({ minLength: 8 }),
});

function LoginForm() {
  const form = useForm(LoginSchema, {
    handleSubmit: async (data) => {
      await api.login(data);
    },
  });

  return (
    <MobxForm store={form}>
      <input {...form.fields.email.props()} type="email" placeholder="Email" />
      <input {...form.fields.password.props()} type="password" placeholder="Password" />
      {form.fields.email.touched && <span>{form.fields.email.errorMessage}</span>}
      <button type="submit" disabled={form.submitting}>
        Login
      </button>
    </MobxForm>
  );
}
```

`useForm` creates a `FormModel` once and persists it across renders. `MobxForm` renders a `<form>` element with the `onSubmit` handler pre-wired.

## `FormModel`

```ts
const form = new FormModel(schema, {
  handleSubmit: async (data) => {
    /* ... */
  },
  initialValues: { email: "user@example.com" },
});
```

### Properties

| Property      | Type            | Description                              |
| ------------- | --------------- | ---------------------------------------- |
| `fields`      | `FormFields<T>` | Map of field name → `FormFieldModel`     |
| `valid`       | `boolean`       | `true` when all fields pass validation   |
| `submitting`  | `boolean`       | `true` while `handleSubmit` is in-flight |
| `submitted`   | `boolean`       | `true` after the first successful submit |
| `submitError` | `any`           | Last error thrown by `handleSubmit`      |

### Methods

```ts
form.validate(); // touch all fields and return valid boolean
form.reset(); // restore initial values, clear errors and touched state
form.toJSON(); // { fieldName: value, ... } — current field values
form.props(); // { onSubmit } — spread onto a <form> element
form.setSubmitError(e); // set or clear (pass undefined) the submit error
```

### Submit lifecycle

`form.props().onSubmit`:

1. Calls `form.validate()` — if invalid, stops here
2. Sets `submitting = true`
3. Calls `handleSubmit(form.toJSON())`
4. On success: sets `submitted = true`
5. On error: stores the error in `submitError`
6. Finally: sets `submitting = false`

## `FormFieldModel`

Each field in `form.fields` is a `FormFieldModel` with its own reactive state.

### Properties

| Property       | Type                     | Description                                          |
| -------------- | ------------------------ | ---------------------------------------------------- |
| `name`         | `string`                 | Field key from the schema                            |
| `value`        | `Static<T> \| undefined` | Current value (TypeBox-coerced)                      |
| `touched`      | `boolean`                | Set to `true` on blur or explicit `setTouched(true)` |
| `valid`        | `boolean`                | Passes TypeBox schema check                          |
| `errorMessage` | `string`                 | Non-empty only when `touched && !valid`              |

### Methods

```ts
field.setValue(value?)   // update value (runs through TypeBox Value.Convert)
field.setTouched(bool)   // manually mark as touched/untouched
field.reset()            // restore initial value, clear touched
field.props()            // { name, value, onChange, onBlur } — spread onto any input
field.toJSON()           // current plain value
```

### Value coercion

TypeBox's `Value.Convert` runs on every `setValue` call. This means `"42"` converts to `42` for `T.Number()` schemas, `"true"` converts to `true` for `T.Boolean()`, etc. Undefined coerces to `""` for string fields.

### Error messages

| Condition                                            | Message                           |
| ---------------------------------------------------- | --------------------------------- |
| `!touched`                                           | `""` (no message shown)           |
| Required field is blank (`""`) or `undefined`        | `"This field is required."`       |
| Schema has `errorMessage: string`                    | That string                       |
| Schema has `errorMessage: (value, schema) => string` | Result of the function            |
| String with `format` constraint                      | `"Please enter a valid {format}"` |
| Anything else                                        | TypeBox's default error message   |

To require a non-empty string, use `T.String({ minLength: 1 })`. Plain `T.String()` accepts `""` as valid.

## Discriminated unions

`FormModel` accepts a `T.Union` of objects as its root schema, not just a single `T.Object`. The fields of every variant are merged into one field map, and any field shared across variants (most importantly the discriminator) is unioned — so the discriminator field validates against, and a `<select>` can offer, every variant's literal.

For a union, `form.fields` exposes only the **shared** fields (those present in every variant, including the discriminator); variant-specific fields are reached through `<FormWhen>` (typed, narrowed) or `form.rawFields` (the lower-level escape hatch holding every field across all variants). Both views point at the same underlying field instances — prefer `<FormWhen>`; reach for `rawFields` only for imperative/non-React access.

Because a union form can't be validated field-by-field (the inactive variant's required fields would always fail), `form.valid` validates the **assembled object** against the full union schema, and `form.toJSON()` runs `Value.Clean` so the submitted payload matches exactly one variant — stray values left over from a previously-selected variant are dropped. This guarantees `handleSubmit` receives a valid `Static<T>`.

```ts
const PaymentSchema = T.Union([
  T.Object({
    method: T.Literal("card"),
    holder: T.String({ minLength: 1 }),
    cardNumber: T.String({ minLength: 4 }),
  }),
  T.Object({
    method: T.Literal("bank"),
    holder: T.String({ minLength: 1 }),
    routing: T.String({ minLength: 4 }),
  }),
]);

const form = useForm(PaymentSchema, {
  handleSubmit: async (data) => {
    /* data is the narrowed union */
  },
});
```

### `<FormWhen>`

Render variant-specific fields without manual conditionals or casts. `FormWhen` renders its children only while the discriminator `field` holds `value`, passing the **fields narrowed to that variant** (`fields.cardNumber` exists in the `card` block; `fields.routing` does not). The form itself is already in scope, so the render prop only hands you the fields. Stack one per variant:

```tsx
<MobxForm form={form}>
  {/* shared + discriminator fields render normally */}
  <input {...form.fields.holder.props()} />
  <select {...form.fields.method.props()}>
    <option value="card">Card</option>
    <option value="bank">Bank</option>
  </select>

  <FormWhen form={form} field="method" value="card">
    {(fields) => <input {...fields.cardNumber.props()} />}
  </FormWhen>

  <FormWhen form={form} field="method" value="bank">
    {(fields) => <input {...fields.routing.props()} />}
  </FormWhen>
</MobxForm>
```

`field` is constrained to the union's literal-typed (discriminator) keys and `value` to that key's literals, so typos are compile errors. The form must be passed as a prop (not read from context) so the union type is preserved for narrowing.

## React helpers

```tsx
import { useForm, MobxForm, useFormContext } from "@jayalfredprufrock/mobx-toolbox/form";

// useForm — create (once) and persist a FormModel
const form = useForm(schema, config);

// MobxForm — renders <form onSubmit={...}> with FormProvider
<MobxForm store={form}>...</MobxForm>;

// useFormContext — access current form inside children of MobxForm
const form = useFormContext();
```

## Key types

```ts
import type {
  FormConfig, // { handleSubmit, initialValues? }
  FormFields, // { [fieldName]: FormFieldModel }
} from "@jayalfredprufrock/mobx-toolbox/form";
```
