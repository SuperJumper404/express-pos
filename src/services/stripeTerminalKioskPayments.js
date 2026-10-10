const { toStripeAmount } = require("../helpers/stripePayment");
const {
  TERMINAL_PAYMENT_METHOD,
  calculateTerminalApplicationFee,
  buildTerminalPaymentIntentParams,
} = require("../helpers/stripeTerminal");
const { TerminalPaymentError } = require("./stripeTerminalPayments");
const {
  buildTerminalCardTicket,
  terminalCardReceiptDetails,
  serializeTerminalCardReceiptDetails,
} = require("../helpers/stripeTerminalCardTicket");

const COUNTER_PAYMENT_METHOD = "Paiement au comptoir";

const fail = (code) => { throw new TerminalPaymentError(code); };

const positiveId = (value) => {
  if (!((typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value)))
    && Number.isSafeInteger(Number(value)) && Number(value) > 0)) fail("TERMINAL_INVALID_INPUT");
  return Number(value);
};

const active = (session) => ["creating", "processing"].includes(session.status);

const matchingAction = (reader, intentId) => reader.action
  && reader.action.type === "process_payment_intent"
  && reader.action.process_payment_intent
  && reader.action.process_payment_intent.payment_intent === intentId;

const cancelable = (intent) => ["requires_payment_method", "requires_confirmation",
  "requires_action", "requires_capture"].includes(intent.status);

const pickCheckoutPayload = (body = {}) => {
  const allowed = [
    "customer", "customerID", "phone", "remark", "items", "expected_total",
    "discount_type", "discount_value", "is_takeaway", "client_order_token",
  ];
  return allowed.reduce((result, key) => {
    if (body[key] !== undefined) result[key] = body[key];
    return result;
  }, {});
};

const safeCardTicket = (session, intent) => {
  if (session.status !== "succeeded" && (!intent || intent.status !== "succeeded")) return null;
  return buildTerminalCardTicket(session, intent);
};
const recoverableActivePaymentAgeMs = 120 * 1000;
const recoverableIntentStatus = (intent) => ["succeeded", "canceled"].includes(intent.status);
const oldEnoughForRecovery = (session) => {
  const createdAt = new Date(session.created_at).getTime();
  return Number.isFinite(createdAt) && Date.now() - createdAt >= recoverableActivePaymentAgeMs;
};

