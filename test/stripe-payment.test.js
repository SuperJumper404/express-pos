const assert = require("assert");
const {
  calculateApplicationFee,
  normalizeCommissionPercent,
  toStripeAmount,
  buildDestinationPaymentIntentParams,
} = require("../src/helpers/stripePayment");
const {
  QR_PAYMENT_MODES,
  normalizeQrPaymentMode,
  isStripePaymentAllowed,
  isStripeRequiredBeforeOrder,
} = require("../src/helpers/qrPaymentMode");
const { ORDER_STATUSES } = require("../src/helpers/orderStatus");
const { resolveStripePaymentMethod } = require("../src/helpers/stripePaymentMethod");
const { parsePositiveIntegerEnv } = require("../src/helpers/env");
const { buildCheckoutModule } = require("../src/modules/m_checkout");
const { buildPaymentModule } = require("../src/modules/m_payments");
const callbackDbPath = require.resolve("../src/config/db");
require.cache[callbackDbPath] = {
  exports: { query: () => { throw new Error("unexpected legacy DB query"); } },
};
const {
  buildQrTablePaymentIntentController,
} = require("../src/controllers/c_stripe");

assert.strictEqual(toStripeAmount(12.34), 1234);
assert.strictEqual(toStripeAmount("12.30"), 1230);
assert.strictEqual(calculateApplicationFee(4000, 5), 200);
assert.strictEqual(calculateApplicationFee(999, 5), 50);
assert.strictEqual(normalizeCommissionPercent(null), 5);
assert.strictEqual(normalizeCommissionPercent(""), 5);
assert.strictEqual(normalizeCommissionPercent("7.5"), 7.5);
assert.strictEqual(normalizeCommissionPercent("-1"), 5);
assert.strictEqual(normalizeCommissionPercent("101"), 5);
assert.strictEqual(calculateApplicationFee(1200, "7.5"), 90);

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
assert.strictEqual(isStripePaymentAllowed("stripe_before_order"), true);
assert.strictEqual(isStripePaymentAllowed("pay_at_counter"), true);
assert.strictEqual(ORDER_STATUSES.PENDING, 1);

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

assert.strictEqual(parsePositiveIntegerEnv(undefined, 15), 15);
assert.strictEqual(parsePositiveIntegerEnv("", 15), 15);
assert.strictEqual(parsePositiveIntegerEnv("0", 15), 15);
assert.strictEqual(parsePositiveIntegerEnv("-2", 15), 15);
assert.strictEqual(parsePositiveIntegerEnv("1.5", 15), 15);
assert.strictEqual(parsePositiveIntegerEnv("30", 15), 30);

const cloneLifecycleState = (state) => ({
  products: new Map(state.products),
  reservations: state.reservations.map((row) => ({ ...row })),
  movements: state.movements.map((row) => ({ ...row })),
  orders: state.orders.map((row) => ({ ...row })),
  payments: state.payments.map((row) => ({ ...row })),
});

