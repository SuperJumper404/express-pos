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
  buildStripeWebhookEventHandler,
  buildCancelQrTablePaymentIntentController,
  buildQrTablePaymentIntentController,
  buildMarkQrTablePaymentAtCounter,
  buildRefundPaidOrderController,
  buildRegenerateOrderPaymentIntent,
} = require("../src/controllers/c_stripe");
const {
  buildArchiveOrderController,
  buildPendingStripeArchiveSync,
} = require("../src/controllers/c_orders");
const { buildOrderArchiveModule } = require("../src/modules/m_orders");
const {
  buildNonOverlappingRunner,
  buildStripePaymentMaintenance,
} = require("../src/services/stripePaymentMaintenance");

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
    lockOrderReservations: async ({ orderId }) => state.reservations.filter(
      (row) => row.order_id === Number(orderId),
    ),
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
    updatePaymentPending: async ({ paymentIntentId, status }) => {
      const payment = state.payments.find(
        (row) => row.stripe_payment_intent_id === paymentIntentId,
      );
      if (payment && !["succeeded", "canceled", "refunded"].includes(payment.status)) {
        payment.status = status;
      }
      return { affectedRows: payment ? 1 : 0 };
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
    updatePaymentAtCounter: async ({ orderId, paymentIntentId }) => {
      const payment = state.payments.find(
        (row) => row.order_id === Number(orderId)
          && row.stripe_payment_intent_id === paymentIntentId,
      );
      if (payment) payment.status = "canceled";
      return { affectedRows: payment ? 1 : 0 };
    },
    updateOrderAtCounter: async ({ orderId, shopId, paymentIntentId }) => {
      const order = state.orders.find(
        (row) => row.id === Number(orderId) && row.shopid === Number(shopId),
      );
      if (!order
        || order.payment_status !== "requires_payment"
        || order.stripe_payment_intent_id !== paymentIntentId) {
        return { affectedRows: 0 };
      }
      Object.assign(order, {
        payment_status: "unpaid",
        payment: "Paiement au comptoir",
        payment_provider: null,
        stripe_payment_intent_id: null,
      });
      return { affectedRows: 1 };
    },
    cancelPaymentsForOrder: async ({ orderId, paymentIntentId }) => {
      const payment = state.payments.find(
        (row) => row.order_id === Number(orderId)
          && (row.stripe_payment_intent_id || null) === paymentIntentId,
      );
      if (payment) payment.status = "canceled";
      return { affectedRows: payment ? 1 : 0 };
    },
    cancelProvisionalOrder: async ({ orderId, shopId, paymentIntentId }) => {
      const order = state.orders.find(
        (row) => row.id === Number(orderId) && row.shopid === Number(shopId),
      );
      if (!order
        || order.payment_status !== "requires_payment"
        || (order.stripe_payment_intent_id || null) !== paymentIntentId) {
        return { affectedRows: 0 };
      }
      order.payment_status = "canceled";
      order.status = ORDER_STATUSES.CANCELED;
      return { affectedRows: 1 };
    },
    cancelOrphanedProvisionalOrder: async ({ orderId, shopId }) => {
      const order = state.orders.find(
        (row) => row.id === Number(orderId) && row.shopid === Number(shopId),
      );
      if (!order
        || Number(order.status) !== ORDER_STATUSES.PENDING
        || order.payment_status !== "requires_payment"
        || order.payment_provider !== "stripe"
        || order.stripe_payment_intent_id != null) {
        return { affectedRows: 0 };
      }
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
      stripe_payment_intent_id: "pi_42",
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
          stripe_payment_intent_id: "pi_42",
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
    paymentIntentId: "pi_42",
    paymentMethod: "Carte",
    timestamp: "2026-07-24 12:00:00",
    connection,
  });
};

const runPendingPaymentShopScopeContract = async () => {
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
      updatePaymentPending: async (input) => {
        received.updatePaymentPending = input;
        return { affectedRows: 1 };
      },
    },
    finalizeReservations: async () => ({ changed: 1 }),
    now: () => new Date("2026-07-24T12:00:00.000Z"),
  });

  await payments.markPaymentAttemptFailed({
    id: "pi_42",
    status: "requires_payment_method",
  });

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
  assert.deepStrictEqual(received.updatePaymentPending, {
    paymentIntentId: "pi_42",
    status: "requires_payment_method",
    timestamp: "2026-07-24 12:00:00",
    connection,
  });
};

const runStripeWebhookReconciliationContract = async () => {
  const actions = [];
  let currentPaymentIntent = {
    id: "pi_42",
    status: "requires_payment_method",
  };
  let currentRefund = { id: "re_42", status: "pending" };
  const handler = buildStripeWebhookEventHandler({
    getStripe: () => ({
      paymentIntents: {
        retrieve: async (id) => ({ ...currentPaymentIntent, id }),
      },
      charges: {
        retrieve: async (id) => ({ id }),
      },
      refunds: {
        retrieve: async (id) => {
          actions.push(["retrieve-refund", id]);
          return { ...currentRefund, id };
        },
        list: async (params) => {
          actions.push(["list-refunds", params]);
          return {
            data: [
              { id: "re_previous", status: "succeeded", amount: 1200 },
              { id: "re_42", status: "succeeded", amount: 1100 },
            ],
            has_more: false,
          };
        },
      },
    }),
    markPaymentAttemptFailed: async (paymentIntent) => {
      actions.push(["failed", paymentIntent.status]);
    },
    markPaymentProcessing: async (paymentIntentId) => {
      actions.push(["processing", paymentIntentId]);
    },
    markPaymentSucceeded: async (paymentIntent, charge) => {
      actions.push(["succeeded", paymentIntent.id, charge && charge.id]);
    },
    markPaymentCanceled: async (paymentIntentId) => {
      actions.push(["canceled", paymentIntentId]);
    },
    reconcileStripeRefund: async (refund) => {
      actions.push([
        "refund",
        refund.id,
        refund.status,
        refund.cumulative_succeeded_amount,
      ]);
    },
  });

  await handler({
    type: "payment_intent.payment_failed",
    data: { object: { id: "pi_42", status: "requires_payment_method" } },
  });
  await handler({
    type: "payment_intent.processing",
    data: { object: { id: "pi_42", status: "processing" } },
  });
  assert.deepStrictEqual(actions, [
    ["failed", "requires_payment_method"],
    ["failed", "requires_payment_method"],
  ], "a stale processing webhook must use Stripe's current retryable state");

  actions.length = 0;
  currentPaymentIntent = { id: "pi_42", status: "processing" };
  await handler({
    type: "payment_intent.processing",
    data: { object: { id: "pi_42", status: "processing" } },
  });
  assert.deepStrictEqual(actions, [["processing", "pi_42"]]);

  actions.length = 0;
  currentPaymentIntent = {
    id: "pi_42",
    status: "succeeded",
    latest_charge: "ch_42",
  };
  await handler({
    type: "payment_intent.processing",
    data: { object: { id: "pi_42", status: "processing" } },
  });
  assert.deepStrictEqual(actions, [["succeeded", "pi_42", "ch_42"]]);

  actions.length = 0;
  currentPaymentIntent = { id: "pi_42", status: "canceled" };
  await handler({
    type: "payment_intent.payment_failed",
    data: { object: { id: "pi_42", status: "requires_payment_method" } },
  });
  assert.deepStrictEqual(actions, [["canceled", "pi_42"]]);

  actions.length = 0;
  currentRefund = {
    id: "re_42",
    status: "succeeded",
    amount: 1100,
    charge: "ch_42",
  };
  await handler({
    type: "refund.created",
    data: { object: { id: "re_42", status: "pending" } },
  });
  assert.deepStrictEqual(actions, [
    ["retrieve-refund", "re_42"],
    ["list-refunds", { charge: "ch_42", limit: 100 }],
    ["refund", "re_42", "succeeded", 2300],
  ]);

  actions.length = 0;
  currentRefund = { id: "re_42", status: "pending" };
  await handler({
    type: "refund.failed",
    data: { object: { id: "re_42", status: "failed" } },
  });
  assert.deepStrictEqual(actions, [
    ["retrieve-refund", "re_42"],
    ["refund", "re_42", "pending", undefined],
  ]);
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
    stripe_payment_intent_id: "pi_42",
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
    paymentIntentId: "pi_42",
    status: "canceled",
    connection,
  });
};

const makeRefundLifecycleHarness = () => {
  const state = {
    order: {
      id: 42,
      shopid: 7,
      status: 3,
      payment_status: "paid",
      payment_provider: "stripe",
      stripe_payment_intent_id: "pi_42",
    },
    payment: {
      id: 12,
      order_id: 42,
      shop_id: 7,
      stripe_payment_intent_id: "pi_42",
      stripe_charge_id: "ch_42",
      amount_cents: 2300,
      stripe_refund_id: null,
      refund_status: null,
      refund_failure_reason: null,
      refunded_at: null,
      status: "succeeded",
    },
  };
  const events = [];
  const repository = {
    findPaymentForOrderRefund: async ({ orderId, shopId, connection }) => {
      if (connection) events.push("lock-payment");
      if (Number(orderId) !== state.payment.order_id
        || Number(shopId) !== state.payment.shop_id) return null;
      return state.payment;
    },
    findPaymentsForRefund: async ({ refund, connection }) => {
      if (connection) events.push("lock-payment");
      const chargeId = typeof refund.charge === "string"
        ? refund.charge
        : refund.charge && refund.charge.id;
      return [
        state.payment.stripe_refund_id === refund.id,
        state.payment.stripe_payment_intent_id === refund.payment_intent,
        state.payment.stripe_charge_id === chargeId,
      ].some(Boolean) ? [state.payment] : [];
    },
    lockOrder: async ({ orderId, shopId }) => {
      events.push("lock-order");
      return Number(orderId) === state.order.id && Number(shopId) === state.order.shopid
        ? state.order
        : null;
    },
    updatePaymentRefundState: async ({
      refundId,
      refundStatus,
      failureReason,
      paymentStatus,
      refundedAt,
    }) => {
      Object.assign(state.payment, {
        stripe_refund_id: refundId,
        refund_status: refundStatus,
        refund_failure_reason: failureReason,
        refunded_at: refundedAt,
        status: paymentStatus,
      });
      events.push("update-payment");
      return { affectedRows: 1 };
    },
    updateOrderRefunded: async () => {
      state.order.payment_status = "refunded";
      state.order.status = ORDER_STATUSES.CANCELED;
      events.push("update-order");
      return { affectedRows: 1 };
    },
    updateOrderRefundNonFinal: async () => {
      state.order.payment_status = "paid";
      events.push("update-order-non-final");
      return { affectedRows: 1 };
    },
    backfillRefundCharge: async ({ chargeId }) => {
      if (state.payment.stripe_charge_id != null) return { affectedRows: 0 };
      state.payment.stripe_charge_id = chargeId;
      events.push("backfill-charge");
      return { affectedRows: 1 };
    },
  };
  const payments = buildPaymentModule({
    repository,
    withTransaction: async (work) => work({ transaction: true }),
    now: () => new Date("2026-07-26T19:30:00.000Z"),
  });
  return { events, payments, state };
};

