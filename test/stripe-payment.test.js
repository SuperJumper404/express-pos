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
const { buildOrderEditingModule } = require("../src/modules/m_orderEditing");
const callbackDbPath = require.resolve("../src/config/db");
require.cache[callbackDbPath] = {
  exports: { query: () => { throw new Error("unexpected legacy DB query"); } },
};
const {
  buildCancelQrTablePaymentIntentController,
  buildQrTablePaymentIntentController,
  buildRegenerateOrderPaymentIntent,
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
      shop_id: 7,
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
    lockOrder: (input) => paymentRepository.findOrderById(input),
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

const runPaymentEditRaceContract = async () => {
  const makeDeferred = () => {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
  };
  const state = {
    order: {
      id: 42,
      shopid: 7,
      customerID: 12,
      operator: 9,
      status: ORDER_STATUSES.PENDING,
      payment_status: "requires_payment",
      payment_provider: "stripe",
    },
    payment: {
      order_id: 42,
      shop_id: 7,
      stripe_payment_intent_id: "pi_42",
      status: "requires_payment",
    },
  };
  let lockTail = Promise.resolve();
  const editLockAttempted = makeDeferred();
  let editPassedEligibility = false;
  const runInTransaction = async (work) => {
    const connection = {};
    try {
      return await work(connection);
    } finally {
      if (connection.releaseOrder) connection.releaseOrder();
    }
  };
  const acquireOrderLock = async (connection, owner) => {
    const previous = lockTail;
    let release;
    lockTail = new Promise((done) => { release = done; });
    if (owner === "edit") editLockAttempted.resolve();
    await previous;
    connection.releaseOrder = release;
    return state.order;
  };
  const paymentSettlementEntered = makeDeferred();
  const finishPaymentSettlement = makeDeferred();
  const payments = buildPaymentModule({
    withTransaction: runInTransaction,
    repository: {
      findPaymentByIntent: async () => state.payment,
      findOrderById: async () => state.order,
      lockOrder: async ({ connection }) => acquireOrderLock(connection, "payment"),
      updatePaymentSucceeded: async () => {
        state.payment.status = "succeeded";
        return { affectedRows: 1 };
      },
      updateOrderSucceeded: async () => {
        state.order.payment_status = "paid";
        return { affectedRows: 1 };
      },
    },
    finalizeReservations: async () => {
      paymentSettlementEntered.resolve();
      await finishPaymentSettlement.promise;
      return { changed: 1 };
    },
    now: () => new Date("2026-07-24T12:00:00.000Z"),
  });
  const editing = buildOrderEditingModule({
    withTransaction: runInTransaction,
    repository: {
      lockOrder: ({ connection }) => acquireOrderLock(connection, "edit"),
      lockDetails: async () => {
        editPassedEligibility = true;
        throw new Error("edit crossed eligibility while payment was settling");
      },
    },
  });

  const payment = payments.markPaymentSucceeded(succeededIntent);
  await paymentSettlementEntered.promise;
  const amendment = editing.amendOrder({
    orderId: 42,
    shopId: 7,
    operatorId: 9,
    contentRevision: "stale-revision",
    expectedTotal: 0,
    items: [],
  }).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await editLockAttempted.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(
    editPassedEligibility,
    false,
    "an edit waits on the order row while payment reservations are finalized",
  );

  finishPaymentSettlement.resolve();
  await payment;
  const amendmentOutcome = await amendment;
  assert.strictEqual(
    amendmentOutcome.error && amendmentOutcome.error.code,
    "ORDER_NOT_EDITABLE",
    "the edit re-checks eligibility after the payment commits",
  );
  assert.strictEqual(state.order.payment_status, "paid");
};

const runSucceededPaymentShopScopeContract = async () => {
  const connection = { transaction: true };
  const received = {};
  const events = [];
  const payments = buildPaymentModule({
    withTransaction: async (work) => work(connection),
    repository: {
      findPaymentByIntent: async ({ connection: suppliedConnection }) => {
        events.push(suppliedConnection ? "lock-payment" : "read-payment");
        return {
          order_id: 42,
          shop_id: 7,
          stripe_payment_intent_id: "pi_42",
          status: "requires_payment",
        };
      },
      lockOrder: async (input) => {
        events.push("lock-order");
        received.lockOrder = input;
        return {
          id: 42,
          shopid: 7,
          customerID: 12,
          operator: 9,
          status: ORDER_STATUSES.PENDING,
          payment_status: "requires_payment",
          payment_provider: "stripe",
        };
      },
      updatePaymentSucceeded: async () => ({ affectedRows: 1 }),
      updateOrderSucceeded: async (input) => {
        received.updateOrderSucceeded = input;
        return { affectedRows: 1 };
      },
    },
    finalizeReservations: async () => ({ changed: 1 }),
    now: () => new Date("2026-07-24T12:00:00.000Z"),
  });

  await payments.markPaymentSucceeded(succeededIntent);

  assert.deepStrictEqual(events.slice(0, 3), [
    "read-payment",
    "lock-order",
    "lock-payment",
  ]);
  assert.deepStrictEqual(received.lockOrder, {
    orderId: 42,
    shopId: 7,
    connection,
  });
  assert.deepStrictEqual(received.updateOrderSucceeded, {
    orderId: 42,
    shopId: 7,
    paymentMethod: "Carte",
    timestamp: "2026-07-24 12:00:00",
    connection,
  });
};

const runTerminalPaymentShopScopeContract = async () => {
  const connection = { transaction: true };
  const received = {};
  const events = [];
  const payments = buildPaymentModule({
    withTransaction: async (work) => work(connection),
    repository: {
      findPaymentByIntent: async ({ connection: suppliedConnection }) => {
        events.push(suppliedConnection ? "lock-payment" : "read-payment");
        return {
          order_id: 42,
          shop_id: 7,
          stripe_payment_intent_id: "pi_42",
          status: "requires_payment",
        };
      },
      lockOrder: async (input) => {
        events.push("lock-order");
        received.lockOrder = input;
        return {
          id: 42,
          shopid: 7,
          customerID: 12,
          operator: 9,
          status: ORDER_STATUSES.PENDING,
          payment_status: "requires_payment",
          payment_provider: "stripe",
        };
      },
      updatePaymentTerminal: async () => ({ affectedRows: 1 }),
      updateOrderTerminal: async (input) => {
        received.updateOrderTerminal = input;
        return { affectedRows: 1 };
      },
    },
    finalizeReservations: async () => ({ changed: 1 }),
    now: () => new Date("2026-07-24T12:00:00.000Z"),
  });

  await payments.markPaymentFailed("pi_42");

  assert.deepStrictEqual(events.slice(0, 3), [
    "read-payment",
    "lock-order",
    "lock-payment",
  ]);
  assert.deepStrictEqual(received.lockOrder, {
    orderId: 42,
    shopId: 7,
    connection,
  });
  assert.deepStrictEqual(received.updateOrderTerminal, {
    orderId: 42,
    shopId: 7,
    status: "failed",
    connection,
  });
};

const runCanceledPaymentUsesSuppliedOrderLockContract = async () => {
  const connection = { transaction: true };
  const lockedOrder = {
    id: 42,
    shopid: 7,
    customerID: 12,
    operator: 9,
    status: ORDER_STATUSES.PENDING,
    payment_status: "requires_payment",
    payment_provider: "stripe",
  };
  let startedTransactions = 0;
  let redundantOrderLocks = 0;
  const nestedConnection = { transaction: "nested" };
  const received = {};
  const payments = buildPaymentModule({
    withTransaction: async (work) => {
      startedTransactions += 1;
      return work(nestedConnection);
    },
    repository: {
      findPaymentByIntent: async () => ({
        order_id: 42,
        shop_id: 7,
        stripe_payment_intent_id: "pi_42",
        status: "requires_payment",
      }),
      lockOrder: async () => {
        redundantOrderLocks += 1;
        return lockedOrder;
      },
      updatePaymentTerminal: async () => ({ affectedRows: 1 }),
      updateOrderTerminal: async (input) => {
        received.updateOrderTerminal = input;
        return { affectedRows: 1 };
      },
    },
    finalizeReservations: async () => ({ changed: 1 }),
  });

  await payments.markPaymentCanceled("pi_42", { connection, order: lockedOrder });

  assert.strictEqual(startedTransactions, 0);
  assert.strictEqual(redundantOrderLocks, 0);
  assert.deepStrictEqual(received.updateOrderTerminal, {
    orderId: 42,
    shopId: 7,
    status: "canceled",
    connection,
  });
};

const runRefundLockOrderContract = async () => {
  const events = [];
  const payments = buildPaymentModule({
    withTransaction: async (work) => work({ transaction: true }),
    repository: {
      lockOrder: async () => {
        events.push("lock-order");
        return { id: 42, shopid: 7, payment_status: "paid" };
      },
      updatePaymentRefunded: async () => {
        events.push("update-payment");
        return { affectedRows: 1 };
      },
      updateOrderRefunded: async () => {
        events.push("update-order");
        return { affectedRows: 1 };
      },
    },
  });

  await payments.markPaymentRefunded(42, "re_42");

  assert.deepStrictEqual(events, ["lock-order", "update-payment", "update-order"]);
};

const runStripeReservationContracts = async () => {
  let harness = makeStripeLifecycleHarness();
  assert.strictEqual(
    (await harness.payments.getStripeOrderForCancellation(42, 7)).id,
    42,
  );
  assert.strictEqual(
    await harness.payments.getStripeOrderForCancellation(42, 8),
    null,
    "the cancellation read is scoped to the authenticated shop",
  );
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
  assert.deepStrictEqual(harness.events.slice(1, 3), ["lock-order", "lock-payment"]);
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
      items: [{
        product_id: 10,
        quantity: 2,
        selected_product_step_choice_ids: [101],
      }],
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
    isTakeaway: false,
    clientOrderToken: "stripe-token-1",
    paymentMode: "stripe",
  }]);
  assert.strictEqual(persisted[0].orderId, 42);
  assert.strictEqual(persisted[0].shopId, 7);
  assert.strictEqual(persisted[0].stripe_payment_intent_id, "pi_42");
  assert.strictEqual(stripeCreateCalls[0][1].idempotencyKey, "qr-7-stripe-token-1");
  assert.strictEqual(persisted[0].amount, 23);
  assert.deepStrictEqual(cleaned, []);

  response = makeResponse();
  await controller({
    shopid: 7,
    id: 9,
    body: {
      customer: "Grace",
      customerID: 13,
      phone: "0304",
      remark: "Table 8",
      payment: "cash",
      items: [{ product_id: 10, quantity: 1, selected_choice_ids: [101] }],
      expected_total: "11.50",
      client_order_token: "stripe-token-legacy",
    },
  }, response);
  assert.strictEqual(response.statusCode, 200);
  assert.deepStrictEqual(checkoutCalls[1], {
    shopId: 7,
    actorId: 9,
    customer: { id: 13, name: "Grace", phone: "0304", remark: "Table 8" },
    items: [{ productId: 10, quantity: 1, selectedChoiceIds: [101] }],
    expectedTotal: "11.50",
    isTakeaway: false,
    clientOrderToken: "stripe-token-legacy",
    paymentMode: "stripe",
  });

  response = makeResponse();
  await controller({
    shopid: 7,
    id: 9,
    body: {
      customer: { id: 12, name: "Ada" },
      items: [{
        product_id: 10,
        quantity: 1,
        selected_product_step_choice_ids: [101],
        selected_choice_ids: [102],
      }],
      expected_total: "10.50",
      client_order_token: "stripe-token-conflict",
    },
  }, response);
  assert.strictEqual(response.statusCode, 400);
  assert.strictEqual(response.payload.data.code, "CHECKOUT_REQUEST_INVALID");
  assert.strictEqual(
    response.payload.data.field,
    "items.0.selected_product_step_choice_ids",
  );
  assert.strictEqual(checkoutCalls.length, 2);

  const availableShop = {
    id: 7,
    qr_payment_mode: "stripe_before_order",
    stripe_account_id: "acct_7",
    stripe_charges_enabled: 1,
    stripe_commission_percent: 5,
    kitchen_closed: 0,
  };
  for (const scenario of [{
    name: "missing shop",
    rows: [],
    status: 404,
    code: "SHOP_NOT_FOUND",
    message: "Restaurant introuvable.",
  }, {
    name: "closed kitchen",
    rows: [{ ...availableShop, kitchen_closed: 1 }],
    status: 422,
    code: "KITCHEN_CLOSED",
    message: "La cuisine est fermee.",
  }, {
    name: "Stripe mode disabled",
    rows: [availableShop],
    stripePaymentAllowed: false,
    status: 422,
    code: "STRIPE_PAYMENT_DISABLED",
    message: "Le paiement Stripe n'est pas actif pour ce restaurant.",
  }, {
    name: "missing Connect account",
    rows: [{ ...availableShop, stripe_account_id: null }],
    status: 422,
    code: "STRIPE_CONNECT_INCOMPLETE",
    message: "Le restaurant doit connecter Stripe avant d'accepter les paiements.",
  }, {
    name: "Connect charges disabled",
    rows: [{ ...availableShop, stripe_charges_enabled: 0 }],
    status: 422,
    code: "STRIPE_CONNECT_INCOMPLETE",
    message: "Le restaurant doit connecter Stripe avant d'accepter les paiements.",
  }]) {
    let preconditionCheckoutCalls = 0;
    let preconditionStripeCalls = 0;
    let preconditionCleanupCalls = 0;
    const preconditionController = buildQrTablePaymentIntentController({
      getShopInfo: async () => scenario.rows,
      createCheckout: async () => {
        preconditionCheckoutCalls += 1;
        throw new Error("checkout must not start");
      },
      getStripe: () => {
        preconditionStripeCalls += 1;
        throw new Error("Stripe must not start");
      },
      isStripePaymentAllowed: () => scenario.stripePaymentAllowed !== false,
      cancelProvisionalStripeOrder: async () => {
        preconditionCleanupCalls += 1;
      },
      logger: { error: () => {} },
    });
    response = makeResponse();
    await preconditionController({ shopid: 7, id: 9, body: {} }, response);
    assert.strictEqual(response.statusCode, scenario.status, scenario.name);
    assert.strictEqual(response.payload.message, scenario.message, scenario.name);
    assert.deepStrictEqual(response.payload.data, { code: scenario.code }, scenario.name);
    assert.strictEqual(preconditionCheckoutCalls, 0, scenario.name);
    assert.strictEqual(preconditionStripeCalls, 0, scenario.name);
    assert.strictEqual(preconditionCleanupCalls, 0, scenario.name);
  }

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
    releasesReservation: true,
  }, {
    name: "payment record",
    options: { paymentAttached: false, failPaymentRecord: true },
    cancelFails: true,
    releasesReservation: false,
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
            return { id, status: "canceled" };
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
    assert.strictEqual(
      lifecycle.getState().orders[0].payment_status,
      scenario.releasesReservation ? "canceled" : "requires_payment",
    );
    assert.strictEqual(
      lifecycle.getState().reservations[0].status,
      scenario.releasesReservation ? "released" : "reserved",
      "a failed external cancellation must keep the reservation",
    );
    assert.strictEqual(lifecycle.getState().products.get(10), scenario.releasesReservation ? 10 : 8);
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

const runStripeCancellationControllerContracts = async () => {
  const routerSource = require("fs").readFileSync(
    require.resolve("../src/routers/r_stripe"),
    "utf8",
  );
  assert.match(
    routerSource,
    /\.post\([\s\S]*"\/stripe\/payment-intents\/qr-table\/:orderId\/cancel",[\s\S]*authentication,[\s\S]*stripe\.cancelQrTablePaymentIntent/,
  );

  let order = {
    id: 42,
    shopid: 7,
    payment_status: "requires_payment",
    payment_provider: "stripe",
    stripe_payment_intent_id: "pi_42",
  };
  const events = [];
  let releaseCount = 0;
  const controller = buildCancelQrTablePaymentIntentController({
    getStripeOrderForCancellation: async (orderId, shopId) => {
      events.push(["read", Number(orderId), Number(shopId)]);
      return order && order.id === Number(orderId) && order.shopid === Number(shopId)
        ? order
        : null;
    },
    getStripe: () => ({
      paymentIntents: {
        retrieve: async (id) => {
          events.push(["retrieve", id]);
          return { id, status: "requires_payment_method" };
        },
        cancel: async (id) => {
          events.push(["cancel", id]);
          return { id, status: "canceled" };
        },
      },
    }),
    cancelProvisionalStripeOrder: async (orderId, shopId) => {
      events.push(["release", Number(orderId), Number(shopId)]);
      releaseCount += 1;
      order = { ...order, payment_status: "canceled" };
      return { canceled: true };
    },
    logger: { error: () => {} },
  });

  let response = makeResponse();
  await controller({ params: { orderId: "42" }, shopid: 7 }, response);
  assert.strictEqual(response.statusCode, 200);
  assert.deepStrictEqual(response.payload.data, {
    orderId: 42,
    canceled: true,
    idempotent_replay: false,
  });
  assert.deepStrictEqual(events.slice(0, 4), [
    ["read", 42, 7],
    ["retrieve", "pi_42"],
    ["cancel", "pi_42"],
    ["release", 42, 7],
  ], "Stripe must be canceled before reservations are released");
  assert.strictEqual(releaseCount, 1);

  response = makeResponse();
  await controller({ params: { orderId: "42" }, shopid: 7 }, response);
  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(response.payload.data.idempotent_replay, true);
  assert.strictEqual(releaseCount, 1, "repeat cancellation releases at most once");
  assert.strictEqual(events.filter(([name]) => name === "cancel").length, 1);

  response = makeResponse();
  await controller({ params: { orderId: "42" }, shopid: 8 }, response);
  assert.strictEqual(response.statusCode, 404, "foreign orders are hidden");
  assert.deepStrictEqual(response.payload.data, { code: "STRIPE_ORDER_NOT_FOUND" });

  order = null;
  response = makeResponse();
  await controller({ params: { orderId: "404" }, shopid: 7 }, response);
  assert.strictEqual(response.statusCode, 404);
  assert.deepStrictEqual(response.payload.data, { code: "STRIPE_ORDER_NOT_FOUND" });

  response = makeResponse();
  await controller({ params: { orderId: "0" }, shopid: 7 }, response);
  assert.strictEqual(response.statusCode, 400);
  assert.deepStrictEqual(response.payload.data, {
    code: "STRIPE_ORDER_CANCEL_INVALID",
    field: "order_id",
  });

  let stripeCalls = 0;
  let internalCalls = 0;
  const buildScenario = ({
    orderStatus = "requires_payment",
    paymentIntentStatus = "requires_payment_method",
    cancelResultStatus = "canceled",
    cancelError = null,
  } = {}) => buildCancelQrTablePaymentIntentController({
    getStripeOrderForCancellation: async () => ({
      id: 42,
      shopid: 7,
      payment_status: orderStatus,
      payment_provider: "stripe",
      stripe_payment_intent_id: "pi_42",
    }),
    getStripe: () => ({
      paymentIntents: {
        retrieve: async () => {
          stripeCalls += 1;
          return { id: "pi_42", status: paymentIntentStatus };
        },
        cancel: async () => {
          stripeCalls += 1;
          if (cancelError) throw cancelError;
          return { id: "pi_42", status: cancelResultStatus };
        },
      },
    }),
    cancelProvisionalStripeOrder: async () => {
      internalCalls += 1;
      return { canceled: true };
    },
    logger: { error: () => {} },
  });

  stripeCalls = 0;
  internalCalls = 0;
  response = makeResponse();
  await buildScenario({ orderStatus: "paid" })(
    { params: { orderId: "42" }, shopid: 7 },
    response,
  );
  assert.strictEqual(response.statusCode, 409);
  assert.strictEqual(response.payload.data.code, "STRIPE_ORDER_NOT_CANCELABLE");
  assert.strictEqual(stripeCalls, 0);
  assert.strictEqual(internalCalls, 0);

  stripeCalls = 0;
  internalCalls = 0;
  response = makeResponse();
  await buildScenario({ paymentIntentStatus: "succeeded" })(
    { params: { orderId: "42" }, shopid: 7 },
    response,
  );
  assert.strictEqual(response.statusCode, 409);
  assert.strictEqual(response.payload.data.code, "STRIPE_PAYMENT_ALREADY_SUCCEEDED");
  assert.strictEqual(stripeCalls, 1);
  assert.strictEqual(internalCalls, 0);

  stripeCalls = 0;
  internalCalls = 0;
  response = makeResponse();
  await buildScenario({ cancelError: new Error("Stripe API secret failure") })(
    { params: { orderId: "42" }, shopid: 7 },
    response,
  );
  assert.strictEqual(response.statusCode, 409);
  assert.deepStrictEqual(response.payload.data, { code: "STRIPE_PAYMENT_CANCEL_FAILED" });
  assert.strictEqual(internalCalls, 0);
  assert.ok(!JSON.stringify(response.payload).includes("secret"));

  let refreshedStatus = "canceled";
  let refreshCount = 0;
  let fallbackReleaseCount = 0;
  const fallbackLogs = [];
  const buildCancelThrowController = () => buildCancelQrTablePaymentIntentController({
    getStripeOrderForCancellation: async () => ({
      id: 42,
      shopid: 7,
      payment_status: "requires_payment",
      payment_provider: "stripe",
      stripe_payment_intent_id: "pi_42",
    }),
    getStripe: () => ({
      paymentIntents: {
        retrieve: async () => {
          refreshCount += 1;
          if (refreshedStatus === "retrieve_failed" && refreshCount > 1) {
            throw new Error("Stripe refresh secret failure");
          }
          return {
            id: "pi_42",
            status: refreshCount === 1 ? "requires_payment_method" : refreshedStatus,
          };
        },
        cancel: async () => {
          throw new Error("Stripe concurrent cancel secret failure");
        },
      },
    }),
    cancelProvisionalStripeOrder: async () => {
      fallbackReleaseCount += 1;
      return { canceled: true };
    },
    logger: { error: (...args) => fallbackLogs.push(args) },
  });

  response = makeResponse();
  await buildCancelThrowController()(
    { params: { orderId: "42" }, shopid: 7 },
    response,
  );
  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(response.payload.data.idempotent_replay, true);
  assert.strictEqual(refreshCount, 2);
  assert.strictEqual(fallbackReleaseCount, 1, "the local reservation is released once");
  assert.ok(!JSON.stringify(response.payload).includes("secret"));

  for (const [status, expectedCode] of [
    ["succeeded", "STRIPE_PAYMENT_ALREADY_SUCCEEDED"],
    ["processing", "STRIPE_PAYMENT_CANCEL_FAILED"],
    ["retrieve_failed", "STRIPE_PAYMENT_CANCEL_FAILED"],
  ]) {
    refreshedStatus = status;
    refreshCount = 0;
    fallbackReleaseCount = 0;
    response = makeResponse();
    await buildCancelThrowController()(
      { params: { orderId: "42" }, shopid: 7 },
      response,
    );
    assert.strictEqual(response.statusCode, 409, status);
    assert.strictEqual(response.payload.data.code, expectedCode, status);
    assert.strictEqual(fallbackReleaseCount, 0, `${status} must not release locally`);
    assert.ok(!JSON.stringify(response.payload).includes("secret"), status);
  }

  stripeCalls = 0;
  internalCalls = 0;
  response = makeResponse();
  await buildScenario({ cancelResultStatus: "processing" })(
    { params: { orderId: "42" }, shopid: 7 },
    response,
  );
  assert.strictEqual(response.statusCode, 409);
  assert.strictEqual(response.payload.data.code, "STRIPE_PAYMENT_CANCEL_FAILED");
  assert.strictEqual(internalCalls, 0);

  let raceReadCount = 0;
  response = makeResponse();
  await buildCancelQrTablePaymentIntentController({
    getStripeOrderForCancellation: async () => {
      raceReadCount += 1;
      return {
        id: 42,
        shopid: 7,
        payment_status: raceReadCount === 1 ? "requires_payment" : "canceled",
        payment_provider: "stripe",
        stripe_payment_intent_id: "pi_42",
      };
    },
    getStripe: () => ({
      paymentIntents: {
        retrieve: async () => ({ id: "pi_42", status: "canceled" }),
      },
    }),
    cancelProvisionalStripeOrder: async () => ({ ignored: true }),
    logger: { error: () => {} },
  })({ params: { orderId: "42" }, shopid: 7 }, response);
  assert.strictEqual(response.statusCode, 200, "a concurrent cancellation is idempotent");
  assert.strictEqual(response.payload.data.idempotent_replay, true);
  assert.strictEqual(raceReadCount, 2);
};

const runReplacementPaymentContracts = async () => {
  const migrationPath = require("path").join(
    __dirname,
    "../db/migrations/20260725090000_order_edit_replacement_attempt.sql",
  );
  assert.strictEqual(require("fs").existsSync(migrationPath), true);
  const migration = require("fs").readFileSync(migrationPath, "utf8");
  assert.match(migration, /ADD COLUMN `stripe_replacement_attempt_token` varchar\(64\) DEFAULT NULL/);
  assert.match(migration, /DROP COLUMN `stripe_replacement_attempt_token`/);

  const events = [];
  const persisted = [];
  let attachedIntentId = null;
  const stripeClient = {
    paymentIntents: {
      create: async (params, options) => {
        events.push(["create", params, options]);
        return {
          id: "pi_replacement",
          client_secret: "secret_replacement",
          status: "requires_payment_method",
        };
      },
      retrieve: async (id) => {
        events.push(["retrieve", id]);
        return {
          id,
          client_secret: "secret_replacement",
          status: "requires_payment_method",
        };
      },
      cancel: async (id) => {
        events.push(["cancel", id]);
        return { id, status: "canceled" };
      },
    },
  };
  const regenerate = buildRegenerateOrderPaymentIntent({
    getShopInfo: async () => [{
      id: 7,
      stripe_account_id: "acct_7",
      stripe_charges_enabled: 1,
      stripe_commission_percent: 5,
    }],
    getStripe: () => stripeClient,
    persistReplacementPaymentIntent: async (data) => {
      persisted.push(data);
      attachedIntentId = data.stripe_payment_intent_id;
      return { attached: true };
    },
    publishableKey: "pk_test",
  });
  const order = {
    id: 42,
    shopid: 7,
    status: 1,
    subtotal: 31,
    payment_provider: "stripe",
    payment_status: "unpaid",
    stripe_payment_intent_id: null,
    stripe_replacement_attempt_token: "attempt-current",
  };
  const result = await regenerate({ order, contentRevision: "revision-new" });
  assert.deepStrictEqual(result, {
    orderId: 42,
    paymentIntentId: "pi_replacement",
    clientSecret: "secret_replacement",
    publishableKey: "pk_test",
  });
  assert.strictEqual(events[0][1].amount, 3100, "the replacement uses the edited total");
  assert.strictEqual(
    events[0][2].idempotencyKey,
    "order-edit:7:42:revision-new",
  );
  assert.strictEqual(persisted[0].replacement_attempt_token, "attempt-current");

  events.length = 0;
  await regenerate({
    order: { ...order, payment_status: "requires_payment", stripe_payment_intent_id: attachedIntentId },
    contentRevision: "revision-new",
  });
  assert.deepStrictEqual(events, [["retrieve", "pi_replacement"]],
    "an attached replacement is returned without creating another intent");

  let persistenceAttempt = 0;
  const retryKeys = [];
  const retry = buildRegenerateOrderPaymentIntent({
    getShopInfo: async () => [{
      id: 7,
      stripe_account_id: "acct_7",
      stripe_charges_enabled: 1,
      stripe_commission_percent: 5,
    }],
    getStripe: () => ({ paymentIntents: {
      create: async (_params, options) => {
        retryKeys.push(options.idempotencyKey);
        return {
          id: "pi_same",
          client_secret: "secret_same",
          status: "requires_payment_method",
        };
      },
    } }),
    persistReplacementPaymentIntent: async () => {
      persistenceAttempt += 1;
      if (persistenceAttempt === 1) throw new Error("database unavailable after Stripe create");
      return { attached: true };
    },
  });
  await assert.rejects(
    () => retry({ order, contentRevision: "revision-new" }),
    /database unavailable/,
  );
  const recovered = await retry({ order, contentRevision: "revision-new" });
  assert.strictEqual(recovered.paymentIntentId, "pi_same");
  assert.deepStrictEqual(retryKeys, [
    "order-edit:7:42:revision-new",
    "order-edit:7:42:revision-new",
  ], "retrying after an attachment failure reuses the Stripe idempotency key");

  const paymentState = {
    order: {
      ...order,
      stripe_replacement_attempt_token: "attempt-current",
    },
    payments: [],
  };
  const payments = buildPaymentModule({
    withTransaction: async (work) => work({ transaction: true }),
    repository: {
      lockOrder: async () => paymentState.order,
      findPaymentByIntent: async ({ paymentIntentId }) => paymentState.payments.find(
        (payment) => payment.stripe_payment_intent_id === paymentIntentId,
      ) || null,
      stagePaymentCanceled: async ({ orderId, paymentIntentId }) => {
        const payment = paymentState.payments.find((row) => (
          Number(row.order_id) === Number(orderId)
          && row.stripe_payment_intent_id === paymentIntentId
          && row.status !== "succeeded"
        ));
        if (!payment) return { affectedRows: 0 };
        payment.status = "canceled";
        return { affectedRows: 1 };
      },
      stageOrderPaymentReplacement: async ({
        paymentIntentId, replacementAttemptToken,
      }) => {
        if (paymentState.order.payment_status !== "requires_payment"
          || paymentState.order.stripe_payment_intent_id !== paymentIntentId) {
          return { affectedRows: 0 };
        }
        paymentState.order.payment_status = "unpaid";
        paymentState.order.stripe_payment_intent_id = null;
        paymentState.order.stripe_replacement_attempt_token = replacementAttemptToken;
        return { affectedRows: 1 };
      },
      attachReplacementPaymentIntent: async ({ paymentIntentId, replacementAttemptToken }) => {
        if (paymentState.order.stripe_replacement_attempt_token !== replacementAttemptToken) {
          return { affectedRows: 0 };
        }
        paymentState.order.stripe_payment_intent_id = paymentIntentId;
        paymentState.order.payment_status = "requires_payment";
        return { affectedRows: 1 };
      },
      upsertPaymentRecord: async ({ data }) => {
        paymentState.payments.push({ ...data });
        return { affectedRows: 1 };
      },
    },
  });
  paymentState.order.payment_status = "requires_payment";
  paymentState.order.stripe_payment_intent_id = "pi_old";
  paymentState.order.stripe_replacement_attempt_token = null;
  paymentState.payments.push({
    order_id: 42,
    stripe_payment_intent_id: "pi_old",
    status: "requires_payment_method",
  });
  const staged = await payments.stagePaymentReplacement({
    orderId: 42,
    shopId: 7,
    paymentIntentId: "pi_old",
    connection: { transaction: true },
  });
  assert.strictEqual(staged.ready, true);
  assert.match(staged.replacement_attempt_token, /^[a-f0-9]{64}$/);
  assert.strictEqual(paymentState.order.payment_status, "unpaid");
  assert.strictEqual(paymentState.order.stripe_payment_intent_id, null);
  assert.strictEqual(paymentState.payments[0].status, "canceled");

  paymentState.order.stripe_replacement_attempt_token = "attempt-current";
  const stale = await payments.persistReplacementPaymentIntent({
    orderId: 42,
    shopId: 7,
    stripe_payment_intent_id: "pi_stale",
    replacement_attempt_token: "attempt-stale",
    amount: 31,
    amount_cents: 3100,
    application_fee_amount: 155,
    currency: "eur",
    status: "requires_payment_method",
  });
  assert.deepStrictEqual(stale, { attached: false, stale_attempt: true });
  assert.strictEqual(paymentState.order.stripe_payment_intent_id, null);
  assert.strictEqual(
    paymentState.payments.some((payment) => payment.stripe_payment_intent_id === "pi_stale"),
    false,
  );

  const routerSource = require("fs").readFileSync(
    require.resolve("../src/routers/r_stripe"),
    "utf8",
  );
  assert.match(
    routerSource,
    /\.post\([\s\S]*"\/stripe\/orders\/:id\/replacement-payment",[\s\S]*authentication,[\s\S]*orderEditing\.replacementPayment/,
  );
};

runSucceededPaymentShopScopeContract()
  .then(runTerminalPaymentShopScopeContract)
  .then(runCanceledPaymentUsesSuppliedOrderLockContract)
  .then(runRefundLockOrderContract)
  .then(runPaymentEditRaceContract)
  .then(runStripeReservationContracts)
  .then(runCashRegisterArchiveContract)
  .then(runStripeCheckoutControllerContracts)
  .then(runStripeCancellationControllerContracts)
  .then(runReplacementPaymentContracts)
  .then(() => console.log("stripePayment tests passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
