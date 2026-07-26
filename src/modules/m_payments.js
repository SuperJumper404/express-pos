const crypto = require("crypto");
const pool = require("../config/dbPool");
const { ORDER_STATUSES } = require("../helpers/orderStatus");
const { finalizeReservations } = require("./m_checkout");
const { resolveStripePaymentMethod } = require("../helpers/stripePaymentMethod");
const { withTransaction } = require("../helpers/withTransaction");

const formatDate = (value) => value.toISOString().slice(0, 19).replace("T", " ");
const SQL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const normalizeSqlTimestamp = (value) => {
  if (typeof value === "string" && SQL_TIMESTAMP_PATTERN.test(value)) return value;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid payment timestamp");
  return formatDate(date);
};

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

  lockOrderReservations: ({ orderId, connection }) => queryResult(
    connection,
    `SELECT id, order_id, status
     FROM order_stock_reservations
     WHERE order_id = ?
     ORDER BY id
     FOR UPDATE`,
    [orderId],
  ),

  getPaidOrderForRefund: ({ orderId, shopId, connection }) => queryResult(
    connection,
    `SELECT orders.*, payments.stripe_payment_intent_id,
            payments.stripe_charge_id,
            payments.stripe_refund_id,
            payments.refund_status,
            payments.refund_failure_reason,
            payments.amount_cents,
            payments.status AS payment_record_status
     FROM orders
     JOIN payments
       ON payments.order_id = orders.id
      AND payments.stripe_payment_intent_id = orders.stripe_payment_intent_id
      AND payments.status IN ('succeeded', 'refunded')
     WHERE orders.id = ?
       AND orders.shopid = ?
       AND (
         (orders.payment_status = 'paid' AND payments.status = 'succeeded')
         OR (orders.payment_status = 'refunded' AND payments.status = 'refunded')
       )
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
     JOIN payments
       ON payments.order_id = orders.id
      AND payments.stripe_payment_intent_id = orders.stripe_payment_intent_id
     WHERE orders.id = ?
       AND orders.shopid = ?
       AND orders.payment_status = 'requires_payment'
       AND orders.payment_provider = 'stripe'
     LIMIT 1`,
    [orderId, shopId],
  ),

  findPaymentForOrderRefund: ({
    orderId, shopId, paymentIntentId, connection,
  }) => queryResult(
    connection,
    `SELECT * FROM payments
     WHERE order_id = ?
       AND shop_id = ?
       AND stripe_payment_intent_id = ?
       AND status IN ('succeeded', 'refunded')
     LIMIT 1${connection ? " FOR UPDATE" : ""}`,
    [orderId, shopId, paymentIntentId],
  ).then((rows) => rows[0] || null),

  findPaymentsForRefund: ({ refund, connection }) => {
    const chargeId = typeof refund.charge === "string"
      ? refund.charge
      : refund.charge && refund.charge.id;
    return queryResult(
      connection,
      `SELECT * FROM payments
       WHERE (? IS NOT NULL AND stripe_refund_id = ?)
          OR (? IS NOT NULL AND stripe_payment_intent_id = ?)
          OR (? IS NOT NULL AND stripe_charge_id = ?)
       ${connection ? "FOR UPDATE" : ""}`,
      [
        refund.id || null,
        refund.id || null,
        refund.payment_intent || null,
        refund.payment_intent || null,
        chargeId || null,
        chargeId || null,
      ],
    );
  },

  findExpiredStripePayments: ({ now, connection }) => queryResult(
    connection,
    `SELECT DISTINCT orders.id AS order_id,
            orders.shopid AS shop_id,
            COALESCE(
              payments.stripe_payment_intent_id,
              orders.stripe_payment_intent_id
            ) AS stripe_payment_intent_id
     FROM orders
     LEFT JOIN payments
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
    orderId, shopId, paymentIntentId, paymentMethod, timestamp, connection,
  }) => queryResult(
    connection,
    `UPDATE orders
     SET payment_status = 'paid',
         payment = ?,
         finished = ?
     WHERE id = ?
       AND shopid = ?
       AND payment_status = 'requires_payment'
       AND stripe_payment_intent_id = ?`,
    [paymentMethod, timestamp, orderId, shopId, paymentIntentId],
  ),

  updatePaymentTerminal: ({ paymentIntentId, status, timestamp, connection }) => queryResult(
    connection,
    `UPDATE payments
     SET status = ?, updated = ?
     WHERE stripe_payment_intent_id = ?`,
    [status, timestamp, paymentIntentId],
  ),

  updateOrderTerminal: ({
    orderId, shopId, paymentIntentId, status, connection,
  }) => queryResult(
    connection,
    `UPDATE orders
     SET payment_status = ?
     WHERE id = ?
       AND shopid = ?
       AND payment_status = 'requires_payment'
       AND stripe_payment_intent_id = ?`,
    [status, orderId, shopId, paymentIntentId],
  ),

  updatePaymentAtCounter: ({
    orderId, paymentIntentId, timestamp, connection,
  }) => queryResult(
    connection,
    `UPDATE payments
     SET status = 'canceled', updated = ?
     WHERE order_id = ?
       AND stripe_payment_intent_id = ?`,
    [timestamp, orderId, paymentIntentId],
  ),

  updateOrderAtCounter: ({
    orderId, shopId, paymentIntentId, timestamp, connection,
  }) => queryResult(
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
       AND payment_provider = 'stripe'
       AND stripe_payment_intent_id = ?`,
    [timestamp, orderId, shopId, paymentIntentId],
  ),

  cancelPaymentsForOrder: ({
    orderId, paymentIntentId, timestamp, connection,
  }) => queryResult(
    connection,
    `UPDATE payments
     SET status = 'canceled', updated = ?
     WHERE order_id = ?
       AND stripe_payment_intent_id <=> ?
       AND status <> 'succeeded'`,
    [timestamp, orderId, paymentIntentId],
  ),

  cancelProvisionalOrder: ({
    orderId, shopId, paymentIntentId, timestamp, connection,
  }) => queryResult(
    connection,
    `UPDATE orders
     SET payment_status = 'canceled', status = ?, finished = ?
     WHERE id = ?
       AND shopid = ?
       AND payment_status = 'requires_payment'
       AND payment_provider = 'stripe'
       AND stripe_payment_intent_id <=> ?`,
    [ORDER_STATUSES.CANCELED, timestamp, orderId, shopId, paymentIntentId],
  ),

  cancelOrphanedProvisionalOrder: ({
    orderId, shopId, timestamp, connection,
  }) => queryResult(
    connection,
    `UPDATE orders
     SET payment_status = 'canceled', status = ?, finished = ?
     WHERE id = ?
       AND shopid = ?
       AND status = ?
       AND payment_status = 'requires_payment'
       AND payment_provider = 'stripe'
       AND stripe_payment_intent_id IS NULL`,
    [ORDER_STATUSES.CANCELED, timestamp, orderId, shopId, ORDER_STATUSES.PENDING],
  ),

  updatePaymentRefundState: ({
    paymentId,
    orderId,
    shopId,
    paymentIntentId,
    refundId,
    refundStatus,
    failureReason,
    paymentStatus,
    refundedAt,
    timestamp,
    connection,
  }) => queryResult(
    connection,
    `UPDATE payments
     SET stripe_refund_id = ?,
         refund_status = ?,
         refund_failure_reason = ?,
         status = ?,
         refunded_at = ?,
         updated = ?
     WHERE id = ?
       AND order_id = ?
       AND shop_id = ?
       AND stripe_payment_intent_id = ?`,
    [
      refundId,
      refundStatus,
      failureReason,
      paymentStatus,
      refundedAt,
      timestamp,
      paymentId,
      orderId,
      shopId,
      paymentIntentId,
    ],
  ),

  updateOrderRefunded: ({ orderId, shopId, connection }) => queryResult(
    connection,
    `UPDATE orders
     SET payment_status = 'refunded', status = ?
     WHERE id = ?
       AND shopid = ?
       AND payment_status = 'paid'
       AND payment_provider = 'stripe'`,
    [ORDER_STATUSES.CANCELED, orderId, shopId],
  ),

  updateOrderRefundNonFinal: ({ orderId, shopId, connection }) => queryResult(
    connection,
    `UPDATE orders
     SET payment_status = 'paid'
     WHERE id = ?
       AND shopid = ?
       AND payment_status = 'refunded'
       AND payment_provider = 'stripe'`,
    [orderId, shopId],
  ),

  backfillRefundCharge: ({
    paymentId, orderId, shopId, paymentIntentId, chargeId, connection,
  }) => queryResult(
    connection,
    `UPDATE payments
     SET stripe_charge_id = ?
     WHERE id = ?
       AND order_id = ?
       AND shop_id = ?
       AND stripe_payment_intent_id = ?
       AND stripe_charge_id IS NULL`,
    [chargeId, paymentId, orderId, shopId, paymentIntentId],
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
    repository.findExpiredStripePayments({ now: normalizeSqlTimestamp(currentTimestamp) })
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
      if (order.stripe_payment_intent_id !== paymentIntentId) {
        return { ignored: true, stale_intent: true };
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
        paymentIntentId,
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
    if (order.stripe_payment_intent_id !== paymentIntentId) {
      return { ignored: true, stale_intent: true };
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
      paymentIntentId,
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
      const reservations = await repository.lockOrderReservations({
        orderId: data.orderId,
        connection,
      });
      if (!reservations.length
        || reservations.some((reservation) => reservation.status !== "reserved")) {
        return { attached: false, reservations_unavailable: true };
      }
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

  const markStripeOrderPayAtCounter = (
    orderId,
    shopId,
    paymentIntentId,
  ) => runInTransaction(
    async (connection) => {
      const order = await repository.lockOrder({ orderId, shopId, connection });
      if (!order) throw new Error("Commande introuvable");
      if (order.payment_status === "unpaid" && !order.payment_provider) {
        return { orderId: Number(orderId), alreadyUpdated: true };
      }
      if (order.payment_status !== "requires_payment" || order.payment_provider !== "stripe") {
        throw new Error("Commande Stripe en attente introuvable");
      }
      if (order.stripe_payment_intent_id !== paymentIntentId) {
        return { ignored: true, stale_intent: true };
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
        paymentIntentId,
        timestamp: currentTimestamp,
        connection,
      });
      const result = await repository.updateOrderAtCounter({
        orderId: order.id,
        shopId,
        paymentIntentId,
        timestamp: currentTimestamp,
        connection,
      });
      if (!result.affectedRows) throw new Error("Commande Stripe en attente introuvable");
      return { orderId: Number(orderId) };
    },
  );

  const cancelProvisionalStripeOrder = (
    orderId,
    shopId,
    paymentIntentId,
  ) => runInTransaction(
    async (connection) => {
      const order = await repository.lockOrder({ orderId, shopId, connection });
      if (!order) return { missing: true };
      if (order.payment_status !== "requires_payment" || order.payment_provider !== "stripe") {
        return { ignored: true };
      }
      if (order.stripe_payment_intent_id !== paymentIntentId) {
        return { ignored: true, stale_intent: true };
      }

      await settleReservations({
        orderId: order.id,
        status: "released",
        connection,
      });
      const currentTimestamp = timestamp();
      await repository.cancelPaymentsForOrder({
        orderId: order.id,
        paymentIntentId,
        timestamp: currentTimestamp,
        connection,
      });
      await repository.cancelProvisionalOrder({
        orderId: order.id,
        shopId,
        paymentIntentId,
        timestamp: currentTimestamp,
        connection,
      });
      return { canceled: true };
    },
  );

  const cancelOrphanedProvisionalStripeOrder = (orderId, shopId) => runInTransaction(
    async (connection) => {
      const order = await repository.lockOrder({ orderId, shopId, connection });
      if (!order) return { missing: true };
      if (Number(order.status) !== ORDER_STATUSES.PENDING
        || order.payment_status !== "requires_payment"
        || order.payment_provider !== "stripe") {
        return { ignored: true };
      }
      if (order.stripe_payment_intent_id != null) {
        return { ignored: true, stale_scan: true };
      }

      await settleReservations({
        orderId: order.id,
        status: "released",
        connection,
      });
      const currentTimestamp = timestamp();
      await repository.cancelPaymentsForOrder({
        orderId: order.id,
        paymentIntentId: null,
        timestamp: currentTimestamp,
        connection,
      });
      const result = await repository.cancelOrphanedProvisionalOrder({
        orderId: order.id,
        shopId,
        timestamp: currentTimestamp,
        connection,
      });
      if (!result.affectedRows) {
        throw new Error("Orphaned Stripe order changed during cancellation");
      }
      return { canceled: true };
    },
  );

  const refundChargeId = (refund) => (
    typeof refund.charge === "string"
      ? refund.charge
      : refund.charge && refund.charge.id
  );
  const matchesLegacyTerminalReference = (payment, refund) => {
    const chargeId = refundChargeId(refund);
    const refundIdMatches = payment.stripe_refund_id
      && refund.id === payment.stripe_refund_id;
    const externalReferenceMatches = !payment.stripe_refund_id
      && Number(refund.amount) === Number(payment.amount_cents)
      && (
        (refund.payment_intent
          && refund.payment_intent === payment.stripe_payment_intent_id)
        || (chargeId && chargeId === payment.stripe_charge_id)
      );
    return (payment.status === "refunded" || payment.refund_status === "legacy_unknown")
      && (refundIdMatches || externalReferenceMatches);
  };
  const validRefundMetadata = (
    payment,
    refund,
    { requireForNewAssociation = false, order = null } = {},
  ) => {
    const metadata = refund.metadata || {};
    const alreadyAssociated = Boolean(
      refund.id && payment.stripe_refund_id === refund.id,
    );
    const legacyTerminal = matchesLegacyTerminalReference(payment, refund)
      && (!order || order.payment_status === "refunded");
    const matchesNumber = (key, expected) => {
      if (metadata[key] == null || metadata[key] === "") {
        return alreadyAssociated || legacyTerminal || !requireForNewAssociation;
      }
      return /^\d+$/.test(String(metadata[key]))
        && Number(metadata[key]) === Number(expected);
    };
    return matchesNumber("order_id", payment.order_id)
      && matchesNumber("shop_id", payment.shop_id);
  };
  const matchesRefundReferences = (payment, refund, metadataOptions) => {
    const chargeId = refundChargeId(refund);
    if (payment.stripe_refund_id
      && refund.id
      && payment.stripe_refund_id !== refund.id) return false;
    if (refund.payment_intent
      && payment.stripe_payment_intent_id !== refund.payment_intent) return false;
    if (chargeId && payment.stripe_charge_id && payment.stripe_charge_id !== chargeId) {
      return false;
    }
    if (chargeId && !payment.stripe_charge_id) {
      const extractedLegacyRefundMatches = payment.refund_status === "legacy_unknown"
        && payment.stripe_refund_id === refund.id
        && refund.payment_intent === payment.stripe_payment_intent_id;
      if (!extractedLegacyRefundMatches) return false;
    }
    return validRefundMetadata(payment, refund, metadataOptions);
  };
  const selectRefundPayment = (payments, refund, order = null) => {
    const matches = payments.filter((payment) => matchesRefundReferences(
      payment,
      refund,
      { requireForNewAssociation: true, order },
    ));
    return matches.length === 1 ? matches[0] : null;
  };

  const applyRefundState = async ({
    order, payment, refund, connection,
  }) => {
    if (!payment
      || Number(payment.order_id) !== Number(order.id)
      || Number(payment.shop_id) !== Number(order.shopid)
      || order.payment_provider !== "stripe"
      || order.stripe_payment_intent_id !== payment.stripe_payment_intent_id
      || !matchesRefundReferences(payment, refund)) {
      return { ignored: true };
    }
    const cumulativeRefunded = Number(refund.cumulative_amount_refunded);
    const hasAuthoritativeCumulative = refund.cumulative_amount_refunded != null
      && Number.isSafeInteger(cumulativeRefunded)
      && cumulativeRefunded >= 0;
    const cumulativeRefundComplete = hasAuthoritativeCumulative
      && cumulativeRefunded >= Number(payment.amount_cents);
    const individualRefundIsPartial = refund.amount != null
      && Number(refund.amount) !== Number(payment.amount_cents);
    if ((refund.status === "succeeded"
      && hasAuthoritativeCumulative
      && !cumulativeRefundComplete)
      || (individualRefundIsPartial
        && !(refund.status === "succeeded" && cumulativeRefundComplete))) {
      return { ignored: true, partial_refund: true };
    }
    const legacyUnknownState = payment.refund_status === "legacy_unknown"
      || (
        !payment.refund_status
        && !payment.stripe_refund_id
        && payment.status === "refunded"
      );
    const legacyTerminal = legacyUnknownState
      && matchesLegacyTerminalReference(payment, refund)
      && order.payment_status === "refunded";
    const legacyChargeId = refundChargeId(refund);
    if (legacyTerminal && legacyChargeId && !payment.stripe_charge_id) {
      const backfilledCharge = await repository.backfillRefundCharge({
        paymentId: payment.id,
        orderId: payment.order_id,
        shopId: payment.shop_id,
        paymentIntentId: payment.stripe_payment_intent_id,
        chargeId: legacyChargeId,
        connection,
      });
      if (!backfilledCharge.affectedRows) {
        throw new Error("Legacy refund charge backfill failed");
      }
    }
    if (legacyTerminal && refund.status === "succeeded") {
      const updatedPayment = await repository.updatePaymentRefundState({
        paymentId: payment.id,
        orderId: payment.order_id,
        shopId: payment.shop_id,
        paymentIntentId: payment.stripe_payment_intent_id,
        refundId: refund.id,
        refundStatus: "succeeded",
        failureReason: null,
        paymentStatus: "refunded",
        refundedAt: payment.refunded_at,
        timestamp: timestamp(),
        connection,
      });
      if (!updatedPayment.affectedRows) {
        throw new Error("Legacy refund backfill failed");
      }
      return { status: "succeeded", legacy_backfill: true };
    }
    if (legacyTerminal
      && ["pending", "requires_action", "failed", "canceled"].includes(refund.status)) {
      const updatedPayment = await repository.updatePaymentRefundState({
        paymentId: payment.id,
        orderId: payment.order_id,
        shopId: payment.shop_id,
        paymentIntentId: payment.stripe_payment_intent_id,
        refundId: refund.id,
        refundStatus: refund.status,
        failureReason: ["failed", "canceled"].includes(refund.status)
          ? refund.failure_reason || null
          : null,
        paymentStatus: "succeeded",
        refundedAt: null,
        timestamp: timestamp(),
        connection,
      });
      if (!updatedPayment.affectedRows) {
        throw new Error("Legacy refund payment correction failed");
      }
      const updatedOrder = await repository.updateOrderRefundNonFinal({
        orderId: order.id,
        shopId: order.shopid,
        connection,
      });
      if (!updatedOrder.affectedRows) {
        throw new Error("Legacy refund order correction failed");
      }
      return {
        status: refund.status,
        business_status_unchanged: true,
        order_status: order.status,
      };
    }
    if (payment.status === "refunded"
      && payment.refund_status === "succeeded"
      && payment.stripe_refund_id === refund.id
      && order.payment_status === "refunded") {
      return { status: "succeeded", idempotent_replay: true };
    }
    if (payment.refund_status === "succeeded" && refund.status !== "succeeded") {
      return { ignored: true };
    }
    if (["failed", "canceled"].includes(payment.refund_status)
      && ["pending", "requires_action"].includes(refund.status)) {
      return { ignored: true };
    }
    if (payment.status !== "succeeded" || order.payment_status !== "paid") {
      return { ignored: true };
    }
    if (refund.status === "succeeded") {
      const currentTimestamp = timestamp();
      const updatedPayment = await repository.updatePaymentRefundState({
        paymentId: payment.id,
        orderId: payment.order_id,
        shopId: payment.shop_id,
        paymentIntentId: payment.stripe_payment_intent_id,
        refundId: refund.id,
        refundStatus: "succeeded",
        failureReason: null,
        paymentStatus: "refunded",
        refundedAt: currentTimestamp,
        timestamp: currentTimestamp,
        connection,
      });
      if (!updatedPayment.affectedRows) {
        throw new Error("Refund payment transition failed");
      }
      const updatedOrder = await repository.updateOrderRefunded({
        orderId: order.id,
        shopId: order.shopid,
        connection,
      });
      if (!updatedOrder.affectedRows) {
        throw new Error("Refund order transition failed");
      }
      return { status: "succeeded" };
    }
    if (!["pending", "requires_action", "failed", "canceled"].includes(refund.status)) {
      return { ignored: true };
    }
    const failureReason = ["failed", "canceled"].includes(refund.status)
      ? refund.failure_reason || null
      : null;
    const updatedPayment = await repository.updatePaymentRefundState({
      paymentId: payment.id,
      orderId: payment.order_id,
      shopId: payment.shop_id,
      paymentIntentId: payment.stripe_payment_intent_id,
      refundId: refund.id,
      refundStatus: refund.status,
      failureReason,
      paymentStatus: "succeeded",
      refundedAt: null,
      timestamp: timestamp(),
      connection,
    });
    if (!updatedPayment.affectedRows) {
      throw new Error("Refund payment transition failed");
    }
    return { status: refund.status };
  };

  const recordRefundState = ({
    orderId, shopId, refund,
  }) => runInTransaction(async (connection) => {
    const order = await repository.lockOrder({ orderId, shopId, connection });
    if (!order) return { missing: true };
    const payment = await repository.findPaymentForOrderRefund({
      orderId,
      shopId,
      paymentIntentId: order.stripe_payment_intent_id,
      connection,
    });
    return applyRefundState({ order, payment, refund, connection });
  });

  const reconcileStripeRefund = async (refund) => {
    const references = await repository.findPaymentsForRefund({ refund });
    if (!references.length) return { missing: true };
    const reference = selectRefundPayment(references, refund);
    if (!reference) return { ignored: true };

    return runInTransaction(async (connection) => {
      const order = await repository.lockOrder({
        orderId: reference.order_id,
        shopId: reference.shop_id,
        connection,
      });
      if (!order) return { missing: true };
      const lockedReferences = await repository.findPaymentsForRefund({
        refund,
        connection,
      });
      const payment = selectRefundPayment(lockedReferences, refund, order);
      if (!payment) return { ignored: true };
      return applyRefundState({ order, payment, refund, connection });
    });
  };

  return {
    attachPaymentIntentToOrder,
    cancelOrphanedProvisionalStripeOrder,
    cancelProvisionalStripeOrder,
    createPaymentRecord,
    findExpiredStripePayments,
    getPaidOrderForRefund,
    getPendingStripeOrderForCounter,
    getStripeOrderForCancellation,
    markPaymentAttemptFailed,
    markPaymentCanceled,
    markPaymentProcessing,
    markPaymentSucceeded,
    markStripeOrderPayAtCounter,
    persistPaymentIntentForOrder,
    persistReplacementPaymentIntent,
    recordRefundState,
    reconcileStripeRefund,
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
