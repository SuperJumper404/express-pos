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
const { buildCashRegisterArchiveFields } = require("../src/helpers/cashRegisterPayment");
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
const {
  buildArchiveOrderController,
  buildPendingStripeArchiveSync,
} = require("../src/controllers/c_orders");
const { buildOrderArchiveModule } = require("../src/modules/m_orders");

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
  details: state.details.map((row) => ({ ...row })),
  orders: state.orders.map((row) => ({ ...row })),
  payments: state.payments.map((row) => ({ ...row })),
});

const makeStripeLifecycleHarness = ({
  paymentAttached = true,
  failAttachment = false,
  failPaymentRecord = false,
  orderPaymentStatus = "requires_payment",
  paymentStatus = "requires_payment",
} = {}) => {
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
    details: [{ id: 70, orderid: 42, productid: 10, qty: 2 }],
    orders: [{
      id: 42,
      shopid: 7,
      customerID: 12,
      operator: 9,
      payment_status: orderPaymentStatus,
      payment_provider: "stripe",
      stripe_payment_intent_id: paymentAttached ? "pi_42" : null,
      client_order_token: "stripe-token-1",
      status: ORDER_STATUSES.PENDING,
    }],
    payments: paymentAttached ? [{
      order_id: 42,
      stripe_payment_intent_id: "pi_42",
      status: paymentStatus,
    }] : [],
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
    lockOrderForReservationBackfill: async ({ orderId }) => state.orders.find(
      (row) => row.id === Number(orderId),
    ) || null,
    getLegacyOrderDetails: async ({ orderId }) => state.details
      .filter((row) => row.orderid === Number(orderId))
      .map((row) => ({ productid: row.productid, quantity: row.qty })),
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
    insertReservation: async ({ reservation }) => {
      state.reservations.push({ id: state.reservations.length + 1, ...reservation });
      return { insertId: state.reservations.length };
    },
  };
  const paymentRepository = {
    findPaymentByIntent: async ({ paymentIntentId, connection }) => {
      if (connection) events.push("lock-payment");
      return state.payments.find(
        (row) => row.stripe_payment_intent_id === paymentIntentId,
      ) || null;
    },
    findOrderById: async ({ orderId, shopId, connection }) => {
      if (connection) events.push("lock-order");
      return state.orders.find(
        (row) => row.id === Number(orderId) && (shopId == null || row.shopid === Number(shopId)),
      ) || null;
    },
    attachPaymentIntentToOrder: async ({ orderId, shopId, paymentIntentId }) => {
      if (failAttachment) throw new Error("SQL attach failure");
      const order = state.orders.find(
        (row) => row.id === Number(orderId) && row.shopid === Number(shopId),
      );
      if (!order
        || order.payment_status !== "requires_payment"
        || order.payment_provider !== "stripe"
        || (order.stripe_payment_intent_id
          && order.stripe_payment_intent_id !== paymentIntentId)) {
        return { affectedRows: 0 };
      }
      if (order.stripe_payment_intent_id === paymentIntentId) {
        return { affectedRows: 0 };
      }
      order.stripe_payment_intent_id = paymentIntentId;
      return { affectedRows: 1 };
    },
    upsertPaymentRecord: async ({ data }) => {
      if (failPaymentRecord) throw new Error("SQL payment record failure");
      const existing = state.payments.find(
        (row) => row.stripe_payment_intent_id === data.stripe_payment_intent_id,
      );
      if (existing) {
        if (!["succeeded", "canceled", "refunded"].includes(existing.status)) {
          Object.assign(existing, data);
        }
        return { affectedRows: 1 };
      }
      state.payments.push({ ...data });
      return { insertId: state.payments.length };
    },
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

  harness = makeStripeLifecycleHarness();
  harness.getState().reservations.length = 0;
  harness.getState().products.set(10, 10);
  harness.getState().orders[0].client_order_token = null;
  await harness.payments.markPaymentSucceeded(succeededIntent);
  await harness.payments.markPaymentSucceeded(succeededIntent);
  assert.strictEqual(harness.getState().orders[0].payment_status, "paid");
  assert.strictEqual(harness.getState().products.get(10), 8);
  assert.strictEqual(harness.getState().reservations[0].status, "committed");
  assert.strictEqual(harness.getState().movements.length, 1);

  harness = makeStripeLifecycleHarness();
  harness.getState().reservations.length = 0;
  harness.getState().products.set(10, 10);
  await assert.rejects(
    () => harness.payments.markPaymentSucceeded(succeededIntent),
    (error) => error.code === "RESERVATION_INTEGRITY_ERROR",
  );
  assert.strictEqual(harness.getState().orders[0].payment_status, "requires_payment");
  assert.strictEqual(harness.getState().payments[0].status, "requires_payment");
  assert.strictEqual(harness.getState().products.get(10), 10);
  assert.strictEqual(harness.getState().movements.length, 0);

  harness = makeStripeLifecycleHarness({ paymentAttached: false });
  let persistence = await harness.payments.persistPaymentIntentForOrder({
    orderId: 42,
    shopId: 7,
    stripe_payment_intent_id: "pi_42",
    amount: 23,
    amount_cents: 2300,
    application_fee_amount: 115,
    currency: "eur",
    status: "requires_payment_method",
  });
  assert.strictEqual(persistence.attached, true);
  assert.strictEqual(harness.getState().orders[0].stripe_payment_intent_id, "pi_42");
  assert.strictEqual(harness.getState().payments[0].status, "requires_payment_method");

  harness = makeStripeLifecycleHarness();
  harness.events.length = 0;
  persistence = await harness.payments.persistPaymentIntentForOrder({
    orderId: 42,
    shopId: 7,
    stripe_payment_intent_id: "pi_42",
    amount: 23,
    amount_cents: 2300,
    application_fee_amount: 115,
    currency: "eur",
    status: "requires_payment_method",
  });
  assert.strictEqual(persistence.attached, true);
  assert.deepStrictEqual(harness.events.slice(1, 3), ["lock-payment", "lock-order"]);
  assert.strictEqual(harness.getState().orders[0].payment_status, "requires_payment");
  assert.strictEqual(harness.getState().payments[0].status, "requires_payment_method");

  harness = makeStripeLifecycleHarness({
    paymentAttached: false,
    orderPaymentStatus: "paid",
  });
  persistence = await harness.payments.persistPaymentIntentForOrder({
    orderId: 42,
    shopId: 7,
    stripe_payment_intent_id: "pi_race",
    amount: 23,
    amount_cents: 2300,
    application_fee_amount: 115,
    currency: "eur",
    status: "requires_payment_method",
  });
  assert.deepStrictEqual(persistence, {
    attached: false,
    terminal: true,
    payment_status: "paid",
  });
  assert.strictEqual(harness.getState().orders[0].stripe_payment_intent_id, null);
  assert.strictEqual(harness.getState().payments.length, 0);

  harness = makeStripeLifecycleHarness({ paymentStatus: "succeeded" });
  harness.getState().orders[0].stripe_payment_intent_id = null;
  persistence = await harness.payments.persistPaymentIntentForOrder({
    orderId: 42,
    shopId: 7,
    stripe_payment_intent_id: "pi_42",
    amount: 23,
    amount_cents: 2300,
    application_fee_amount: 115,
    currency: "eur",
    status: "requires_payment_method",
  });
  assert.strictEqual(persistence.attached, false);
  assert.strictEqual(persistence.payment_status, "succeeded");
  assert.strictEqual(harness.getState().payments[0].status, "succeeded");
};

