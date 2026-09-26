const assert = require("assert");
const {
  TERMINAL_PAYMENT_METHOD,
  TERMINAL_PAYMENT_STATUSES,
  allocateTerminalOrderAmounts,
  calculateTerminalApplicationFee,
  buildTerminalPaymentIntentParams,
} = require("../src/helpers/stripeTerminal");

assert.strictEqual(TERMINAL_PAYMENT_METHOD, "Carte bancaire - TPE Stripe");
assert.deepStrictEqual(TERMINAL_PAYMENT_STATUSES, {
  CREATING: "creating",
  PROCESSING: "processing",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  CANCELED: "canceled",
});

const orders = [
  { id: 31, amountCents: 1200 },
  { id: 12, amountCents: 800 },
];
assert.deepStrictEqual(allocateTerminalOrderAmounts({ orders }), {
  subtotalCents: 2000,
  discountCents: 0,
  totalCents: 2000,
  allocations: [
    { orderId: 12, amountCents: 800 },
    { orderId: 31, amountCents: 1200 },
  ],
});
assert.deepStrictEqual(allocateTerminalOrderAmounts({
  orders, discountType: "percent", discountValue: 12.5,
}), {
  subtotalCents: 2000,
  discountCents: 250,
  totalCents: 1750,
  allocations: [
    { orderId: 12, amountCents: 700 },
    { orderId: 31, amountCents: 1050 },
  ],
});
assert.deepStrictEqual(allocateTerminalOrderAmounts({
  orders: [{ id: 42, amountCents: 1500 }],
  discountType: "percent",
  discountValue: 8.7,
}), {
  subtotalCents: 1500,
  discountCents: 131,
  totalCents: 1369,
  allocations: [{ orderId: 42, amountCents: 1369 }],
});
assert.deepStrictEqual(allocateTerminalOrderAmounts({
  orders, discountType: "amount", discountValue: 500,
}), {
  subtotalCents: 2000,
  discountCents: 500,
  totalCents: 1500,
  allocations: [
    { orderId: 12, amountCents: 600 },
    { orderId: 31, amountCents: 900 },
  ],
});

const roundingOrders = [
  { id: 30, amountCents: 100 },
  { id: 10, amountCents: 100 },
  { id: 20, amountCents: 100 },
];
const rounded = allocateTerminalOrderAmounts({
  orders: roundingOrders, discountType: "amount", discountValue: 2,
});
assert.deepStrictEqual(rounded, {
  subtotalCents: 300,
  discountCents: 2,
  totalCents: 298,
  allocations: [
    { orderId: 10, amountCents: 99 },
    { orderId: 20, amountCents: 99 },
    { orderId: 30, amountCents: 100 },
  ],
});
assert.strictEqual(
  rounded.allocations.reduce((sum, allocation) => sum + allocation.amountCents, 0),
  rounded.totalCents,
);
assert.deepStrictEqual(allocateTerminalOrderAmounts({
  orders: [...roundingOrders].reverse(), discountType: "amount", discountValue: 2,
}), rounded);

for (const input of [
  { orders: [] },
  { orders: [{ id: 1, amountCents: 0 }] },
  { orders: [{ id: 1, amountCents: -1 }] },
  { orders: [{ id: 1, amountCents: 12.5 }] },
  { orders: [{ id: 1, amountCents: 100 }, { id: 1, amountCents: 100 }] },
  { orders, discountType: "amount", discountValue: 2000 },
  { orders, discountType: "amount", discountValue: -1 },
  { orders, discountType: "percent", discountValue: 101 },
  { orders, discountType: "other", discountValue: 10 },
]) {
  assert.throws(() => allocateTerminalOrderAmounts(input), /invalid|positive/i);
}

assert.strictEqual(calculateTerminalApplicationFee(2000), 100);
assert.strictEqual(calculateTerminalApplicationFee(999, "7.5"), 75);
assert.strictEqual(calculateTerminalApplicationFee(1500, 8.7), 131);
assert.strictEqual(calculateTerminalApplicationFee(2000, "invalid"), 100);
assert.strictEqual(calculateTerminalApplicationFee(2000, 0), 0);
assert.throws(() => calculateTerminalApplicationFee(0, 5), /invalid/i);

assert.deepStrictEqual(buildTerminalPaymentIntentParams({
  totalCents: 1750,
  connectedAccountId: "acct_123",
  applicationFeeAmount: 88,
  terminalPaymentId: 42,
  shopId: 7,
}), {
  amount: 1750,
  currency: "eur",
  payment_method_types: ["card_present"],
  capture_method: "automatic",
  application_fee_amount: 88,
  on_behalf_of: "acct_123",
  transfer_data: { destination: "acct_123" },
  metadata: { terminal_payment_id: "42", shop_id: "7" },
});

for (const input of [
  { totalCents: 0, connectedAccountId: "acct_123", applicationFeeAmount: 0,
    terminalPaymentId: 42, shopId: 7 },
  { totalCents: 10.5, connectedAccountId: "acct_123", applicationFeeAmount: 0,
    terminalPaymentId: 42, shopId: 7 },
  { totalCents: 100, connectedAccountId: "", applicationFeeAmount: 5,
    terminalPaymentId: 42, shopId: 7 },
  { totalCents: 100, connectedAccountId: "acct_123", applicationFeeAmount: 101,
    terminalPaymentId: 42, shopId: 7 },
]) {
  assert.throws(() => buildTerminalPaymentIntentParams(input));
}

console.log("stripe terminal domain tests passed");
