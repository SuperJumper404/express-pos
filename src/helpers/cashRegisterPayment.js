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

const assertDeliverySettlementDiscount = (order, discount = {}) => {
  const type = discount.discountType == null || discount.discountType === "" ? "none" : String(discount.discountType).trim().toLowerCase();
  const value = discount.discountValue == null || discount.discountValue === "" ? 0 : Number(discount.discountValue);
  if ((["none", "amount", "percent"].includes(type) && value === 0)
    || (type === order.discount_type && Number.isFinite(value) && value >= 0 && value === Number(order.discount_value))) return;
  throw new DomainError(409, "DELIVERY_REQUOTE_REQUIRED", "Delivery price changes require an explicit confirmed quote");
};

const assertDeliveryCollectionAllowed = (order) => {
  if (order.payment_status !== "unpaid" || order.payment_provider != null
    || order.stripe_payment_intent_id != null || order.stripe_terminal_payment_id != null) {
    throw new DomainError(409, "DELIVERY_PAYMENT_NOT_SETTLED", "Delivery payment must be reconciled before collection");
  }
};

const buildCashRegisterArchiveFields = ({ order = {}, paymentMethod } = {}) => {
  if (order.delivery_id != null) {
    if (["paid", "refunded"].includes(order.payment_status)) {
      return {
        payment: order.payment, payment_status: order.payment_status,
        payment_provider: order.payment_provider || null,
        stripe_payment_intent_id: order.stripe_payment_intent_id || null,
        stripe_terminal_payment_id: order.stripe_terminal_payment_id || null,
        used_payment_method: getCollectedPaymentMethod(order),
      };
    }
    assertDeliveryCollectionAllowed(order);
    if (!normalizeCashPaymentMethod(paymentMethod)) {
      throw new DomainError(409, "DELIVERY_PAYMENT_NOT_SETTLED", "Delivery archive requires an explicit cashier settlement");
    }
  }
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
  assertDeliveryCollectionAllowed,
  assertDeliverySettlementDiscount,
  PAYMENT_STATUSES,
  buildCashRegisterCollectionFields,
  buildCashRegisterArchiveFields,
  isPaymentAlreadyCollected,
  shouldCancelPendingStripePayment,
};