const runPendingRefundLifecycleContract = async () => {
  const harness = makeRefundLifecycleHarness();

  const result = await harness.payments.recordRefundState({
    orderId: 42,
    shopId: 7,
    refund: {
      id: "re_42",
      status: "pending",
      payment_intent: "pi_42",
      charge: "ch_42",
    },
  });

  assert.deepStrictEqual(result, { status: "pending" });
  assert.strictEqual(harness.state.payment.stripe_refund_id, "re_42");
  assert.strictEqual(harness.state.payment.refund_status, "pending");
  assert.strictEqual(harness.state.payment.status, "succeeded");
  assert.strictEqual(harness.state.payment.refunded_at, null);
  assert.strictEqual(harness.state.order.payment_status, "paid");
  assert.strictEqual(harness.state.order.status, 3);
  assert.deepStrictEqual(harness.events, [
    "lock-order",
    "lock-payment",
    "update-payment",
  ]);
};

const runPartialRefundDoesNotClaimAssociationContract = async () => {
  const harness = makeRefundLifecycleHarness();
  const partialSucceeded = await harness.payments.reconcileStripeRefund({
    id: "re_partial_succeeded",
    status: "succeeded",
    amount: 1200,
    cumulative_succeeded_amount: 1200,
    payment_intent: "pi_42",
    charge: "ch_42",
    metadata: { order_id: "42", shop_id: "7" },
  });
  assert.deepStrictEqual(partialSucceeded, {
    ignored: true,
    partial_refund: true,
  });
  assert.strictEqual(harness.state.payment.stripe_refund_id, null);
  assert.strictEqual(harness.state.payment.refund_status, null);
  assert.strictEqual(harness.state.payment.status, "succeeded");
  assert.strictEqual(harness.state.order.payment_status, "paid");

  const remainingSucceeded = await harness.payments.reconcileStripeRefund({
    id: "re_remaining_after_partial",
    status: "succeeded",
    amount: 1100,
    cumulative_succeeded_amount: 2300,
    payment_intent: "pi_42",
    charge: "ch_42",
    metadata: { order_id: "42", shop_id: "7" },
  });
  assert.deepStrictEqual(remainingSucceeded, { status: "succeeded" });
  assert.strictEqual(harness.state.payment.stripe_refund_id, "re_remaining_after_partial");
  assert.strictEqual(harness.state.payment.refund_status, "succeeded");
  assert.strictEqual(harness.state.payment.status, "refunded");
  assert.strictEqual(harness.state.order.payment_status, "refunded");
};

const runCumulativeRefundWebhookLifecycleContract = async () => {
  const harness = makeRefundLifecycleHarness();
  const refunds = {
    re_a: {
      id: "re_a",
      status: "succeeded",
      amount: 1200,
      payment_intent: "pi_42",
      charge: "ch_42",
      metadata: { order_id: "42", shop_id: "7" },
    },
    re_b: {
      id: "re_b",
      status: "pending",
      amount: 1100,
      payment_intent: "pi_42",
      charge: "ch_42",
      metadata: { order_id: "42", shop_id: "7" },
    },
  };
  const listCalls = [];
  const handler = buildStripeWebhookEventHandler({
    getStripe: () => ({
      refunds: {
        retrieve: async (refundId) => ({ ...refunds[refundId] }),
        list: async (params) => {
          listCalls.push(params);
          return {
            data: Object.values(refunds).map((refund) => ({ ...refund })),
            has_more: false,
          };
        },
      },
    }),
    reconcileStripeRefund: harness.payments.reconcileStripeRefund,
  });

  await handler({ type: "refund.updated", data: { object: { id: "re_a" } } });
  assert.strictEqual(harness.state.payment.stripe_refund_id, null);
  assert.strictEqual(harness.state.payment.status, "succeeded");
  assert.strictEqual(harness.state.order.payment_status, "paid");

  refunds.re_b.status = "failed";
  await handler({ type: "refund.failed", data: { object: { id: "re_b" } } });
  assert.strictEqual(harness.state.payment.stripe_refund_id, null);
  assert.strictEqual(harness.state.payment.status, "succeeded");
  assert.strictEqual(harness.state.order.payment_status, "paid");

  refunds.re_b.status = "succeeded";
  await handler({ type: "refund.updated", data: { object: { id: "re_b" } } });
  assert.strictEqual(harness.state.payment.stripe_refund_id, "re_b");
  assert.strictEqual(harness.state.payment.status, "refunded");
  assert.strictEqual(harness.state.order.payment_status, "refunded");
  assert.deepStrictEqual(listCalls, [
    { charge: "ch_42", limit: 100 },
    { charge: "ch_42", limit: 100 },
    { charge: "ch_42", limit: 100 },
  ]);
};

const runRefundPaginationContract = async () => {
  const listCalls = [];
  let reconciled = null;
  const handler = buildStripeWebhookEventHandler({
    getStripe: () => ({
      refunds: {
        retrieve: async () => ({
          id: "re_b",
          status: "succeeded",
          amount: 1100,
          charge: "ch_42",
        }),
        list: async (params) => {
          listCalls.push(params);
          if (!params.starting_after) {
            return {
              data: [{ id: "re_a", status: "succeeded", amount: 1200 }],
              has_more: true,
            };
          }
          return {
            data: [{ id: "re_b", status: "succeeded", amount: 1100 }],
            has_more: false,
          };
        },
      },
    }),
    reconcileStripeRefund: async (refund) => {
      reconciled = refund;
    },
  });
  await handler({ type: "refund.updated", data: { object: { id: "re_b" } } });
  assert.deepStrictEqual(listCalls, [
    { charge: "ch_42", limit: 100 },
    { charge: "ch_42", limit: 100, starting_after: "re_a" },
  ]);
  assert.strictEqual(reconciled.cumulative_succeeded_amount, 2300);

  const malformedHandler = buildStripeWebhookEventHandler({
    getStripe: () => ({
      refunds: {
        retrieve: async () => ({
          id: "re_b",
          status: "succeeded",
          amount: 1100,
          charge: "ch_42",
        }),
        list: async () => ({ data: [], has_more: true }),
      },
    }),
    reconcileStripeRefund: async () => {
      throw new Error("malformed pagination must not reconcile");
    },
  });
  await assert.rejects(
    () => malformedHandler({
      type: "refund.updated",
      data: { object: { id: "re_b" } },
    }),
    /Stripe refund pagination is incomplete/,
  );

  let reconciliationsAfterApiError = 0;
  const apiErrorHandler = buildStripeWebhookEventHandler({
    getStripe: () => ({
      refunds: {
        retrieve: async () => ({
          id: "re_b",
          status: "succeeded",
          amount: 1100,
          charge: "ch_42",
        }),
        list: async () => {
          throw new Error("Stripe list unavailable");
        },
      },
    }),
    reconcileStripeRefund: async () => {
      reconciliationsAfterApiError += 1;
    },
  });
  await assert.rejects(
    () => apiErrorHandler({
      type: "refund.updated",
      data: { object: { id: "re_b" } },
    }),
    /Stripe list unavailable/,
  );
  assert.strictEqual(reconciliationsAfterApiError, 0);
};

