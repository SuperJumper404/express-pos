const { randomUUID } = require("crypto");
const { toStripeAmount } = require("../helpers/stripePayment");
const {
  allocateTerminalOrderAmounts, calculateTerminalApplicationFee, buildTerminalPaymentIntentParams,
} = require("../helpers/stripeTerminal");

const ERRORS = {
  TERMINAL_INVALID_INPUT: [422, "Parametres du paiement invalides."],
  TERMINAL_INVALID_ORDERS: [409, "Ces commandes ne peuvent pas etre encaissees sur le terminal."],
  TERMINAL_ORDER_BUSY: [409, "Une commande a deja un paiement sur un autre terminal."],
  TERMINAL_NO_READER: [409, "Aucun terminal actif ne vous est assigne."],
  TERMINAL_READER_OFFLINE: [409, "Le terminal est hors ligne."],
  TERMINAL_READER_BUSY: [409, "Le terminal est occupe."],
  TERMINAL_CONNECT_NOT_READY: [409, "Le compte Stripe du restaurant ne permet pas les paiements."],
  TERMINAL_PAYMENT_NOT_FOUND: [404, "Paiement terminal introuvable."],
  TERMINAL_PAYMENT_CREATING: [409, "La preparation du paiement est en cours."],
  TERMINAL_PAYMENT_FAILED: [409, "Le paiement sur le terminal a echoue."],
  TERMINAL_STRIPE_ERROR: [502, "Le service de paiement Stripe est indisponible."],
  TERMINAL_CLEANUP_FAILED: [502, "Verification du paiement necessaire avant une nouvelle tentative."],
  TERMINAL_INTERNAL_ERROR: [500, "Impossible de gerer le paiement terminal."],
};

class TerminalPaymentError extends Error {
  constructor(code) {
    super(ERRORS[code][1]);
    this.code = code;
    this.statusCode = ERRORS[code][0];
  }
}
const fail = (code) => { throw new TerminalPaymentError(code); };
const positiveId = (value) => {
  if (!((typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value)))
    && Number.isSafeInteger(Number(value)) && Number(value) > 0)) fail("TERMINAL_INVALID_INPUT");
  return Number(value);
};
const active = (session) => ["creating", "processing"].includes(session.status);
const cancelable = (intent) => ["requires_payment_method", "requires_confirmation", "requires_action", "requires_capture"].includes(intent.status);
const matchingAction = (reader, intentId) => reader.action
  && reader.action.type === "process_payment_intent"
  && reader.action.process_payment_intent
  && reader.action.process_payment_intent.payment_intent === intentId;

