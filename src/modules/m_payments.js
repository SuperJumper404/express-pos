const crypto = require("crypto");
const pool = require("../config/dbPool");
const { ORDER_STATUSES } = require("../helpers/orderStatus");
const { finalizeReservations } = require("./m_checkout");
const { resolveStripePaymentMethod } = require("../helpers/stripePaymentMethod");
const { withTransaction } = require("../helpers/withTransaction");

const formatDate = (value) => value.toISOString().slice(0, 19).replace("T", " ");

const queryResult = async (connection, sql, values = []) => {
  const [result] = await (connection || pool).query(sql, values);
  return result;
};

const sqlRepository = {
  upsertPaymentRecord: ({ data, connection }) => queryResult(
    connection,
    `INSERT INTO payments SET ?
     ON DUPLICATE KEY UPDATE
       order_id = VALUES(order_id),
       shop_id = VALUES(shop_id),
       amount = VALUES(amount),
       amount_cents = VALUES(amount_cents),
       application_fee_amount = VALUES(application_fee_amount),
       currency = VALUES(currency),
       status = CASE
         WHEN payments.status IN ('succeeded', 'canceled', 'refunded')
           THEN payments.status
         ELSE VALUES(status)
       END`,
    [data],
  ),

  attachPaymentIntentToOrder: ({ orderId, paymentIntentId, connection }) => queryResult(
    connection,
    `UPDATE orders
     SET stripe_payment_intent_id = ?,
         payment_provider = 'stripe'
     WHERE id = ?
       AND payment_status = 'requires_payment'
       AND payment_provider = 'stripe'
       AND (stripe_payment_intent_id IS NULL OR stripe_payment_intent_id = ?)`,
    [paymentIntentId, orderId, paymentIntentId],
  ),

  stagePaymentCanceled: ({ orderId, paymentIntentId, timestamp, connection }) => queryResult(
    connection,
    `UPDATE payments
     SET status = 'canceled', updated = ?
     WHERE order_id = ?
       AND stripe_payment_intent_id = ?
       AND status <> 'succeeded'`,
    [timestamp, orderId, paymentIntentId],
  ),

  stageOrderPaymentReplacement: ({
    orderId, shopId, paymentIntentId, replacementAttemptToken, connection,
  }) => queryResult(
    connection,
    `UPDATE orders
     SET payment_status = 'unpaid',
         stripe_payment_intent_id = NULL,
         stripe_replacement_attempt_token = ?
     WHERE id = ?
       AND shopid = ?
       AND status = ?
       AND payment_status = 'requires_payment'
       AND payment_provider = 'stripe'
       AND stripe_payment_intent_id = ?`,
    [replacementAttemptToken, orderId, shopId, ORDER_STATUSES.PENDING, paymentIntentId],
  ),

  rotatePaymentReplacementAttempt: ({
    orderId, shopId, currentAttemptToken, replacementAttemptToken, connection,
  }) => queryResult(
    connection,
    `UPDATE orders
     SET stripe_replacement_attempt_token = ?
     WHERE id = ?
       AND shopid = ?
       AND status = ?
       AND payment_status = 'unpaid'
       AND payment_provider = 'stripe'
       AND stripe_payment_intent_id IS NULL
       AND stripe_replacement_attempt_token <=> ?`,
    [replacementAttemptToken, orderId, shopId, ORDER_STATUSES.PENDING, currentAttemptToken],
  ),

  attachReplacementPaymentIntent: ({
    orderId, shopId, paymentIntentId, replacementAttemptToken, connection,
  }) => queryResult(
    connection,
    `UPDATE orders
     SET payment_status = 'requires_payment',
         stripe_payment_intent_id = ?
     WHERE id = ?
       AND shopid = ?
       AND status = ?
       AND payment_status = 'unpaid'
       AND payment_provider = 'stripe'
       AND stripe_payment_intent_id IS NULL
       AND stripe_replacement_attempt_token = ?`,
    [paymentIntentId, orderId, shopId, ORDER_STATUSES.PENDING, replacementAttemptToken],
  ),

  findPaymentByIntent: ({ paymentIntentId, connection }) => queryResult(
    connection,
    `SELECT * FROM payments
     WHERE stripe_payment_intent_id = ?
     LIMIT 1${connection ? " FOR UPDATE" : ""}`,
    [paymentIntentId],
  ).then((rows) => rows[0] || null),

  findOrderById: ({ orderId, shopId, connection }) => {
    const shopClause = shopId == null ? "" : " AND shopid = ?";
    const params = shopId == null ? [orderId] : [orderId, shopId];
    return queryResult(
      connection,
      `SELECT * FROM orders
       WHERE id = ?${shopClause}
       LIMIT 1${connection ? " FOR UPDATE" : ""}`,
      params,
    ).then((rows) => rows[0] || null);
  },

  lockOrder: ({ orderId, shopId, connection }) => {
    const shopClause = shopId == null ? "" : " AND shopid = ?";
    const params = shopId == null ? [orderId] : [orderId, shopId];
    return queryResult(
      connection,
      `SELECT * FROM orders
       WHERE id = ?${shopClause}
       LIMIT 1 FOR UPDATE`,
      params,
    ).then((rows) => rows[0] || null);
  },

  getPaidOrderForRefund: ({ orderId, shopId, connection }) => queryResult(
    connection,
    `SELECT orders.*, payments.stripe_payment_intent_id,
            payments.status AS payment_record_status
     FROM orders
     JOIN payments ON payments.order_id = orders.id
     WHERE orders.id = ?
       AND orders.shopid = ?
       AND orders.payment_status = 'paid'
     LIMIT 1`,
    [orderId, shopId],
  ),

  getPendingStripeOrderForCounter: ({ orderId, shopId, connection }) => queryResult(
    connection,
    `SELECT orders.id,
            orders.shopid,
            orders.payment_status,
            payments.stripe_payment_intent_id
     FROM orders
     JOIN payments ON payments.order_id = orders.id
     WHERE orders.id = ?
       AND orders.shopid = ?
       AND orders.payment_status = 'requires_payment'
       AND orders.payment_provider = 'stripe'
     LIMIT 1`,
    [orderId, shopId],
  ),

  findExpiredStripePayments: ({ now, connection }) => queryResult(
    connection,
    `SELECT DISTINCT orders.id AS order_id,
            orders.shopid AS shop_id,
            payments.stripe_payment_intent_id
     FROM orders
     JOIN payments
       ON payments.order_id = orders.id
      AND payments.stripe_payment_intent_id = orders.stripe_payment_intent_id
     JOIN order_stock_reservations reservations
       ON reservations.order_id = orders.id
     WHERE orders.payment_provider = 'stripe'
       AND orders.payment_status = 'requires_payment'
       AND reservations.status = 'reserved'
       AND reservations.expires_at IS NOT NULL
       AND reservations.expires_at <= ?
     ORDER BY orders.id`,
    [now],
  ),

  updatePaymentSucceeded: ({
    paymentIntentId, chargeId, paymentMethod, timestamp, connection,
  }) => queryResult(
    connection,
    `UPDATE payments
     SET status = 'succeeded',
         stripe_charge_id = ?,
         payment_method = ?,
         updated = ?
     WHERE stripe_payment_intent_id = ?`,
    [chargeId, paymentMethod, timestamp, paymentIntentId],
  ),

  updatePaymentPending: ({ paymentIntentId, status, timestamp, connection }) => queryResult(
    connection,
    `UPDATE payments
     SET status = ?, updated = ?
     WHERE stripe_payment_intent_id = ?
       AND status NOT IN ('succeeded', 'canceled', 'refunded')`,
    [status, timestamp, paymentIntentId],
  ),

  updateOrderSucceeded: ({
    orderId, shopId, paymentMethod, timestamp, connection,
  }) => queryResult(
    connection,
    `UPDATE orders
     SET payment_status = 'paid',
         payment = ?,
         finished = ?
     WHERE id = ? AND shopid = ? AND payment_status = 'requires_payment'`,
    [paymentMethod, timestamp, orderId, shopId],
  ),

  updatePaymentTerminal: ({ paymentIntentId, status, timestamp, connection }) => queryResult(
    connection,
    `UPDATE payments
     SET status = ?, updated = ?
     WHERE stripe_payment_intent_id = ?`,
    [status, timestamp, paymentIntentId],
  ),

  updateOrderTerminal: ({ orderId, shopId, status, connection }) => queryResult(
    connection,
    `UPDATE orders
     SET payment_status = ?
     WHERE id = ? AND shopid = ? AND payment_status = 'requires_payment'`,
    [status, orderId, shopId],
  ),

  updatePaymentAtCounter: ({ orderId, timestamp, connection }) => queryResult(
    connection,
    `UPDATE payments
     SET status = 'canceled', updated = ?
     WHERE order_id = ?`,
    [timestamp, orderId],
  ),

  updateOrderAtCounter: ({ orderId, shopId, timestamp, connection }) => queryResult(
    connection,
    `UPDATE orders
     SET status = 1,
         payment_status = 'unpaid',
         payment = 'Paiement au comptoir',
         payment_provider = NULL,
         stripe_payment_intent_id = NULL,
         finished = ?
     WHERE id = ?
       AND shopid = ?
       AND payment_status = 'requires_payment'
       AND payment_provider = 'stripe'`,
    [timestamp, orderId, shopId],
  ),

  cancelPaymentsForOrder: ({ orderId, timestamp, connection }) => queryResult(
    connection,
    `UPDATE payments
     SET status = 'canceled', updated = ?
     WHERE order_id = ? AND status <> 'succeeded'`,
    [timestamp, orderId],
  ),

  cancelProvisionalOrder: ({ orderId, shopId, timestamp, connection }) => queryResult(
    connection,
    `UPDATE orders
     SET payment_status = 'canceled', status = ?, finished = ?
     WHERE id = ?
       AND shopid = ?
       AND payment_status = 'requires_payment'
       AND payment_provider = 'stripe'`,
    [ORDER_STATUSES.CANCELED, timestamp, orderId, shopId],
  ),

  updatePaymentRefunded: ({ orderId, refundId, timestamp, connection }) => queryResult(
    connection,
    `UPDATE payments
     SET status = 'refunded',
         refunded_at = ?,
         updated = ?,
         stripe_charge_id = COALESCE(stripe_charge_id, ?)
     WHERE order_id = ?`,
    [timestamp, timestamp, refundId, orderId],
  ),

  updateOrderRefunded: ({ orderId, connection }) => queryResult(
    connection,
    `UPDATE orders
     SET payment_status = 'refunded', status = ?
     WHERE id = ?`,
    [ORDER_STATUSES.CANCELED, orderId],
  ),
};