const makeStripeLifecycleHarness = () => {
  let state = {
    products: new Map([[10, 8]]),
    reservations: [{
      id: 1,
      order_id: 42,
      product_id: 10,
      quantity: 2,
      status: "reserved",
      expires_at: "2026-07-24 11:59:00",
    }],
    movements: [],
    orders: [{
      id: 42,
      shopid: 7,
      customerID: 12,
      operator: 9,
      payment_status: "requires_payment",
      payment_provider: "stripe",
      stripe_payment_intent_id: "pi_42",
      status: ORDER_STATUSES.PENDING,
    }],
    payments: [{
      order_id: 42,
      stripe_payment_intent_id: "pi_42",
      status: "requires_payment",
    }],
  };
  const events = [];
  const withTransaction = async (work) => {
    const before = cloneLifecycleState(state);
    events.push("begin");
    try {
      const result = await work({ transaction: true });
      events.push("commit");
      return result;
    } catch (error) {
      state = before;
      events.push("rollback");
      throw error;
    }
  };
  const checkoutRepository = {
    lockExpiredReservations: async () => state.reservations.filter(
      (row) => row.status === "reserved" && row.expires_at <= "2026-07-24 12:00:00",
    ),
    lockReservationsByOrder: async ({ orderId }) => state.reservations.filter(
      (row) => row.order_id === Number(orderId),
    ),
    lockProducts: async ({ productIds }) => productIds.map((productId) => ({
      id: productId,
      stock: state.products.get(productId),
    })),
    updateReservationStatus: async ({ reservationId, fromStatus, toStatus }) => {
      const reservation = state.reservations.find((row) => row.id === reservationId);
      if (!reservation || reservation.status !== fromStatus) return { affectedRows: 0 };
      reservation.status = toStatus;
      return { affectedRows: 1 };
    },
    adjustStock: async ({ productId, delta }) => {
      state.products.set(productId, state.products.get(productId) + delta);
      events.push(["stock", productId, delta]);
      return { affectedRows: 1 };
    },
    insertMovement: async ({ movement }) => {
      state.movements.push({ ...movement });
      return { insertId: state.movements.length };
    },
  };
  const paymentRepository = {
    findPaymentByIntent: async ({ paymentIntentId }) => state.payments.find(
      (row) => row.stripe_payment_intent_id === paymentIntentId,
    ) || null,
    findOrderById: async ({ orderId, shopId }) => state.orders.find(
      (row) => row.id === Number(orderId) && (shopId == null || row.shopid === Number(shopId)),
    ) || null,
    updatePaymentSucceeded: async ({ paymentIntentId, chargeId, paymentMethod }) => {
      const payment = state.payments.find(
        (row) => row.stripe_payment_intent_id === paymentIntentId,
      );
      payment.status = "succeeded";
      payment.stripe_charge_id = chargeId;
      payment.payment_method = paymentMethod;
      return { affectedRows: 1 };
    },
    updateOrderSucceeded: async ({ orderId, paymentMethod }) => {
      const order = state.orders.find((row) => row.id === Number(orderId));
      order.payment_status = "paid";
      order.payment = paymentMethod;
      return { affectedRows: 1 };
    },
    updatePaymentTerminal: async ({ paymentIntentId, status }) => {
      const payment = state.payments.find(
        (row) => row.stripe_payment_intent_id === paymentIntentId,
      );
      if (payment) payment.status = status;
      return { affectedRows: payment ? 1 : 0 };
    },
    updateOrderTerminal: async ({ orderId, status }) => {
      const order = state.orders.find((row) => row.id === Number(orderId));
      if (order) order.payment_status = status;
      return { affectedRows: order ? 1 : 0 };
    },
    updatePaymentAtCounter: async ({ orderId }) => {
      const payment = state.payments.find((row) => row.order_id === Number(orderId));
      if (payment) payment.status = "canceled";
      return { affectedRows: payment ? 1 : 0 };
    },
    updateOrderAtCounter: async ({ orderId, shopId }) => {
      const order = state.orders.find(
        (row) => row.id === Number(orderId) && row.shopid === Number(shopId),
      );
      if (!order || order.payment_status !== "requires_payment") return { affectedRows: 0 };
      Object.assign(order, {
        payment_status: "unpaid",
        payment: "Paiement au comptoir",
        payment_provider: null,
        stripe_payment_intent_id: null,
      });
      return { affectedRows: 1 };
    },
    cancelPaymentsForOrder: async ({ orderId }) => {
      const payment = state.payments.find((row) => row.order_id === Number(orderId));
      if (payment) payment.status = "canceled";
      return { affectedRows: payment ? 1 : 0 };
    },
    cancelProvisionalOrder: async ({ orderId, shopId }) => {
      const order = state.orders.find(
        (row) => row.id === Number(orderId) && row.shopid === Number(shopId),
      );
      if (!order || order.payment_status !== "requires_payment") return { affectedRows: 0 };
      order.payment_status = "canceled";
      order.status = ORDER_STATUSES.CANCELED;
      return { affectedRows: 1 };
    },
  };
  const checkout = buildCheckoutModule({
    repository: checkoutRepository,
    withTransaction,
    now: () => new Date("2026-07-24T12:00:00.000Z"),
  });
  const payments = buildPaymentModule({
    repository: paymentRepository,
    withTransaction,
    finalizeReservations: checkout.finalizeReservations,
    now: () => new Date("2026-07-24T12:00:00.000Z"),
  });
  return {
    checkout,
    payments,
    events,
    getState: () => state,
  };
};

const succeededIntent = {
  id: "pi_42",
  latest_charge: "ch_42",
  payment_method_types: ["card"],
};

const runStripeReservationContracts = async () => {
  let harness = makeStripeLifecycleHarness();
  await harness.payments.markPaymentSucceeded(succeededIntent);
  await harness.payments.markPaymentSucceeded(succeededIntent);
  assert.strictEqual(harness.getState().products.get(10), 8);
  assert.strictEqual(harness.getState().reservations[0].status, "committed");
  assert.strictEqual(harness.getState().movements.length, 1);
  assert.strictEqual(harness.getState().orders[0].payment_status, "paid");

  harness = makeStripeLifecycleHarness();
  await harness.payments.markStripeOrderPayAtCounter(42, 7);
  assert.strictEqual(harness.getState().products.get(10), 8);
  assert.strictEqual(harness.getState().reservations[0].status, "committed");
  assert.strictEqual(harness.getState().movements.length, 1);
  assert.strictEqual(harness.getState().orders[0].payment_status, "unpaid");

  for (const transition of ["failed", "canceled"]) {
    harness = makeStripeLifecycleHarness();
    const action = transition === "failed" ? "markPaymentFailed" : "markPaymentCanceled";
    await harness.payments[action]("pi_42");
    await harness.payments[action]("pi_42");
    assert.strictEqual(harness.getState().products.get(10), 10, `${transition} restores once`);
    assert.strictEqual(harness.getState().reservations[0].status, "released");
    await harness.payments.markPaymentSucceeded(succeededIntent);
    assert.strictEqual(harness.getState().products.get(10), 10);
    assert.strictEqual(harness.getState().orders[0].payment_status, transition);
  }

  harness = makeStripeLifecycleHarness();
  await harness.payments.markPaymentSucceeded(succeededIntent);
  await harness.payments.markPaymentCanceled("pi_42");
  assert.strictEqual(harness.getState().products.get(10), 8);
  assert.strictEqual(harness.getState().reservations[0].status, "committed");

  harness = makeStripeLifecycleHarness();
  assert.strictEqual(await harness.checkout.releaseExpiredReservations(), 1);
  assert.strictEqual(await harness.checkout.releaseExpiredReservations(), 0);
  await harness.payments.markPaymentSucceeded(succeededIntent);
  assert.strictEqual(harness.getState().products.get(10), 10);
  assert.strictEqual(harness.getState().reservations[0].status, "released");

  harness = makeStripeLifecycleHarness();
  await harness.payments.cancelProvisionalStripeOrder(42, 7);
  await harness.payments.cancelProvisionalStripeOrder(42, 7);
  assert.strictEqual(harness.getState().products.get(10), 10);
  assert.strictEqual(harness.getState().reservations[0].status, "released");
  assert.strictEqual(harness.getState().orders[0].payment_status, "canceled");
  assert.strictEqual(harness.getState().orders[0].status, ORDER_STATUSES.CANCELED);
};

