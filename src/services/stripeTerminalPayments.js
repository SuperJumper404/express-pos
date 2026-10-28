const { randomUUID } = require("crypto");
const { toStripeAmount } = require("../helpers/stripePayment");
const { standalonePaymentDto } = require("../helpers/standaloneTerminalPayment");
const {
  allocateTerminalOrderAmounts, calculateTerminalApplicationFee, buildTerminalPaymentIntentParams,
} = require("../helpers/stripeTerminal");
const {
  buildTerminalCardTicket,
  terminalCardReceiptDetails,
  serializeTerminalCardReceiptDetails,
} = require("../helpers/stripeTerminalCardTicket");

const ERRORS = {
  DELIVERY_REQUOTE_REQUIRED: [409, "Les changements de prix livraison exigent un devis confirme."],
  TERMINAL_INVALID_INPUT: [422, "Parametres du paiement invalides."],
  TERMINAL_INVALID_ORDERS: [409, "Ces commandes ne peuvent pas etre encaissees sur le terminal."],
  TERMINAL_ORDER_BUSY: [409, "Une commande a deja un paiement sur un autre terminal."],
  TERMINAL_NO_READER: [409, "Aucun terminal actif ne vous est assigne."],
  TERMINAL_READER_OFFLINE: [409, "Le terminal est hors ligne."],
  TERMINAL_READER_BUSY: [409, "Le terminal est occupe."],
  TERMINAL_CONNECT_NOT_READY: [409, "Le compte Stripe du restaurant ne permet pas les paiements."],
  TERMINAL_PAYMENT_NOT_FOUND: [404, "Paiement terminal introuvable."],
  TERMINAL_PAYMENT_CREATING: [409, "La preparation du paiement est en cours."],
  TERMINAL_RECOVERY_REQUIRED: [409, "Ce paiement doit etre verifie avant une nouvelle tentative."],
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
const recoverableActivePaymentAgeMs = 30 * 1000;
const oldEnoughForRecovery = (session) => {
  const createdAt = new Date(session.created_at).getTime();
  return Number.isFinite(createdAt) && Date.now() - createdAt >= recoverableActivePaymentAgeMs;
};
const matchingAction = (reader, intentId) => reader.action
  && reader.action.type === "process_payment_intent"
  && reader.action.process_payment_intent
  && reader.action.process_payment_intent.payment_intent === intentId;

const buildStripeTerminalPaymentService = ({ stripe, terminalStore, shopStore }) => {
  const databaseTransaction = async (work, run = terminalStore.withTransaction) => {
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
  const safe = (operation) => async (input) => {
    try { return await operation(input); }
    catch (error) {
      if (error instanceof TerminalPaymentError) throw error;
      fail("TERMINAL_INTERNAL_ERROR");
    }
  };
  const stripeCall = async (operation) => {
    try { return await operation(); }
    catch (error) { fail(error.code === "terminal_reader_busy" ? "TERMINAL_READER_BUSY" : "TERMINAL_STRIPE_ERROR"); }
  };
  const dto = async (session, store = terminalStore, intent = null) => {
    if (session.payment_kind === "standalone") {
      const attachmentsCount = await store.countPaymentAttachments({ shopId: session.shopid, paymentId: session.id });
      return standalonePaymentDto({ ...session, attachments_count: attachmentsCount }, intent);
    }
    const allocations = (await store.listPaymentAllocations({ shopId: session.shopid, paymentId: session.id }))
      .map((a) => ({ orderId: a.order_id, amountCents: a.amount_cents }))
      .sort((a, b) => a.orderId - b.orderId);
    if (session.status === "succeeded" && (!allocations.length
      || allocations.some((a) => !Number.isSafeInteger(a.orderId) || a.orderId <= 0
        || !Number.isSafeInteger(a.amountCents) || a.amountCents < 0)
      || new Set(allocations.map((a) => a.orderId)).size !== allocations.length
      || allocations.reduce((sum, a) => sum + a.amountCents, 0) !== session.amount_cents)) {
      fail("TERMINAL_RECOVERY_REQUIRED");
    }
    return {
      id: session.id,
      readerId: session.terminal_reader_id,
      status: session.status,
      amountCents: session.amount_cents,
      currency: session.currency,
      orderIds: allocations.map((a) => a.orderId),
      ...(session.status === "succeeded" && { allocations }),
      ...(session.status === "succeeded" && { cardTicket: buildTerminalCardTicket(session, intent) }),
      failureCode: ERRORS[session.failure_code] ? session.failure_code : null,
      failureMessage: ERRORS[session.failure_code] ? ERRORS[session.failure_code][1] : null,
    };
  };
  const payment = async (input, store = terminalStore, forUpdate = false) => {
    const shopId = positiveId(input.shopId);
    const cashierUserId = positiveId(input.cashierUserId);
    const paymentId = positiveId(input.paymentId);
    const session = forUpdate && input.paymentKind === "standalone"
      ? await store.findPaymentSession({ shopId, paymentId, forUpdate: true })
      : forUpdate
      ? (await store.lockPaymentSession({ shopId, paymentId })).payment
      : await store.findPaymentSession({ shopId, paymentId });
    if (!session || Number(session.shopid) !== shopId || Number(session.cashier_user_id) !== cashierUserId
      || (session.payment_kind || "order") !== (input.paymentKind || "order")) {
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
  const assertIntentMatches = (session, intent, expectedId = session.stripe_payment_intent_id) => {
    if (!intent || typeof intent.id !== "string" || intent.id !== expectedId
      || intent.amount !== session.amount_cents || intent.currency !== session.currency
      || !intent.metadata || intent.metadata.terminal_payment_id !== String(session.id)
      || intent.metadata.shop_id !== String(session.shopid)
      || (session.payment_kind === "standalone" && intent.metadata.payment_kind !== "standalone")) fail("TERMINAL_STRIPE_ERROR");
  };
  const reconcile = async (session, intent, store) => {
    assertIntentMatches(session, intent);
    if (intent.status === "succeeded") {
      const finalize = session.payment_kind === "standalone" ? store.finalizeStandalonePaymentSucceeded : store.finalizePaymentSucceeded;
      await finalize({
        shopId: session.shopid, paymentId: session.id, stripePaymentIntentId: intent.id,
        stripeChargeId: typeof intent.latest_charge === "string" ? intent.latest_charge : (intent.latest_charge || {}).id || null,
        cardReceiptDetails: serializeTerminalCardReceiptDetails(
          terminalCardReceiptDetails(typeof intent.latest_charge === "object" ? intent.latest_charge : null),
        ),
        timestamp: new Date(),
      });
    } else if (intent.status === "canceled") {
      await update(session, { status: "canceled" }, store);
    }
    return store.findPaymentSession({ shopId: session.shopid, paymentId: session.id });
  };
  const readerAction = async (session, work, store = terminalStore) => {
    const result = await store.withReaderActionLock({ shopId: session.shopid, readerId: session.terminal_reader_id }, work);
    if (result === null) fail("TERMINAL_READER_BUSY");
    return result;
  };
  const sessionScope = (session) => ({ shopId: session.shopid, cashierUserId: session.cashier_user_id, paymentId: session.id, paymentKind: session.payment_kind || "order" });
  const cancelRemote = (session, reader, store = terminalStore) => readerAction(session, async (lockedStore) => {
    const current = await payment(sessionScope(session), lockedStore);
    if (current.terminal_reader_id !== reader.id || (current.stripe_payment_intent_id
      && current.stripe_payment_intent_id !== session.stripe_payment_intent_id)) fail("TERMINAL_RECOVERY_REQUIRED");
    const remote = await stripeCall(() => stripe.terminal.readers.retrieve(reader.stripe_reader_id));
    let intent = await stripeCall(() => stripe.paymentIntents.retrieve(session.stripe_payment_intent_id));
    // cancelAction is untargeted: keep the reader lock from this read through
    // cancellation so another application instance cannot hand off its next PI.
    if (active(current) && current.stripe_payment_intent_id === session.stripe_payment_intent_id
      && !["succeeded", "canceled"].includes(intent.status)
      && matchingAction(remote, session.stripe_payment_intent_id) && remote.action.status === "in_progress") {
      let canceled;
      let cancellationError;
      try {
        canceled = await stripeCall(() => stripe.terminal.readers.cancelAction(reader.stripe_reader_id, {}, {
          idempotencyKey: `${session.idempotency_key}:cancel-action`,
        }));
      } catch (error) { cancellationError = error; }
      if (!canceled || canceled.id !== reader.stripe_reader_id
        || (matchingAction(canceled, session.stripe_payment_intent_id) && canceled.action.status === "in_progress")) {
        // A delayed response (or cached action snapshot) can outlive the actual
        // cancellation. Confirm the live reader before retaining its lock.
        const observed = await stripeCall(() => stripe.terminal.readers.retrieve(reader.stripe_reader_id));
        if (!observed || observed.id !== reader.stripe_reader_id
          || (matchingAction(observed, session.stripe_payment_intent_id) && observed.action.status === "in_progress")) {
          if (cancellationError) throw cancellationError;
          fail("TERMINAL_STRIPE_ERROR");
        }
      }
      // Collection may have succeeded while cancellation was requested.
      intent = await stripeCall(() => stripe.paymentIntents.retrieve(session.stripe_payment_intent_id));
    }
    if (active(current) && cancelable(intent)) {
      try {
        intent = await stripe.paymentIntents.cancel(intent.id, {}, { idempotencyKey: `${session.idempotency_key}:cancel` });
      } catch (error) {
        intent = await stripeCall(() => stripe.paymentIntents.retrieve(session.stripe_payment_intent_id));
        if (!["succeeded", "canceled", "processing"].includes(intent.status)) fail("TERMINAL_STRIPE_ERROR");
      }
    }
    return intent;
  }, store);

  const markCanceled = async (session) => {
    await databaseTransaction(async (transactionStore) => {
      const current = await payment(sessionScope(session), transactionStore, true);
      if (active(current)) await update(current, { status: "canceled" }, transactionStore);
    }, terminalStore.withTransaction);
  };

  const recoverActivePayment = async (session) => {
    if (session.payment_kind === "standalone") return false;
    if (!session.stripe_payment_intent_id || !oldEnoughForRecovery(session)) return false;
    let intent = await stripeCall(() => stripe.paymentIntents.retrieve(session.stripe_payment_intent_id));
    if (["succeeded", "canceled"].includes(intent.status)) {
      await databaseTransaction(
        async (transactionStore) => reconcile(session, intent, transactionStore),
        terminalStore.withTransaction,
      );
      return true;
    }
    if (!cancelable(intent)) return false;
    const reader = await terminalStore.findReader({ shopId: session.shopid, readerId: session.terminal_reader_id });
    if (!reader) return false;
    intent = await cancelRemote(session, reader);
    if (intent.status === "succeeded") {
      await databaseTransaction(
        async (transactionStore) => reconcile(session, intent, transactionStore),
        terminalStore.withTransaction,
      );
      return true;
    }
    if (intent.status === "canceled") {
      await markCanceled(session);
      return true;
    }
    return false;
  };

  const createPayment = async ({ session, reader }, store) => {
    // Stripe can prune a key after 24 hours. Never risk replay beyond that window.
    const standalone = session.payment_kind === "standalone";
    const submittedAt = standalone ? session.stripe_create_submitted_at : session.created_at;
    const createdAt = new Date(submittedAt).getTime();
    if (!session.stripe_payment_intent_id && (!standalone || submittedAt != null)
      && (!Number.isFinite(createdAt) || Date.now() - createdAt >= 23 * 60 * 60 * 1000)) {
      fail("TERMINAL_RECOVERY_REQUIRED");
    }
    if (!session.stripe_connected_account_id) fail("TERMINAL_RECOVERY_REQUIRED");
    let intent;
    // A known Stripe intent can settle after a lost local response. Its state
    // must be reconciled before a missing/offline reader can block collection.
    if (standalone && session.stripe_payment_intent_id) {
      intent = await stripeCall(() => stripe.paymentIntents.retrieve(session.stripe_payment_intent_id));
      assertIntentMatches(session, intent);
      if (["succeeded", "canceled"].includes(intent.status)) {
        return databaseTransaction(async transactionStore => dto(await reconcile(session, intent, transactionStore), transactionStore, intent), store.withTransaction);
      }
      if (intent.status === "processing") {
        await databaseTransaction(async transactionStore => {
          const current = await payment(sessionScope(session), transactionStore, true);
          if (active(current)) await update(current, { status: "processing" }, transactionStore);
        }, store.withTransaction);
        return dto(await store.findPaymentSession({ shopId: session.shopid, paymentId: session.id }), store);
      }
    }
    if (!reader) fail("TERMINAL_NO_READER");
    const remote = await stripeCall(() => stripe.terminal.readers.retrieve(reader.stripe_reader_id));
    if (remote.status !== "online") fail("TERMINAL_READER_OFFLINE");
    if (remote.action && remote.action.status === "in_progress"
      && !matchingAction(remote, session.stripe_payment_intent_id)) fail("TERMINAL_READER_BUSY");
    if (standalone && !session.stripe_payment_intent_id && session.stripe_create_submitted_at == null) {
      // Commit before the external call. A crash after this write is ambiguous,
      // while offline/busy reservations remain provably unsubmitted.
      const timestamp = new Date();
      await databaseTransaction(async transactionStore => {
        const current = await payment(sessionScope(session), transactionStore, true);
        if (!active(current)) fail("TERMINAL_RECOVERY_REQUIRED");
        const saved = await update(current, { stripeCreateSubmittedAt: timestamp }, transactionStore);
        if (!saved || saved.affectedRows !== 1) fail("TERMINAL_INTERNAL_ERROR");
      }, store.withTransaction);
      session.stripe_create_submitted_at = timestamp;
    }
    try {
      const params = buildTerminalPaymentIntentParams({
        totalCents: session.amount_cents, applicationFeeAmount: session.application_fee_amount,
        connectedAccountId: session.stripe_connected_account_id, terminalPaymentId: session.id, shopId: session.shopid,
      });
      if (session.payment_kind === "standalone") params.metadata.payment_kind = "standalone";
      intent = intent || (session.stripe_payment_intent_id
        ? await stripe.paymentIntents.retrieve(session.stripe_payment_intent_id)
        : await stripe.paymentIntents.create(params, { idempotencyKey: session.idempotency_key }));
      if (standalone) assertIntentMatches(session, intent, intent && intent.id);
    } catch (error) {
      // Even a delayed original caller may follow another ambiguous attempt.
      // Preserve the key until a persisted PI can be reconciled or canceled.
      fail("TERMINAL_STRIPE_ERROR");
    }
    session.stripe_payment_intent_id = intent.id;
    try {
      await databaseTransaction(async (transactionStore) => {
        const saved = await update(session, { stripePaymentIntentId: intent.id }, transactionStore);
        if (!saved || saved.affectedRows !== 1) fail("TERMINAL_INTERNAL_ERROR");
      }, store.withTransaction);
      if (session.payment_kind === "standalone" && ["succeeded", "canceled"].includes(intent.status)) {
        return databaseTransaction(async transactionStore => dto(await reconcile(session, intent, transactionStore), transactionStore, intent), store.withTransaction);
      }
      if (session.payment_kind === "standalone" && intent.status === "processing") {
        await databaseTransaction(async transactionStore => {
          const latest = await payment(sessionScope(session), transactionStore, true);
          if (active(latest)) await update(latest, { status: "processing" }, transactionStore);
        }, store.withTransaction);
        return dto(await store.findPaymentSession({ shopId: session.shopid, paymentId: session.id }), store);
      }
      await readerAction(session, async (lockedStore) => {
        const current = await payment(sessionScope(session), lockedStore);
        if (!active(current) || current.status === "processing") return true;
        if (current.stripe_payment_intent_id !== intent.id || current.terminal_reader_id !== reader.id) fail("TERMINAL_RECOVERY_REQUIRED");
        const currentReader = await stripeCall(() => stripe.terminal.readers.retrieve(reader.stripe_reader_id));
        if (currentReader.status !== "online") fail("TERMINAL_READER_OFFLINE");
        if (currentReader.action && currentReader.action.status === "in_progress" && !matchingAction(currentReader, intent.id)) fail("TERMINAL_READER_BUSY");
        if (!matchingAction(currentReader, intent.id) || currentReader.action.status !== "in_progress") {
          await stripeCall(() => stripe.terminal.readers.processPaymentIntent(reader.stripe_reader_id, {
            payment_intent: intent.id,
            process_config: { enable_customer_cancellation: true },
          }, { idempotencyKey: `${session.idempotency_key}:process` }));
        }
        await databaseTransaction(async (transactionStore) => {
          const latest = await payment(sessionScope(session), transactionStore, true);
          if (active(latest)) await update(latest, { status: "processing" }, transactionStore);
        }, lockedStore.withTransaction);
        return true;
      }, store);
    } catch (error) {
      let remoteIntent;
      try { remoteIntent = await cancelRemote(session, reader, store); }
      catch (cleanupError) { fail("TERMINAL_CLEANUP_FAILED"); }
      if (remoteIntent.status === "canceled") await markFailed(session, "TERMINAL_STRIPE_ERROR", store);
      else if (remoteIntent.status === "succeeded") {
        return databaseTransaction(async (transactionStore) => dto(await reconcile(session, remoteIntent, transactionStore), transactionStore, remoteIntent), store.withTransaction);
      }
      throw error;
    }
    return dto(await store.findPaymentSession({ shopId: session.shopid, paymentId: session.id }), store);
  };

  const startPaymentAttempt = async (input, recovered = false) => {
    const shopId = positiveId(input.shopId);
    const cashierUserId = positiveId(input.cashierUserId);
    if (!Array.isArray(input.orderIds) || !input.orderIds.length
      || input.orderIds.some((id) => !Number.isSafeInteger(id) || id <= 0)
      || new Set(input.orderIds).size !== input.orderIds.length) fail("TERMINAL_INVALID_INPUT");
    const orderIds = [...input.orderIds].sort((a, b) => a - b);
    const shop = await shopStore.findShop({ shopId });
    const reserved = await databaseTransaction(async (store) => {
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
      if (orders.some(order => order.delivery_id != null || order.fulfillment_type === "delivery")
        && Number(input.discountValue || 0) !== 0) fail("DELIVERY_REQUOTE_REQUIRED");
      if (activePayment) {
        if (activePayment.payment_kind === "standalone") fail("TERMINAL_READER_BUSY");
        if (activePayment.stripe_payment_intent_id) return { activePayment };
        if (Number(activePayment.cashier_user_id) !== cashierUserId) fail("TERMINAL_READER_BUSY");
        if (activePayment.status === "creating" && !activePayment.stripe_payment_intent_id) {
          const allocations = await store.listPaymentAllocations({ shopId, paymentId: activePayment.id });
          const savedIds = allocations.map((a) => a.order_id).sort((a, b) => a - b);
          if (savedIds.length !== orderIds.length || savedIds.some((id, index) => id !== orderIds[index])) {
            return { existing: await dto(activePayment, store) };
          }
          return { reader, session: activePayment };
        }
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
      if (store.applyLoyaltyDiscounts) amounts = await store.applyLoyaltyDiscounts({ shopId, orders, allocations: amounts.allocations });
      if (amounts.totalCents < 50) fail("TERMINAL_INVALID_INPUT");
      const applicationFeeAmount = calculateTerminalApplicationFee(amounts.totalCents, shop.stripe_commission_percent);
      const saved = await store.createPaymentSession({
        shopId, readerId: reader.id, cashierUserId, idempotencyKey: `terminal:${shopId}:${randomUUID()}`,
        connectedAccountId: shop.stripe_account_id, amountCents: amounts.totalCents, applicationFeeAmount, currency: "eur",
        discountType: input.discountType || "none", discountValue: input.discountValue === undefined ? 0 : input.discountValue,
      });
      if (!saved || saved.affectedRows !== 1 || !Number.isSafeInteger(saved.insertId) || saved.insertId <= 0) fail("TERMINAL_INTERNAL_ERROR");
      await store.createAllocations({ shopId, paymentId: saved.insertId, allocations: amounts.allocations });
      return { reader, session: await store.findPaymentSession({ shopId, paymentId: saved.insertId }) };
    });
    if (reserved.activePayment) {
      if (await recoverActivePayment(reserved.activePayment)) {
        if (recovered) fail("TERMINAL_RECOVERY_REQUIRED");
        return startPaymentAttempt(input, true);
      }
      if (Number(reserved.activePayment.cashier_user_id) !== cashierUserId) fail("TERMINAL_READER_BUSY");
      return dto(reserved.activePayment);
    }
    if (reserved.existing) return reserved.existing;
    const paymentId = reserved.session.id;
    const result = await terminalStore.withPaymentCreationLock({ shopId, paymentId }, async (store) => {
      const current = await payment({ shopId, cashierUserId, paymentId }, store);
      if (current.status !== "creating" || current.stripe_payment_intent_id) return dto(current, store);
      return createPayment({ ...reserved, session: current }, store);
    });
    return result || dto(await payment({ shopId, cashierUserId, paymentId }));
  };
  const startPayment = safe((input) => startPaymentAttempt(input));

  const startStandalonePayment = safe(async (input) => {
    const shopId = positiveId(input.shopId);
    const cashierUserId = positiveId(input.cashierUserId);
    if (!Number.isSafeInteger(input.amountCents) || input.amountCents < 50 || input.amountCents > 99999999
      || typeof input.attemptKey !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.attemptKey)) fail("TERMINAL_INVALID_INPUT");
    const idempotencyKey = `terminal:standalone:${shopId}:${cashierUserId}:${input.attemptKey.toLowerCase()}`;
    const findExisting = async (store) => {
      const existing = await store.findPaymentByIdempotencyKey({ shopId, idempotencyKey });
      if (existing && (existing.payment_kind !== "standalone" || Number(existing.cashier_user_id) !== cashierUserId
        || existing.amount_cents !== input.amountCents)) fail("TERMINAL_INVALID_INPUT");
      return existing;
    };
    // Replay works after settlement, reassignment and offline readers too.
    let session = await findExisting(terminalStore);
    let reader;
    if (!session) {
      const shop = await shopStore.findShop({ shopId });
      ({ session, reader } = await databaseTransaction(async store => {
        const assigned = await store.findAssignedReader({ shopId, userId: cashierUserId, forUpdate: true });
        if (!assigned) fail("TERMINAL_NO_READER");
        const existing = await findExisting(store);
        if (existing) return { session: existing, reader: assigned };
        if (await store.findActivePaymentForReader({ shopId, readerId: assigned.id, forUpdate: true })) fail("TERMINAL_READER_BUSY");
        if (!shop || Number(shop.id) !== shopId || !shop.stripe_account_id || Number(shop.stripe_charges_enabled) !== 1) fail("TERMINAL_CONNECT_NOT_READY");
        const saved = await store.createStandalonePaymentSession({ shopId, cashierUserId, readerId: assigned.id,
          idempotencyKey, connectedAccountId: shop.stripe_account_id, amountCents: input.amountCents,
          applicationFeeAmount: calculateTerminalApplicationFee(input.amountCents, shop.stripe_commission_percent) });
        if (!saved || saved.affectedRows !== 1 || !Number.isSafeInteger(saved.insertId) || saved.insertId <= 0) fail("TERMINAL_INTERNAL_ERROR");
        return { session: await store.findPaymentSession({ shopId, paymentId: saved.insertId }), reader: assigned };
      }));
    }
    if (session.status !== "creating") return getPaymentStatus({ ...input, paymentId: session.id, paymentKind: "standalone" });
    reader ||= await terminalStore.findReader({ shopId, readerId: session.terminal_reader_id });
    if (!reader && !session.stripe_payment_intent_id) fail("TERMINAL_RECOVERY_REQUIRED");
    const result = await terminalStore.withPaymentCreationLock({ shopId, paymentId: session.id }, async store => {
      const current = await payment({ shopId, cashierUserId, paymentId: session.id, paymentKind: "standalone" }, store);
      if (current.status !== "creating") return dto(current, store);
      return createPayment({ session: current, reader }, store);
    });
    return result || dto(await payment({ shopId, cashierUserId, paymentId: session.id, paymentKind: "standalone" }));
  });

  const getPaymentStatus = safe(async (input) => {
    const session = await payment(input);
    if (!active(session) || !session.stripe_payment_intent_id) return dto(session);
    let intent = await stripeCall(() => stripe.paymentIntents.retrieve(session.stripe_payment_intent_id));
    let expiredCancel = false;
    if (session.payment_kind !== "standalone" && oldEnoughForRecovery(session) && cancelable(intent)) {
      const reader = await terminalStore.findReader({ shopId: session.shopid, readerId: session.terminal_reader_id });
      if (!reader) fail("TERMINAL_NO_READER");
      intent = await cancelRemote(session, reader);
      expiredCancel = intent.status === "canceled";
    }
    let failedAction = false;
    let customerCanceled = false;
    if (!expiredCancel && session.status === "processing" && intent.status === "requires_payment_method") {
      const reader = await terminalStore.findReader({ shopId: session.shopid, readerId: session.terminal_reader_id });
      if (!reader) fail("TERMINAL_NO_READER");
      const remote = await stripeCall(() => stripe.terminal.readers.retrieve(reader.stripe_reader_id));
      if (matchingAction(remote, intent.id) && remote.action.status === "failed") {
        intent = await cancelRemote(session, reader);
        failedAction = intent.status === "canceled";
        customerCanceled = failedAction && remote.action.failure_code === "customer_canceled";
      }
    }
    return databaseTransaction(async (store) => {
      const current = await payment(input, store, true);
      if (!active(current)) return dto(current, store);
      if (expiredCancel || customerCanceled) return dto(await reconcile(current, intent, store), store, intent);
      if (failedAction) {
        await markFailed(current, "TERMINAL_PAYMENT_FAILED", store);
        return dto(await payment(input, store), store);
      }
      return dto(await reconcile(current, intent, store), store, intent);
    });
  });

  const cancelPayment = safe(async (input) => {
    const session = await payment(input);
    if (!active(session)) return dto(session);
    if (session.payment_kind === "standalone" && session.status === "creating" && !session.stripe_payment_intent_id) {
      // Serialize against the whole creation/handoff operation, then inspect the
      // durable marker again. Only a request never submitted to Stripe is free.
      const result = await terminalStore.withPaymentCreationLock({ shopId: session.shopid, paymentId: session.id }, store => databaseTransaction(async transactionStore => {
        const current = await payment(input, transactionStore, true);
        if (!active(current)) return dto(current, transactionStore);
        if (current.stripe_create_submitted_at != null) fail("TERMINAL_RECOVERY_REQUIRED");
        if (current.status !== "creating" || current.stripe_payment_intent_id) fail("TERMINAL_PAYMENT_CREATING");
        await update(current, { status: "canceled" }, transactionStore);
        return dto(await payment(input, transactionStore), transactionStore);
      }, store.withTransaction));
      if (!result) fail("TERMINAL_PAYMENT_CREATING");
      return result;
    }
    if (session.status === "creating" || !session.stripe_payment_intent_id) fail("TERMINAL_PAYMENT_CREATING");
    const reader = await terminalStore.findReader({ shopId: session.shopid, readerId: session.terminal_reader_id });
    if (!reader) fail("TERMINAL_NO_READER");
    const intent = await cancelRemote(session, reader);
    return databaseTransaction(async (store) => {
      const current = await payment(input, store, true);
      return dto(active(current) ? await reconcile(current, intent, store) : current, store, intent);
    });
  });

  return { startPayment, getPaymentStatus, cancelPayment, startStandalonePayment,
    getStandalonePaymentStatus: input => getPaymentStatus({ ...input, paymentKind: "standalone" }),
    cancelStandalonePayment: input => cancelPayment({ ...input, paymentKind: "standalone" }) };
};

module.exports = { buildStripeTerminalPaymentService, TerminalPaymentError };
