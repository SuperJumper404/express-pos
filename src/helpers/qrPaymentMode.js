const QR_PAYMENT_MODES = {
  STRIPE_BEFORE_ORDER: "stripe_before_order",
  PAY_AT_COUNTER: "pay_at_counter",
};

const VALID_QR_PAYMENT_MODES = Object.values(QR_PAYMENT_MODES);

const normalizeQrPaymentMode = (mode) => {
  if (VALID_QR_PAYMENT_MODES.includes(mode)) {
    return mode;
  }

  return QR_PAYMENT_MODES.STRIPE_BEFORE_ORDER;
};

const isStripeRequiredBeforeOrder = (mode) =>
  normalizeQrPaymentMode(mode) === QR_PAYMENT_MODES.STRIPE_BEFORE_ORDER;

const isStripePaymentAllowed = (mode) =>
  [
    QR_PAYMENT_MODES.STRIPE_BEFORE_ORDER,
    QR_PAYMENT_MODES.PAY_AT_COUNTER,
  ].includes(normalizeQrPaymentMode(mode));

module.exports = {
  QR_PAYMENT_MODES,
  normalizeQrPaymentMode,
  isStripePaymentAllowed,
  isStripeRequiredBeforeOrder,
};
