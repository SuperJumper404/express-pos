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
         WHEN payments.status IN ('succeeded', 'canceled', 'failed', 'refunded')
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

  updateOrderSucceeded: ({ orderId, paymentMethod, timestamp, connection }) => queryResult(
    connection,
    `UPDATE orders
     SET payment_status = 'paid',
         payment = ?,
         finished = ?
     WHERE id = ? AND payment_status = 'requires_payment'`,
    [paymentMethod, timestamp, orderId],
  ),

  updatePaymentTerminal: ({ paymentIntentId, status, timestamp, connection }) => queryResult(
    connection,
    `UPDATE payments
     SET status = ?, updated = ?
     WHERE stripe_payment_intent_id = ?`,
    [status, timestamp, paymentIntentId],
  ),

  updateOrderTerminal: ({ orderId, status, connection }) => queryResult(
    connection,
    `UPDATE orders
     SET payment_status = ?
     WHERE id = ? AND payment_status = 'requires_payment'`,
    [status, orderId],
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
  const terminalPaymentStatuses = new Set([
    "succeeded",
    "canceled",
    "failed",
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
      const existingPayment = await repository.findPaymentByIntent({
        paymentIntentId: data.stripe_payment_intent_id,
        connection,
      });
      const order = await repository.findOrderById({
        orderId: data.orderId,
        shopId: data.shopId,
        connection,
      });
      if (!order) return { attached: false, missing: true };
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

  const getStripeOrderForCancellation = (orderId, shopId) => (
    repository.findOrderById({ orderId, shopId })
  );

  const markPaymentSucceeded = (paymentIntent, charge = null) => runInTransaction(
    async (connection) => {
      const paymentIntentId = paymentIntent.id;
      const payment = await repository.findPaymentByIntent({
        paymentIntentId,
        connection,
      });
      if (!payment) throw new Error("Paiement introuvable");

      const order = await repository.findOrderById({
        orderId: payment.order_id,
        connection,
      });
      if (!order) throw new Error("Commande introuvable");
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
        paymentMethod,
        timestamp: currentTimestamp,
        connection,
      });
      return { paid: true };
    },
  );

  const markPaymentTerminal = (paymentIntentId, status) => runInTransaction(
    async (connection) => {
      const payment = await repository.findPaymentByIntent({
        paymentIntentId,
        connection,
      });
      if (!payment) return { missing: true };
      const order = await repository.findOrderById({
        orderId: payment.order_id,
        connection,
      });
      if (!order) return { missing: true };
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
        status,
        connection,
      });
      return { status };
    },
  );

  const markPaymentFailed = (paymentIntentId) => (
    markPaymentTerminal(paymentIntentId, "failed")
  );
  const markPaymentCanceled = (paymentIntentId) => (
    markPaymentTerminal(paymentIntentId, "canceled")
  );

  const markStripeOrderPayAtCounter = (orderId, shopId) => runInTransaction(
    async (connection) => {
      const order = await repository.findOrderById({ orderId, shopId, connection });
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
      const order = await repository.findOrderById({ orderId, shopId, connection });
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
    getPaidOrderForRefund,
    getPendingStripeOrderForCounter,
    getStripeOrderForCancellation,
    markPaymentCanceled,
    markPaymentFailed,
    markPaymentRefunded,
    markPaymentSucceeded,
    markStripeOrderPayAtCounter,
    persistPaymentIntentForOrder,
  };
};

const paymentModule = buildPaymentModule();

module.exports = {
  ...paymentModule,
  buildPaymentModule,
};