const buildStripeTerminalKioskPaymentService = ({
  stripe,
  terminalStore,
  checkout,
  shopStore,
  orderArchive = null,
}) => {
  const databaseTransaction = async (work, run = terminalStore.withTransaction) => {
    for (let attempt = 1; ; attempt += 1) {
      try { return await run(work); } catch (error) {
        const contention = ["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"].includes(error.code)
          || [1213, 1205].includes(error.errno);
        if (!contention || attempt === 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, attempt * 10));
      }
    }
  };

  const safe = (operation) => async (input) => {
    try { return await operation(input); } catch (error) {
      if (error instanceof TerminalPaymentError) throw error;
      fail("TERMINAL_INTERNAL_ERROR");
    }
  };

  const stripeCall = async (operation) => {
    try { return await operation(); } catch (error) { fail("TERMINAL_STRIPE_ERROR"); }
  };

  const resolveReader = async ({ shopId, servicePointId }) => {
    const reader = await terminalStore.findAssignedReaderByServicePoint({ shopId, servicePointId });
    if (!reader) fail("TERMINAL_NO_READER");
    return reader;
  };

  const readerDto = (reader) => (reader ? {
    id: reader.id,
    label: reader.label || null,
    status: reader.status || null,
    stripeReaderId: reader.stripe_reader_id,
  } : null);

  const orderForSession = async (session, store = terminalStore) => {
    const allocations = await store.listPaymentAllocations({
      shopId: session.shopid,
      paymentId: session.id,
    });
    const allocation = allocations[0] || null;
    const order = allocation && store.findKioskTerminalOrder
      ? await store.findKioskTerminalOrder({ shopId: session.shopid, orderId: allocation.order_id })
      : null;
    return { allocations, order };
  };

  const dto = async (session, store = terminalStore, intent = null) => {
    const { allocations, order } = await orderForSession(session, store);
    const outcome = session.status === "succeeded" ? "paid"
      : session.status === "failed" ? "failed"
        : session.status === "canceled" ? "canceled"
          : "pending";
    return {
      id: session.id,
      orderId: order ? order.id : (allocations[0] || {}).order_id || null,
      orderNumber: order ? order.ordernumber || null : null,
      readerId: session.terminal_reader_id,
      status: session.status,
      amountCents: session.amount_cents,
      currency: session.currency,
      orderIds: allocations.map((allocation) => allocation.order_id),
      outcome,
      cardTicket: outcome === "paid" ? safeCardTicket(session, intent) : null,
    };
  };

  const payment = async ({ shopId, servicePointId, paymentId }, store = terminalStore, forUpdate = false) => {
    const session = forUpdate && store.lockPaymentSession
      ? (await store.lockPaymentSession({ shopId, paymentId })).payment
      : await store.findPaymentSession({ shopId, paymentId });
    if (!session || Number(session.shopid) !== shopId) fail("TERMINAL_PAYMENT_NOT_FOUND");
    const { order } = await orderForSession(session, store);
    if (!order) {
      if (!active(session)) return session;
      fail("TERMINAL_PAYMENT_NOT_FOUND");
    }
    if (Number(order.shopid) !== shopId
      || (order.service_point_id != null && Number(order.service_point_id) !== servicePointId)) {
      fail("TERMINAL_PAYMENT_NOT_FOUND");
    }
    return session;
  };

  const update = (session, values, store = terminalStore) => store.updatePaymentSession({
    shopId: session.shopid,
    paymentId: session.id,
    ...values,
  });

  const commitReservations = async (orderIds) => {
    if (!checkout.finalizeReservations) return;
    for (const orderId of orderIds) {
      await checkout.finalizeReservations({ orderId, status: "commit", operator: 0 });
    }
  };

  const releaseReservations = async (orderIds) => {
    if (!checkout.finalizeReservations) return;
    for (const orderId of orderIds) {
      await checkout.finalizeReservations({ orderId, status: "release", operator: 0 });
    }
  };

  const markCounterFallback = async (session, status, store = terminalStore) => {
    await store.markKioskPaymentCounterFallback({
      shopId: session.shopid,
      paymentId: session.id,
      status,
      payment: COUNTER_PAYMENT_METHOD,
    });
    const allocations = await store.listPaymentAllocations({ shopId: session.shopid, paymentId: session.id });
    await commitReservations(allocations.map((allocation) => allocation.order_id));
    return store.findPaymentSession({ shopId: session.shopid, paymentId: session.id });
  };

  const markExplicitCancel = async (session, store = terminalStore) => {
    await update(session, { status: "canceled" }, store);
    return store.findPaymentSession({ shopId: session.shopid, paymentId: session.id });
  };

  const removePreparedKioskOrders = async (session, store = terminalStore) => {
    const allocations = await store.listPaymentAllocations({
      shopId: session.shopid,
      paymentId: session.id,
    });
    const orderIds = [...new Set(allocations.map((allocation) => allocation.order_id))];
    if (!orderIds.length) return;
    await releaseReservations(orderIds);
    if (!orderArchive || typeof orderArchive.hideOrder !== "function") return;
    for (const orderId of orderIds) {
      await orderArchive.hideOrder({ shopId: session.shopid, orderId });
    }
  };

  const reconcile = async (session, intent, store) => {
    if (!intent || intent.id !== session.stripe_payment_intent_id
      || intent.amount !== session.amount_cents
      || intent.currency !== session.currency
      || !intent.metadata
      || intent.metadata.terminal_payment_id !== String(session.id)
      || intent.metadata.shop_id !== String(session.shopid)) {
      fail("TERMINAL_STRIPE_ERROR");
    }
    if (intent.status === "succeeded") {
      await store.finalizeKioskPaymentSucceeded({
        shopId: session.shopid,
        paymentId: session.id,
        stripePaymentIntentId: intent.id,
        stripeChargeId: typeof intent.latest_charge === "string"
          ? intent.latest_charge
          : (intent.latest_charge || {}).id || null,
        cardReceiptDetails: serializeTerminalCardReceiptDetails(
          terminalCardReceiptDetails(typeof intent.latest_charge === "object" ? intent.latest_charge : null),
        ),
        timestamp: new Date(),
        payment: TERMINAL_PAYMENT_METHOD,
      });
      const allocations = await store.listPaymentAllocations({ shopId: session.shopid, paymentId: session.id });
      await commitReservations(allocations.map((allocation) => allocation.order_id));
    } else if (intent.status === "canceled") {
      await markCounterFallback(session, "canceled", store);
    }
    return store.findPaymentSession({ shopId: session.shopid, paymentId: session.id });
  };
  const recoverActivePayment = async (session) => {
    if (!session.stripe_payment_intent_id || !oldEnoughForRecovery(session)) return false;
    const intent = await stripeCall(() => stripe.paymentIntents.retrieve(session.stripe_payment_intent_id));
    if (!recoverableIntentStatus(intent)) return false;
    await databaseTransaction(
      async (transactionStore) => reconcile(session, intent, transactionStore),
      terminalStore.withTransaction,
    );
    return true;
  };

  const cancelRemote = async (session, reader, store = terminalStore) => {
    const remote = await stripeCall(() => stripe.terminal.readers.retrieve(reader.stripe_reader_id));
    let intent = await stripeCall(() => stripe.paymentIntents.retrieve(session.stripe_payment_intent_id));
    if (matchingAction(remote, session.stripe_payment_intent_id) && remote.action.status === "in_progress") {
      await stripeCall(() => stripe.terminal.readers.cancelAction(reader.stripe_reader_id, {}, {
        idempotencyKey: `${session.idempotency_key}:cancel-action`,
      }));
      intent = await stripeCall(() => stripe.paymentIntents.retrieve(session.stripe_payment_intent_id));
    }
    if (active(session) && cancelable(intent)) {
      intent = await stripeCall(() => stripe.paymentIntents.cancel(intent.id, {}, {
        idempotencyKey: `${session.idempotency_key}:cancel`,
      }));
    }
    return intent;
  };

  const createPayment = async ({ session, reader }, store) => {
    try {
      const remote = await stripeCall(() => stripe.terminal.readers.retrieve(reader.stripe_reader_id));
      if (remote.status !== "online") fail("TERMINAL_READER_OFFLINE");
      if (remote.action && remote.action.status === "in_progress") fail("TERMINAL_READER_BUSY");

      const intent = await stripeCall(() => stripe.paymentIntents.create(buildTerminalPaymentIntentParams({
        totalCents: session.amount_cents,
        applicationFeeAmount: session.application_fee_amount,
        connectedAccountId: session.stripe_connected_account_id,
        terminalPaymentId: session.id,
        shopId: session.shopid,
      }), { idempotencyKey: session.idempotency_key }));
      session.stripe_payment_intent_id = intent.id;
      await databaseTransaction((transactionStore) => update(session, {
        stripePaymentIntentId: intent.id,
      }, transactionStore), store.withTransaction);
      const handedOff = await store.withReaderActionLock({ shopId: session.shopid, readerId: reader.id }, async () => {
        await stripeCall(() => stripe.terminal.readers.processPaymentIntent(reader.stripe_reader_id, {
          payment_intent: intent.id,
        }, { idempotencyKey: `${session.idempotency_key}:process` }));
        await databaseTransaction((transactionStore) => update(session, {
          status: "processing",
        }, transactionStore), store.withTransaction);
      });
      if (handedOff === null) fail("TERMINAL_READER_BUSY");
    } catch (error) {
      if (session.stripe_payment_intent_id) {
        const remoteIntent = await cancelRemote(session, reader, store);
        if (remoteIntent.status === "succeeded") {
          return databaseTransaction(async (transactionStore) => (
            dto(await reconcile(session, remoteIntent, transactionStore), transactionStore, remoteIntent)
          ), store.withTransaction);
        }
      }
      return databaseTransaction(async (transactionStore) => (
        dto(await markCounterFallback(session, "failed", transactionStore), transactionStore)
      ), store.withTransaction);
    }
    return dto(await store.findPaymentSession({ shopId: session.shopid, paymentId: session.id }), store);
  };

  const getCurrentReader = safe(async (input) => {
    const shopId = positiveId(input.shopId);
    const servicePointId = positiveId(input.servicePointId);
    const reader = await terminalStore.findAssignedReaderByServicePoint({ shopId, servicePointId });
    return readerDto(reader);
  });

  const startPaymentAttempt = async (input, recovered = false) => {
    const shopId = positiveId(input.shopId);
    const servicePointId = positiveId(input.servicePointId);
    const reader = await resolveReader({ shopId, servicePointId });
    const body = pickCheckoutPayload(input.checkoutPayload || {});
    const normalized = checkout.normalizeCheckoutRequestBody
      ? checkout.normalizeCheckoutRequestBody(body, { paymentModeOverride: "stripe_terminal_kiosk" })
      : { ...body, paymentMode: "stripe_terminal_kiosk" };
    const checkoutResult = await checkout.createCheckout({
      ...normalized,
      shopId,
      sessionSubject: "service_point",
      servicePointId,
      orderSource: "borne",
      paymentMode: "stripe_terminal_kiosk",
    });
    const order = await terminalStore.findKioskTerminalOrder({
      shopId,
      orderId: positiveId(checkoutResult.orderId),
    });
    if (!order) fail("TERMINAL_INVALID_ORDERS");
    const existing = await terminalStore.findActiveKioskPaymentForOrder({
      shopId,
      orderId: order.id,
      servicePointId,
    });
    if (existing) return dto(existing);

    const shop = await shopStore.findShop({ shopId });
    if (!shop || Number(shop.id) !== shopId || !shop.stripe_account_id
      || Number(shop.stripe_charges_enabled) !== 1) fail("TERMINAL_CONNECT_NOT_READY");
    const amountCents = toStripeAmount(order.subtotal);
    if (amountCents < 50) fail("TERMINAL_INVALID_INPUT");
    const applicationFeeAmount = calculateTerminalApplicationFee(amountCents, shop.stripe_commission_percent);
    const idempotencyToken = String(normalized.clientOrderToken || body.client_order_token || order.id);
    const reserved = await databaseTransaction(async (store) => {
      const activePayment = await store.findActiveKioskPaymentForOrder({
        shopId,
        orderId: order.id,
        servicePointId,
      });
      if (activePayment) return { existing: await dto(activePayment, store) };
      const activeReaderPayment = await store.findActivePaymentForReader({
        shopId,
        readerId: reader.id,
      });
      if (activeReaderPayment) return { activeReaderPayment };
      let saved;
      try {
        saved = await store.createKioskPaymentSession({
          shopId,
          readerId: reader.id,
          servicePointId,
          idempotencyKey: `terminal-kiosk:${shopId}:${servicePointId}:${idempotencyToken}`,
          connectedAccountId: shop.stripe_account_id,
          amountCents,
          applicationFeeAmount,
          currency: "eur",
        });
      } catch (error) {
        if (error && (error.code === "ER_DUP_ENTRY" || error.errno === 1062)) {
          fail("TERMINAL_READER_BUSY");
        }
        throw error;
      }
      if (!saved || saved.affectedRows !== 1 || !Number.isSafeInteger(saved.insertId)) {
        fail("TERMINAL_INTERNAL_ERROR");
      }
      await store.createAllocations({
        shopId,
        paymentId: saved.insertId,
        allocations: [{ orderId: order.id, amountCents }],
      });
      return {
        session: await store.findPaymentSession({ shopId, paymentId: saved.insertId }),
      };
    });
    if (reserved.activeReaderPayment) {
      if (await recoverActivePayment(reserved.activeReaderPayment)) {
        if (recovered) fail("TERMINAL_RECOVERY_REQUIRED");
        return startPaymentAttempt(input, true);
      }
      fail("TERMINAL_READER_BUSY");
    }
    if (reserved.existing) return reserved.existing;
    const result = await terminalStore.withPaymentCreationLock({
      shopId,
      paymentId: reserved.session.id,
    }, async (store) => {
      const current = await payment({
        shopId,
        servicePointId,
        paymentId: reserved.session.id,
      }, store);
      if (current.status !== "creating" || current.stripe_payment_intent_id) return dto(current, store);
      return createPayment({ session: current, reader }, store);
    });
    return result || dto(await payment({ shopId, servicePointId, paymentId: reserved.session.id }));
  };
  const startPayment = safe((input) => startPaymentAttempt(input));

  const getPaymentStatus = safe(async (input) => {
    const shopId = positiveId(input.shopId);
    const servicePointId = positiveId(input.servicePointId);
    const paymentId = positiveId(input.paymentId);
    const session = await payment({ shopId, servicePointId, paymentId });
    if (!active(session) || !session.stripe_payment_intent_id) return dto(session);
    let intent = await stripeCall(() => stripe.paymentIntents.retrieve(session.stripe_payment_intent_id));
    let failedAction = false;
    if (session.status === "processing" && intent.status === "requires_payment_method") {
      const reader = await terminalStore.findReader({ shopId, readerId: session.terminal_reader_id });
      if (!reader) fail("TERMINAL_NO_READER");
      const remote = await stripeCall(() => stripe.terminal.readers.retrieve(reader.stripe_reader_id));
      failedAction = matchingAction(remote, intent.id) && remote.action.status === "failed";
      if (failedAction) intent = await cancelRemote(session, reader);
    }
    return databaseTransaction(async (store) => {
      const current = await payment({ shopId, servicePointId, paymentId }, store, true);
      if (!active(current)) return dto(current, store, intent);
      if (failedAction) return dto(await markCounterFallback(current, "failed", store), store, intent);
      return dto(await reconcile(current, intent, store), store, intent);
    });
  });

  const cancelPayment = safe(async (input) => {
    const shopId = positiveId(input.shopId);
    const servicePointId = positiveId(input.servicePointId);
    const paymentId = positiveId(input.paymentId);
    const session = await payment({ shopId, servicePointId, paymentId });
    if (!active(session)) return dto(session);
    if (session.status === "creating" || !session.stripe_payment_intent_id) fail("TERMINAL_PAYMENT_CREATING");
    const reader = await terminalStore.findReader({ shopId, readerId: session.terminal_reader_id });
    if (!reader) fail("TERMINAL_NO_READER");
    const intent = await cancelRemote(session, reader);
    const canceled = await databaseTransaction(async (store) => {
      const current = await payment({ shopId, servicePointId, paymentId }, store, true);
      if (!active(current)) return current;
      return intent.status === "canceled"
        ? markExplicitCancel(current, store)
        : reconcile(current, intent, store);
    });
    if (active(session) && canceled.status === "canceled") {
      await removePreparedKioskOrders(canceled);
    }
    return dto(canceled, terminalStore, intent);
  });

  return {
    getCurrentReader,
    startPayment,
    getPaymentStatus,
    cancelPayment,
  };
};

module.exports = { buildStripeTerminalKioskPaymentService };
