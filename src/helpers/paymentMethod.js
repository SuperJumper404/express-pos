const CANONICAL_PAYMENT_METHODS = Object.freeze([
  "Carte bancaire",
  "Stripe",
  "Espèces",
  "Chèque",
  "Ticket restaurant",
]);

const foldPaymentText = (value) => String(value || "")
  .trim()
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/\s+/g, " ");

const normalizePaymentMethod = (payment, provider) => {
  const paymentKey = foldPaymentText(payment);
  const providerKey = foldPaymentText(provider);

  if (providerKey.includes("stripe") || paymentKey.includes("stripe")) {
    return "Stripe";
  }
  if (["carte", "carte bancaire", "cb", "carte bleu", "card", "credit card"]
    .includes(paymentKey)) {
    return "Carte bancaire";
  }
  if (["espece", "especes", "cash"].includes(paymentKey)) {
    return "Espèces";
  }
  if (["cheque", "cheques"].includes(paymentKey)) {
    return "Chèque";
  }
  if ([
    "ticket",
    "ticket resto",
    "ticket restaurant",
    "tickets resto",
    "tickets restaurants",
    "tickets restaurant",
  ].includes(paymentKey)) {
    return "Ticket restaurant";
  }
  return paymentKey ? "Carte bancaire" : "";
};

const normalizePaymentMethods = (methods) => [...new Set(
  (Array.isArray(methods) ? methods : [])
    .map((method) => normalizePaymentMethod(method))
    .filter(Boolean),
)];

module.exports = {
  CANONICAL_PAYMENT_METHODS,
  normalizePaymentMethod,
  normalizePaymentMethods,
};