const makeResponse = () => ({
  statusCode: null,
  payload: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.payload = payload;
    return this;
  },
});

const runStripeCheckoutControllerContracts = async () => {
  const checkoutCalls = [];
  const attached = [];
  const recorded = [];
  const stripeCreateCalls = [];
  let cleaned = [];
  const controller = buildQrTablePaymentIntentController({
    getShopInfo: async () => [{
      id: 7,
      qr_payment_mode: "stripe_before_order",
      stripe_account_id: "acct_7",
      stripe_charges_enabled: 1,
      stripe_commission_percent: 5,
      kitchen_closed: 0,
    }],
    createCheckout: async (input) => {
      checkoutCalls.push(input);
      return { orderId: 42, total: 23, payment_status: "requires_payment" };
    },
    getStripe: () => ({
      paymentIntents: {
        create: async (...args) => {
          stripeCreateCalls.push(args);
          return {
            id: "pi_42",
            client_secret: "secret_42",
            status: "requires_payment_method",
          };
        },
      },
    }),
    attachPaymentIntentToOrder: async (...args) => attached.push(args),
    createPaymentRecord: async (data) => recorded.push(data),
    cancelProvisionalStripeOrder: async (...args) => cleaned.push(args),
    logger: { error: () => {} },
  });
  const request = {
    shopid: 7,
    id: 9,
    body: {
      customer: { id: 12, name: "Ada", phone: "0102", remark: "Sans sac" },
      items: [{ product_id: 10, quantity: 2, selected_choice_ids: [101] }],
      expected_total: "23.00",
      client_order_token: "stripe-token-1",
    },
  };
  let response = makeResponse();
  await controller(request, response);
  assert.strictEqual(response.statusCode, 200);
  assert.deepStrictEqual(checkoutCalls, [{
    shopId: 7,
    actorId: 9,
    customer: request.body.customer,
    items: [{ productId: 10, quantity: 2, selectedChoiceIds: [101] }],
    expectedTotal: "23.00",
    clientOrderToken: "stripe-token-1",
    paymentMode: "stripe",
  }]);
  assert.deepStrictEqual(attached, [[42, "pi_42"]]);
  assert.strictEqual(stripeCreateCalls[0][1].idempotencyKey, "qr-7-stripe-token-1");
  assert.strictEqual(recorded[0].amount, 23);
  assert.deepStrictEqual(cleaned, []);

  const logs = [];
  cleaned = [];
  const failingController = buildQrTablePaymentIntentController({
    getShopInfo: async () => [{
      id: 7,
      qr_payment_mode: "stripe_before_order",
      stripe_account_id: "acct_7",
      stripe_charges_enabled: 1,
      stripe_commission_percent: 5,
      kitchen_closed: 0,
    }],
    createCheckout: async () => ({
      orderId: 42,
      total: 23,
      payment_status: "requires_payment",
    }),
    getStripe: () => ({
      paymentIntents: {
        create: async () => { throw new Error("Stripe secret key rejected"); },
      },
    }),
    attachPaymentIntentToOrder: async () => {},
    createPaymentRecord: async () => {},
    cancelProvisionalStripeOrder: async (...args) => cleaned.push(args),
    logger: { error: (...args) => logs.push(args) },
  });
  response = makeResponse();
  await failingController(request, response);
  assert.strictEqual(response.statusCode, 500);
  assert.deepStrictEqual(cleaned, [[42, 7]]);
  assert.ok(!JSON.stringify(response.payload).includes("Stripe secret"));
  assert.strictEqual(logs.length, 1);
};

runStripeReservationContracts()
  .then(runStripeCheckoutControllerContracts)
  .then(() => console.log("stripePayment tests passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