const runSucceededRefundLifecycleContract = async () => {
  const harness = makeRefundLifecycleHarness();
  const refund = {
    id: "re_42",
    status: "succeeded",
    amount: 2300,
    payment_intent: "pi_42",
    charge: "ch_42",
  };

  assert.deepStrictEqual(
    await harness.payments.recordRefundState({ orderId: 42, shopId: 7, refund }),
    { status: "succeeded" },
  );
  assert.strictEqual(harness.state.payment.status, "refunded");
  assert.strictEqual(harness.state.payment.refund_status, "succeeded");
  assert.strictEqual(harness.state.payment.refund_failure_reason, null);
  assert.strictEqual(harness.state.payment.refunded_at, "2026-07-26 19:30:00");
  assert.strictEqual(harness.state.order.payment_status, "refunded");

  let legacyChargeHarness = makeRefundLifecycleHarness();
  legacyChargeHarness.state.order.payment_status = "refunded";
  legacyChargeHarness.state.order.status = ORDER_STATUSES.CANCELED;
  Object.assign(legacyChargeHarness.state.payment, {
    status: "refunded",
    refund_status: "legacy_unknown",
    refunded_at: "2026-07-25 10:00:00",
    stripe_refund_id: "re_extracted",
    stripe_charge_id: null,
  });
  assert.deepStrictEqual(
    await legacyChargeHarness.payments.reconcileStripeRefund({
      id: "re_extracted",
      status: "succeeded",
      payment_intent: "pi_42",
      amount: 2300,
      charge: "ch_backfilled",
    }),
    { status: "succeeded", legacy_backfill: true },
  );
  assert.strictEqual(legacyChargeHarness.state.payment.stripe_charge_id, "ch_backfilled");

  const partialLegacyHarness = makeRefundLifecycleHarness();
  partialLegacyHarness.state.order.payment_status = "refunded";
  partialLegacyHarness.state.order.status = ORDER_STATUSES.CANCELED;
  Object.assign(partialLegacyHarness.state.payment, {
    status: "refunded",
    refund_status: "legacy_unknown",
    refunded_at: "2026-07-25 10:00:00",
    stripe_refund_id: null,
  });
  assert.deepStrictEqual(
    await partialLegacyHarness.payments.reconcileStripeRefund({
      id: "re_partial",
      status: "pending",
      payment_intent: "pi_42",
      charge: "ch_42",
      amount: 1200,
    }),
    { ignored: true },
  );
  assert.strictEqual(partialLegacyHarness.state.payment.stripe_refund_id, null);
  assert.strictEqual(partialLegacyHarness.state.payment.refund_status, "legacy_unknown");
  assert.strictEqual(partialLegacyHarness.state.order.payment_status, "refunded");
  assert.deepStrictEqual(partialLegacyHarness.events, []);

  const partialModernHarness = makeRefundLifecycleHarness();
  const partialModern = await partialModernHarness.payments.reconcileStripeRefund({
    id: "re_partial_modern",
    status: "succeeded",
    amount: 1200,
    payment_intent: "pi_42",
    charge: "ch_42",
    metadata: { order_id: "42", shop_id: "7" },
  });
  assert.deepStrictEqual(partialModern, {
    ignored: true,
    partial_refund: true,
  });
  assert.strictEqual(partialModernHarness.state.payment.status, "succeeded");
  assert.strictEqual(partialModernHarness.state.payment.refund_status, null);
  assert.strictEqual(partialModernHarness.state.order.payment_status, "paid");

  legacyChargeHarness = makeRefundLifecycleHarness();
  legacyChargeHarness.state.order.payment_status = "refunded";
  legacyChargeHarness.state.order.status = ORDER_STATUSES.CANCELED;
  Object.assign(legacyChargeHarness.state.payment, {
    status: "refunded",
    refund_status: "legacy_unknown",
    stripe_refund_id: "re_extracted",
    stripe_charge_id: "ch_local",
  });
  assert.deepStrictEqual(
    await legacyChargeHarness.payments.reconcileStripeRefund({
      id: "re_extracted",
      status: "succeeded",
      payment_intent: "pi_42",
      charge: "ch_other",
    }),
    { ignored: true },
  );
  assert.strictEqual(legacyChargeHarness.state.payment.stripe_charge_id, "ch_local");
  assert.strictEqual(harness.state.order.status, ORDER_STATUSES.CANCELED);

  const eventsAfterSuccess = harness.events.slice();
  assert.deepStrictEqual(
    await harness.payments.recordRefundState({ orderId: 42, shopId: 7, refund }),
    { status: "succeeded", idempotent_replay: true },
  );
  assert.deepStrictEqual(harness.events, [
    ...eventsAfterSuccess,
    "lock-order",
    "lock-payment",
  ]);

  const webhookFirst = makeRefundLifecycleHarness();
  await webhookFirst.payments.reconcileStripeRefund({
    ...refund,
    metadata: { order_id: "42", shop_id: "7" },
  });
  assert.deepStrictEqual(
    await webhookFirst.payments.recordRefundState({
      orderId: 42,
      shopId: 7,
      refund: { ...refund, status: "pending" },
    }),
    { status: "succeeded", idempotent_replay: true },
  );
  assert.strictEqual(webhookFirst.state.payment.status, "refunded");
  assert.strictEqual(webhookFirst.state.order.payment_status, "refunded");
};

const runFailedRefundLifecycleContract = async () => {
  for (const [status, failureReason] of [
    ["failed", "lost_or_stolen_card"],
    ["canceled", null],
  ]) {
    const harness = makeRefundLifecycleHarness();
    await harness.payments.recordRefundState({
      orderId: 42,
      shopId: 7,
      refund: { id: "re_42", status: "pending", payment_intent: "pi_42" },
    });

    assert.deepStrictEqual(
      await harness.payments.recordRefundState({
        orderId: 42,
        shopId: 7,
        refund: {
          id: "re_42",
          status,
          payment_intent: "pi_42",
          failure_reason: failureReason,
        },
      }),
      { status },
    );
    assert.strictEqual(harness.state.payment.status, "succeeded");
    assert.strictEqual(harness.state.payment.refund_status, status);
    assert.strictEqual(harness.state.payment.refund_failure_reason, failureReason);
    assert.strictEqual(harness.state.payment.refunded_at, null);
    assert.strictEqual(harness.state.order.payment_status, "paid");
    assert.strictEqual(harness.state.order.status, 3);
  }
};

