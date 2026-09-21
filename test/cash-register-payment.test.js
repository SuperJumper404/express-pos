const assert = require("assert");
const {
  buildCashRegisterCollectionFields,
  buildCashRegisterArchiveFields,
  isPaymentAlreadyCollected,
  shouldCancelPendingStripePayment,
} = require("../src/helpers/cashRegisterPayment");

assert.strictEqual(
  isPaymentAlreadyCollected({ payment_status: "paid" }),
  true,
);
assert.strictEqual(
  isPaymentAlreadyCollected({ payment_status: "unpaid" }),
  false,
);

assert.strictEqual(
  shouldCancelPendingStripePayment({
    payment_status: "requires_payment",
    payment_provider: "stripe",
    stripe_payment_intent_id: "pi_123",
  }),
  true,
);
assert.strictEqual(
  shouldCancelPendingStripePayment({
    payment_status: "paid",
    payment_provider: "stripe",
    stripe_payment_intent_id: "pi_123",
  }),
  false,
);

assert.deepStrictEqual(
  buildCashRegisterArchiveFields({
    order: {
      payment_status: "paid",
      payment_provider: "stripe",
      payment: "Apple Pay",
      stripe_payment_intent_id: "pi_123",
    },
    paymentMethod: "Especes",
  }),
  {
    payment: "Stripe",
    payment_status: "paid",
    payment_provider: "stripe",
    stripe_payment_intent_id: "pi_123",
    used_payment_method: "Stripe",
  },
);

assert.throws(
  () =>
    buildCashRegisterArchiveFields({
      order: {
        payment_status: "paid",
        payment: "Paiement au comptoir",
      },
      paymentMethod: "",
    }),
  /Moyen de paiement requis/,
);

assert.deepStrictEqual(
  buildCashRegisterArchiveFields({
    order: {
      payment_status: "paid",
      payment: "Paiement au comptoir",
    },
    paymentMethod: "Especes",
  }),
  {
    payment: "Espèces",
    payment_status: "paid",
    payment_provider: null,
    stripe_payment_intent_id: null,
    used_payment_method: "Espèces",
  },
);

assert.deepStrictEqual(
  buildCashRegisterCollectionFields("Especes"),
  {
    payment: "Espèces",
    payment_status: "paid",
    payment_provider: null,
    stripe_payment_intent_id: null,
  },
);

assert.deepStrictEqual(
  buildCashRegisterArchiveFields({
    order: {
      payment_status: "unpaid",
      payment: "Paiement au comptoir",
    },
    paymentMethod: "Tickets Restaurants",
  }),
  {
    payment: "Ticket restaurant",
    payment_status: "paid",
    payment_provider: null,
    stripe_payment_intent_id: null,
    used_payment_method: "Ticket restaurant",
  },
);

assert.deepStrictEqual(
  buildCashRegisterArchiveFields({
    order: {
      payment_status: "requires_payment",
      payment_provider: "stripe",
      payment: "Stripe",
      stripe_payment_intent_id: "pi_456",
    },
    paymentMethod: "Cheques",
  }),
  {
    payment: "Chèque",
    payment_status: "paid",
    payment_provider: null,
    stripe_payment_intent_id: null,
    used_payment_method: "Chèque",
  },
);

assert.throws(
  () =>
    buildCashRegisterArchiveFields({
      order: { payment_status: "unpaid" },
      paymentMethod: "",
    }),
  /Moyen de paiement requis/,
);

console.log("cashRegisterPayment tests passed");
