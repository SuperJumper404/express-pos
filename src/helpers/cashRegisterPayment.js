const PAYMENT_STATUSES = {
  PAID: "paid",
  REQUIRES_PAYMENT: "requires_payment",
};

const normalizePaymentMethod = (paymentMethod) =>
  String(paymentMethod || "").trim();

const isTemporaryCounterPayment = (order = {}) => {
  const payment = String(order.payment || order.used_payment_method || "")
    .trim()
    .toLowerCase();
  return payment.includes("comptoir") || payment.includes("encaisser");
};

const isPaymentAlreadyCollected = (order = {}) =>
  order.payment_status === PAYMENT_STATUSES.PAID && !isTemporaryCounterPayment(order);

const shouldCancelPendingStripePayment = (order = {}) =>
  order.payment_status === PAYMENT_STATUSES.REQUIRES_PAYMENT &&
  order.payment_provider === "stripe" &&
  Boolean(order.stripe_payment_intent_id);

const getCollectedPaymentMethod = (order = {}) =>
  order.used_payment_method || order.payment || "Paye";

const buildCashRegisterCollectionFields = (paymentMethod) => {
  const normalizedPaymentMethod = normalizePaymentMethod(paymentMethod);
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
  if (order.payment_status === PAYMENT_STATUSES.PAID && isTemporaryCounterPayment(order)) {
    return {
      ...buildCashRegisterCollectionFields(paymentMethod),
      used_payment_method: normalizePaymentMethod(paymentMethod),
    };
  }

  if (isPaymentAlreadyCollected(order)) {
    return {
      payment: order.payment,
      payment_status: PAYMENT_STATUSES.PAID,
      payment_provider: order.payment_provider || null,
      stripe_payment_intent_id: order.stripe_payment_intent_id || null,
      used_payment_method: getCollectedPaymentMethod(order),
    };
  }

  return {
    ...buildCashRegisterCollectionFields(paymentMethod),
    used_payment_method: normalizePaymentMethod(paymentMethod),
  };
};

module.exports = {
  PAYMENT_STATUSES,
  buildCashRegisterCollectionFields,
  buildCashRegisterArchiveFields,
  isPaymentAlreadyCollected,
  shouldCancelPendingStripePayment,
};
