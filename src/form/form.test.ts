import { describe, expect, test, vi } from "vite-plus/test";
import * as T from "typebox";
import { autorun } from "mobx";
import { FormFieldModel } from "./form-field.model";
import { FormModel } from "./form.model";
import type { FormConfig } from "./form.types";
import { DiscriminatedUnion } from "../util/union-schema";

// ---------------------------------------------------------------------------
// FormFieldModel
// ---------------------------------------------------------------------------

describe("FormFieldModel", () => {
  describe("initialization", () => {
    test("sets name from config", () => {
      const field = new FormFieldModel({ name: "email", schema: T.String() });
      expect(field.name).toBe("email");
    });

    test("value is coerced to empty string when no initialValue given for T.String()", () => {
      const field = new FormFieldModel({ name: "email", schema: T.String() });
      // TypeBox Value.Convert coerces undefined → "" for string schemas
      expect(field.value).toBe("");
    });

    test("value stays undefined when no initialValue given for T.Integer()", () => {
      // Value.Convert would fabricate 0 here, which renders as real input
      // (e.g. an epoch-0 date in a date control) — it must stay undefined.
      const field = new FormFieldModel({ name: "bornAt", schema: T.Integer() });
      expect(field.value).toBeUndefined();
    });

    test("value is coerced to false when no initialValue given for T.Boolean()", () => {
      const field = new FormFieldModel({ name: "subscribed", schema: T.Boolean() });
      expect(field.value).toBe(false);
    });

    test("value is set from initialValue", () => {
      const field = new FormFieldModel({
        name: "age",
        schema: T.Number(),
        initialValue: 25,
      });
      expect(field.value).toBe(25);
    });

    test("converts initialValue via typebox coercion", () => {
      const field = new FormFieldModel({
        name: "age",
        schema: T.Number(),
        initialValue: "42" as any,
      });
      expect(field.value).toBe(42);
    });

    test("touched is false by default", () => {
      const field = new FormFieldModel({ name: "x", schema: T.String() });
      expect(field.touched).toBe(false);
    });
  });

  describe("setValue", () => {
    test("updates value", () => {
      const field = new FormFieldModel({ name: "name", schema: T.String() });
      field.setValue("Alice");
      expect(field.value).toBe("Alice");
    });

    test("coerces value via typebox", () => {
      const field = new FormFieldModel({ name: "count", schema: T.Number() });
      field.setValue("7" as any);
      expect(field.value).toBe(7);
    });

    test("setting undefined coerces to empty string for T.String()", () => {
      const field = new FormFieldModel({
        name: "name",
        schema: T.String(),
        initialValue: "Alice",
      });
      field.setValue(undefined);
      // TypeBox Value.Convert coerces undefined → "" for string schemas
      expect(field.value).toBe("");
    });

    test("setting undefined clears numeric fields to undefined", () => {
      const field = new FormFieldModel({
        name: "bornAt",
        schema: T.Integer(),
        initialValue: 518405528375,
      });
      field.setValue(undefined);
      expect(field.value).toBeUndefined();
    });

    test("value is reactive", () => {
      const field = new FormFieldModel({ name: "name", schema: T.String() });
      const values: (string | undefined)[] = [];
      const dispose = autorun(() => values.push(field.value));
      field.setValue("Alice");
      dispose();
      expect(values).toEqual(["", "Alice"]);
    });
  });

  describe("setTouched", () => {
    test("marks field as touched", () => {
      const field = new FormFieldModel({ name: "x", schema: T.String() });
      field.setTouched(true);
      expect(field.touched).toBe(true);
    });

    test("can untouched a field", () => {
      const field = new FormFieldModel({ name: "x", schema: T.String() });
      field.setTouched(true);
      field.setTouched(false);
      expect(field.touched).toBe(false);
    });
  });

  describe("valid", () => {
    test("required string field is invalid when blank", () => {
      // T.String({ minLength: 1 }) rejects empty strings — use this for "required" fields.
      const field = new FormFieldModel({ name: "name", schema: T.String({ minLength: 1 }) });
      expect(field.valid).toBe(false);
    });

    test("required string field is valid when set", () => {
      const field = new FormFieldModel({
        name: "name",
        schema: T.String({ minLength: 1 }),
        initialValue: "Alice",
      });
      expect(field.valid).toBe(true);
    });

    test("optional field is valid when undefined", () => {
      const field = new FormFieldModel({
        name: "bio",
        schema: T.Optional(T.String()),
      });
      expect(field.valid).toBe(true);
    });

    test("number field with min constraint is invalid when below min", () => {
      const field = new FormFieldModel({
        name: "age",
        schema: T.Number({ minimum: 18 }),
        initialValue: 10,
      });
      expect(field.valid).toBe(false);
    });

    test("valid is reactive", () => {
      const field = new FormFieldModel({ name: "name", schema: T.String({ minLength: 1 }) });
      const valids: boolean[] = [];
      const dispose = autorun(() => valids.push(field.valid));
      field.setValue("Alice");
      dispose();
      expect(valids).toEqual([false, true]);
    });
  });

  describe("errorMessage", () => {
    test("is empty when field is valid", () => {
      const field = new FormFieldModel({
        name: "name",
        schema: T.String(),
        initialValue: "Alice",
      });
      field.setTouched(true);
      expect(field.errorMessage).toBe("");
    });

    test("is empty when field is invalid but not touched", () => {
      const field = new FormFieldModel({ name: "name", schema: T.String() });
      expect(field.errorMessage).toBe("");
    });

    test("shows required message for blank required field", () => {
      const field = new FormFieldModel({ name: "name", schema: T.String({ minLength: 1 }) });
      field.setTouched(true);
      expect(field.errorMessage).toBe("This field is required.");
    });

    test("shows custom errorMessage string from schema for non-empty invalid value", () => {
      // value must be non-empty so the "This field is required." branch is skipped
      const field = new FormFieldModel({
        name: "name",
        schema: T.String({ minLength: 5, errorMessage: "Must be at least 5 characters" } as any),
        initialValue: "hi",
      });
      field.setTouched(true);
      expect(field.errorMessage).toBe("Must be at least 5 characters");
    });
  });

  describe("reset", () => {
    test("restores initial value", () => {
      const field = new FormFieldModel({
        name: "name",
        schema: T.String(),
        initialValue: "Alice",
      });
      field.setValue("Bob");
      field.reset();
      expect(field.value).toBe("Alice");
    });

    test("clears touched state", () => {
      const field = new FormFieldModel({ name: "name", schema: T.String() });
      field.setTouched(true);
      field.reset();
      expect(field.touched).toBe(false);
    });
  });

  describe("props()", () => {
    test("includes name, value, onChange, onBlur", () => {
      const field = new FormFieldModel({
        name: "email",
        schema: T.String(),
        initialValue: "a@b.com",
      });
      const props = field.props();
      expect(props.name).toBe("email");
      expect(props.value).toBe("a@b.com");
      expect(typeof props.onChange).toBe("function");
      expect(typeof props.onBlur).toBe("function");
    });

    test("onChange updates value", () => {
      const field = new FormFieldModel({ name: "email", schema: T.String() });
      field.props().onChange("new@email.com");
      expect(field.value).toBe("new@email.com");
    });

    test("onBlur marks field as touched", () => {
      const field = new FormFieldModel({ name: "email", schema: T.String() });
      field.props().onBlur();
      expect(field.touched).toBe(true);
    });
  });

  describe("toJSON()", () => {
    test("returns current value", () => {
      const field = new FormFieldModel({
        name: "name",
        schema: T.String(),
        initialValue: "Alice",
      });
      expect(field.toJSON()).toBe("Alice");
    });
  });
});