const isReservationTransitionError = (error) => (
  error && error.code === "RESERVATION_TRANSITION_INVALID"
);

const buildPaymentModule = ({
  repository = sqlRepository,
  withTransaction: runInTransaction = withTransaction,
  finalizeReservations: settleReservations = finalizeReservations,
  now = () => new Date(),
} = {}) => {
  const timestamp = () => formatDate(now());
  const replacementAttemptToken = () => crypto.randomBytes(32).toString("hex");
  const terminalPaymentStatuses = new Set([
    "succeeded",
    "canceled",
    "refunded",
  ]);

  const paymentRecordData = (data) => ({
    order_id: data.order_id || data.orderId,
    shop_id: data.shop_id || data.shopId,
    stripe_payment_intent_id: data.stripe_payment_intent_id,
    amount: data.amount,
    amount_cents: data.amount_cents,
    application_fee_amount: data.application_fee_amount,
    currency: data.currency || "eur",
    status: data.status,
    created: data.created || timestamp(),
  });

  const createPaymentRecord = (data) => repository.upsertPaymentRecord({
    data: paymentRecordData(data),
  });

  const attachPaymentIntentToOrder = (orderId, paymentIntentId) => (
    repository.attachPaymentIntentToOrder({ orderId, paymentIntentId })
  );

  const persistPaymentIntentForOrder = (data) => runInTransaction(
    async (connection) => {
      const order = await repository.lockOrder({
        orderId: data.orderId,
        shopId: data.shopId,
        connection,
      });
      if (!order) return { attached: false, missing: true };
      const existingPayment = await repository.findPaymentByIntent({
        paymentIntentId: data.stripe_payment_intent_id,
        connection,
      });
      if (order.payment_status !== "requires_payment" || order.payment_provider !== "stripe") {
        return {
          attached: false,
          terminal: true,
          payment_status: order.payment_status,
        };
      }
      if (order.stripe_payment_intent_id
        && order.stripe_payment_intent_id !== data.stripe_payment_intent_id) {
        return {
          attached: false,
          terminal: true,
          payment_status: "payment_intent_already_attached",
        };
      }

      if (existingPayment && terminalPaymentStatuses.has(existingPayment.status)) {
        return {
          attached: false,
          terminal: true,
          payment_status: existingPayment.status,
        };
      }

      if (order.stripe_payment_intent_id !== data.stripe_payment_intent_id) {
        const attachment = await repository.attachPaymentIntentToOrder({
          orderId: data.orderId,
          shopId: data.shopId,
          paymentIntentId: data.stripe_payment_intent_id,
          connection,
        });
        if (!attachment.affectedRows) {
          return {
            attached: false,
            terminal: true,
            payment_status: "order_transitioned",
          };
        }
      }
      await repository.upsertPaymentRecord({
        data: paymentRecordData(data),
        connection,
      });
      return { attached: true };
    },
  );

  const getPaidOrderForRefund = (orderId, shopId) => (
    repository.getPaidOrderForRefund({ orderId, shopId })
  );

  const getPendingStripeOrderForCounter = (orderId, shopId) => (
    repository.getPendingStripeOrderForCounter({ orderId, shopId })
  );

  const findExpiredStripePayments = (currentTimestamp = timestamp()) => (
    repository.findExpiredStripePayments({ now: currentTimestamp })
  );

  const getStripeOrderForCancellation = (orderId, shopId) => (
    repository.findOrderById({ orderId, shopId })
  );

  const markPaymentSucceeded = async (paymentIntent, charge = null) => {
    const paymentIntentId = paymentIntent.id;
    const paymentReference = await repository.findPaymentByIntent({ paymentIntentId });
    if (!paymentReference) throw new Error("Paiement introuvable");

    return runInTransaction(async (connection) => {
      const order = await repository.lockOrder({
        orderId: paymentReference.order_id,
        shopId: paymentReference.shop_id,
        connection,
      });
      if (!order) throw new Error("Commande introuvable");

      const payment = await repository.findPaymentByIntent({
        paymentIntentId,
        connection,
      });
      if (!payment) throw new Error("Paiement introuvable");
      if (Number(payment.order_id) !== Number(order.id)
        || Number(payment.shop_id) !== Number(order.shopid)) {
        throw new Error("Paiement introuvable");
      }
      if (order.payment_status === "paid") return { alreadyPaid: true };
      if (order.payment_status !== "requires_payment") return { ignored: true };

      try {
        await settleReservations({
          orderId: order.id,
          status: "committed",
          operator: order.operator || order.customerID,
          connection,
        });
      } catch (error) {
        if (isReservationTransitionError(error)) return { ignored: true };
        throw error;
      }

      const paymentMethod = resolveStripePaymentMethod({ paymentIntent, charge });
      const currentTimestamp = timestamp();
      await repository.updatePaymentSucceeded({
        paymentIntentId,
        chargeId: paymentIntent.latest_charge || null,
        paymentMethod,
        timestamp: currentTimestamp,
        connection,
      });
      await repository.updateOrderSucceeded({
        orderId: order.id,
        shopId: payment.shop_id,
        paymentMethod,
        timestamp: currentTimestamp,
        connection,
      });
      return { paid: true };
    });
  };

  const markPaymentPending = async (paymentIntentId, status) => {
    const paymentReference = await repository.findPaymentByIntent({ paymentIntentId });
    if (!paymentReference) return { missing: true };

    return runInTransaction(async (connection) => {
      const order = await repository.lockOrder({
        orderId: paymentReference.order_id,
        shopId: paymentReference.shop_id,
        connection,
      });
      if (!order || order.payment_status !== "requires_payment") return { ignored: true };

      const payment = await repository.findPaymentByIntent({
        paymentIntentId,
        connection,
      });
      if (!payment
        || Number(payment.order_id) !== Number(order.id)
        || Number(payment.shop_id) !== Number(order.shopid)) {
        return { missing: true };
      }

      await repository.updatePaymentPending({
        paymentIntentId,
        status,
        timestamp: timestamp(),
        connection,
      });
      return { status };
    });
  };

  const markPaymentAttemptFailed = (paymentIntent) => markPaymentPending(
    paymentIntent.id,
    paymentIntent.status || "requires_payment_method",
  );

  const markPaymentProcessing = (paymentIntentId) => markPaymentPending(
    paymentIntentId,
    "processing",
  );

  const applyPaymentTerminal = async ({
    paymentIntentId, status, connection, lockedOrder,
  }) => {
    const payment = await repository.findPaymentByIntent({
      paymentIntentId,
      connection,
    });
    if (!payment) return { missing: true };
    const order = lockedOrder || await repository.lockOrder({
      orderId: payment.order_id,
      shopId: payment.shop_id,
      connection,
    });
    if (!order) return { missing: true };
    if (Number(order.id) !== Number(payment.order_id)
      || Number(order.shopid) !== Number(payment.shop_id)) {
      return { missing: true };
    }
    if (order.payment_status !== "requires_payment") return { ignored: true };

    try {
      await settleReservations({
        orderId: order.id,
        status: "released",
        connection,
      });
    } catch (error) {
      if (isReservationTransitionError(error)) return { ignored: true };
      throw error;
    }

    const currentTimestamp = timestamp();
    await repository.updatePaymentTerminal({
      paymentIntentId,
      status,
      timestamp: currentTimestamp,
      connection,
    });
    await repository.updateOrderTerminal({
      orderId: order.id,
      shopId: payment.shop_id,
      status,
      connection,
    });
    return { status };
  };

  const markPaymentTerminal = async (
    paymentIntentId,
    status,
    { connection, order } = {},
  ) => {
    if (connection) {
      return applyPaymentTerminal({
        paymentIntentId,
        status,
        connection,
        lockedOrder: order,
      });
    }

    const paymentReference = await repository.findPaymentByIntent({ paymentIntentId });
    if (!paymentReference) return { missing: true };
    return runInTransaction(async (transactionConnection) => {
      const lockedOrder = await repository.lockOrder({
        orderId: paymentReference.order_id,
        shopId: paymentReference.shop_id,
        connection: transactionConnection,
      });
      if (!lockedOrder) return { missing: true };
      return applyPaymentTerminal({
        paymentIntentId,
        status,
        connection: transactionConnection,
        lockedOrder,
      });
    });
  };

  const stagePaymentReplacement = async ({
    orderId, shopId, paymentIntentId, connection,
  }) => {
    if (!connection) throw new Error("Payment replacement requires an active transaction");
    const token = replacementAttemptToken();
    const currentTimestamp = timestamp();
    const payment = await repository.stagePaymentCanceled({
      orderId,
      paymentIntentId,
      timestamp: currentTimestamp,
      connection,
    });
    const order = await repository.stageOrderPaymentReplacement({
      orderId,
      shopId,
      paymentIntentId,
      replacementAttemptToken: token,
      connection,
    });
    return {
      ready: Boolean(payment.affectedRows && order.affectedRows),
      replacement_attempt_token: order.affectedRows ? token : null,
    };
  };

  const rotatePaymentReplacementAttempt = async ({
    orderId, shopId, currentAttemptToken, connection,
  }) => {
    if (!connection) throw new Error("Payment replacement requires an active transaction");
    const token = replacementAttemptToken();
    const result = await repository.rotatePaymentReplacementAttempt({
      orderId,
      shopId,
      currentAttemptToken,
      replacementAttemptToken: token,
      connection,
    });
    return {
      ready: Boolean(result.affectedRows),
      replacement_attempt_token: result.affectedRows ? token : null,
    };
  };

  const persistReplacementPaymentIntent = (data) => runInTransaction(
    async (connection) => {
      if (!data.replacement_attempt_token
        || ["canceled", "succeeded"].includes(data.status)) {
        return { attached: false, terminal_intent: true };
      }
      const order = await repository.lockOrder({
        orderId: data.orderId,
        shopId: data.shopId,
        connection,
      });
      if (!order) return { attached: false, missing: true };
      const existingPayment = await repository.findPaymentByIntent({
        paymentIntentId: data.stripe_payment_intent_id,
        connection,
      });
      if (order.payment_status === "requires_payment"
        && order.payment_provider === "stripe"
        && order.stripe_payment_intent_id === data.stripe_payment_intent_id
        && order.stripe_replacement_attempt_token === data.replacement_attempt_token) {
        if (!existingPayment) {
          await repository.upsertPaymentRecord({
            data: paymentRecordData(data),
            connection,
          });
        }
        return { attached: true, idempotent_replay: true };
      }
      if (order.stripe_replacement_attempt_token !== data.replacement_attempt_token) {
        return { attached: false, stale_attempt: true };
      }
      if (Number(order.status) !== ORDER_STATUSES.PENDING
        || order.payment_status !== "unpaid"
        || order.payment_provider !== "stripe"
        || order.stripe_payment_intent_id != null) {
        return { attached: false, terminal: true, payment_status: order.payment_status };
      }
      const attachment = await repository.attachReplacementPaymentIntent({
        orderId: data.orderId,
        shopId: data.shopId,
        paymentIntentId: data.stripe_payment_intent_id,
        replacementAttemptToken: data.replacement_attempt_token,
        connection,
      });
      if (!attachment.affectedRows) return { attached: false, stale_attempt: true };
      await repository.upsertPaymentRecord({
        data: paymentRecordData(data),
        connection,
      });
      return { attached: true };
    },
  );

  const recoverCanceledEditPayment = ({ orderId, shopId, paymentIntentId }) => (
    runInTransaction(async (connection) => {
      const order = await repository.lockOrder({ orderId, shopId, connection });
      if (!order) return { recovered: false, missing: true };
      if (order.payment_status === "unpaid"
        && order.payment_provider === "stripe"
        && order.stripe_payment_intent_id == null) {
        return { recovered: true, idempotent_replay: true };
      }
      if (Number(order.status) !== ORDER_STATUSES.PENDING
        || order.payment_status !== "requires_payment"
        || order.payment_provider !== "stripe"
        || order.stripe_payment_intent_id !== paymentIntentId) {
        return { recovered: false, terminal: true };
      }
      const staged = await stagePaymentReplacement({
        orderId,
        shopId,
        paymentIntentId,
        connection,
      });
      return { recovered: staged.ready, ...staged };
    })
  );
  const markPaymentCanceled = (paymentIntentId, options) => (
    markPaymentTerminal(paymentIntentId, "canceled", options)
  );

  const markStripeOrderPayAtCounter = (orderId, shopId) => runInTransaction(
    async (connection) => {
      const order = await repository.lockOrder({ orderId, shopId, connection });
      if (!order) throw new Error("Commande introuvable");
      if (order.payment_status === "unpaid" && !order.payment_provider) {
        return { orderId: Number(orderId), alreadyUpdated: true };
      }
      if (order.payment_status !== "requires_payment" || order.payment_provider !== "stripe") {
        throw new Error("Commande Stripe en attente introuvable");
      }

      await settleReservations({
        orderId: order.id,
        status: "committed",
        operator: order.operator || order.customerID,
        connection,
      });
      const currentTimestamp = timestamp();
      await repository.updatePaymentAtCounter({
        orderId: order.id,
        timestamp: currentTimestamp,
        connection,
      });
      const result = await repository.updateOrderAtCounter({
        orderId: order.id,
        shopId,
        timestamp: currentTimestamp,
        connection,
      });
      if (!result.affectedRows) throw new Error("Commande Stripe en attente introuvable");
      return { orderId: Number(orderId) };
    },
  );

  const cancelProvisionalStripeOrder = (orderId, shopId) => runInTransaction(
    async (connection) => {
      const order = await repository.lockOrder({ orderId, shopId, connection });
      if (!order) return { missing: true };
      if (order.payment_status !== "requires_payment" || order.payment_provider !== "stripe") {
        return { ignored: true };
      }

      await settleReservations({
        orderId: order.id,
        status: "released",
        connection,
      });
      const currentTimestamp = timestamp();
      await repository.cancelPaymentsForOrder({
        orderId: order.id,
        timestamp: currentTimestamp,
        connection,
      });
      await repository.cancelProvisionalOrder({
        orderId: order.id,
        shopId,
        timestamp: currentTimestamp,
        connection,
      });
      return { canceled: true };
    },
  );

  const markPaymentRefunded = (orderId, refundId) => runInTransaction(
    async (connection) => {
      const order = await repository.lockOrder({ orderId, connection });
      if (!order) return { missing: true };
      const currentTimestamp = timestamp();
      await repository.updatePaymentRefunded({
        orderId,
        refundId,
        timestamp: currentTimestamp,
        connection,
      });
      return repository.updateOrderRefunded({ orderId, connection });
    },
  );

  return {
    attachPaymentIntentToOrder,
    cancelProvisionalStripeOrder,
    createPaymentRecord,
    findExpiredStripePayments,
    getPaidOrderForRefund,
    getPendingStripeOrderForCounter,
    getStripeOrderForCancellation,
    markPaymentAttemptFailed,
    markPaymentCanceled,
    markPaymentProcessing,
    markPaymentRefunded,
    markPaymentSucceeded,
    markStripeOrderPayAtCounter,
    persistPaymentIntentForOrder,
    persistReplacementPaymentIntent,
    recoverCanceledEditPayment,
    rotatePaymentReplacementAttempt,
    stagePaymentReplacement,
  };
};

const paymentModule = buildPaymentModule();

module.exports = {
  ...paymentModule,
  buildPaymentModule,
};
