const DomainError = require("../helpers/domainError");
const { assertDeliveryOwner, isCourier, forbidden } = require("../helpers/deliveryAuthorization");
const { resolveDeliveryOrder } = require("../modules/m_deliveryOrders");
const { buildDeliveryCheckoutPayments } = require("./deliveryCheckoutPayments");
const { getDefaultPaymentService } = require("../controllers/c_stripeTerminal");
const pool = require("../config/dbPool");

const readAssignedTerminal = async ({ shopId, userId }) => {
  const [rows] = await pool.query(`SELECT u.terminal_requested_at, r.id AS reader_id, r.label
    FROM users u LEFT JOIN stripe_terminal_readers r ON r.shopid=u.shopid AND r.active_assigned_user_id=u.id
    WHERE u.shopid=? AND u.id=? AND u.access=6 AND u.status=1`, [shopId, userId]);
  if (!rows[0]) throw forbidden();
  return { assigned: rows[0].reader_id != null, label: rows[0].label || null, requestedAt: rows[0].terminal_requested_at || null };
};

const requestAssignedTerminal = async ({ shopId, userId }) => {
  await pool.query(`UPDATE users u SET terminal_requested_at=COALESCE(terminal_requested_at,UTC_TIMESTAMP())
    WHERE u.shopid=? AND u.id=? AND u.access=6 AND u.status=1 AND NOT EXISTS (
      SELECT 1 FROM stripe_terminal_readers r WHERE r.shopid=u.shopid AND r.active_assigned_user_id=u.id
    )`, [shopId, userId]);
  return readAssignedTerminal({ shopId, userId });
};

const findTerminalPayment = async ({ shopId, cashierUserId, orderId }) => {
  const [rows] = await pool.query(
    `SELECT p.id FROM stripe_terminal_payment_orders a
     JOIN stripe_terminal_payments p ON p.id=a.terminal_payment_id AND p.shopid=a.shopid
     WHERE a.shopid=? AND a.order_id=? AND p.cashier_user_id=? AND p.payment_kind='order'
       AND p.status IN ('creating','processing') LIMIT 1`,
    [shopId, orderId, cashierUserId],
  );
  return rows[0]?.id;
};

const buildCourierDeliveryPayments = ({
  checkout = buildDeliveryCheckoutPayments(), terminal = getDefaultPaymentService,
  resolve = resolveDeliveryOrder, findPayment = findTerminalPayment,
} = {}) => {
  const payment = async ({ actor, deliveryId, action, method, expectedVersion, attemptId }) => {
    if (!isCourier(actor)) throw forbidden();
    if ((action !== "read" && !["qr", "terminal"].includes(method)) ||
      (action === "start" && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) ||
      (action === "cancel" && (typeof attemptId !== "string" || !/^[a-zA-Z0-9_]{1,191}$/.test(attemptId)))) {
      throw new DomainError(400, "DELIVERY_REQUEST_INVALID", "Demande de paiement invalide.");
    }
    if (method === "qr") return { ...await checkout.courier({ actor, deliveryId, action, expectedVersion, attemptId }), method: "qr" };
    const current = await resolve({ shopId: actor.shopId, deliveryId });
    if (!current) throw new DomainError(404, "DELIVERY_NOT_FOUND", "Livraison introuvable.");
    assertDeliveryOwner(actor, current.delivery);
    if (current.order.payment_status === "paid") return { status: "paid" };
    const scope = { shopId: actor.shopId, cashierUserId: actor.id, orderId: current.order.id };
    const paymentId = await findPayment(scope);
    if (!paymentId && action === "read") {
      if (current.order.payment_status !== "requires_payment") return { status: "idle", method: "qr" };
      return { ...await checkout.courier({ actor, deliveryId, action }), method: "qr" };
    }
    if (!paymentId && action === "cancel") return { status: "idle" };
    try {
      const cancel = action === "cancel" && String(paymentId) === attemptId;
      const result = action === "start"
        ? await terminal().startPayment({ ...scope, orderIds: [scope.orderId], courierDelivery: { id: deliveryId, expectedVersion } })
        : await terminal()[cancel ? "cancelPayment" : "getPaymentStatus"]({ ...scope, paymentId,
          ...(cancel && { courierDelivery: true }) });
      const status = ({ creating: "creating", processing: "processing", succeeded: "paid", canceled: "idle", failed: "failed" })[result.status];
      return { method: "terminal", status, attemptId: String(result.id), message: result.failureMessage };
    } catch (error) {
      if (error.statusCode && error.code) throw new DomainError(error.statusCode, error.code, error.message);
      throw error;
    }
  };
  return { payment, readAssignedTerminal, requestAssignedTerminal };
};

module.exports = { buildCourierDeliveryPayments };
