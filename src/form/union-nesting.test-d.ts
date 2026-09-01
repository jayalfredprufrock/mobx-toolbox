/**
 * Type-level tests for unions of unions.
 *
 * TypeBox does not normalize nesting: `T.Union([A, T.Union([B, C])])` keeps a union inside `anyOf`,
 * while `T.Static` reads it as the flat `A | B | C`. So every helper that walks `anyOf` on the type
 * has to flatten too — otherwise a nested member fails its `extends TObject` test and collapses to
 * `never`, dropping that whole branch's fields with no error at the point of definition. The
 * failure is silent by nature, which is what makes it worth pinning here: this file passing
 * `vp check` *is* the test.
 */
import * as T from "typebox";
import { makeUnionModel } from "../model/make-model";
import type {
  DiscriminatorKeys,
  DiscriminatorValue,
  FormConfig,
  FormFields,
  MatchVariant,
  RawFormFields,
} from "./form.types";

const assignableTo = <Expected>(_value: Expected): void => {};

const Card = T.Object({ method: T.Literal("card"), holder: T.String(), cardNumber: T.String() });
const Wire = T.Object({ method: T.Literal("wire"), holder: T.String(), swift: T.String() });
const Bank = T.Object({ method: T.Literal("bank"), holder: T.String(), routing: T.String() });

const Electronic = T.Union([Card, Wire]);
/** Two levels, with a bare object as a direct sibling of a union. */
const Payment = T.Union([Electronic, Bank]);
type PaymentSchema = typeof Payment;

/** Reached through the public config rather than the private mapped type it resolves to. */
type InitialValues = NonNullable<FormConfig<PaymentSchema>["initialValues"]>;

// --- Static flattens on its own ---------------------------------------------

type Payload = T.Static<PaymentSchema>;
assignableTo<Payload>({ method: "wire", holder: "Ada", swift: "DEUTDEFF" });
assignableTo<Payload>({ method: "bank", holder: "Ada", routing: "021" });
// @ts-expect-error `swift` belongs to the wire variant, not bank
assignableTo<Payload>({ method: "bank", holder: "Ada", swift: "DEUTDEFF" });

// --- makeUnionModel ---------------------------------------------------------

const PaymentModel = makeUnionModel(Payment, "method", { keys: ["holder"] as const });
const payment = new PaymentModel({ method: "card", holder: "Ada", cardNumber: "4242" });

// A guard on a literal from either side of the nesting reveals that variant's fields.
if (payment.is("wire")) assignableTo<string>(payment.swift);
if (payment.is("bank")) assignableTo<string>(payment.routing);
assignableTo<string | undefined>(payment.as("card")?.cardNumber);
// @ts-expect-error not a discriminator value on any variant
payment.is("crypto");
// Shared across every variant at every depth, so it is on the base instance.
assignableTo<string>(payment.holder);
assignableTo<{ holder: string }>(payment.buildParams());

// @ts-expect-error `method` is a valid discriminator; `holder` is not a literal anywhere
const _badDiscriminator = makeUnionModel(Payment, "nope");

// --- form types -------------------------------------------------------------

// Only fields on *every* variant, nesting included.
assignableTo<keyof FormFields<PaymentSchema>>("holder");
assignableTo<keyof FormFields<PaymentSchema>>("method");
// @ts-expect-error card-only, so not a shared field
assignableTo<keyof FormFields<PaymentSchema>>("cardNumber");

// Every field across every variant — the nested branch's fields must survive.
assignableTo<keyof RawFormFields<PaymentSchema>>("cardNumber");
assignableTo<keyof RawFormFields<PaymentSchema>>("swift");
assignableTo<keyof RawFormFields<PaymentSchema>>("routing");

assignableTo<InitialValues>({ method: "wire", swift: "DEUTDEFF" });
assignableTo<InitialValues>({ method: "bank", routing: "021" });
// @ts-expect-error not a field on any variant
assignableTo<InitialValues>({ wallet: "0x" });

// --- FormWhen narrowing -----------------------------------------------------

assignableTo<DiscriminatorKeys<PaymentSchema>>("method");
// @ts-expect-error not a literal on any variant
assignableTo<DiscriminatorKeys<PaymentSchema>>("holder");

// Literals from both the nested union and the bare sibling.
assignableTo<DiscriminatorValue<PaymentSchema, "method">>("card");
assignableTo<DiscriminatorValue<PaymentSchema, "method">>("wire");
assignableTo<DiscriminatorValue<PaymentSchema, "method">>("bank");
// @ts-expect-error no such variant
assignableTo<DiscriminatorValue<PaymentSchema, "method">>("crypto");

// A nested variant still resolves to its own object schema, not `never`.
type Wired = MatchVariant<PaymentSchema, "method", "wire">;
assignableTo<keyof Wired["properties"]>("swift");
assignableTo<T.Static<Wired>>({ method: "wire", holder: "Ada", swift: "DEUTDEFF" });
