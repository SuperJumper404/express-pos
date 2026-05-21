const assert = require("assert");
const {
  calculateApplicationFee,
  toStripeAmount,
  buildDestinationPaymentIntentParams,
} = require("../src/helpers/stripePayment");
const {
  QR_PAYMENT_MODES,
  normalizeQrPaymentMode,
  isStripeRequiredBeforeOrder,
} = require("../src/helpers/qrPaymentMode");
const { resolveStripePaymentMethod } = require("../src/helpers/stripePaymentMethod");

assert.strictEqual(toStripeAmount(12.34), 1234);
assert.strictEqual(toStripeAmount("12.30"), 1230);
assert.strictEqual(calculateApplicationFee(4000, 5), 200);
assert.strictEqual(calculateApplicationFee(999, 5), 50);

const params = buildDestinationPaymentIntentParams({
  amount: 40,
  currency: "eur",
  connectedAccountId: "acct_123",
  orderId: 42,
  shopId: 7,
  commissionPercent: 5,
  paymentMethodConfigurationId: "pmc_test_123",
});

assert.deepStrictEqual(params, {
  amount: 4000,
  currency: "eur",
  automatic_payment_methods: { enabled: true },
  application_fee_amount: 200,
  on_behalf_of: "acct_123",
  payment_method_configuration: "pmc_test_123",
  transfer_data: { destination: "acct_123" },
  metadata: {
    order_id: "42",
    shop_id: "7",
  },
});

const paramsWithoutPaymentMethodConfiguration = buildDestinationPaymentIntentParams({
  amount: 10,
  connectedAccountId: "acct_123",
  orderId: 43,
  shopId: 8,
});

assert.strictEqual(
  Object.prototype.hasOwnProperty.call(
    paramsWithoutPaymentMethodConfiguration,
    "payment_method_configuration",
  ),
  false,
);

assert.throws(
  () => buildDestinationPaymentIntentParams({ amount: 0, connectedAccountId: "acct_123" }),
  /Montant invalide/,
);
assert.throws(
  () => buildDestinationPaymentIntentParams({ amount: 10, connectedAccountId: "" }),
  /Compte Stripe restaurateur manquant/,
);

assert.strictEqual(
  normalizeQrPaymentMode(QR_PAYMENT_MODES.PAY_AT_COUNTER),
  QR_PAYMENT_MODES.PAY_AT_COUNTER,
);
assert.strictEqual(
  normalizeQrPaymentMode("invalid-mode"),
  QR_PAYMENT_MODES.STRIPE_BEFORE_ORDER,
);
assert.strictEqual(isStripeRequiredBeforeOrder("stripe_before_order"), true);
assert.strictEqual(isStripeRequiredBeforeOrder("pay_at_counter"), false);

assert.strictEqual(
  resolveStripePaymentMethod({
    charge: {
      payment_method_details: {
        type: "card",
        card: { wallet: { type: "apple_pay" } },
      },
    },
  }),
  "Apple Pay",
);
assert.strictEqual(
  resolveStripePaymentMethod({
    charge: {
      payment_method_details: {
        type: "card",
        card: { wallet: { type: "google_pay" } },
      },
    },
  }),
  "Google Pay",
);
assert.strictEqual(
  resolveStripePaymentMethod({
    charge: { payment_method_details: { type: "card" } },
  }),
  "Carte",
);
assert.strictEqual(
  resolveStripePaymentMethod({
    paymentIntent: { payment_method_types: ["card"] },
  }),
  "Carte",
);
assert.strictEqual(resolveStripePaymentMethod({}), "Stripe");

console.log("stripePayment tests passed");
