const { normalizeCommissionPercent } = require("./stripePayment");

const TERMINAL_PAYMENT_METHOD = "Carte bancaire - TPE Stripe";
const TERMINAL_PAYMENT_STATUSES = Object.freeze({
  CREATING: "creating",
  PROCESSING: "processing",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  CANCELED: "canceled",
});

const isPositiveCents = (value) => Number.isSafeInteger(value) && value > 0;
const isPositiveId = (value) => Number.isSafeInteger(value) && value > 0;

const allocateTerminalOrderAmounts = ({ orders, discountType = "none", discountValue = 0 }) => {
  if (!Array.isArray(orders) || orders.length === 0) {
    throw new Error("Invalid Terminal orders");
  }

  const sortedOrders = [...orders].sort((left, right) => left.id - right.id);
  let subtotalCents = 0;
  const seenIds = new Set();
  for (const order of sortedOrders) {
    if (!order || !isPositiveId(order.id) || !isPositiveCents(order.amountCents)
      || seenIds.has(order.id)) {
      throw new Error("Invalid Terminal order amount or ID");
    }
    seenIds.add(order.id);
    subtotalCents += order.amountCents;
  }
  if (!Number.isSafeInteger(subtotalCents)) {
    throw new Error("Invalid Terminal subtotal");
  }

  let discountCents = 0;
  if (discountType === "percent") {
    const percent = Number(discountValue);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      throw new Error("Invalid Terminal discount");
    }
    discountCents = Math.round((subtotalCents * percent) / 100);
  } else if (discountType === "amount") {
    if (!Number.isSafeInteger(discountValue) || discountValue < 0) {
      throw new Error("Invalid Terminal discount");
    }
    discountCents = discountValue;
  } else if (discountType !== "none") {
    throw new Error("Invalid Terminal discount type");
  }

  const totalCents = subtotalCents - discountCents;
  if (!Number.isSafeInteger(discountCents) || !isPositiveCents(totalCents)) {
    throw new Error("Invalid Terminal total");
  }

  const allocations = sortedOrders.map((order) => {
    const proportionalDiscount = Number(
      (BigInt(order.amountCents) * BigInt(discountCents)) / BigInt(subtotalCents),
    );
    return { orderId: order.id, amountCents: order.amountCents - proportionalDiscount };
  });
  let residualCents = allocations.reduce((sum, allocation) => sum + allocation.amountCents, 0)
    - totalCents;
  for (const allocation of allocations) {
    if (residualCents === 0) break;
    allocation.amountCents -= 1;
    residualCents -= 1;
  }

  return { subtotalCents, discountCents, totalCents, allocations };
};

const calculateTerminalApplicationFee = (totalCents, commissionPercent) => {
  if (!isPositiveCents(totalCents)) {
    throw new Error("Invalid Terminal total");
  }
  return Math.round((totalCents * normalizeCommissionPercent(commissionPercent)) / 100);
};

const buildTerminalPaymentIntentParams = ({ totalCents, connectedAccountId,
  applicationFeeAmount, terminalPaymentId, shopId }) => {
  if (!isPositiveCents(totalCents)) {
    throw new Error("Invalid Terminal total");
  }
  if (!connectedAccountId || typeof connectedAccountId !== "string") {
    throw new Error("Compte Stripe restaurateur manquant");
  }
  if (!Number.isSafeInteger(applicationFeeAmount) || applicationFeeAmount < 0
    || applicationFeeAmount > totalCents) {
    throw new Error("Invalid Terminal application fee");
  }
  if (!isPositiveId(terminalPaymentId) || !isPositiveId(shopId)) {
    throw new Error("Invalid Terminal payment or shop ID");
  }

  return {
    amount: totalCents,
    currency: "eur",
    payment_method_types: ["card_present"],
    capture_method: "automatic",
    application_fee_amount: applicationFeeAmount,
    on_behalf_of: connectedAccountId,
    transfer_data: { destination: connectedAccountId },
    metadata: {
      terminal_payment_id: String(terminalPaymentId),
      shop_id: String(shopId),
    },
  };
};

module.exports = {
  TERMINAL_PAYMENT_METHOD,
  TERMINAL_PAYMENT_STATUSES,
  allocateTerminalOrderAmounts,
  calculateTerminalApplicationFee,
  buildTerminalPaymentIntentParams,
};
