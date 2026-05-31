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
