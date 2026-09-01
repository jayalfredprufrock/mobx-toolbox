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
  handleError: (error, form) => {
    /* optional — see Handling submit errors */
  },
  initialValues: { email: "user@example.com" },
});
```

### Properties

| Property      | Type            | Description                                                 |
| ------------- | --------------- | ----------------------------------------------------------- |
| `fields`      | `FormFields<T>` | Map of field name → `FormFieldModel`                        |
| `valid`       | `boolean`       | `true` when all fields pass validation                      |
| `submitting`  | `boolean`       | `true` while `handleSubmit` is in-flight                    |
| `submitted`   | `boolean`       | `true` after the first successful submit                    |
| `submitError` | `unknown`       | Last error thrown by `handleSubmit` (narrow before reading) |

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

1. Ignores the event entirely if a submit is already in flight
2. Clears `submitError` and `submitted`
3. Calls `form.validate()` — if invalid, stops here
4. Sets `submitting = true`
5. Calls `handleSubmit(form.toJSON())`
6. On success: sets `submitted = true`
7. On error: stores the error in `submitError`, then calls `handleError` if given, otherwise `console.error`s it
8. Finally: sets `submitting = false`

### Handling submit errors

`handleSubmit` rejecting is the normal way to report failure. The form stores the error and then hands
it to `handleError`:

```ts
const form = useForm(UserSchema, {
  handleSubmit: async (data) => {
    const res = await api.save(data);
    if (res.error) throw res.error;
  },
  handleError: (error, form) => {
    if ((error as ApiError).code === "NAME_TAKEN") {
      // put it where the user is looking, and don't also show a form-level banner
      form.fields.name.setError("That name is taken.");
      form.setSubmitError(undefined);
      return;
    }
    toast.error("Something went wrong. Please try again.");
    reportToSentry(error);
  },
});
```

Two things to know:

**Suppressing `submitError`.** It is stored _before_ `handleError` runs, so clearing it with
`form.setSubmitError(undefined)` inside the handler is how you take over presentation completely —
useful when the message belongs on a field, or when you only want a toast. Per-error, so you can
suppress the banner for expected failures and keep it for unexpected ones.

**Providing `handleError` replaces the default log.** With no handler the form `console.error`s, because
its own `catch` has already consumed the rejection — without that, a network failure or a plain bug in
`handleSubmit` produces no console output, no unhandled rejection, and no visible change beyond the
spinner stopping. If you take the hook, reporting unexpected failures becomes your job.

## `FormFieldModel`

Each field in `form.fields` is a `FormFieldModel` with its own reactive state.

### Properties

| Property       | Type                     | Description                                                        |
| -------------- | ------------------------ | ------------------------------------------------------------------ | ----------------------------------------------- |
| `name`         | `string`                 | Field key from the schema                                          |
| `value`        | `Static<T> \| undefined` | Current value (TypeBox-coerced)                                    |
| `touched`      | `boolean`                | Set to `true` on blur or explicit `setTouched(true)`               |
| `valid`        | `boolean`                | Passes TypeBox schema check                                        |
| `error`        | `string                  | undefined`                                                         | Manually-set error (see below); blocks validity |
| `errorMessage` | `string`                 | `error` when set, else the schema message when `touched && !valid` |

### Methods

```ts
field.setValue(value?)   // update value (runs through TypeBox Value.Convert)
field.setTouched(bool)   // manually mark as touched/untouched
field.setError(msg?)     // set or clear a manual error
field.reset()            // restore initial value, clear touched
field.props()            // { name, value, onChange, onBlur } — spread onto any input
field.toJSON()           // current plain value
```

### Value coercion

TypeBox's `Value.Convert` runs on every `setValue` call. This means `"42"` converts to `42` for `T.Number()` schemas, `"true"` converts to `true` for `T.Boolean()`, etc. Undefined coerces to `""` for string fields.

### Error messages

| Condition                                            | Message                           |
| ---------------------------------------------------- | --------------------------------- |
| `error` is set (via `setError`)                      | That message, even if untouched   |
| `!touched`                                           | `""` (no message shown)           |
| Required field is blank (`""`) or `undefined`        | `"This field is required."`       |
| Schema has `errorMessage: string`                    | That string                       |
| Schema has `errorMessage: (value, schema) => string` | Result of the function            |
| String with `format` constraint                      | `"Please enter a valid {format}"` |
| Anything else                                        | TypeBox's default error message   |

To require a non-empty string, use `T.String({ minLength: 1 })`. Plain `T.String()` accepts `""` as valid.

### Setting errors by hand

Not every rule fits a schema. `field.setError(message)` marks a field invalid with a message of your
own — for a server response, a cross-field rule, or a companion model that isn't finished working:

```ts
const uploader = useUploader({ requestUpload });

const form = useForm(DocumentSchema, {
  handleSubmit: async (data) => {
    // uploader.invalid is true while anything is pending, uploading or failed
    if (uploader.invalid) {
      form.fields.document.setError("Wait for the upload to finish.");
      throw new Error("not ready");
    }

    const res = await api.save(data);
    if (res.error === "NAME_TAKEN") {
      form.fields.name.setError("That name is taken.");
      throw new Error(res.error);
    }
  },
});
```

Manual errors display immediately, without the field being `touched` — a file or picker field may never
be touched, and you set the message deliberately. They take precedence over the schema's message, and
they make the field (and the form) invalid.

They clear on their own at the three moments where they stop describing reality:

| Cleared by                         | Why                                                                                                                                             |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `field.setValue(...)`              | The message described the previous value                                                                                                        |
| `form.validate()`, so every submit | Each attempt is judged fresh — otherwise an unedited field keeps the form invalid and the next submit silently does nothing instead of retrying |
| `field.reset()` / `form.reset()`   | Obvious                                                                                                                                         |

**You have to throw.** `handleSubmit` resolving is what sets `submitted = true`, so setting an error and
returning normally reports success. Throwing routes into `submitError` as usual — which is why the
examples above throw something cheap after setting the field error. If you don't want a form-level
banner alongside the field message, check `submitError` before rendering one, or clear it with
`form.setSubmitError(undefined)`.

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

Variants can be grouped and the groups composed to any depth — `T.Union([Electronic, Manual])`,
where each of those is itself a union. A union of unions is treated as the one flat union of leaf
variants that `T.Static` already reads it as, so field merging, `fields`/`rawFields`, `<FormWhen>`
narrowing and `toJSON` cleaning all behave identically. The discriminator has to be shared by every
leaf variant, not just by every top-level member.

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
  FormConfig, // { handleSubmit, handleError?, initialValues? }
  FormFields, // { [fieldName]: FormFieldModel }
} from "@jayalfredprufrock/mobx-toolbox/form";
```
