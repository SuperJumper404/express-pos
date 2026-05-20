const DEFAULT_COMMISSION_PERCENT = 5;

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
  const parsedPercent = Number(commissionPercent);

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
}) => {
  if (!connectedAccountId) {
    throw new Error("Compte Stripe restaurateur manquant");
  }

  const amountInCents = toStripeAmount(amount);

  return {
    amount: amountInCents,
    currency,
    automatic_payment_methods: { enabled: true },
    application_fee_amount: calculateApplicationFee(
      amountInCents,
      commissionPercent,
    ),
    transfer_data: { destination: connectedAccountId },
    metadata: {
      order_id: String(orderId),
      shop_id: String(shopId),
    },
  };
};

module.exports = {
  DEFAULT_COMMISSION_PERCENT,
  calculateApplicationFee,
  toStripeAmount,
  buildDestinationPaymentIntentParams,
};
