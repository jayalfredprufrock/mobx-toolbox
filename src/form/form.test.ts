import { describe, expect, test, vi } from "vite-plus/test";
import * as T from "typebox";
import { autorun } from "mobx";
import { FormFieldModel } from "./form-field.model";
import { FormModel } from "./form.model";

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
