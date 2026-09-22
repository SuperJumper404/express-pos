const assert = require("assert");
const {
  resolveCheckoutPaymentState,
} = require("../src/modules/m_checkout");

assert.deepStrictEqual(resolveCheckoutPaymentState("stripe"), {
  payment: "Stripe",
  payment_status: "requires_payment",
  payment_provider: "stripe",
});

assert.deepStrictEqual(resolveCheckoutPaymentState("cash"), {
  payment: "Espèces",
  payment_status: "unpaid",
  payment_provider: null,
});

assert.deepStrictEqual(resolveCheckoutPaymentState("counter_pay_before:Espèces"), {
  payment: "Espèces",
  payment_status: "paid",
  payment_provider: "counter",
});

assert.deepStrictEqual(resolveCheckoutPaymentState("counter_pay_before:Carte bancaire"), {
  payment: "Carte bancaire",
  payment_status: "paid",
  payment_provider: "counter",
});

console.log("counter checkout payment mode tests passed");
