const assert = require("assert");
const {
  CANONICAL_PAYMENT_METHODS,
  normalizePaymentMethod,
  normalizePaymentMethods,
} = require("../src/helpers/paymentMethod");

assert.strictEqual(normalizePaymentMethod("carte bancaire"), "Carte bancaire");
assert.strictEqual(normalizePaymentMethod("CB"), "Carte bancaire");
assert.strictEqual(normalizePaymentMethod("especes"), "Espèces");
assert.strictEqual(normalizePaymentMethod("Tickets Restaurants"), "Ticket restaurant");
assert.strictEqual(normalizePaymentMethod("cheques"), "Chèque");
assert.strictEqual(normalizePaymentMethod("stripe", "stripe"), "Stripe");
assert.strictEqual(normalizePaymentMethod("carte bancaire", "stripe"), "Stripe");
assert.strictEqual(normalizePaymentMethod("Paiement inhabituel"), "Carte bancaire");
assert.deepStrictEqual(normalizePaymentMethods(["CB", "carte bancaire", "Especes"]), [
  "Carte bancaire",
  "Espèces",
]);
assert.deepStrictEqual(CANONICAL_PAYMENT_METHODS, [
  "Carte bancaire",
  "Stripe",
  "Espèces",
  "Chèque",
  "Ticket restaurant",
]);

console.log("payment method standardization tests passed");
