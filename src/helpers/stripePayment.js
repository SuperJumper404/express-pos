const DEFAULT_COMMISSION_PERCENT = 5;

const normalizeCommissionPercent = (commissionPercent) => {
  if (
    commissionPercent === undefined ||
    commissionPercent === null ||
    commissionPercent === ""
  ) {
    return DEFAULT_COMMISSION_PERCENT;
  }

  const parsedPercent = Number(commissionPercent);
  if (
    !Number.isFinite(parsedPercent) ||
    parsedPercent < 0 ||
    parsedPercent > 100
  ) {
    return DEFAULT_COMMISSION_PERCENT;
  }

  return parsedPercent;
};

const toStripeAmount = (amount) => {
  const parsed = Number(amount);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("Montant invalide");
  }
  return Math.round(parsed * 100);
};

const calculateApplicationFee = (
  amountInCents,
  commissionPercent = DEFAULT_COMMISSION_PERCENT,
) => {
  const parsedAmount = Number(amountInCents);
  const parsedPercent = normalizeCommissionPercent(commissionPercent);

  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    throw new Error("Montant invalide");
  }

  if (!Number.isFinite(parsedPercent) || parsedPercent < 0) {
    throw new Error("Commission invalide");
  }

  return Math.round((parsedAmount * parsedPercent) / 100);
};

const buildDestinationPaymentIntentParams = ({
  amount,
  currency = "eur",
  connectedAccountId,
  orderId,
  shopId,
  commissionPercent = DEFAULT_COMMISSION_PERCENT,
  paymentMethodConfigurationId,
}) => {
  if (!connectedAccountId) {
    throw new Error("Compte Stripe restaurateur manquant");
  }

  const amountInCents = toStripeAmount(amount);

  const params = {
    amount: amountInCents,
    currency,
    automatic_payment_methods: { enabled: true },
    application_fee_amount: calculateApplicationFee(
      amountInCents,
      commissionPercent,
    ),
    on_behalf_of: connectedAccountId,
    transfer_data: { destination: connectedAccountId },
    metadata: {
      order_id: String(orderId),
      shop_id: String(shopId),
    },
  };

  if (paymentMethodConfigurationId) {
    params.payment_method_configuration = paymentMethodConfigurationId;
  }

  return params;
};

module.exports = {
  DEFAULT_COMMISSION_PERCENT,
  calculateApplicationFee,
  normalizeCommissionPercent,
  toStripeAmount,
  buildDestinationPaymentIntentParams,
};