const runCashRegisterArchiveContract = async () => {
  let harness = makeStripeLifecycleHarness();
  const stripeCalls = [];
  let sync = buildPendingStripeArchiveSync({
    getStripe: () => ({
      paymentIntents: {
        retrieve: async () => ({ id: "pi_42", status: "requires_payment" }),
        cancel: async (id) => stripeCalls.push(["cancel", id]),
      },
      charges: { retrieve: async () => null },
    }),
    markPaymentSucceeded: harness.payments.markPaymentSucceeded,
    markStripeOrderPayAtCounter: harness.payments.markStripeOrderPayAtCounter,
    findOrderById: async () => [harness.getState().orders[0]],
  });
  const syncedOrder = await sync(harness.getState().orders[0]);
  assert.deepStrictEqual(stripeCalls, [["cancel", "pi_42"]]);
  assert.strictEqual(harness.getState().products.get(10), 8);
  assert.strictEqual(harness.getState().reservations[0].status, "committed");
  assert.strictEqual(harness.getState().movements.length, 1);
  assert.strictEqual(syncedOrder.payment_status, "unpaid");
  assert.deepStrictEqual(buildCashRegisterArchiveFields({
    order: syncedOrder,
    paymentMethod: "Carte",
  }), {
    payment: "Carte",
    payment_status: "paid",
    payment_provider: null,
    stripe_payment_intent_id: null,
    used_payment_method: "Carte",
  });
  const archivedOrders = [];
  const archiveModule = buildOrderArchiveModule({
    repository: {
      findOrderForArchive: async () => syncedOrder,
      insertArchive: async ({ archive }) => {
        archivedOrders.push({ id: 100, ...archive });
        return { insertId: 100 };
      },
      findOrderDetails: async () => [],
      findActiveSnapshots: async () => [],
      insertArchiveDetail: async () => ({ insertId: 200 }),
      insertArchiveSnapshot: async () => ({ insertId: 300 }),
      deleteActiveSnapshots: async () => ({ affectedRows: 0 }),
      deleteLegacyCustomizations: async () => ({ affectedRows: 0 }),
      deleteOrderDetails: async () => ({ affectedRows: 0 }),
      deleteOrder: async () => ({ affectedRows: 1 }),
    },
    withTransaction: async (work) => work({ transaction: true }),
    createToken: () => "paid-archive-token",
  });
  await archiveModule.mArchiveOrder(42, "Carte", 7);
  assert.strictEqual(archivedOrders[0].payment_status, "paid");
  assert.strictEqual(archivedOrders[0].payment, "Carte");
  assert.strictEqual(harness.getState().reservations[0].status, "committed");
  assert.strictEqual(harness.getState().products.get(10), 8);
  assert.strictEqual(harness.getState().movements.length, 1);

  harness = makeStripeLifecycleHarness();
  const succeededStripe = {
    paymentIntents: {
      retrieve: async () => ({
        id: "pi_42",
        status: "succeeded",
        latest_charge: "ch_42",
        payment_method_types: ["card"],
      }),
    },
    charges: { retrieve: async () => null },
  };
  sync = buildPendingStripeArchiveSync({
    getStripe: () => succeededStripe,
    markPaymentSucceeded: harness.payments.markPaymentSucceeded,
    markStripeOrderPayAtCounter: harness.payments.markStripeOrderPayAtCounter,
    findOrderById: async () => [harness.getState().orders[0]],
  });
  let succeededOrder = await sync(harness.getState().orders[0]);
  assert.strictEqual(succeededOrder.payment_status, "paid");
  assert.strictEqual(harness.getState().reservations[0].status, "committed");

  harness = makeStripeLifecycleHarness();
  sync = buildPendingStripeArchiveSync({
    getStripe: () => succeededStripe,
    markPaymentSucceeded: async (paymentIntent, charge) => {
      await harness.payments.markPaymentSucceeded(paymentIntent, charge);
      return harness.payments.markPaymentSucceeded(paymentIntent, charge);
    },
    markStripeOrderPayAtCounter: harness.payments.markStripeOrderPayAtCounter,
    findOrderById: async () => [harness.getState().orders[0]],
  });
  succeededOrder = await sync(harness.getState().orders[0]);
  assert.strictEqual(succeededOrder.payment_status, "paid");
  assert.strictEqual(harness.getState().movements.length, 1);

  harness = makeStripeLifecycleHarness();
  await harness.checkout.releaseExpiredReservations();
  let archiveCalls = 0;
  sync = buildPendingStripeArchiveSync({
    getStripe: () => ({
      paymentIntents: {
        retrieve: async () => ({
          id: "pi_42",
          status: "succeeded",
          latest_charge: "ch_42",
          payment_method_types: ["card"],
        }),
      },
      charges: { retrieve: async () => null },
    }),
    markPaymentSucceeded: harness.payments.markPaymentSucceeded,
    markStripeOrderPayAtCounter: harness.payments.markStripeOrderPayAtCounter,
    findOrderById: async () => [harness.getState().orders[0]],
  });
  const latePaymentArchiveController = buildArchiveOrderController({
    findOrderById: async () => [harness.getState().orders[0]],
    syncPendingStripeBeforeCashRegisterArchive: sync,
    archiveOrder: async () => {
      archiveCalls += 1;
      return { affectedRows: 1 };
    },
  });
  const latePaymentResponse = makeResponse();
  await latePaymentArchiveController({
    params: { id: 42 },
    body: { payment_method: "Carte" },
    shopid: 7,
  }, latePaymentResponse);
  assert.strictEqual(archiveCalls, 0);
  assert.strictEqual(latePaymentResponse.statusCode, 409);
  assert.strictEqual(
    latePaymentResponse.payload.message,
    "Le paiement Stripe ne peut pas etre confirme pour cette commande.",
  );
  assert.deepStrictEqual(latePaymentResponse.payload.data, {
    code: "STRIPE_PAYMENT_NOT_SETTLED",
  });
  assert.strictEqual(latePaymentResponse.payload.error, undefined);
  assert.strictEqual(harness.getState().orders[0].payment_status, "requires_payment");
  assert.strictEqual(harness.getState().reservations[0].status, "released");
  assert.strictEqual(harness.getState().products.get(10), 10);
  assert.strictEqual(harness.getState().movements.length, 0);

  harness = makeStripeLifecycleHarness();
  sync = buildPendingStripeArchiveSync({
    getStripe: () => ({
      paymentIntents: {
        retrieve: async () => ({ id: "pi_42", status: "requires_payment" }),
        cancel: async () => { throw new Error("Stripe cancel failed"); },
      },
      charges: { retrieve: async () => null },
    }),
    markPaymentSucceeded: harness.payments.markPaymentSucceeded,
    markStripeOrderPayAtCounter: harness.payments.markStripeOrderPayAtCounter,
    findOrderById: async () => [harness.getState().orders[0]],
  });
  await assert.rejects(() => sync(harness.getState().orders[0]), /Stripe cancel failed/);
  assert.strictEqual(harness.getState().reservations[0].status, "reserved");
  assert.strictEqual(harness.getState().movements.length, 0);
  assert.strictEqual(harness.getState().orders[0].payment_status, "requires_payment");

  harness = makeStripeLifecycleHarness();
  sync = buildPendingStripeArchiveSync({
    getStripe: () => ({
      paymentIntents: {
        retrieve: async () => ({ id: "pi_42", status: "requires_payment" }),
        cancel: async () => {},
      },
      charges: { retrieve: async () => null },
    }),
    markPaymentSucceeded: harness.payments.markPaymentSucceeded,
    markStripeOrderPayAtCounter: async () => {
      throw new Error("committed transition failed");
    },
    findOrderById: async () => [harness.getState().orders[0]],
  });
  await assert.rejects(
    () => sync(harness.getState().orders[0]),
    /committed transition failed/,
  );
  assert.strictEqual(harness.getState().reservations[0].status, "reserved");
  assert.strictEqual(harness.getState().movements.length, 0);
  assert.strictEqual(harness.getState().orders[0].payment_status, "requires_payment");

  harness = makeStripeLifecycleHarness();
  await harness.payments.markPaymentCanceled("pi_42");
  sync = buildPendingStripeArchiveSync({
    getStripe: () => ({ paymentIntents: {}, charges: {} }),
    markPaymentSucceeded: harness.payments.markPaymentSucceeded,
    markStripeOrderPayAtCounter: harness.payments.markStripeOrderPayAtCounter,
    findOrderById: async () => [harness.getState().orders[0]],
  });
  await assert.rejects(
    () => sync(harness.getState().orders[0]),
    /Stripe annulee ou echouee/,
  );
  assert.strictEqual(harness.getState().reservations[0].status, "released");
  assert.strictEqual(harness.getState().products.get(10), 10);
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
  const persisted = [];
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
    persistPaymentIntentForOrder: async (data) => {
      persisted.push(data);
      return { attached: true };
    },
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
  assert.strictEqual(persisted[0].orderId, 42);
  assert.strictEqual(persisted[0].shopId, 7);
  assert.strictEqual(persisted[0].stripe_payment_intent_id, "pi_42");
  assert.strictEqual(stripeCreateCalls[0][1].idempotencyKey, "qr-7-stripe-token-1");
  assert.strictEqual(persisted[0].amount, 23);
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
    persistPaymentIntentForOrder: async () => ({ attached: true }),
    cancelProvisionalStripeOrder: async (...args) => cleaned.push(args),
    logger: { error: (...args) => logs.push(args) },
  });
  response = makeResponse();
  await failingController(request, response);
  assert.strictEqual(response.statusCode, 500);
  assert.deepStrictEqual(cleaned, [[42, 7]]);
  assert.ok(!JSON.stringify(response.payload).includes("Stripe secret"));
  assert.strictEqual(logs.length, 1);

  for (const scenario of [{
    name: "attachment",
    options: { paymentAttached: false, failAttachment: true },
    cancelFails: false,
  }, {
    name: "payment record",
    options: { paymentAttached: false, failPaymentRecord: true },
    cancelFails: true,
  }]) {
    const lifecycle = makeStripeLifecycleHarness(scenario.options);
    const cancellationCalls = [];
    const scenarioLogs = [];
    const persistenceFailureController = buildQrTablePaymentIntentController({
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
          create: async () => ({
            id: "pi_42",
            client_secret: "secret_42",
            status: "requires_payment_method",
          }),
          cancel: async (id) => {
            cancellationCalls.push(id);
            if (scenario.cancelFails) throw new Error("Stripe cleanup cancel failed");
          },
        },
      }),
      persistPaymentIntentForOrder: lifecycle.payments.persistPaymentIntentForOrder,
      cancelProvisionalStripeOrder: lifecycle.payments.cancelProvisionalStripeOrder,
      logger: { error: (...args) => scenarioLogs.push(args) },
    });
    response = makeResponse();
    await persistenceFailureController(request, response);
    assert.strictEqual(response.statusCode, 500, scenario.name);
    assert.deepStrictEqual(cancellationCalls, ["pi_42"]);
    assert.strictEqual(lifecycle.getState().orders[0].stripe_payment_intent_id, null);
    assert.strictEqual(lifecycle.getState().orders[0].payment_status, "canceled");
    assert.strictEqual(lifecycle.getState().reservations[0].status, "released");
    assert.strictEqual(lifecycle.getState().products.get(10), 10);
    assert.strictEqual(lifecycle.getState().payments.length, 0);
    assert.ok(!JSON.stringify(response.payload).includes("SQL"));
    assert.ok(!JSON.stringify(response.payload).includes("Stripe cleanup"));
    assert.ok(scenarioLogs.length >= 1);
  }

  const terminalRace = makeStripeLifecycleHarness({
    paymentAttached: false,
    orderPaymentStatus: "paid",
  });
  const terminalCancellationCalls = [];
  const terminalLogs = [];
  const terminalRaceController = buildQrTablePaymentIntentController({
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
        create: async () => ({
          id: "pi_race",
          client_secret: "secret_race",
          status: "requires_payment_method",
        }),
        cancel: async (id) => {
          terminalCancellationCalls.push(id);
          throw new Error("terminal cleanup cancel failed");
        },
      },
    }),
    persistPaymentIntentForOrder: terminalRace.payments.persistPaymentIntentForOrder,
    cancelProvisionalStripeOrder: async () => {
      throw new Error("terminal order must not be cleaned as provisional");
    },
    logger: { error: (...args) => terminalLogs.push(args) },
  });
  response = makeResponse();
  await terminalRaceController(request, response);
  assert.strictEqual(response.statusCode, 409);
  assert.deepStrictEqual(terminalCancellationCalls, ["pi_race"]);
  assert.strictEqual(terminalRace.getState().orders[0].payment_status, "paid");
  assert.strictEqual(terminalRace.getState().orders[0].stripe_payment_intent_id, null);
  assert.strictEqual(terminalRace.getState().reservations[0].status, "reserved");
  assert.strictEqual(terminalRace.getState().products.get(10), 8);
  assert.ok(!JSON.stringify(response.payload).includes("terminal cleanup"));
  assert.strictEqual(terminalLogs.length, 1);
};

runStripeReservationContracts()
  .then(runCashRegisterArchiveContract)
  .then(runStripeCheckoutControllerContracts)
  .then(() => console.log("stripePayment tests passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