const buildStripeTerminalPaymentService = ({ stripe, terminalStore, shopStore }) => {
  const safe = (operation) => async (input) => {
    try { return await operation(input); }
    catch (error) {
      if (error instanceof TerminalPaymentError) throw error;
      fail("TERMINAL_INTERNAL_ERROR");
    }
  };
  const stripeCall = async (operation) => {
    try { return await operation(); }
    catch (error) { fail("TERMINAL_STRIPE_ERROR"); }
  };
  const dto = async (session, store = terminalStore) => ({
    id: session.id,
    readerId: session.terminal_reader_id,
    status: session.status,
    amountCents: session.amount_cents,
    currency: session.currency,
    orderIds: (await store.listPaymentAllocations({ shopId: session.shopid, paymentId: session.id }))
      .map((a) => a.order_id).sort((a, b) => a - b),
    failureCode: ERRORS[session.failure_code] ? session.failure_code : null,
    failureMessage: ERRORS[session.failure_code] ? ERRORS[session.failure_code][1] : null,
  });
  const payment = async (input, store = terminalStore, forUpdate = false) => {
    const shopId = positiveId(input.shopId);
    const cashierUserId = positiveId(input.cashierUserId);
    const paymentId = positiveId(input.paymentId);
    const session = await store.findPaymentSession({ shopId, paymentId, forUpdate });
    if (!session || Number(session.shopid) !== shopId || Number(session.cashier_user_id) !== cashierUserId) {
      fail("TERMINAL_PAYMENT_NOT_FOUND");
    }
    return session;
  };
  const update = (session, values, store = terminalStore) => store.updatePaymentSession({
    shopId: session.shopid, paymentId: session.id, ...values,
  });
  const markFailed = (session, code, store = terminalStore) => update(session, {
    status: "failed", failureCode: code, failureMessage: ERRORS[code][1],
  }, store);
  const reconcile = async (session, intent, store) => {
    if (!intent || intent.id !== session.stripe_payment_intent_id
      || intent.amount !== session.amount_cents || intent.currency !== session.currency
      || !intent.metadata || intent.metadata.terminal_payment_id !== String(session.id)
      || intent.metadata.shop_id !== String(session.shopid)) fail("TERMINAL_STRIPE_ERROR");
    if (intent.status === "succeeded") {
      await store.finalizePaymentSucceeded({
        shopId: session.shopid, paymentId: session.id, stripePaymentIntentId: intent.id,
        stripeChargeId: typeof intent.latest_charge === "string" ? intent.latest_charge : (intent.latest_charge || {}).id || null,
        timestamp: new Date(),
      });
    } else if (intent.status === "canceled") {
      await update(session, { status: "canceled" }, store);
    }
    return store.findPaymentSession({ shopId: session.shopid, paymentId: session.id });
  };
  const cancelRemote = async (session, reader) => {
    const remote = await stripeCall(() => stripe.terminal.readers.retrieve(reader.stripe_reader_id));
    if (matchingAction(remote, session.stripe_payment_intent_id) && remote.action.status === "in_progress") {
      const canceled = await stripeCall(() => stripe.terminal.readers.cancelAction(reader.stripe_reader_id));
      if (!canceled || canceled.id !== reader.stripe_reader_id
        || (matchingAction(canceled, session.stripe_payment_intent_id) && canceled.action.status === "in_progress")) {
        fail("TERMINAL_STRIPE_ERROR");
      }
    }
    // Re-read after cancelAction: collection may have succeeded while cancellation was requested.
    let intent = await stripeCall(() => stripe.paymentIntents.retrieve(session.stripe_payment_intent_id));
    if (cancelable(intent)) {
      try {
        intent = await stripe.paymentIntents.cancel(intent.id);
      } catch (error) {
        intent = await stripeCall(() => stripe.paymentIntents.retrieve(session.stripe_payment_intent_id));
        if (!["succeeded", "canceled", "processing"].includes(intent.status)) fail("TERMINAL_STRIPE_ERROR");
      }
    }
    return intent;
  };

  const startPayment = safe(async (input) => {
    const shopId = positiveId(input.shopId);
    const cashierUserId = positiveId(input.cashierUserId);
    if (!Array.isArray(input.orderIds) || !input.orderIds.length
      || input.orderIds.some((id) => !Number.isSafeInteger(id) || id <= 0)
      || new Set(input.orderIds).size !== input.orderIds.length) fail("TERMINAL_INVALID_INPUT");
    const orderIds = [...input.orderIds].sort((a, b) => a - b);
    const shop = await shopStore.findShop({ shopId });
    const reserved = await terminalStore.withTransaction(async (store) => {
      let locked;
      try { locked = await store.lockReaderAndOrders({ shopId, userId: cashierUserId, orderIds }); }
      catch (error) {
        const codes = {
          "No active assigned Terminal reader": "TERMINAL_NO_READER",
          "Invalid Terminal order selection": "TERMINAL_INVALID_ORDERS",
          "Order has an active Terminal payment": "TERMINAL_ORDER_BUSY",
        };
        if (codes[error.message]) fail(codes[error.message]);
        throw error;
      }
      const { reader, orders, activePayment } = locked;
      if (activePayment) {
        if (Number(activePayment.cashier_user_id) !== cashierUserId) fail("TERMINAL_READER_BUSY");
        return { existing: await dto(activePayment, store) };
      }
      if (!shop || Number(shop.id) !== shopId || !shop.stripe_account_id || Number(shop.stripe_charges_enabled) !== 1) {
        fail("TERMINAL_CONNECT_NOT_READY");
      }
      let amounts;
      try {
        amounts = allocateTerminalOrderAmounts({
          orders: orders.map((o) => ({ id: o.id, amountCents: toStripeAmount(o.subtotal) })),
          discountType: input.discountType, discountValue: input.discountValue,
        });
      } catch (error) { fail("TERMINAL_INVALID_INPUT"); }
      const applicationFeeAmount = calculateTerminalApplicationFee(amounts.totalCents, shop.stripe_commission_percent);
      const saved = await store.createPaymentSession({
        shopId, readerId: reader.id, cashierUserId, idempotencyKey: `terminal:${shopId}:${randomUUID()}`,
        amountCents: amounts.totalCents, applicationFeeAmount, currency: "eur",
        discountType: input.discountType || "none", discountValue: input.discountValue === undefined ? 0 : input.discountValue,
      });
      if (!saved || saved.affectedRows !== 1 || !Number.isSafeInteger(saved.insertId) || saved.insertId <= 0) fail("TERMINAL_INTERNAL_ERROR");
      await store.createAllocations({ shopId, paymentId: saved.insertId, allocations: amounts.allocations });
      return { reader, session: await store.findPaymentSession({ shopId, paymentId: saved.insertId }) };
    });
    if (reserved.existing) return reserved.existing;
    const { reader, session } = reserved;
    try {
      const remote = await stripeCall(() => stripe.terminal.readers.retrieve(reader.stripe_reader_id));
      if (remote.status !== "online") fail("TERMINAL_READER_OFFLINE");
      if (remote.action && remote.action.status === "in_progress") fail("TERMINAL_READER_BUSY");
    } catch (error) {
      await markFailed(session, error.code);
      throw error;
    }
    let intent;
    try {
      intent = await stripe.paymentIntents.create(buildTerminalPaymentIntentParams({
        totalCents: session.amount_cents, applicationFeeAmount: session.application_fee_amount,
        connectedAccountId: shop.stripe_account_id, terminalPaymentId: session.id, shopId,
      }), { idempotencyKey: session.idempotency_key });
    } catch (error) {
      // A connection failure may hide a created PI. Keep its durable idempotency key reserved for recovery.
      if (error.type === "StripeInvalidRequestError" && error.statusCode === 400) await markFailed(session, "TERMINAL_STRIPE_ERROR");
      fail("TERMINAL_STRIPE_ERROR");
    }
    session.stripe_payment_intent_id = intent.id;
    try {
      const saved = await update(session, { stripePaymentIntentId: intent.id });
      if (!saved || saved.affectedRows !== 1) fail("TERMINAL_INTERNAL_ERROR");
      await stripeCall(() => stripe.terminal.readers.processPaymentIntent(reader.stripe_reader_id, {
        payment_intent: intent.id,
      }, { idempotencyKey: `${session.idempotency_key}:process` }));
      await update(session, { status: "processing" });
    } catch (error) {
      let remoteIntent;
      try { remoteIntent = await cancelRemote(session, reader); }
      catch (cleanupError) { fail("TERMINAL_CLEANUP_FAILED"); }
      if (remoteIntent.status === "canceled") await markFailed(session, "TERMINAL_STRIPE_ERROR");
      else if (remoteIntent.status === "succeeded") {
        return terminalStore.withTransaction(async (store) => dto(await reconcile(session, remoteIntent, store), store));
      }
      throw error;
    }
    return dto(await terminalStore.findPaymentSession({ shopId, paymentId: session.id }));
  });

  const getPaymentStatus = safe(async (input) => {
    const session = await payment(input);
    if (!active(session) || !session.stripe_payment_intent_id) return dto(session);
    const intent = await stripeCall(() => stripe.paymentIntents.retrieve(session.stripe_payment_intent_id));
    return terminalStore.withTransaction(async (store) => {
      const current = await payment(input, store, true);
      if (!active(current)) return dto(current, store);
      if (current.status === "processing" && intent.status === "requires_payment_method") {
        const reader = await store.findReader({ shopId: current.shopid, readerId: current.terminal_reader_id });
        if (!reader) fail("TERMINAL_NO_READER");
        const remote = await stripeCall(() => stripe.terminal.readers.retrieve(reader.stripe_reader_id));
        if (matchingAction(remote, intent.id) && remote.action.status === "failed") {
          const canceled = await cancelRemote(current, reader);
          if (canceled.status === "canceled") {
            await markFailed(current, "TERMINAL_PAYMENT_FAILED", store);
            return dto(await payment(input, store), store);
          }
          return dto(await reconcile(current, canceled, store), store);
        }
      }
      return dto(await reconcile(current, intent, store), store);
    });
  });

  const cancelPayment = safe((input) => terminalStore.withTransaction(async (store) => {
    const session = await payment(input, store, true);
    if (!active(session)) return dto(session, store);
    if (session.status === "creating" || !session.stripe_payment_intent_id) fail("TERMINAL_PAYMENT_CREATING");
    const reader = await store.findReader({ shopId: session.shopid, readerId: session.terminal_reader_id });
    if (!reader) fail("TERMINAL_NO_READER");
    const intent = await cancelRemote(session, reader);
    return dto(await reconcile(session, intent, store), store);
  }));

  return { startPayment, getPaymentStatus, cancelPayment };
};

module.exports = { buildStripeTerminalPaymentService, TerminalPaymentError };
