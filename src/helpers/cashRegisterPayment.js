const PAYMENT_STATUSES = {
  PAID: "paid",
  REQUIRES_PAYMENT: "requires_payment",
};
const { normalizePaymentMethod } = require("./paymentMethod");
const DomainError = require("./domainError");
const { TERMINAL_PAYMENT_METHOD } = require("./stripeTerminal");

const normalizeCashPaymentMethod = (paymentMethod) =>
  normalizePaymentMethod(paymentMethod);

const isTemporaryCounterPayment = (order = {}) => {
  const payment = String(order.payment || order.used_payment_method || "")
    .trim()
    .toLowerCase();
  return payment.includes("comptoir") || payment.includes("encaisser");
};

const isPaymentAlreadyCollected = (order = {}) =>
  order.payment_status === PAYMENT_STATUSES.PAID && !isTemporaryCounterPayment(order);

const isCashRegisterOrderDueAndArchivable = (order = {}) => {
  if (Number(order.status) !== 3) return false;
  if (order.payment_status === "unpaid") return true;
  if (order.payment_status === PAYMENT_STATUSES.PAID) {
    return isTemporaryCounterPayment(order);
  }
  if (order.payment_status !== PAYMENT_STATUSES.REQUIRES_PAYMENT) return false;
  return !(order.payment_provider === "stripe"
    && order.stock_reservation_status === "released");
};

const CASH_REGISTER_DUE_AND_ARCHIVABLE_SQL = `(
  orders.payment_status = 'unpaid'
  OR (
    orders.payment_status = 'requires_payment'
    AND NOT (
      COALESCE(orders.payment_provider, '') = 'stripe'
      AND COALESCE(stock_reservations.stock_reservation_status, '') = 'released'
    )
  )
  OR (
    orders.payment_status = 'paid'
    AND (
      LOWER(COALESCE(orders.payment, '')) LIKE '%comptoir%'
      OR LOWER(COALESCE(orders.payment, '')) LIKE '%encaisser%'
      OR LOWER(COALESCE(orders.used_payment_method, '')) LIKE '%comptoir%'
      OR LOWER(COALESCE(orders.used_payment_method, '')) LIKE '%encaisser%'
    )
  )
)`;

const shouldCancelPendingStripePayment = (order = {}) =>
  order.payment_status === PAYMENT_STATUSES.REQUIRES_PAYMENT &&
  order.payment_provider === "stripe" &&
  Boolean(order.stripe_payment_intent_id);

const getCollectedPaymentMethod = (order = {}) =>
  normalizePaymentMethod(
    order.used_payment_method || order.payment,
    order.payment_provider,
  ) || "Carte bancaire";

const buildCashRegisterCollectionFields = (paymentMethod) => {
  const normalizedPaymentMethod = normalizeCashPaymentMethod(paymentMethod);
  if (!normalizedPaymentMethod) {
    throw new Error("Moyen de paiement requis pour encaisser cette commande");
  }

  return {
    payment: normalizedPaymentMethod,
    payment_status: PAYMENT_STATUSES.PAID,
    payment_provider: null,
    stripe_payment_intent_id: null,
  };
};

const buildCashRegisterArchiveFields = ({ order = {}, paymentMethod } = {}) => {
  if (order.stripe_terminal_payment_id != null) {
    if (order.payment_status !== PAYMENT_STATUSES.PAID) {
      throw new DomainError(409, "TERMINAL_PAYMENT_NOT_SETTLED", "Le paiement terminal ne peut pas etre archive.");
    }
    return {
      payment: TERMINAL_PAYMENT_METHOD,
      payment_status: PAYMENT_STATUSES.PAID,
      payment_provider: "stripe_terminal",
      stripe_payment_intent_id: order.stripe_payment_intent_id || null,
      stripe_terminal_payment_id: order.stripe_terminal_payment_id,
      used_payment_method: TERMINAL_PAYMENT_METHOD,
    };
  }

  if (order.payment_status === PAYMENT_STATUSES.PAID && isTemporaryCounterPayment(order)) {
    return {
      ...buildCashRegisterCollectionFields(paymentMethod),
      used_payment_method: normalizeCashPaymentMethod(paymentMethod),
    };
  }

  if (isPaymentAlreadyCollected(order)) {
    return {
      payment: normalizePaymentMethod(order.payment, order.payment_provider) || "Carte bancaire",
      payment_status: PAYMENT_STATUSES.PAID,
      payment_provider: order.payment_provider || null,
      stripe_payment_intent_id: order.stripe_payment_intent_id || null,
      used_payment_method: getCollectedPaymentMethod(order),
    };
  }

  return {
    ...buildCashRegisterCollectionFields(paymentMethod),
    used_payment_method: normalizeCashPaymentMethod(paymentMethod),
  };
};

module.exports = {
  PAYMENT_STATUSES,
  buildCashRegisterCollectionFields,
  buildCashRegisterArchiveFields,
  CASH_REGISTER_DUE_AND_ARCHIVABLE_SQL,
  isCashRegisterOrderDueAndArchivable,
  isPaymentAlreadyCollected,
  shouldCancelPendingStripePayment,
};
