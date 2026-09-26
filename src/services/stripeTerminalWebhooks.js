const retryTerminalTransaction = async (run, work) => {
  for (let attempt = 1; ; attempt += 1) {
    try { return await run(work); }
    catch (error) {
      const contention = ["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"].includes(error.code)
        || [1213, 1205].includes(error.errno);
      if (!contention || attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 10));
    }
  }
};

const buildStripeTerminalWebhookHandler = ({ terminalStore }) => async (event) => {
  // Reader actions describe collection, not settlement. They never release or
  // finalize a payment; polling and the authoritative PI event reconcile it.
  if (event.type.startsWith("terminal.reader.")) return { handled: true };
  const intent = event.data.object;
  const metadata = intent.metadata || {};
  if (!event.type.startsWith("payment_intent.")
    || !Object.prototype.hasOwnProperty.call(metadata, "terminal_payment_id")) return null;
  if (event.type !== "payment_intent.succeeded") return { handled: true };
  const shopId = Number(metadata.shop_id);
  const paymentId = Number(metadata.terminal_payment_id);
  if (![shopId, paymentId].every((id) => Number.isSafeInteger(id) && id > 0)
    || String(shopId) !== metadata.shop_id || String(paymentId) !== metadata.terminal_payment_id) {
    return { handled: true, ignored: true };
  }
  try {
    return await retryTerminalTransaction(terminalStore.withTransaction, async (store) => {
      const payment = await store.findPaymentSession({ shopId, paymentId });
      if (!payment || Number(payment.shopid) !== shopId || Number(payment.id) !== paymentId
        || payment.stripe_payment_intent_id !== intent.id || intent.status !== "succeeded"
        || payment.amount_cents !== intent.amount || payment.currency !== intent.currency) {
        throw new Error("Terminal payment mismatch");
      }
      const result = await store.finalizePaymentSucceeded({
        shopId, paymentId, stripePaymentIntentId: intent.id,
        stripeChargeId: typeof intent.latest_charge === "string" ? intent.latest_charge : (intent.latest_charge || {}).id || null,
        timestamp: new Date(event.created * 1000),
      });
      return { handled: true, ...result };
    });
  } catch (error) {
    throw new Error("Impossible de rapprocher le paiement terminal.");
  }
};

module.exports = { buildStripeTerminalWebhookHandler, retryTerminalTransaction };
