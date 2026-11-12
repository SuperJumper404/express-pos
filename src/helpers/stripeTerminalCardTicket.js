const safeText = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);

const safeLast4 = (value) => (/^[0-9]{4}$/.test(String(value || "")) ? String(value) : null);

const latestCharge = (intent, fallbackChargeId = null) => {
  if (intent && typeof intent.latest_charge === "object" && intent.latest_charge) {
    return intent.latest_charge;
  }
  const id = intent && typeof intent.latest_charge === "string"
    ? intent.latest_charge
    : fallbackChargeId;
  return { id: safeText(id) };
};

const terminalCardReceiptDetails = (charge) => {
  const card = charge
    && charge.payment_method_details
    && charge.payment_method_details.card_present
    ? charge.payment_method_details.card_present
    : {};
  const receipt = card.receipt && typeof card.receipt === "object" ? card.receipt : {};
  return {
    brand: safeText(card.brand),
    last4: safeLast4(card.last4),
    ...(["credit", "debit", "prepaid"].includes(card.funding) && { funding: card.funding }),
    network: safeText(card.network),
    networkTransactionId: safeText(card.network_transaction_id),
    readMethod: safeText(card.read_method),
    authorizationCode: safeText(receipt.authorization_code),
    authorizationResponseCode: safeText(receipt.authorization_response_code),
    applicationPreferredName: safeText(receipt.application_preferred_name),
    dedicatedFileName: safeText(receipt.dedicated_file_name),
    applicationCryptogram: safeText(receipt.application_cryptogram),
    terminalVerificationResults: safeText(receipt.terminal_verification_results),
    transactionStatusInformation: safeText(receipt.transaction_status_information),
    cardholderVerificationMethod: safeText(receipt.cardholder_verification_method),
    accountType: safeText(receipt.account_type),
  };
};

const hasAnyDetail = (details) => Boolean(details && Object.values(details).some((value) => value !== null));

const serializeTerminalCardReceiptDetails = (details) => (
  hasAnyDetail(details) ? JSON.stringify(details) : null
);

const parseTerminalCardReceiptDetails = (value) => {
  if (!value) return null;
  if (typeof value === "object" && !Array.isArray(value)) return terminalCardReceiptDetails({
    payment_method_details: { card_present: {
      ...value,
      network_transaction_id: value.networkTransactionId,
      read_method: value.readMethod,
      receipt: {
      authorization_code: value.authorizationCode,
      authorization_response_code: value.authorizationResponseCode,
      application_preferred_name: value.applicationPreferredName,
      dedicated_file_name: value.dedicatedFileName,
      application_cryptogram: value.applicationCryptogram,
      terminal_verification_results: value.terminalVerificationResults,
      transaction_status_information: value.transactionStatusInformation,
      cardholder_verification_method: value.cardholderVerificationMethod,
      account_type: value.accountType,
      },
    } },
  });
  try {
    return parseTerminalCardReceiptDetails(JSON.parse(value));
  } catch (error) {
    return null;
  }
};

const buildTerminalCardTicket = (session, intent = null) => {
  const charge = latestCharge(intent, session && session.stripe_charge_id);
  const freshDetails = terminalCardReceiptDetails(charge);
  const storedDetails = parseTerminalCardReceiptDetails(session && session.card_receipt_details);
  const details = { ...freshDetails, ...storedDetails,
    ...Object.fromEntries(Object.entries(freshDetails).filter(([, value]) => value != null)) };
  return {
    ...details,
    chargeId: safeText(charge.id) || safeText(session && session.stripe_charge_id),
    terminalPaymentId: session && session.id,
    amountCents: session && session.amount_cents,
  };
};

// Receipt enrichment must never change settlement or make an accepted payment fail.
const resolveTerminalCardTicket = async (session, intent = null, stripe = null) => {
  const saved = buildTerminalCardTicket(session, intent);
  if (!stripe || !session.stripe_payment_intent_id
    || (session.status !== "succeeded" && (!intent || intent.status !== "succeeded"))
    || (saved.brand && saved.last4 && saved.funding && saved.applicationPreferredName && saved.dedicatedFileName)) return saved;
  try {
    const expanded = await stripe.paymentIntents.retrieve(session.stripe_payment_intent_id, { expand: ["latest_charge"] });
    if (!expanded || expanded.id !== session.stripe_payment_intent_id || expanded.status !== "succeeded"
      || expanded.amount !== session.amount_cents || expanded.currency !== session.currency
      || !expanded.metadata || expanded.metadata.shop_id !== String(session.shopid)
      || expanded.metadata.terminal_payment_id !== String(session.id)) return saved;
    return buildTerminalCardTicket({ ...session,
      card_receipt_details: serializeTerminalCardReceiptDetails(saved) }, expanded);
  } catch (_) { return saved; }
};

module.exports = {
  terminalCardReceiptDetails,
  serializeTerminalCardReceiptDetails,
  parseTerminalCardReceiptDetails,
  buildTerminalCardTicket,
  resolveTerminalCardTicket,
};
