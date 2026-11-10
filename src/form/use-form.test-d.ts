/**
 * Type-level tests for `useForm`'s inference. `config` is `NoInfer`, so `T` comes from `schema`
 * alone. Inferring it from `handleSubmit`'s `data` as well related TypeBox's `StaticType` to itself
 * alias-to-alias, which cost ~1M instantiations per program with typebox >= 1.3. These pin the
 * behaviour callers rely on, so it can't change without notice. This file passing `vp check` *is*
 * the test.
 */
import * as T from "typebox";
import type { FormModel } from "./form.model";
import { useForm } from "./use-form";
import { DiscriminatedUnion } from "../util/union-schema";

type Equal<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;
const assertTrue = <_ extends true>(): void => {};

const Login = T.Object({
  email: T.String(),
  remember: T.Optional(T.Boolean()),
});

const Payment = DiscriminatedUnion("method", [
  T.Object({ method: T.Literal("card"), cardNumber: T.String() }),
  T.Object({ method: T.Literal("wire"), swift: T.String() }),
]);

// `T` is the schema, and `handleSubmit`'s `data` is its static type.
const login = useForm(Login, {
  initialValues: { email: "a@b.c" },
  handleSubmit: async (data) => {
    assertTrue<Equal<typeof data, T.Static<typeof Login>>>();
  },
});
assertTrue<Equal<typeof login, FormModel<typeof Login>>>();

// Unions: `data` is the union of the variants.
const payment = useForm(Payment, {
  handleSubmit: async (data) => {
    assertTrue<Equal<typeof data, T.Static<typeof Payment>>>();
  },
});
assertTrue<Equal<typeof payment, FormModel<typeof Payment>>>();

// `FormModel<any>` still accepts every form.
const anyForms: FormModel<any>[] = [login, payment];
void anyForms;

// Explicit type arguments still work.
useForm<typeof Login>(Login, {
  handleSubmit: async (data) => {
    assertTrue<Equal<typeof data, T.Static<typeof Login>>>();
  },
});

// `config` doesn't take part in inference, so `handleSubmit` can't widen or replace `T`.
useForm(Login, {
  // @ts-expect-error `email` is a string, not a number
  handleSubmit: async (data: { email: number }) => {
    void data;
  },
});
useForm(Login, {
  // @ts-expect-error not a field on the schema
  initialValues: { nope: 1 },
  handleSubmit: async () => {},
});
