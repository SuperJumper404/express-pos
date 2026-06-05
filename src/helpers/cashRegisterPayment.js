const PAYMENT_STATUSES = {
  PAID: "paid",
  REQUIRES_PAYMENT: "requires_payment",
};

const normalizePaymentMethod = (paymentMethod) =>
  String(paymentMethod || "").trim();

const isPaymentAlreadyCollected = (order = {}) =>
  order.payment_status === PAYMENT_STATUSES.PAID;

const shouldCancelPendingStripePayment = (order = {}) =>
  order.payment_status === PAYMENT_STATUSES.REQUIRES_PAYMENT &&
  order.payment_provider === "stripe" &&
  Boolean(order.stripe_payment_intent_id);

const getCollectedPaymentMethod = (order = {}) =>
  order.used_payment_method || order.payment || "Paye";

const buildCashRegisterArchiveFields = ({ order = {}, paymentMethod } = {}) => {
  if (isPaymentAlreadyCollected(order)) {
    return {
      payment: order.payment,
      payment_status: PAYMENT_STATUSES.PAID,
      payment_provider: order.payment_provider || null,
      stripe_payment_intent_id: order.stripe_payment_intent_id || null,
      used_payment_method: getCollectedPaymentMethod(order),
    };
  }

  const normalizedPaymentMethod = normalizePaymentMethod(paymentMethod);
  if (!normalizedPaymentMethod) {
    throw new Error("Moyen de paiement requis pour encaisser cette commande");
  }

  return {
    payment: normalizedPaymentMethod,
    payment_status: PAYMENT_STATUSES.PAID,
    payment_provider: null,
    stripe_payment_intent_id: null,
    used_payment_method: normalizedPaymentMethod,
  };
};

module.exports = {
  PAYMENT_STATUSES,
  buildCashRegisterArchiveFields,
  isPaymentAlreadyCollected,
  shouldCancelPendingStripePayment,
};
