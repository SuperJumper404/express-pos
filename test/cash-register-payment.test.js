const assert = require("assert");
const {
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
    payment: "Apple Pay",
    payment_status: "paid",
    payment_provider: "stripe",
    stripe_payment_intent_id: "pi_123",
    used_payment_method: "Apple Pay",
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
    payment: "Tickets Restaurants",
    payment_status: "paid",
    payment_provider: null,
    stripe_payment_intent_id: null,
    used_payment_method: "Tickets Restaurants",
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
    payment: "Cheques",
    payment_status: "paid",
    payment_provider: null,
    stripe_payment_intent_id: null,
    used_payment_method: "Cheques",
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
