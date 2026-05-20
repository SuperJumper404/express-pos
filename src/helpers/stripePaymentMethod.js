const STRIPE_PAYMENT_METHOD_LABELS = {
  card: "Carte",
  link: "Link",
  paypal: "PayPal",
  sepa_debit: "SEPA",
};

const STRIPE_WALLET_LABELS = {
  apple_pay: "Apple Pay",
  google_pay: "Google Pay",
};

const resolveStripePaymentMethod = ({ paymentIntent, charge } = {}) => {
  const details = charge?.payment_method_details;
  const walletType = details?.card?.wallet?.type;

  if (walletType && STRIPE_WALLET_LABELS[walletType]) {
    return STRIPE_WALLET_LABELS[walletType];
  }

  if (details?.type && STRIPE_PAYMENT_METHOD_LABELS[details.type]) {
    return STRIPE_PAYMENT_METHOD_LABELS[details.type];
  }

  const intentMethodType = paymentIntent?.payment_method_types?.[0];
  if (intentMethodType && STRIPE_PAYMENT_METHOD_LABELS[intentMethodType]) {
    return STRIPE_PAYMENT_METHOD_LABELS[intentMethodType];
  }

  return "Stripe";
};

module.exports = {
  resolveStripePaymentMethod,
};