// ---------------------------------------------------------------------------
// FormModel
// ---------------------------------------------------------------------------

const UserSchema = T.Object({
  name: T.String({ minLength: 1 }),
  age: T.Number({ minimum: 1 }),
  bio: T.Optional(T.String()),
});

describe("FormModel", () => {
  const makeForm = (initialValues?: Partial<T.Static<typeof UserSchema>>) =>
    new FormModel(UserSchema, {
      handleSubmit: vi.fn().mockResolvedValue(undefined),
      initialValues,
    });

  test("creates a field for each schema property", () => {
    const form = makeForm();
    expect(form.fields.name).toBeInstanceOf(FormFieldModel);
    expect(form.fields.age).toBeInstanceOf(FormFieldModel);
    expect(form.fields.bio).toBeInstanceOf(FormFieldModel);
  });

  test("populates fields with initialValues", () => {
    const form = makeForm({ name: "Alice", age: 30 });
    expect(form.fields.name.value).toBe("Alice");
    expect(form.fields.age.value).toBe(30);
  });

  describe("valid", () => {
    test("is false when any required field is empty", () => {
      const form = makeForm();
      expect(form.valid).toBe(false);
    });

    test("is true when all required fields are filled", () => {
      const form = makeForm({ name: "Alice", age: 30 });
      expect(form.valid).toBe(true);
    });
  });

  describe("validate()", () => {
    test("marks all fields as touched", () => {
      const form = makeForm();
      form.validate();
      for (const field of Object.values(form.fields)) {
        expect(field.touched).toBe(true);
      }
    });

    test("returns false when form is invalid", () => {
      const form = makeForm();
      expect(form.validate()).toBe(false);
    });

    test("returns true when form is valid", () => {
      const form = makeForm({ name: "Alice", age: 25 });
      expect(form.validate()).toBe(true);
    });
  });

  describe("toJSON()", () => {
    test("returns object of field values keyed by field name", () => {
      const form = makeForm({ name: "Alice", age: 30 });
      const data = form.toJSON();
      expect(data.name).toBe("Alice");
      expect(data.age).toBe(30);
    });
  });

  describe("reset()", () => {
    test("restores initial values across all fields", () => {
      const form = makeForm({ name: "Alice", age: 30 });
      form.fields.name.setValue("Bob");
      form.reset();
      expect(form.fields.name.value).toBe("Alice");
    });

    test("clears submitError", () => {
      const form = makeForm();
      form.setSubmitError(new Error("oops"));
      form.reset();
      expect(form.submitError).toBeUndefined();
    });

    test("untouch all fields", () => {
      const form = makeForm();
      form.validate(); // touches all
      form.reset();
      for (const field of Object.values(form.fields)) {
        expect(field.touched).toBe(false);
      }
    });
  });

  describe("setSubmitError()", () => {
    test("stores the error", () => {
      const form = makeForm();
      const err = new Error("fail");
      form.setSubmitError(err);
      expect(form.submitError).toBe(err);
    });

    test("clears when called with undefined", () => {
      const form = makeForm();
      form.setSubmitError(new Error("fail"));
      form.setSubmitError(undefined);
      expect(form.submitError).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// FormModel — discriminated unions
// ---------------------------------------------------------------------------

const PaymentSchema = DiscriminatedUnion("method", [
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

describe("FormModel (discriminated union)", () => {
  const makePaymentForm = (initialValues?: Partial<T.Static<typeof PaymentSchema>>) =>
    new FormModel(PaymentSchema, {
      handleSubmit: vi.fn().mockResolvedValue(undefined),
      initialValues,
    });

  test("merges fields across all variants", () => {
    const form = makePaymentForm();
    expect(form.fields.method).toBeInstanceOf(FormFieldModel);
    expect(form.fields.holder).toBeInstanceOf(FormFieldModel); // shared
    expect(form.rawFields.cardNumber).toBeInstanceOf(FormFieldModel); // card-only
    expect(form.rawFields.routing).toBeInstanceOf(FormFieldModel); // bank-only
  });

  test("rawFields exposes shared and variant fields; fields exposes only shared", () => {
    const form = makePaymentForm();
    expect(Object.keys(form.rawFields).sort()).toEqual([
      "cardNumber",
      "holder",
      "method",
      "routing",
    ]);
    // same underlying field instances, just a different typed view
    expect(form.rawFields.method).toBe(form.fields.method);
  });

  test("discriminator field accepts any variant's literal", () => {
    const form = makePaymentForm({ method: "card" });
    expect(form.fields.method.valid).toBe(true);
    form.fields.method.setValue("bank");
    expect(form.fields.method.valid).toBe(true);
  });

  test("valid is false until the active variant is fully satisfied", () => {
    const form = makePaymentForm({ method: "card", holder: "Ada" });
    expect(form.valid).toBe(false); // cardNumber missing
    form.rawFields.cardNumber.setValue("1234");
    expect(form.valid).toBe(true);
  });

  test("inactive variant's fields don't affect validity", () => {
    // routing is required by the bank variant, but card is active
    const form = makePaymentForm({ method: "card", holder: "Ada", cardNumber: "1234" });
    expect(form.valid).toBe(true);
  });

  test("toJSON strips fields not belonging to the active variant", () => {
    const form = makePaymentForm({ method: "card", holder: "Ada", cardNumber: "1234" });
    form.rawFields.routing.setValue("9999"); // stray value from the other variant
    expect(form.toJSON()).toEqual({ method: "card", holder: "Ada", cardNumber: "1234" });
  });

  test("switching the discriminator changes which object validates", () => {
    const form = makePaymentForm({ method: "card", holder: "Ada", cardNumber: "1234" });
    expect(form.valid).toBe(true);
    form.fields.method.setValue("bank");
    expect(form.valid).toBe(false); // routing now required
    form.rawFields.routing.setValue("9999");
    expect(form.valid).toBe(true);
    expect(form.toJSON()).toEqual({ method: "bank", holder: "Ada", routing: "9999" });
  });

  test("validate() returns whole-object validity", () => {
    const form = makePaymentForm({ method: "bank", holder: "Ada" });
    expect(form.validate()).toBe(false);
    form.rawFields.routing.setValue("9999");
    expect(form.validate()).toBe(true);
  });

  test("a union of unions merges every nested variant's fields", () => {
    // The same variants, grouped and composed rather than listed flat.
    const Card = T.Object({
      method: T.Literal("card"),
      holder: T.String({ minLength: 1 }),
      cardNumber: T.String({ minLength: 4 }),
    });
    const Bank = T.Object({
      method: T.Literal("bank"),
      holder: T.String({ minLength: 1 }),
      routing: T.String({ minLength: 4 }),
    });
    const Nested = DiscriminatedUnion("method", [T.Union([Card]), T.Union([Bank])]);

    const form = new FormModel(Nested, {
      handleSubmit: vi.fn().mockResolvedValue(undefined),
      initialValues: { method: "card", holder: "Ada", cardNumber: "1234" },
    });

    expect(Object.keys(form.rawFields).sort()).toEqual([
      "cardNumber",
      "holder",
      "method",
      "routing",
    ]);
    expect(form.valid).toBe(true);
    form.rawFields.routing.setValue("9999"); // stray value from the other branch
    expect(form.toJSON()).toEqual({ method: "card", holder: "Ada", cardNumber: "1234" });
  });
});

// ---------------------------------------------------------------------------
// manual field errors
// ---------------------------------------------------------------------------

describe("manual field errors", () => {
  const makeForm = (initialValues?: Partial<T.Static<typeof UserSchema>>) =>
    new FormModel(UserSchema, {
      handleSubmit: vi.fn().mockResolvedValue(undefined),
      initialValues,
    });

  test("setError displays and invalidates the field", () => {
    const form = makeForm({ name: "Ada", age: 36 });
    expect(form.valid).toBe(true);

    form.fields.name.setError("That name is taken.");

    expect(form.fields.name.errorMessage).toBe("That name is taken.");
    expect(form.fields.name.valid).toBe(false);
    expect(form.valid).toBe(false);
  });

  test("it shows without the field being touched", () => {
    // a file or picker field may never be "touched", and the caller set this deliberately
    const field = new FormFieldModel({ name: "doc", schema: T.String() });
    field.setError("Wait for the upload to finish.");
    expect(field.touched).toBe(false);
    expect(field.errorMessage).toBe("Wait for the upload to finish.");
  });

  test("it takes precedence over the schema message", () => {
    const field = new FormFieldModel({ name: "name", schema: T.String({ minLength: 1 }) });
    field.setTouched(true);
    expect(field.errorMessage).toBe("This field is required.");

    field.setError("Server says no.");
    expect(field.errorMessage).toBe("Server says no.");
  });

  test("editing the value clears it", () => {
    const form = makeForm({ name: "Ada", age: 36 });
    form.fields.name.setError("That name is taken.");

    form.fields.name.setValue("Grace");

    expect(form.fields.name.error).toBeUndefined();
    expect(form.fields.name.errorMessage).toBe("");
    expect(form.valid).toBe(true);
  });

  test("setError(undefined) clears it", () => {
    const form = makeForm({ name: "Ada", age: 36 });
    form.fields.name.setError("nope");
    form.fields.name.setError(undefined);
    expect(form.valid).toBe(true);
  });

  test("reset clears it", () => {
    const form = makeForm({ name: "Ada", age: 36 });
    form.fields.name.setError("nope");
    form.reset();
    expect(form.fields.name.error).toBeUndefined();
  });

  test("validate() clears it so a resubmit actually retries", () => {
    const form = makeForm({ name: "Ada", age: 36 });
    form.fields.name.setError("That name is taken.");
    expect(form.valid).toBe(false);

    // without clearing, an unedited field would keep the form invalid forever and the next
    // submit would silently do nothing
    expect(form.validate()).toBe(true);
    expect(form.fields.name.error).toBeUndefined();
  });

  test("it is observable", () => {
    const field = new FormFieldModel({ name: "name", schema: T.String() });
    const seen: string[] = [];
    const dispose = autorun(() => seen.push(field.errorMessage));

    field.setError("nope");
    field.setValue("Ada");

    expect(seen).toEqual(["", "nope", ""]);
    dispose();
  });
});

describe("manual field errors (discriminated union)", () => {
  const makePaymentForm = (initialValues?: Partial<T.Static<typeof PaymentSchema>>) =>
    new FormModel(PaymentSchema, {
      handleSubmit: vi.fn().mockResolvedValue(undefined),
      initialValues,
    });

  test("an error on an active field blocks a union form", () => {
    const form = makePaymentForm({ method: "card", holder: "Ada", cardNumber: "1234" });
    expect(form.valid).toBe(true);

    form.rawFields.cardNumber.setError("That card was declined.");

    expect(form.valid).toBe(false);
  });

  test("an error on an inactive variant's field does not", () => {
    const form = makePaymentForm({ method: "card", holder: "Ada", cardNumber: "1234" });

    // `routing` belongs to the bank variant; toJSON has already dropped it
    form.rawFields.routing.setError("stale");

    expect(form.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// submit error handling
// ---------------------------------------------------------------------------

describe("submit error handling", () => {
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  const makeForm = (config: Partial<FormConfig<typeof UserSchema>> = {}) =>
    new FormModel(UserSchema, {
      handleSubmit: vi.fn().mockResolvedValue(undefined),
      initialValues: { name: "Ada", age: 36 },
      ...config,
    } as FormConfig<typeof UserSchema>);

  const submit = async (form: FormModel<typeof UserSchema>) => {
    form.props().onSubmit({ preventDefault: () => {} });
    await flush();
  };

  test("a thrown error is stored on submitError", async () => {
    const boom = new Error("boom");
    const form = makeForm({ handleSubmit: vi.fn().mockRejectedValue(boom) });

    await submit(form);

    expect(form.submitError).toBe(boom);
    expect(form.submitted).toBe(false);
    expect(form.submitting).toBe(false);
  });

  test("without handleError it logs, so a throw is never silent", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = new Error("boom");
    const form = makeForm({ handleSubmit: vi.fn().mockRejectedValue(boom) });

    await submit(form);

    expect(logged).toHaveBeenCalledWith(boom);
    logged.mockRestore();
  });

  test("handleError receives the error and the form, and replaces the log", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = new Error("boom");
    const handleError = vi.fn();
    const form = makeForm({ handleSubmit: vi.fn().mockRejectedValue(boom), handleError });

    await submit(form);

    expect(handleError).toHaveBeenCalledTimes(1);
    expect(handleError.mock.calls[0]?.[0]).toBe(boom);
    expect(handleError.mock.calls[0]?.[1]).toBe(form);
    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  test("submitError is set before handleError, so a handler can clear it", async () => {
    const seen: unknown[] = [];
    const form = makeForm({
      handleSubmit: vi.fn().mockRejectedValue(new Error("boom")),
      handleError: (error, f) => {
        seen.push(error);
        // the suppression path: own the presentation entirely
        f.setSubmitError(undefined);
      },
    });

    await submit(form);

    expect(seen).toHaveLength(1);
    expect(form.submitError).toBeUndefined();
  });

  test("handleError can map an API failure onto a field", async () => {
    const form = makeForm({
      handleSubmit: vi.fn().mockRejectedValue({ code: "NAME_TAKEN" }),
      handleError: (error, f) => {
        if ((error as { code?: string }).code === "NAME_TAKEN") {
          f.fields.name.setError("That name is taken.");
          f.setSubmitError(undefined);
        }
      },
    });

    await submit(form);

    expect(form.fields.name.errorMessage).toBe("That name is taken.");
    expect(form.valid).toBe(false);
    expect(form.submitError).toBeUndefined();
  });

  test("handleError is not called when handleSubmit succeeds", async () => {
    const handleError = vi.fn();
    const form = makeForm({ handleError });

    await submit(form);

    expect(handleError).not.toHaveBeenCalled();
    expect(form.submitted).toBe(true);
  });

  test("handleError is not called for a validation failure", async () => {
    const handleError = vi.fn();
    const handleSubmit = vi.fn().mockResolvedValue(undefined);
    const form = makeForm({ handleError, handleSubmit, initialValues: { name: "" } });

    await submit(form);

    expect(handleSubmit).not.toHaveBeenCalled();
    expect(handleError).not.toHaveBeenCalled();
  });
});

describe("submit lifecycle fixes", () => {
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  test("a second submit while one is in flight is ignored", async () => {
    let release: (() => void) | undefined;
    const handleSubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const form = new FormModel(UserSchema, {
      handleSubmit,
      initialValues: { name: "Ada", age: 36 },
    });

    form.props().onSubmit({ preventDefault: () => {} });
    form.props().onSubmit({ preventDefault: () => {} });

    // a double-click used to call handleSubmit twice
    expect(handleSubmit).toHaveBeenCalledTimes(1);

    release?.();
    await flush();
    expect(form.submitting).toBe(false);
  });

  test("submitted is cleared by reset", async () => {
    const form = new FormModel(UserSchema, {
      handleSubmit: vi.fn().mockResolvedValue(undefined),
      initialValues: { name: "Ada", age: 36 },
    });

    form.props().onSubmit({ preventDefault: () => {} });
    await flush();
    expect(form.submitted).toBe(true);

    // otherwise a "save another" flow reports success against an empty form forever
    form.reset();
    expect(form.submitted).toBe(false);
  });

  test("submitted is cleared when a retry starts", async () => {
    let attempt = 0;
    const form = new FormModel(UserSchema, {
      handleSubmit: vi.fn(() => {
        attempt++;
        return attempt === 1 ? Promise.resolve() : Promise.reject(new Error("boom"));
      }),
      initialValues: { name: "Ada", age: 36 },
      handleError: () => {},
    });

    form.props().onSubmit({ preventDefault: () => {} });
    await flush();
    expect(form.submitted).toBe(true);

    form.props().onSubmit({ preventDefault: () => {} });
    await flush();
    expect(form.submitted).toBe(false);
  });
});

describe("dirty state", () => {
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const submit = (form: { props(): any }) => form.props().onSubmit({ preventDefault: () => {} });

  test("a fresh form is clean, including string fields converted from undefined", () => {
    const form = new FormModel(UserSchema, { handleSubmit: vi.fn() });
    expect(form.fields.name.value).toBe("");
    expect(form.fields.name.dirty).toBe(false);
    expect(form.dirty).toBe(false);
  });

  test("is value-based: undoing an edit makes the field clean again", () => {
    const form = new FormModel(UserSchema, {
      handleSubmit: vi.fn(),
      initialValues: { name: "Ada" },
    });
    form.fields.name.setValue("Grace");
    expect(form.fields.name.dirty).toBe(true);
    expect(form.dirty).toBe(true);
    form.fields.name.setValue("Ada");
    expect(form.dirty).toBe(false);
  });

  test("compares converted values, so '36' typed into a number field matches 36", () => {
    const form = new FormModel(UserSchema, { handleSubmit: vi.fn(), initialValues: { age: 36 } });
    form.fields.age.setValue("36" as unknown as number);
    expect(form.fields.age.dirty).toBe(false);
  });

  test("is observable", () => {
    const form = new FormModel(UserSchema, { handleSubmit: vi.fn() });
    const seen: boolean[] = [];
    autorun(() => seen.push(form.dirty));
    form.fields.name.setValue("Ada");
    expect(seen).toEqual([false, true]);
  });

  test("reset makes the form clean", () => {
    const form = new FormModel(UserSchema, { handleSubmit: vi.fn() });
    form.fields.name.setValue("Ada");
    form.reset();
    expect(form.dirty).toBe(false);
  });

  test("a successful submit rebases, so the form is clean and reset keeps the saved values", async () => {
    const form = new FormModel(UserSchema, {
      handleSubmit: vi.fn().mockResolvedValue(undefined),
      initialValues: { name: "Ada", age: 36 },
    });
    form.fields.name.setValue("Grace");
    submit(form);
    await flush();
    expect(form.dirty).toBe(false);

    form.fields.name.setValue("Edith");
    form.reset();
    expect(form.fields.name.value).toBe("Grace");
  });

  test("a failed submit does not rebase", async () => {
    const form = new FormModel(UserSchema, {
      handleSubmit: vi.fn().mockRejectedValue(new Error("boom")),
      handleError: () => {},
      initialValues: { name: "Ada", age: 36 },
    });
    form.fields.name.setValue("Grace");
    submit(form);
    await flush();
    expect(form.dirty).toBe(true);
  });

  test("edits made while a submit is in flight stay dirty", async () => {
    let release: (() => void) | undefined;
    const form = new FormModel(UserSchema, {
      handleSubmit: () => new Promise<void>((resolve) => (release = resolve)),
      initialValues: { name: "Ada", age: 36 },
    });
    form.fields.name.setValue("Grace");
    submit(form);
    form.fields.name.setValue("Edith");
    release?.();
    await flush();
    expect(form.dirty).toBe(true);
    form.fields.name.setValue("Grace");
    expect(form.dirty).toBe(false);
  });

  test("setInitialValues replaces the baseline and resets to it", () => {
    const form = new FormModel(UserSchema, { handleSubmit: vi.fn() });
    form.fields.bio.setValue("draft");
    form.setInitialValues({ name: "Ada", age: 36 });
    expect(form.fields.name.value).toBe("Ada");
    expect(form.fields.bio.value).toBe("");
    expect(form.dirty).toBe(false);
  });

  describe("discriminated union", () => {
    const makePaymentForm = () =>
      new FormModel(PaymentSchema, {
        handleSubmit: vi.fn().mockResolvedValue(undefined),
        initialValues: { method: "card", holder: "Ada", cardNumber: "4242" },
      });

    test("switching variant is dirty", () => {
      const form = makePaymentForm();
      form.fields.method.setValue("bank");
      expect(form.dirty).toBe(true);
    });

    test("edits to another variant's fields don't count once you switch back", () => {
      const form = makePaymentForm();
      form.fields.method.setValue("bank");
      form.rawFields.routing.setValue("021");
      expect(form.dirty).toBe(true);
      form.fields.method.setValue("card");
      expect(form.dirty).toBe(false);
    });
  });
});

describe("edge whitespace", () => {
  const Schema = T.Object({
    name: T.String({ minLength: 1 }),
    password: T.String({ minLength: 1 }),
    tags: T.Optional(T.Array(T.String())),
  });
  const makeForm = (initialValues?: Partial<T.Static<typeof Schema>>) =>
    new FormModel(Schema, { handleSubmit: vi.fn().mockResolvedValue(undefined), initialValues });

  test("value keeps what was typed, so an inner space survives typing", () => {
    const form = makeForm();
    form.fields.name.setValue("John ");
    expect(form.fields.name.value).toBe("John ");
    expect(form.fields.name.props().value).toBe("John ");
  });

  test("toJSON submits the trimmed value", () => {
    const form = makeForm();
    form.fields.name.setValue("  Ada  ");
    expect(form.fields.name.toJSON()).toBe("Ada");
    expect(form.toJSON().name).toBe("Ada");
  });

  test("validation reads the trimmed value, so whitespace alone is required-and-missing", () => {
    const form = makeForm();
    form.fields.name.setValue("   ");
    form.fields.name.setTouched(true);
    expect(form.fields.name.valid).toBe(false);
    expect(form.fields.name.errorMessage).toBe("This field is required.");
  });

  test("an edge-whitespace-only edit is not dirty", () => {
    const form = makeForm({ name: "Ada" });
    form.fields.name.setValue("Ada  ");
    expect(form.fields.name.dirty).toBe(false);
  });

  test("handleSubmit receives trimmed values", async () => {
    const handleSubmit = vi.fn().mockResolvedValue(undefined);
    const form = new FormModel(Schema, { handleSubmit });
    form.fields.name.setValue(" Ada ");
    form.fields.password.setValue("hunter2");
    form.props().onSubmit({ preventDefault: () => {} });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(handleSubmit).toHaveBeenCalledWith({
      name: "Ada",
      password: "hunter2",
      tags: undefined,
    });
  });

  test("non-string values pass through untouched", () => {
    const form = makeForm();
    form.fields.tags.setValue([" a "]);
    expect(form.fields.tags.toJSON()).toEqual([" a "]);
  });
});

describe("passwords", () => {
  const Schema = T.Object({ password: T.String({ format: "password", minLength: 1 }) });

  test("are submitted and validated as typed, not trimmed", () => {
    const form = new FormModel(Schema, { handleSubmit: vi.fn() });
    form.fields.password.setValue(" hunter2 ");
    expect(form.fields.password.toJSON()).toBe(" hunter2 ");
    expect(form.fields.password.valid).toBe(true);
  });

  test("an edge-whitespace edit is dirty", () => {
    const form = new FormModel(Schema, {
      handleSubmit: vi.fn(),
      initialValues: { password: "hunter2" },
    });
    form.fields.password.setValue("hunter2 ");
    expect(form.fields.password.dirty).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fields judged against the active variant
// ---------------------------------------------------------------------------

describe("FormModel (active variant)", () => {
  // `reference` is required (and longer) on a wire, optional on a cheque.
  const TransferSchema = DiscriminatedUnion("method", [
    T.Object({ method: T.Literal("wire"), reference: T.String({ minLength: 6 }) }),
    T.Object({ method: T.Literal("cheque"), reference: T.Optional(T.String()) }),
  ]);
  const makeForm = (initialValues?: Partial<T.Static<typeof TransferSchema>>) =>
    new FormModel(TransferSchema, {
      handleSubmit: vi.fn().mockResolvedValue(undefined),
      initialValues,
    });

  test("a field's requiredness follows the selected variant", () => {
    const form = makeForm({ method: "cheque" });
    const reference = form.fields.reference;
    reference.setTouched(true);
    expect(reference.valid).toBe(true);
    expect(form.valid).toBe(true);

    form.fields.method.setValue("wire");
    expect(reference.valid).toBe(false);
    expect(reference.errorMessage).toBe("This field is required.");
    expect(form.valid).toBe(false);
  });

  test("a field's constraints follow the selected variant", () => {
    const form = makeForm({ method: "wire", reference: "abc" });
    expect(form.fields.reference.valid).toBe(false);

    form.fields.method.setValue("cheque");
    expect(form.fields.reference.valid).toBe(true);
  });

  test("activeVariant tracks the discriminator field", () => {
    const form = makeForm();
    expect(form.activeVariant).toBeUndefined();
    form.fields.method.setValue("wire");
    expect(form.activeVariant).toBe(TransferSchema.anyOf[0]);
  });

  test("with no variant selected the form is invalid, and keeps every field's value", () => {
    const form = makeForm({ reference: "abcdef" } as any);
    expect(form.valid).toBe(false);
    expect(form.toJSON()).toEqual({ method: undefined, reference: "abcdef" });
  });

  test("a plain union is refused when the form is made", () => {
    const Plain = T.Union([T.Object({ kind: T.Literal("a") }), T.Object({ kind: T.Literal("b") })]);
    expect(() => new FormModel(Plain as any, { handleSubmit: vi.fn() })).toThrow(
      /DiscriminatedUnion/,
    );
  });
});