const runRefundWebhookLookupContract = async () => {
  const identifierCases = [
    {
      prepare: (payment) => { payment.stripe_refund_id = "re_42"; },
      refund: { id: "re_42" },
    },
    {
      prepare: () => {},
      refund: { id: "re_42", payment_intent: "pi_42" },
    },
    {
      prepare: () => {},
      refund: { id: "re_42", charge: "ch_42" },
    },
  ];
  for (const identifierCase of identifierCases) {
    const harness = makeRefundLifecycleHarness();
    identifierCase.prepare(harness.state.payment);
    const refund = {
      status: "pending",
      metadata: { order_id: "42", shop_id: "7" },
      ...identifierCase.refund,
    };
    assert.deepStrictEqual(
      await harness.payments.reconcileStripeRefund(refund),
      { status: "pending" },
    );
    assert.strictEqual(harness.state.payment.stripe_refund_id, "re_42");
  }

  let harness = makeRefundLifecycleHarness();
  harness.state.payment.stripe_refund_id = "re_42";
  assert.deepStrictEqual(
    await harness.payments.reconcileStripeRefund({
      id: "re_42",
      status: "pending",
    }),
    { status: "pending" },
    "an already-associated refund ID remains reconcilable without metadata",
  );

  for (const refundReference of [
    { payment_intent: "pi_42" },
    { charge: "ch_42" },
  ]) {
    harness = makeRefundLifecycleHarness();
    assert.deepStrictEqual(
      await harness.payments.reconcileStripeRefund({
        id: "re_new",
        status: "pending",
        ...refundReference,
      }),
      { ignored: true },
      "a new refund association requires order and shop metadata",
    );
    assert.strictEqual(harness.state.payment.stripe_refund_id, null);
    assert.strictEqual(harness.state.payment.refund_status, null);
    assert.strictEqual(harness.state.payment.status, "succeeded");
    assert.strictEqual(harness.state.order.payment_status, "paid");
    assert.strictEqual(harness.state.order.status, 3);
    assert.deepStrictEqual(harness.events, []);
  }

  harness = makeRefundLifecycleHarness();
  harness.state.order.payment_status = "refunded";
  harness.state.order.status = ORDER_STATUSES.CANCELED;
  Object.assign(harness.state.payment, {
    status: "refunded",
    refund_status: "legacy_unknown",
    refunded_at: "2026-07-25 10:00:00",
    stripe_refund_id: null,
  });
  assert.deepStrictEqual(
    await harness.payments.reconcileStripeRefund({
      id: "re_legacy",
      status: "succeeded",
      payment_intent: "pi_42",
      amount: 2300,
    }),
    { status: "succeeded", legacy_backfill: true },
  );
  assert.strictEqual(harness.state.payment.stripe_refund_id, "re_legacy");
  assert.strictEqual(harness.state.payment.refund_status, "succeeded");
  assert.strictEqual(harness.state.payment.refunded_at, "2026-07-25 10:00:00");
  assert.strictEqual(harness.state.order.payment_status, "refunded");

  for (const [currentStatus, failureReason] of [
    ["pending", null],
    ["failed", "expired_or_canceled_card"],
  ]) {
    harness = makeRefundLifecycleHarness();
    harness.state.order.payment_status = "refunded";
    harness.state.order.status = ORDER_STATUSES.CANCELED;
    Object.assign(harness.state.payment, {
      status: "refunded",
      refund_status: "legacy_unknown",
      refunded_at: "2026-07-25 10:00:00",
      stripe_refund_id: currentStatus === "failed" ? "re_legacy" : null,
    });
    assert.deepStrictEqual(
      await harness.payments.reconcileStripeRefund({
        id: "re_legacy",
        status: currentStatus,
        payment_intent: "pi_42",
        amount: 2300,
        failure_reason: failureReason,
      }),
      {
        status: currentStatus,
        business_status_unchanged: true,
        order_status: ORDER_STATUSES.CANCELED,
      },
    );
    assert.strictEqual(harness.state.payment.status, "succeeded");
    assert.strictEqual(harness.state.payment.refund_status, currentStatus);
    assert.strictEqual(harness.state.payment.refund_failure_reason, failureReason);
    assert.strictEqual(harness.state.payment.refunded_at, null);
    assert.strictEqual(harness.state.order.payment_status, "paid");
    assert.strictEqual(harness.state.order.status, ORDER_STATUSES.CANCELED);

    assert.deepStrictEqual(
      await harness.payments.reconcileStripeRefund({
        id: "re_legacy",
        status: "succeeded",
        payment_intent: "pi_42",
        amount: 2300,
      }),
      { status: "succeeded" },
    );
    assert.strictEqual(harness.state.payment.status, "refunded");
    assert.strictEqual(harness.state.order.payment_status, "refunded");
    assert.strictEqual(harness.state.order.status, ORDER_STATUSES.CANCELED);
  }

  for (const mismatchedReference of [
    { payment_intent: "pi_wrong", charge: "ch_42" },
    { payment_intent: "pi_42", charge: "ch_wrong" },
  ]) {
    harness = makeRefundLifecycleHarness();
    harness.state.order.payment_status = "refunded";
    harness.state.order.status = ORDER_STATUSES.CANCELED;
    Object.assign(harness.state.payment, {
      status: "refunded",
      refund_status: "legacy_unknown",
      refunded_at: "2026-07-25 10:00:00",
      stripe_refund_id: null,
    });
    assert.deepStrictEqual(
      await harness.payments.reconcileStripeRefund({
        id: "re_legacy",
        status: "succeeded",
        amount: 2300,
        ...mismatchedReference,
      }),
      { ignored: true },
    );
    assert.strictEqual(harness.state.payment.stripe_refund_id, null);
  }

  harness = makeRefundLifecycleHarness();
  assert.deepStrictEqual(
    await harness.payments.reconcileStripeRefund({
      id: "re_unknown",
      status: "pending",
      payment_intent: "pi_unknown",
      charge: "ch_unknown",
    }),
    { missing: true },
  );
  assert.strictEqual(harness.events.length, 0);
  assert.strictEqual(harness.state.payment.stripe_refund_id, null);

  harness = makeRefundLifecycleHarness();
  assert.deepStrictEqual(
    await harness.payments.reconcileStripeRefund({
      id: "re_42",
      status: "succeeded",
      payment_intent: "pi_42",
      metadata: { order_id: "42", shop_id: "999" },
    }),
    { ignored: true },
  );
  assert.strictEqual(harness.state.payment.status, "succeeded");
  assert.strictEqual(harness.state.order.payment_status, "paid");

  harness = makeRefundLifecycleHarness();
  harness.state.order.stripe_payment_intent_id = "pi_other";
  assert.deepStrictEqual(
    await harness.payments.reconcileStripeRefund({
      id: "re_42",
      status: "succeeded",
      payment_intent: "pi_42",
    }),
    { ignored: true },
  );
  assert.strictEqual(harness.state.payment.status, "succeeded");
  assert.strictEqual(harness.state.order.payment_status, "paid");

  harness = makeRefundLifecycleHarness();
  const succeededRefund = {
    id: "re_42",
    status: "succeeded",
    amount: 2300,
    payment_intent: "pi_42",
    charge: "ch_42",
    metadata: { order_id: "42", shop_id: "7" },
  };
  assert.deepStrictEqual(
    await harness.payments.reconcileStripeRefund(succeededRefund),
    { status: "succeeded" },
  );
  assert.deepStrictEqual(
    await harness.payments.reconcileStripeRefund(succeededRefund),
    { status: "succeeded", idempotent_replay: true },
  );
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
  await harness.payments.markStripeOrderPayAtCounter(42, 7, "pi_42");
  assert.strictEqual(harness.getState().products.get(10), 8);
  assert.strictEqual(harness.getState().reservations[0].status, "committed");
  assert.strictEqual(harness.getState().movements.length, 1);
  assert.strictEqual(harness.getState().orders[0].payment_status, "unpaid");

  harness = makeStripeLifecycleHarness();
  await harness.payments.markPaymentAttemptFailed({
    id: "pi_42",
    status: "requires_payment_method",
  });
  assert.strictEqual(harness.getState().products.get(10), 8);
  assert.strictEqual(harness.getState().reservations[0].status, "reserved");
  assert.strictEqual(harness.getState().orders[0].payment_status, "requires_payment");
  assert.strictEqual(harness.getState().payments[0].status, "requires_payment_method");
  await harness.payments.markPaymentSucceeded(succeededIntent);
  assert.strictEqual(harness.getState().orders[0].payment_status, "paid");
  assert.strictEqual(harness.getState().reservations[0].status, "committed");

  harness = makeStripeLifecycleHarness();
  await harness.payments.markPaymentProcessing("pi_42");
  assert.strictEqual(harness.getState().products.get(10), 8);
  assert.strictEqual(harness.getState().reservations[0].status, "reserved");
  assert.strictEqual(harness.getState().orders[0].payment_status, "requires_payment");
  assert.strictEqual(harness.getState().payments[0].status, "processing");

  harness = makeStripeLifecycleHarness();
  await harness.payments.markPaymentCanceled("pi_42");
  await harness.payments.markPaymentCanceled("pi_42");
  assert.strictEqual(harness.getState().products.get(10), 10, "canceled restores once");
  assert.strictEqual(harness.getState().reservations[0].status, "released");
  await harness.payments.markPaymentSucceeded(succeededIntent);
  assert.strictEqual(harness.getState().products.get(10), 10);
  assert.strictEqual(harness.getState().orders[0].payment_status, "canceled");

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
  await harness.payments.cancelProvisionalStripeOrder(42, 7, "pi_42");
  await harness.payments.cancelProvisionalStripeOrder(42, 7, "pi_42");
  assert.strictEqual(harness.getState().products.get(10), 10);
  assert.strictEqual(harness.getState().reservations[0].status, "released");
  assert.strictEqual(harness.getState().orders[0].payment_status, "canceled");
  assert.strictEqual(harness.getState().orders[0].status, ORDER_STATUSES.CANCELED);

  harness = makeStripeLifecycleHarness();
  harness.getState().orders[0].stripe_payment_intent_id = "pi_replacement";
  const staleCancellation = await harness.payments.cancelProvisionalStripeOrder(
    42,
    7,
    "pi_42",
  );
  assert.deepStrictEqual(staleCancellation, { ignored: true, stale_intent: true });
  assert.strictEqual(harness.getState().reservations[0].status, "reserved");
  assert.strictEqual(harness.getState().orders[0].stripe_payment_intent_id, "pi_replacement");

  harness = makeStripeLifecycleHarness();
  harness.getState().orders[0].stripe_payment_intent_id = "pi_replacement";
  const staleCounter = await harness.payments.markStripeOrderPayAtCounter(
    42,
    7,
    "pi_42",
  );
  assert.deepStrictEqual(staleCounter, { ignored: true, stale_intent: true });
  assert.strictEqual(harness.getState().reservations[0].status, "reserved");
  assert.strictEqual(harness.getState().orders[0].stripe_payment_intent_id, "pi_replacement");

  harness = makeStripeLifecycleHarness({ paymentAttached: false });
  const orphanCancellation = await harness.payments.cancelOrphanedProvisionalStripeOrder(42, 7);
  assert.deepStrictEqual(orphanCancellation, { canceled: true });
  assert.strictEqual(harness.getState().products.get(10), 10);
  assert.strictEqual(harness.getState().reservations[0].status, "released");
  assert.strictEqual(harness.getState().orders[0].payment_status, "canceled");
  assert.strictEqual(harness.getState().orders[0].status, ORDER_STATUSES.CANCELED);

  harness = makeStripeLifecycleHarness({ paymentAttached: false });
  const orphanScan = {
    order_id: 42,
    shop_id: 7,
    stripe_payment_intent_id: null,
  };
  harness.getState().orders[0].stripe_payment_intent_id = "pi_new";
  harness.getState().payments.push({
    order_id: 42,
    shop_id: 7,
    stripe_payment_intent_id: "pi_new",
    status: "requires_payment_method",
  });
  const staleOrphanCancellation = await (
    harness.payments.cancelOrphanedProvisionalStripeOrder(
      orphanScan.order_id,
      orphanScan.shop_id,
    )
  );
  assert.deepStrictEqual(staleOrphanCancellation, { ignored: true, stale_scan: true });
  assert.strictEqual(harness.getState().products.get(10), 8);
  assert.strictEqual(harness.getState().reservations[0].status, "reserved");
  assert.strictEqual(harness.getState().orders[0].payment_status, "requires_payment");
  assert.strictEqual(harness.getState().orders[0].status, ORDER_STATUSES.PENDING);
  assert.strictEqual(harness.getState().orders[0].stripe_payment_intent_id, "pi_new");
  assert.strictEqual(harness.getState().payments[0].status, "requires_payment_method");

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
  sync = buildPendingStripeArchiveSync({
    getStripe: () => ({
      paymentIntents: {
        retrieve: async () => ({ id: "pi_42", status: "requires_payment" }),
        cancel: async () => {
          harness.getState().orders[0].stripe_payment_intent_id = "pi_replacement";
          return { id: "pi_42", status: "canceled" };
        },
      },
      charges: { retrieve: async () => null },
    }),
    markPaymentSucceeded: harness.payments.markPaymentSucceeded,
    markStripeOrderPayAtCounter: harness.payments.markStripeOrderPayAtCounter,
    findOrderById: async () => [harness.getState().orders[0]],
  });
  await assert.rejects(
    () => sync(harness.getState().orders[0]),
    (error) => error.code === "STRIPE_PAYMENT_NOT_SETTLED",
  );
  assert.strictEqual(harness.getState().reservations[0].status, "reserved");
  assert.strictEqual(harness.getState().orders[0].stripe_payment_intent_id, "pi_replacement");

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
  assert.deepStrictEqual(cleaned, [[42, 7, null]]);
  assert.ok(!JSON.stringify(response.payload).includes("Stripe secret"));
  assert.strictEqual(logs.length, 1);

  for (const scenario of [{
    name: "attachment",
    options: { paymentAttached: false, failAttachment: true },
    cancelFails: false,
    releasesReservation: false,
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
    cancelProvisionalStripeOrder: async (orderId, shopId, paymentIntentId) => {
      events.push(["release", Number(orderId), Number(shopId), paymentIntentId]);
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
    ["release", 42, 7, "pi_42"],
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

  let replacementOrder = {
    id: 42,
    shopid: 7,
    payment_status: "requires_payment",
    payment_provider: "stripe",
    stripe_payment_intent_id: "pi_old",
  };
  let expectedCancellationIntent = null;
  response = makeResponse();
  await buildCancelQrTablePaymentIntentController({
    getStripeOrderForCancellation: async () => replacementOrder,
    getStripe: () => ({
      paymentIntents: {
        retrieve: async () => ({ id: "pi_old", status: "requires_payment_method" }),
        cancel: async () => {
          replacementOrder = {
            ...replacementOrder,
            stripe_payment_intent_id: "pi_replacement",
          };
          return { id: "pi_old", status: "canceled" };
        },
      },
    }),
    cancelProvisionalStripeOrder: async (_orderId, _shopId, paymentIntentId) => {
      expectedCancellationIntent = paymentIntentId;
      return { ignored: true, stale_intent: true };
    },
    logger: { error: () => {} },
  })({ params: { orderId: "42" }, shopid: 7 }, response);
  assert.strictEqual(expectedCancellationIntent, "pi_old");
  assert.strictEqual(response.statusCode, 409);
  assert.strictEqual(replacementOrder.stripe_payment_intent_id, "pi_replacement");
};

const runPayAtCounterIntentRaceContract = async () => {
  let receivedIntentId = null;
  const controller = buildMarkQrTablePaymentAtCounter({
    getShopInfo: async () => [{ id: 7, qr_payment_mode: "pay_at_counter" }],
    getPendingStripeOrderForCounter: async () => [{
      stripe_payment_intent_id: "pi_old",
    }],
    getStripe: () => ({
      paymentIntents: {
        retrieve: async () => ({ id: "pi_old", status: "requires_payment_method" }),
        cancel: async () => ({ id: "pi_old", status: "canceled" }),
      },
    }),
    markStripeOrderPayAtCounter: async (_orderId, _shopId, paymentIntentId) => {
      receivedIntentId = paymentIntentId;
      return { ignored: true, stale_intent: true };
    },
  });
  const response = makeResponse();
  await controller({ params: { orderId: "42" }, shopid: 7 }, response);
  assert.strictEqual(receivedIntentId, "pi_old");
  assert.strictEqual(response.statusCode, 409);
  assert.strictEqual(response.payload.data.code, "STRIPE_PAYMENT_NOT_SETTLED");
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
    reservations: [{ order_id: 42, status: "reserved" }],
  };
  const payments = buildPaymentModule({
    withTransaction: async (work) => work({ transaction: true }),
    repository: {
      lockOrder: async () => paymentState.order,
      lockOrderReservations: async () => paymentState.reservations,
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

  paymentState.order.payment_status = "unpaid";
  paymentState.order.stripe_payment_intent_id = null;
  paymentState.order.stripe_replacement_attempt_token = "attempt-released";
  paymentState.reservations[0].status = "released";
  const released = await payments.persistReplacementPaymentIntent({
    orderId: 42,
    shopId: 7,
    stripe_payment_intent_id: "pi_after_release",
    replacement_attempt_token: "attempt-released",
    amount: 31,
    amount_cents: 3100,
    application_fee_amount: 155,
    currency: "eur",
    status: "requires_payment_method",
  });
  assert.deepStrictEqual(released, {
    attached: false,
    reservations_unavailable: true,
  });
  assert.strictEqual(paymentState.order.stripe_payment_intent_id, null);
  assert.strictEqual(
    paymentState.payments.some(
      (payment) => payment.stripe_payment_intent_id === "pi_after_release",
    ),
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

const runRefundControllerContract = async () => {
  const calls = [];
  const controller = buildRefundPaidOrderController({
    getPaidOrderForRefund: async () => [{
      id: 42,
      shopid: 7,
      payment_status: "paid",
      payment_record_status: "succeeded",
      stripe_payment_intent_id: "pi_42",
      stripe_refund_id: null,
    }],
    getStripe: () => ({
      refunds: {
        create: async (params, options) => {
          calls.push(["create", params, options]);
          return { id: "re_42", status: "pending" };
        },
      },
    }),
    recordRefundState: async (input) => {
      calls.push(["record", input]);
      return { status: input.refund.status };
    },
  });
  const response = makeResponse();

  await controller({ params: { id: "42" }, shopid: 7 }, response);

  assert.deepStrictEqual(calls[0], [
    "create",
    {
      payment_intent: "pi_42",
      reverse_transfer: true,
      refund_application_fee: true,
      metadata: {
        order_id: "42",
        shop_id: "7",
      },
    },
    { idempotencyKey: "refund-order-7-42" },
  ]);
  assert.deepStrictEqual(calls[1], [
    "record",
    {
      orderId: 42,
      shopId: 7,
      refund: { id: "re_42", status: "pending" },
    },
  ]);
  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(response.payload.message, "Demande de remboursement enregistree.");
  assert.deepStrictEqual(response.payload.data, {
    refundId: "re_42",
    refundStatus: "pending",
  });

  const cumulativeCalls = [];
  const cumulativeController = buildRefundPaidOrderController({
    getPaidOrderForRefund: async () => [{
      id: 42,
      shopid: 7,
      payment_status: "paid",
      payment_record_status: "succeeded",
      stripe_payment_intent_id: "pi_42",
      stripe_refund_id: null,
    }],
    getStripe: () => ({
      refunds: {
        create: async (params) => {
          cumulativeCalls.push(["create", params]);
          return {
            id: "re_remaining",
            status: "succeeded",
            amount: 1100,
            payment_intent: "pi_42",
            charge: "ch_42",
            metadata: { order_id: "42", shop_id: "7" },
          };
        },
        list: async (params) => {
          cumulativeCalls.push(["list", params]);
          return {
            data: [
              { id: "re_partial", status: "succeeded", amount: 1200 },
              { id: "re_remaining", status: "succeeded", amount: 1100 },
            ],
            has_more: false,
          };
        },
      },
    }),
    recordRefundState: async (input) => {
      cumulativeCalls.push(["record", input]);
      return { status: "succeeded" };
    },
  });
  const cumulativeResponse = makeResponse();
  await cumulativeController(
    { params: { id: "42" }, shopid: 7 },
    cumulativeResponse,
  );
  assert.strictEqual(cumulativeCalls[0][0], "create");
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(cumulativeCalls[0][1], "amount"),
    false,
    "Stripe chooses the remaining refundable amount",
  );
  assert.deepStrictEqual(cumulativeCalls[1], [
    "list",
    { charge: "ch_42", limit: 100 },
  ]);
  assert.strictEqual(
    cumulativeCalls[2][1].refund.cumulative_succeeded_amount,
    2300,
  );
  assert.strictEqual(cumulativeResponse.payload.data.refundStatus, "succeeded");

  for (const nonFinalStatus of [
    "pending",
    "requires_action",
    "failed",
    "canceled",
  ]) {
    const nonFinalHarness = makeRefundLifecycleHarness();
    const nonFinalController = buildRefundPaidOrderController({
      getPaidOrderForRefund: async () => [{
        ...nonFinalHarness.state.order,
        payment_record_status: nonFinalHarness.state.payment.status,
        stripe_charge_id: nonFinalHarness.state.payment.stripe_charge_id,
        stripe_refund_id: nonFinalHarness.state.payment.stripe_refund_id,
        refund_status: nonFinalHarness.state.payment.refund_status,
        amount_cents: nonFinalHarness.state.payment.amount_cents,
      }],
      getStripe: () => ({
        refunds: {
          create: async () => ({
            id: `re_remaining_${nonFinalStatus}`,
            status: nonFinalStatus,
            amount: 1100,
            payment_intent: "pi_42",
            charge: "ch_42",
            metadata: { order_id: "42", shop_id: "7" },
          }),
          list: async () => ({
            data: [{
              id: "re_partial_succeeded",
              status: "succeeded",
              amount: 1200,
            }, {
              id: `re_remaining_${nonFinalStatus}`,
              status: nonFinalStatus,
              amount: 1100,
            }],
            has_more: false,
          }),
        },
      }),
      recordRefundState: nonFinalHarness.payments.recordRefundState,
    });
    const nonFinalResponse = makeResponse();
    await nonFinalController(
      { params: { id: "42" }, shopid: 7 },
      nonFinalResponse,
    );
    assert.strictEqual(nonFinalResponse.statusCode, 200, nonFinalStatus);
    assert.strictEqual(
      nonFinalResponse.payload.message,
      "Demande de remboursement enregistree.",
      nonFinalStatus,
    );
    assert.deepStrictEqual(nonFinalResponse.payload.data, {
      refundId: `re_remaining_${nonFinalStatus}`,
      refundStatus: nonFinalStatus,
      partial_refund: true,
    });
    assert.strictEqual(nonFinalHarness.state.payment.stripe_refund_id, null);
    assert.strictEqual(nonFinalHarness.state.payment.refund_status, null);
    assert.strictEqual(nonFinalHarness.state.payment.status, "succeeded");
    assert.strictEqual(nonFinalHarness.state.order.payment_status, "paid");
  }

  const replayCalls = [];
  const replayController = buildRefundPaidOrderController({
    getPaidOrderForRefund: async () => [{
      id: 42,
      shopid: 7,
      payment_status: "paid",
      payment_record_status: "succeeded",
      stripe_payment_intent_id: "pi_42",
      stripe_refund_id: "re_existing",
      refund_status: "pending",
    }],
    getStripe: () => ({
      refunds: {
        create: async () => {
          throw new Error("must not create a second refund");
        },
        retrieve: async (refundId) => {
          replayCalls.push(["retrieve", refundId]);
          return {
            id: refundId,
            status: "pending",
            payment_intent: "pi_42",
          };
        },
      },
    }),
    recordRefundState: async (input) => {
      replayCalls.push(["record", input]);
      return { status: input.refund.status };
    },
  });
  const replayResponse = makeResponse();
  await replayController({ params: { id: "42" }, shopid: 7 }, replayResponse);
  assert.deepStrictEqual(replayCalls, [
    ["retrieve", "re_existing"],
    ["record", {
      orderId: 42,
      shopId: 7,
      refund: {
        id: "re_existing",
        status: "pending",
        payment_intent: "pi_42",
      },
    }],
  ]);
  assert.strictEqual(replayResponse.payload.data.refundId, "re_existing");
  assert.strictEqual(replayResponse.payload.data.refundStatus, "pending");

  const webhookFirstController = buildRefundPaidOrderController({
    getPaidOrderForRefund: async () => [{
      id: 42,
      shopid: 7,
      payment_status: "paid",
      payment_record_status: "succeeded",
      stripe_payment_intent_id: "pi_42",
      stripe_refund_id: null,
    }],
    getStripe: () => ({
      refunds: {
        create: async () => ({ id: "re_42", status: "pending" }),
      },
    }),
    recordRefundState: async () => ({
      status: "succeeded",
      idempotent_replay: true,
    }),
  });
  const webhookFirstResponse = makeResponse();
  await webhookFirstController(
    { params: { id: "42" }, shopid: 7 },
    webhookFirstResponse,
  );
  assert.strictEqual(webhookFirstResponse.payload.message, "Commande remboursee.");
  assert.strictEqual(webhookFirstResponse.payload.data.refundStatus, "succeeded");

  for (const invalidId of ["42.0", "042", "-42", "0", "not-an-id"]) {
    let lookups = 0;
    const invalidResponse = makeResponse();
    await buildRefundPaidOrderController({
      getPaidOrderForRefund: async () => {
        lookups += 1;
        return [];
      },
      getStripe: () => {
        throw new Error("Stripe must not be called");
      },
    })({ params: { id: invalidId }, shopid: 7 }, invalidResponse);
    assert.strictEqual(invalidResponse.statusCode, 400);
    assert.strictEqual(lookups, 0);
  }

  let stripeCalls = 0;
  const legacyRefundedResponse = makeResponse();
  await buildRefundPaidOrderController({
    getPaidOrderForRefund: async () => [{
      id: 42,
      shopid: 7,
      payment_status: "refunded",
      payment_record_status: "refunded",
      stripe_payment_intent_id: "pi_42",
      stripe_refund_id: null,
      refund_status: "succeeded",
    }],
    getStripe: () => {
      stripeCalls += 1;
      throw new Error("Stripe must not be called for a legacy terminal refund");
    },
  })({ params: { id: "42" }, shopid: 7 }, legacyRefundedResponse);
  assert.strictEqual(stripeCalls, 0);
  assert.strictEqual(legacyRefundedResponse.statusCode, 200);
  assert.deepStrictEqual(legacyRefundedResponse.payload.data, {
    refundId: null,
    refundStatus: "succeeded",
    already_refunded: true,
  });

  const legacyRow = {
    id: 42,
    shopid: 7,
    payment_status: "refunded",
    payment_record_status: "refunded",
    stripe_payment_intent_id: "pi_42",
    stripe_charge_id: null,
    amount_cents: 2300,
    stripe_refund_id: null,
    refund_status: "legacy_unknown",
  };
  const legacyIdResponse = makeResponse();
  let legacyIdCreates = 0;
  await buildRefundPaidOrderController({
    getPaidOrderForRefund: async () => [{
      ...legacyRow,
      stripe_refund_id: "re_legacy",
    }],
    getStripe: () => ({
      refunds: {
        create: async () => { legacyIdCreates += 1; },
        retrieve: async () => ({
          id: "re_legacy",
          status: "pending",
          amount: 2300,
          payment_intent: "pi_42",
        }),
      },
    }),
    recordRefundState: async ({ refund }) => ({
      status: refund.status,
      business_status_unchanged: true,
      order_status: ORDER_STATUSES.CANCELED,
    }),
  })({ params: { id: "42" }, shopid: 7 }, legacyIdResponse);
  assert.strictEqual(legacyIdCreates, 0);
  assert.strictEqual(legacyIdResponse.payload.data.refundStatus, "pending");
  assert.strictEqual(legacyIdResponse.payload.data.business_status_unchanged, true);

  for (const currentStatus of ["failed", "succeeded"]) {
    const currentResponse = makeResponse();
    await buildRefundPaidOrderController({
      getPaidOrderForRefund: async () => [{
        ...legacyRow,
        stripe_refund_id: "re_legacy",
      }],
      getStripe: () => ({
        refunds: {
          create: async () => {
            throw new Error("legacy_unknown must never create a refund");
          },
          retrieve: async () => ({
            id: "re_legacy",
            status: currentStatus,
            amount: 2300,
            payment_intent: "pi_42",
          }),
        },
      }),
      recordRefundState: async ({ refund }) => ({ status: refund.status }),
    })({ params: { id: "42" }, shopid: 7 }, currentResponse);
    assert.strictEqual(currentResponse.payload.data.refundStatus, currentStatus);
  }

  const legacyListCalls = [];
  const legacyListResponse = makeResponse();
  await buildRefundPaidOrderController({
    getPaidOrderForRefund: async () => [legacyRow],
    getStripe: () => ({
      refunds: {
        create: async () => {
          throw new Error("legacy_unknown must never create a refund");
        },
        list: async (params) => {
          legacyListCalls.push(params);
          return {
            data: [{
              id: "re_listed",
              status: "failed",
              failure_reason: "declined",
              amount: 2300,
              payment_intent: "pi_42",
              metadata: {},
            }],
          };
        },
      },
    }),
    recordRefundState: async ({ refund }) => ({
      status: refund.status,
      business_status_unchanged: true,
      order_status: ORDER_STATUSES.CANCELED,
    }),
  })({ params: { id: "42" }, shopid: 7 }, legacyListResponse);
  assert.deepStrictEqual(legacyListCalls, [{
    payment_intent: "pi_42",
    limit: 100,
  }]);
  assert.strictEqual(legacyListResponse.payload.data.refundId, "re_listed");
  assert.strictEqual(legacyListResponse.payload.data.refundStatus, "failed");

  for (const refunds of [
    [],
    [
      { id: "re_1", status: "pending", amount: 2300, payment_intent: "pi_42" },
      { id: "re_2", status: "pending", amount: 2300, payment_intent: "pi_42" },
    ],
  ]) {
    const ambiguousResponse = makeResponse();
    await buildRefundPaidOrderController({
      getPaidOrderForRefund: async () => [legacyRow],
      getStripe: () => ({
        refunds: {
          create: async () => {
            throw new Error("legacy_unknown must never create a refund");
          },
          list: async () => ({ data: refunds }),
        },
      }),
    })({ params: { id: "42" }, shopid: 7 }, ambiguousResponse);
    assert.strictEqual(ambiguousResponse.statusCode, 409);
    assert.strictEqual(ambiguousResponse.payload.data.refundStatus, "legacy_unknown");
    assert.strictEqual(ambiguousResponse.payload.data.manual_review_required, true);
  }

  for (const listed of [
    {
      has_more: true,
      data: [{ id: "re_visible", status: "pending", amount: 2300, payment_intent: "pi_42" }],
    },
    {
      has_more: false,
      data: [
        {
          id: "re_exact",
          status: "pending",
          amount: 2300,
          payment_intent: "pi_42",
          metadata: { order_id: "42", shop_id: "7" },
        },
        { id: "re_other", status: "pending", amount: 2300, payment_intent: "pi_42" },
      ],
    },
  ]) {
    const responseWithUnsafeList = makeResponse();
    await buildRefundPaidOrderController({
      getPaidOrderForRefund: async () => [legacyRow],
      getStripe: () => ({
        refunds: {
          create: async () => {
            throw new Error("legacy_unknown must never create a refund");
          },
          list: async () => listed,
        },
      }),
    })({ params: { id: "42" }, shopid: 7 }, responseWithUnsafeList);
    assert.strictEqual(responseWithUnsafeList.statusCode, 409);
    assert.strictEqual(
      responseWithUnsafeList.payload.data.manual_review_required,
      true,
    );
  }

  const succeededReplayCalls = [];
  const succeededReplayResponse = makeResponse();
  await buildRefundPaidOrderController({
    getPaidOrderForRefund: async () => [{
      id: 42,
      shopid: 7,
      payment_status: "refunded",
      payment_record_status: "refunded",
      stripe_payment_intent_id: "pi_42",
      stripe_refund_id: "re_succeeded",
      refund_status: "succeeded",
    }],
    getStripe: () => ({
      refunds: {
        create: async () => {
          throw new Error("must never recreate an already-succeeded refund");
        },
        retrieve: async (refundId) => {
          succeededReplayCalls.push(["retrieve", refundId]);
          return { id: refundId, status: "succeeded", payment_intent: "pi_42" };
        },
      },
    }),
    recordRefundState: async (input) => {
      succeededReplayCalls.push(["record", input.orderId, input.refund.id]);
      return { status: "succeeded", idempotent_replay: true };
    },
  })({ params: { id: "42" }, shopid: 7 }, succeededReplayResponse);
  assert.deepStrictEqual(succeededReplayCalls, [
    ["retrieve", "re_succeeded"],
    ["record", 42, "re_succeeded"],
  ]);
  assert.deepStrictEqual(succeededReplayResponse.payload.data, {
    refundId: "re_succeeded",
    refundStatus: "succeeded",
    already_refunded: true,
  });

  let stateRead = 0;
  const failedRaceResponse = makeResponse();
  await buildRefundPaidOrderController({
    getPaidOrderForRefund: async () => {
      stateRead += 1;
      if (stateRead === 1) {
        return [{
          id: 42,
          shopid: 7,
          payment_status: "paid",
          payment_record_status: "succeeded",
          stripe_payment_intent_id: "pi_42",
          stripe_refund_id: null,
        }];
      }
      return [{
        id: 42,
        shopid: 7,
        payment_status: "paid",
        payment_record_status: "succeeded",
        stripe_payment_intent_id: "pi_42",
        stripe_refund_id: "re_42",
        refund_status: "failed",
        refund_failure_reason: "expired_or_canceled_card",
      }];
    },
    getStripe: () => ({
      refunds: {
        create: async () => ({ id: "re_42", status: "pending" }),
      },
    }),
    recordRefundState: async () => ({ ignored: true }),
  })({ params: { id: "42" }, shopid: 7 }, failedRaceResponse);
  assert.strictEqual(stateRead, 2);
  assert.strictEqual(failedRaceResponse.payload.data.refundStatus, "failed");
  assert.notStrictEqual(failedRaceResponse.payload.message, "Commande remboursee.");

  const failureController = buildRefundPaidOrderController({
    getPaidOrderForRefund: async () => [{
      stripe_payment_intent_id: "pi_42",
      stripe_refund_id: null,
    }],
    getStripe: () => ({
      refunds: {
        create: async () => {
          throw new Error("sk_test_must_not_be_exposed");
        },
      },
    }),
  });
  const failureResponse = makeResponse();
  await failureController({ params: { id: "42" }, shopid: 7 }, failureResponse);
  assert.strictEqual(failureResponse.statusCode, 500);
  assert.ok(!JSON.stringify(failureResponse.payload).includes("sk_test"));
};

const runRefundMigrationContract = async () => {
  const fs = require("fs");
  const path = require("path");
  const migrationPath = path.join(
    __dirname,
    "../db/migrations/20260726190000_payment_refund_lifecycle.sql",
  );
  assert.strictEqual(fs.existsSync(migrationPath), true);
  const migration = fs.readFileSync(migrationPath, "utf8");
  const [up, down] = migration.split("-- migrate:down");
  assert.match(up, /ADD COLUMN `stripe_refund_id` varchar\(191\) DEFAULT NULL/);
  assert.match(up, /ADD COLUMN `refund_status` varchar\(32\) DEFAULT NULL/);
  assert.match(up, /ADD COLUMN `refund_failure_reason` varchar\(191\) DEFAULT NULL/);
  assert.match(up, /ADD UNIQUE KEY `stripe_refund_id` \(`stripe_refund_id`\)/);
  assert.match(
    up,
    /UPDATE `payments`[\s\S]*SET `refund_status` = 'legacy_unknown'[\s\S]*WHERE `status` = 'refunded'[\s\S]*AND `refunded_at` IS NOT NULL/,
  );
  assert.doesNotMatch(up, /SET `refund_status` = 'succeeded'/);
  assert.match(
    up,
    /SET `stripe_refund_id` = `stripe_charge_id`,[\s\S]*`stripe_charge_id` = NULL[\s\S]*`stripe_charge_id` LIKE 're/,
  );
  assert.ok(
    up.indexOf("ADD UNIQUE KEY `stripe_refund_id`")
      > up.indexOf("SET `stripe_refund_id` = `stripe_charge_id`"),
  );
  assert.match(down, /DROP INDEX `stripe_refund_id`/);
  assert.match(down, /DROP COLUMN `refund_failure_reason`/);
  assert.match(down, /DROP COLUMN `refund_status`/);
  assert.match(down, /DROP COLUMN `stripe_refund_id`/);
  assert.match(
    down,
    /SET `stripe_charge_id` = `stripe_refund_id`[\s\S]*`stripe_charge_id` IS NULL/,
  );
  const downRestore = down.match(/UPDATE `payments`([\s\S]*?)ALTER TABLE `payments`/);
  assert.ok(downRestore);
  assert.doesNotMatch(downRestore[1], /refund_status/);
  assert.ok(
    down.indexOf("DROP INDEX `stripe_refund_id`")
      < down.indexOf("DROP COLUMN `stripe_refund_id`"),
  );
  assert.ok(
    down.indexOf("DROP INDEX `stripe_refund_id`")
      < down.indexOf("SET `stripe_charge_id` = `stripe_refund_id`"),
  );

  const paymentSource = fs.readFileSync(
    require.resolve("../src/modules/m_payments"),
    "utf8",
  );
  assert.doesNotMatch(
    paymentSource,
    /stripe_charge_id\s*=\s*COALESCE\(stripe_charge_id,\s*\?\)/,
  );
  assert.match(paymentSource, /SET stripe_refund_id = \?/);
  assert.match(
    paymentSource,
    /getPaidOrderForRefund:[\s\S]*payments\.stripe_payment_intent_id = orders\.stripe_payment_intent_id[\s\S]*payments\.status IN \('succeeded', 'refunded'\)/,
  );
  assert.match(
    paymentSource,
    /\(orders\.payment_status = 'paid' AND payments\.status = 'succeeded'\)[\s\S]*OR \(orders\.payment_status = 'refunded' AND payments\.status = 'refunded'\)/,
  );
  assert.match(
    paymentSource,
    /findPaymentForOrderRefund:[\s\S]*stripe_payment_intent_id = \?[\s\S]*status IN \('succeeded', 'refunded'\)[\s\S]*FOR UPDATE/,
  );
};

const runStripePaymentMaintenanceContracts = async () => {
  const buildHarness = ({
    rows,
    retrieve,
    cancel,
    retrieveCharge,
  }) => {
    const events = [];
    const errors = [];
    let genericReleaseCount = 0;
    const stripe = {
      paymentIntents: {
        retrieve: async (paymentIntentId) => {
          events.push(["retrieve", paymentIntentId]);
          return retrieve(paymentIntentId);
        },
        cancel: async (paymentIntentId) => {
          events.push(["cancel", paymentIntentId]);
          return cancel(paymentIntentId);
        },
      },
      charges: {
        retrieve: async (chargeId) => {
          events.push(["retrieve-charge", chargeId]);
          return retrieveCharge(chargeId);
        },
      },
    };
    const runMaintenance = buildStripePaymentMaintenance({
      findExpiredStripePayments: async (now) => {
        events.push(["scan", now]);
        return rows;
      },
      getStripe: () => stripe,
      markPaymentSucceeded: async (paymentIntent, charge) => {
        events.push(["mark-succeeded", paymentIntent.id, charge && charge.id]);
      },
      markPaymentCanceled: async (paymentIntentId) => {
        events.push(["mark-canceled", paymentIntentId]);
      },
      cancelOrphanedProvisionalStripeOrder: async (orderId, shopId) => {
        events.push(["cancel-orphaned", orderId, shopId]);
      },
      releaseExpiredReservations: async () => {
        genericReleaseCount += 1;
        events.push(["release-generic"]);
      },
      logger: {
        info: (...args) => events.push(["info", ...args]),
        error: (...args) => errors.push(args),
      },
      now: () => "2026-07-24 12:00:00",
    });
    return {
      errors,
      events,
      getGenericReleaseCount: () => genericReleaseCount,
      runMaintenance,
    };
  };

  let harness = buildHarness({
    rows: [{
      order_id: 41,
      shop_id: 7,
      stripe_payment_intent_id: "pi_cancel",
    }],
    retrieve: async (paymentIntentId) => ({
      id: paymentIntentId,
      status: "requires_payment_method",
      latest_charge: null,
    }),
    cancel: async (paymentIntentId) => ({
      id: paymentIntentId,
      status: "canceled",
    }),
    retrieveCharge: async () => {
      throw new Error("unexpected charge retrieval");
    },
  });
  await harness.runMaintenance();
  assert.deepStrictEqual(harness.events, [
    ["scan", "2026-07-24 12:00:00"],
    ["retrieve", "pi_cancel"],
    ["cancel", "pi_cancel"],
    ["mark-canceled", "pi_cancel"],
    ["release-generic"],
  ]);
  assert.strictEqual(harness.getGenericReleaseCount(), 1);

  harness = buildHarness({
    rows: [{
      order_id: 42,
      shop_id: 7,
      stripe_payment_intent_id: "pi_succeeded",
    }],
    retrieve: async (paymentIntentId) => ({
      id: paymentIntentId,
      status: "succeeded",
      latest_charge: "ch_succeeded",
    }),
    cancel: async () => {
      throw new Error("succeeded payments must never be canceled");
    },
    retrieveCharge: async (chargeId) => ({
      id: chargeId,
      payment_method_details: { type: "card" },
    }),
  });
  await harness.runMaintenance();
  assert.deepStrictEqual(harness.events, [
    ["scan", "2026-07-24 12:00:00"],
    ["retrieve", "pi_succeeded"],
    ["retrieve-charge", "ch_succeeded"],
    ["mark-succeeded", "pi_succeeded", "ch_succeeded"],
    ["release-generic"],
  ]);

  harness = buildHarness({
    rows: [{
      order_id: 43,
      shop_id: 7,
      stripe_payment_intent_id: "pi_processing",
    }],
    retrieve: async (paymentIntentId) => ({
      id: paymentIntentId,
      status: "processing",
      latest_charge: null,
    }),
    cancel: async () => {
      throw new Error("processing payments must never be canceled");
    },
    retrieveCharge: async () => {
      throw new Error("processing payments have no charge");
    },
  });
  await harness.runMaintenance();
  assert.strictEqual(
    harness.events.some(([event]) => ["cancel", "mark-canceled", "mark-succeeded"].includes(event)),
    false,
  );
  assert.strictEqual(harness.events.at(-1)[0], "release-generic");
  assert.strictEqual(harness.getGenericReleaseCount(), 1);

  harness = buildHarness({
    rows: [
      {
        order_id: 44,
        shop_id: 7,
        stripe_payment_intent_id: "pi_retrieve_error",
      },
      {
        order_id: 45,
        shop_id: 7,
        stripe_payment_intent_id: "pi_cancel_error",
      },
      {
        order_id: 46,
        shop_id: 8,
        stripe_payment_intent_id: "pi_already_canceled",
      },
    ],
    retrieve: async (paymentIntentId) => {
      if (paymentIntentId === "pi_retrieve_error") {
        const error = new Error("Stripe unavailable");
        error.secret = "sk_test_must_not_be_logged";
        throw error;
      }
      return {
        id: paymentIntentId,
        status: paymentIntentId === "pi_already_canceled"
          ? "canceled"
          : "requires_confirmation",
        latest_charge: null,
      };
    },
    cancel: async (paymentIntentId) => {
      if (paymentIntentId === "pi_cancel_error") {
        const error = new Error("Cancellation unavailable");
        error.secret = "sk_test_must_not_be_logged";
        throw error;
      }
      return { id: paymentIntentId, status: "canceled" };
    },
    retrieveCharge: async () => null,
  });
  await harness.runMaintenance();
  assert.deepStrictEqual(
    harness.events.filter(([event]) => event === "mark-canceled"),
    [["mark-canceled", "pi_already_canceled"]],
    "orders after failed Stripe calls are still processed independently",
  );
  assert.strictEqual(harness.errors.length, 2);
  assert.ok(harness.errors.every((args) => !JSON.stringify(args).includes("sk_test")));
  assert.ok(harness.errors.every((args) => JSON.stringify(args).includes("order_id")));
  assert.strictEqual(harness.getGenericReleaseCount(), 1);

  harness = buildHarness({
    rows: [{
      order_id: 47,
      shop_id: 8,
      stripe_payment_intent_id: "pi_bad_cancel_response",
    }],
    retrieve: async (paymentIntentId) => ({
      id: paymentIntentId,
      status: "requires_action",
      latest_charge: null,
    }),
    cancel: async (paymentIntentId) => ({
      id: paymentIntentId,
      status: "requires_action",
    }),
    retrieveCharge: async () => null,
  });
  await harness.runMaintenance();
  assert.strictEqual(
    harness.events.some(([event]) => event === "mark-canceled"),
    false,
    "local stock remains reserved until Stripe confirms cancellation",
  );
  assert.strictEqual(harness.errors.length, 1);
  assert.strictEqual(harness.getGenericReleaseCount(), 1);

  harness = buildHarness({
    rows: [{
      order_id: 48,
      shop_id: 8,
      stripe_payment_intent_id: null,
    }],
    retrieve: async () => {
      throw new Error("Stripe must not be called for an orphan order");
    },
    cancel: async () => {
      throw new Error("Stripe must not be called for an orphan order");
    },
    retrieveCharge: async () => null,
  });
  await harness.runMaintenance();
  assert.deepStrictEqual(harness.events, [
    ["scan", "2026-07-24 12:00:00"],
    ["cancel-orphaned", 48, 8],
    ["release-generic"],
  ]);
  assert.deepStrictEqual(harness.errors, []);
};

const runNonOverlappingRunnerContract = async () => {
  const taskResolvers = [];
  let taskCalls = 0;
  const logs = [];
  const run = buildNonOverlappingRunner(
    async () => {
      taskCalls += 1;
      return new Promise((resolve) => taskResolvers.push(resolve));
    },
    { info: (...args) => logs.push(args) },
  );

  const firstTick = run();
  const overlappingTick = await run();
  assert.strictEqual(taskCalls, 1);
  assert.deepStrictEqual(overlappingTick, { skipped: true });
  assert.strictEqual(logs.length, 1);

  taskResolvers.shift()("first complete");
  assert.strictEqual(await firstTick, "first complete");

  const nextTick = run();
  assert.strictEqual(taskCalls, 2);
  taskResolvers.shift()("second complete");
  assert.strictEqual(await nextTick, "second complete");
};

const runExpiredStripePaymentQueryContract = async () => {
  const calls = [];
  const rows = [{
    order_id: 42,
    shop_id: 7,
    stripe_payment_intent_id: "pi_42",
  }];
  const payments = buildPaymentModule({
    repository: {
      findExpiredStripePayments: async (options) => {
        calls.push(options);
        return rows;
      },
    },
    now: () => new Date("2026-07-24T12:00:00.000Z"),
  });

  assert.deepStrictEqual(await payments.findExpiredStripePayments(), rows);
  assert.deepStrictEqual(calls[0], { now: "2026-07-24 12:00:00" });
  await payments.findExpiredStripePayments("2026-07-24 13:00:00");
  assert.deepStrictEqual(calls[1], { now: "2026-07-24 13:00:00" });
  await payments.findExpiredStripePayments(new Date("2026-07-24T12:00:00.000Z"));
  assert.deepStrictEqual(calls[2], { now: "2026-07-24 12:00:00" });

  const source = require("fs").readFileSync(
    require.resolve("../src/modules/m_payments"),
    "utf8",
  );
  assert.match(
    source,
    /SELECT DISTINCT orders\.id AS order_id,[\s\S]*orders\.shopid AS shop_id,[\s\S]*COALESCE\(\s*payments\.stripe_payment_intent_id,\s*orders\.stripe_payment_intent_id\s*\)[\s\S]*LEFT JOIN payments[\s\S]*JOIN order_stock_reservations reservations[\s\S]*payment_provider = 'stripe'[\s\S]*payment_status = 'requires_payment'[\s\S]*reservations\.status = 'reserved'[\s\S]*reservations\.expires_at <= \?[\s\S]*ORDER BY orders\.id/,
  );
  assert.match(
    source,
    /updateOrderSucceeded:[\s\S]*paymentIntentId[\s\S]*payment_status = 'requires_payment'[\s\S]*stripe_payment_intent_id = \?/,
  );
  assert.match(
    source,
    /updateOrderTerminal:[\s\S]*paymentIntentId[\s\S]*payment_status = 'requires_payment'[\s\S]*stripe_payment_intent_id = \?/,
  );
  assert.match(
    source,
    /cancelOrphanedProvisionalOrder:[\s\S]*status = \?[\s\S]*payment_status = 'requires_payment'[\s\S]*payment_provider = 'stripe'[\s\S]*stripe_payment_intent_id IS NULL/,
  );
};

const runStaleExpiredStripeIntentContract = async () => {
  const prepareReplacementHarness = () => {
    const harness = makeStripeLifecycleHarness();
    harness.getState().orders[0].stripe_payment_intent_id = "pi_new";
    harness.getState().payments[0].stripe_payment_intent_id = "pi_old";
    harness.getState().payments.push({
      order_id: 42,
      shop_id: 7,
      stripe_payment_intent_id: "pi_new",
      status: "requires_payment_method",
    });
    return harness;
  };
  const assertReplacementUntouched = (harness) => {
    assert.strictEqual(harness.getState().orders[0].payment_status, "requires_payment");
    assert.strictEqual(harness.getState().orders[0].stripe_payment_intent_id, "pi_new");
    assert.strictEqual(harness.getState().reservations[0].status, "reserved");
    assert.strictEqual(harness.getState().products.get(10), 8);
    assert.strictEqual(harness.getState().movements.length, 0);
    assert.strictEqual(
      harness.getState().payments.find(
        (payment) => payment.stripe_payment_intent_id === "pi_new",
      ).status,
      "requires_payment_method",
    );
  };
  const runScan = async (harness, stripeStatus) => buildStripePaymentMaintenance({
    findExpiredStripePayments: async () => [{
      order_id: 42,
      shop_id: 7,
      stripe_payment_intent_id: "pi_old",
    }],
    getStripe: () => ({
      paymentIntents: {
        retrieve: async () => ({
          id: "pi_old",
          status: stripeStatus,
          latest_charge: null,
          payment_method_types: ["card"],
        }),
      },
      charges: { retrieve: async () => null },
    }),
    markPaymentSucceeded: harness.payments.markPaymentSucceeded,
    markPaymentCanceled: harness.payments.markPaymentCanceled,
    releaseExpiredReservations: async () => 0,
    logger: { error: () => {}, info: () => {} },
    now: () => "2026-07-24 12:00:00",
  })();

  let harness = prepareReplacementHarness();
  await runScan(harness, "canceled");
  assertReplacementUntouched(harness);
  assert.strictEqual(
    harness.getState().payments.find(
      (payment) => payment.stripe_payment_intent_id === "pi_old",
    ).status,
    "requires_payment",
  );

  harness = prepareReplacementHarness();
  await runScan(harness, "succeeded");
  assertReplacementUntouched(harness);
  assert.strictEqual(
    harness.getState().payments.find(
      (payment) => payment.stripe_payment_intent_id === "pi_old",
    ).status,
    "requires_payment",
  );
};

runStripePaymentMaintenanceContracts()
  .then(runNonOverlappingRunnerContract)
  .then(runExpiredStripePaymentQueryContract)
  .then(runStaleExpiredStripeIntentContract)
  .then(runSucceededPaymentShopScopeContract)
  .then(runPendingPaymentShopScopeContract)
  .then(runStripeWebhookReconciliationContract)
  .then(runCanceledPaymentUsesSuppliedOrderLockContract)
  .then(runPendingRefundLifecycleContract)
  .then(runPartialRefundDoesNotClaimAssociationContract)
  .then(runCumulativeRefundWebhookLifecycleContract)
  .then(runRefundPaginationContract)
  .then(runSucceededRefundLifecycleContract)
  .then(runFailedRefundLifecycleContract)
  .then(runRefundWebhookLookupContract)
  .then(runRefundControllerContract)
  .then(runRefundMigrationContract)
  .then(runPaymentEditRaceContract)
  .then(runStripeReservationContracts)
  .then(runCashRegisterArchiveContract)
  .then(runStripeCheckoutControllerContracts)
  .then(runStripeCancellationControllerContracts)
  .then(runPayAtCounterIntentRaceContract)
  .then(runReplacementPaymentContracts)
  .then(() => console.log("stripePayment tests passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
