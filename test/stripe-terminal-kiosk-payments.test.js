const assert = require("assert");
const { buildStripeTerminalKioskPaymentService } = require("../src/services/stripeTerminalKioskPayments");

const tests = [];
const test = (name, run) => tests.push({ name, run });
const clone = (value) => JSON.parse(JSON.stringify(value));

const fixture = () => {
  const state = {
    reader: {
      id: 21,
      shopid: 7,
      assigned_service_point_id: 4,
      is_active: 1,
      stripe_reader_id: "tmr_kiosk",
      status: "online",
      label: "Borne 1",
    },
    shop: {
      id: 7,
      stripe_account_id: "acct_shop",
      stripe_charges_enabled: 1,
      stripe_commission_percent: 5,
    },
    orders: [],
    sessions: [],
    allocations: [],
    archivedOrders: [],
    calls: [],
    remote: { id: "tmr_kiosk", status: "online", action: null },
    intent: null,
  };

  const terminalStore = {
    withTransaction: async (work) => work(terminalStore),
    withPaymentCreationLock: async (scope, work) => work(terminalStore),
    withReaderActionLock: async (scope, work) => work(terminalStore),
    findAssignedReaderByServicePoint: async ({ shopId, servicePointId }) => (
      state.reader
      && state.reader.shopid === shopId
      && state.reader.assigned_service_point_id === servicePointId
      && state.reader.is_active === 1
        ? clone(state.reader)
        : null
    ),
    findReader: async ({ shopId, readerId }) => (
      state.reader && state.reader.shopid === shopId && state.reader.id === readerId
        ? clone(state.reader)
        : null
    ),
    findKioskTerminalOrder: async ({ shopId, orderId }) => clone(
      state.orders.find((order) => order.shopid === shopId && order.id === orderId) || null,
    ),
    findActiveKioskPaymentForOrder: async ({ shopId, orderId }) => clone(
      state.sessions.find((session) => (
        session.shopid === shopId
        && ["creating", "processing", "succeeded"].includes(session.status)
        && state.allocations.some((allocation) => (
          allocation.terminal_payment_id === session.id
          && allocation.shopid === shopId
          && allocation.order_id === orderId
        ))
      )) || null,
    ),
    findActivePaymentForReader: async ({ shopId, readerId }) => clone(
      state.sessions.find((session) => (
        session.shopid === shopId
        && session.terminal_reader_id === readerId
        && ["creating", "processing"].includes(session.status)
      )) || null,
    ),
    createKioskPaymentSession: async (data) => {
      const id = 41 + state.sessions.length;
      state.sessions.push({
        id,
        shopid: data.shopId,
        terminal_reader_id: data.readerId,
        cashier_user_id: 0,
        idempotency_key: data.idempotencyKey,
        stripe_connected_account_id: data.connectedAccountId,
        amount_cents: data.amountCents,
        application_fee_amount: data.applicationFeeAmount,
        currency: data.currency || "eur",
        status: "creating",
        stripe_payment_intent_id: null,
        stripe_charge_id: null,
        created_at: new Date().toISOString(),
      });
      return { affectedRows: 1, insertId: id };
    },
    createAllocations: async ({ shopId, paymentId, allocations }) => {
      state.allocations.push(...allocations.map((allocation) => ({
        shopid: shopId,
        terminal_payment_id: paymentId,
        order_id: allocation.orderId,
        amount_cents: allocation.amountCents,
      })));
    },
    listPaymentAllocations: async ({ shopId, paymentId }) => clone(
      state.allocations.filter((allocation) => (
        allocation.shopid === shopId && allocation.terminal_payment_id === paymentId
      )),
    ),
    findPaymentSession: async ({ shopId, paymentId }) => clone(
      state.sessions.find((session) => session.shopid === shopId && session.id === paymentId) || null,
    ),
    lockPaymentSession: async ({ shopId, paymentId }) => ({
      payment: await terminalStore.findPaymentSession({ shopId, paymentId }),
      allocations: await terminalStore.listPaymentAllocations({ shopId, paymentId }),
    }),
    updatePaymentSession: async (data) => {
      const session = state.sessions.find((row) => row.shopid === data.shopId && row.id === data.paymentId);
      if (!session) return { affectedRows: 0 };
      if (data.stripePaymentIntentId !== undefined) session.stripe_payment_intent_id = data.stripePaymentIntentId;
      if (data.stripeChargeId !== undefined) session.stripe_charge_id = data.stripeChargeId;
      if (data.cardReceiptDetails !== undefined) session.card_receipt_details = data.cardReceiptDetails;
      if (data.status !== undefined) session.status = data.status;
      if (data.failureCode !== undefined) session.failure_code = data.failureCode;
      if (data.failureMessage !== undefined) session.failure_message = data.failureMessage;
      return { affectedRows: 1 };
    },
    finalizeKioskPaymentSucceeded: async ({ shopId, paymentId, stripePaymentIntentId, stripeChargeId, cardReceiptDetails }) => {
      const session = state.sessions.find((row) => row.shopid === shopId && row.id === paymentId);
      assert.strictEqual(session.stripe_payment_intent_id, stripePaymentIntentId);
      session.status = "succeeded";
      session.stripe_charge_id = stripeChargeId;
      session.card_receipt_details = cardReceiptDetails;
      for (const allocation of state.allocations.filter((row) => row.terminal_payment_id === paymentId)) {
        const order = state.orders.find((row) => row.id === allocation.order_id);
        order.status = 3;
        order.payment = "Carte bancaire - TPE Stripe";
        order.payment_status = "paid";
        order.payment_provider = "stripe_terminal";
        order.stripe_terminal_payment_id = paymentId;
      }
      state.calls.push({ name: "finalize-success", args: [{ shopId, paymentId, stripePaymentIntentId, stripeChargeId, cardReceiptDetails }] });
      return { finalized: true };
    },
    markKioskPaymentCounterFallback: async ({ shopId, paymentId, status }) => {
      const session = state.sessions.find((row) => row.shopid === shopId && row.id === paymentId);
      session.status = status;
      for (const allocation of state.allocations.filter((row) => row.terminal_payment_id === paymentId)) {
        const order = state.orders.find((row) => row.id === allocation.order_id);
        order.status = 3;
        order.payment = "Paiement au comptoir";
        order.payment_status = "unpaid";
        order.payment_provider = null;
        order.stripe_terminal_payment_id = null;
      }
      state.calls.push({ name: "counter-fallback", args: [{ shopId, paymentId, status }] });
      return { fallback: true };
    },
  };

  const checkout = {
    normalizeCheckoutRequestBody: (body, options) => {
      state.calls.push({ name: "normalize", args: [clone(body), clone(options)] });
      return {
        customer: body.customer,
        items: body.items,
        expectedTotal: body.expected_total,
        clientOrderToken: body.client_order_token,
        paymentMode: options.paymentModeOverride,
      };
    },
    createCheckout: async (input) => {
      state.calls.push({ name: "checkout", args: [clone(input)] });
      const existing = state.orders.find((order) => order.client_order_token === input.clientOrderToken);
      if (existing) return {
        orderId: existing.id,
        total: Number(existing.subtotal),
        payment_status: existing.payment_status,
        idempotent_replay: true,
      };
      const id = 100 + state.orders.length;
      state.orders.push({
        id,
        shopid: input.shopId,
        ordernumber: `B${id}`,
        subtotal: "20.00",
        payment: "Carte bancaire - TPE Stripe",
        payment_status: "requires_payment",
        payment_provider: "stripe_terminal",
        stripe_terminal_payment_id: null,
        status: 1,
        client_order_token: input.clientOrderToken,
      });
      return { orderId: id, total: 20, payment_status: "requires_payment", idempotent_replay: false };
    },
    finalizeReservations: async ({ orderId, status, operator }) => {
      state.calls.push({ name: "reservations", args: [{ orderId, status, operator }] });
      return { orderId, status };
    },
  };

  const orderArchive = {
    hideOrder: async ({ shopId, orderId }) => {
      const index = state.orders.findIndex((order) => order.shopid === shopId && order.id === orderId);
      if (index < 0) throw new Error("Commande introuvable");
      state.archivedOrders.push(state.orders[index]);
      state.orders.splice(index, 1);
      state.calls.push({ name: "archive-order", args: [{ shopId, orderId }] });
      return { affectedRows: 1 };
    },
  };

  const call = (name, run) => async (...args) => {
    state.calls.push({ name, args: clone(args) });
    return run(...args);
  };
  const stripe = {
    paymentIntents: {
      create: call("create-intent", (params, options) => {
        state.intent = {
          ...params,
          id: "pi_kiosk",
          status: "requires_payment_method",
          latest_charge: null,
        };
        assert.strictEqual(options.idempotencyKey, state.sessions.at(-1).idempotency_key);
        return clone(state.intent);
      }),
      retrieve: call("retrieve-intent", () => clone(state.intent)),
      cancel: call("cancel-intent", (id) => {
        state.intent.status = "canceled";
        return clone(state.intent);
      }),
    },
    terminal: {
      readers: {
        retrieve: call("retrieve-reader", () => clone(state.remote)),
        processPaymentIntent: call("process", (readerId, params) => {
          state.remote.action = {
            type: "process_payment_intent",
            status: "in_progress",
            process_payment_intent: { payment_intent: params.payment_intent },
          };
          return clone(state.remote);
        }),
        cancelAction: call("cancel-action", () => {
          state.remote.action = null;
          return clone(state.remote);
        }),
      },
    },
  };
  const shopStore = {
    findShop: async ({ shopId }) => (state.shop && state.shop.id === shopId ? clone(state.shop) : null),
  };

  return {
    state,
    terminalStore,
    stripe,
    checkout,
    shopStore,
    service: buildStripeTerminalKioskPaymentService({
      stripe,
      terminalStore,
      checkout,
      shopStore,
      orderArchive,
    }),
  };
};

const checkoutPayload = {
  customer: { name: "Ada" },
  items: [{ product_id: 1, quantity: 2 }],
  expected_total: 20,
  client_order_token: "borne-token-1",
  payment_mode: "attacker",
  readerId: 999,
  amountCents: 1,
};
const rejects = (run, code) => assert.rejects(run, (error) => {
  assert.strictEqual(error.code, code);
  return true;
});

test("gets the active reader assigned to this kiosk service point", async () => {
  const f = fixture();
  assert.deepStrictEqual(await f.service.getCurrentReader({ shopId: 7, servicePointId: 4 }), {
    id: 21,
    label: "Borne 1",
    status: "online",
    stripeReaderId: "tmr_kiosk",
  });
  assert.strictEqual(await f.service.getCurrentReader({ shopId: 7, servicePointId: 5 }), null);
});

test("starts one kiosk order and one Terminal PaymentIntent on the assigned reader", async () => {
  const f = fixture();
  const result = await f.service.startPayment({ shopId: 7, servicePointId: 4, checkoutPayload });
  assert.strictEqual(f.state.orders.length, 1);
  assert.strictEqual(f.state.sessions.length, 1);
  assert.strictEqual(f.state.calls.filter((call) => call.name === "create-intent").length, 1);
  assert.strictEqual(f.state.calls.find((call) => call.name === "normalize").args[1].paymentModeOverride, "stripe_terminal_kiosk");
  const checkoutInput = f.state.calls.find((call) => call.name === "checkout").args[0];
  assert.strictEqual(checkoutInput.shopId, 7);
  assert.strictEqual(checkoutInput.servicePointId, 4);
  assert.strictEqual(checkoutInput.sessionSubject, "service_point");
  assert.strictEqual(checkoutInput.orderSource, "borne");
  assert.strictEqual(checkoutInput.paymentMode, "stripe_terminal_kiosk");
  assert.strictEqual(f.state.calls.find((call) => call.name === "process").args[0], "tmr_kiosk");
  assert.strictEqual(f.state.calls.find((call) => call.name === "create-intent").args[0].amount, 2000);
  assert.deepStrictEqual(result, {
    id: 41,
    orderId: 100,
    orderNumber: "B100",
    readerId: 21,
    status: "processing",
    amountCents: 2000,
    currency: "eur",
    orderIds: [100],
    outcome: "pending",
    cardTicket: null,
  });
  assert(!JSON.stringify(f.state.calls).includes("999"));
});

test("replays the same client order token without creating a second PaymentIntent", async () => {
  const f = fixture();
  const first = await f.service.startPayment({ shopId: 7, servicePointId: 4, checkoutPayload });
  const replay = await f.service.startPayment({ shopId: 7, servicePointId: 4, checkoutPayload });
  assert.strictEqual(replay.id, first.id);
  assert.strictEqual(f.state.orders.length, 1);
  assert.strictEqual(f.state.sessions.length, 1);
  assert.strictEqual(f.state.calls.filter((call) => call.name === "create-intent").length, 1);
});

test("rejects a kiosk start when the assigned reader has another active payment", async () => {
  const f = fixture();
  f.state.sessions.push({
    id: 99,
    shopid: 7,
    terminal_reader_id: 21,
    cashier_user_id: 0,
    idempotency_key: "terminal-kiosk:7:4:other",
    stripe_connected_account_id: "acct_shop",
    amount_cents: 2000,
    application_fee_amount: 100,
    currency: "eur",
    status: "processing",
    stripe_payment_intent_id: "pi_other",
    stripe_charge_id: null,
  });
  await rejects(
    () => f.service.startPayment({ shopId: 7, servicePointId: 4, checkoutPayload }),
    "TERMINAL_READER_BUSY",
  );
  assert.strictEqual(f.state.calls.filter((call) => call.name === "create-intent").length, 0);
  assert.strictEqual(f.state.sessions.length, 1);
});

test("reconciles a canceled active reader payment before starting a kiosk payment", async () => {
  const f = fixture();
  f.state.orders.push({
    id: 99,
    shopid: 7,
    ordernumber: "B99",
    subtotal: "20.00",
    payment: "Carte bancaire - TPE Stripe",
    payment_status: "requires_payment",
    payment_provider: "stripe_terminal",
    stripe_terminal_payment_id: null,
    status: 1,
    client_order_token: "old-token",
  });
  f.state.sessions.push({
    id: 40,
    shopid: 7,
    terminal_reader_id: 21,
    cashier_user_id: 0,
    idempotency_key: "terminal-kiosk:7:4:old",
    stripe_connected_account_id: "acct_shop",
    amount_cents: 2000,
    application_fee_amount: 100,
    currency: "eur",
    status: "processing",
    stripe_payment_intent_id: "pi_old",
    stripe_charge_id: null,
    created_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  });
  f.state.allocations.push({
    shopid: 7,
    terminal_payment_id: 40,
    order_id: 99,
    amount_cents: 2000,
  });
  f.state.intent = {
    id: "pi_old",
    amount: 2000,
    currency: "eur",
    status: "canceled",
    metadata: { terminal_payment_id: "40", shop_id: "7" },
    latest_charge: null,
  };
  const result = await f.service.startPayment({ shopId: 7, servicePointId: 4, checkoutPayload });
  assert.strictEqual(f.state.sessions[0].status, "canceled");
  assert.strictEqual(result.id, 42);
  assert.strictEqual(result.status, "processing");
  assert(f.state.calls.some((call) => call.name === "retrieve-intent" && call.args[0] === "pi_old"));
});

test("cleans a stale cancelable kiosk reader payment before starting a new one", async () => {
  const f = fixture();
  f.state.orders.push({
    id: 99,
    shopid: 7,
    ordernumber: "B99",
    subtotal: "20.00",
    payment: "Carte bancaire - TPE Stripe",
    payment_status: "requires_payment",
    payment_provider: "stripe_terminal",
    stripe_terminal_payment_id: null,
    status: 1,
    client_order_token: "old-token",
  });
  f.state.sessions.push({
    id: 40,
    shopid: 7,
    terminal_reader_id: 21,
    cashier_user_id: 0,
    idempotency_key: "terminal-kiosk:7:4:old",
    stripe_connected_account_id: "acct_shop",
    amount_cents: 2000,
    application_fee_amount: 100,
    currency: "eur",
    status: "processing",
    stripe_payment_intent_id: "pi_old",
    stripe_charge_id: null,
    created_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  });
  f.state.allocations.push({
    shopid: 7,
    terminal_payment_id: 40,
    order_id: 99,
    amount_cents: 2000,
  });
  f.state.intent = {
    id: "pi_old",
    amount: 2000,
    currency: "eur",
    status: "requires_payment_method",
    metadata: { terminal_payment_id: "40", shop_id: "7" },
    latest_charge: null,
  };
  f.state.remote.action = {
    type: "process_payment_intent",
    status: "in_progress",
    process_payment_intent: { payment_intent: "pi_old" },
  };
  const result = await f.service.startPayment({ shopId: 7, servicePointId: 4, checkoutPayload });
  assert.strictEqual(f.state.sessions[0].status, "canceled");
  assert.deepStrictEqual(f.state.archivedOrders.map((order) => order.id), [99]);
  assert.deepStrictEqual(
    f.state.calls.filter((call) => call.name === "reservations").map((call) => call.args[0]),
    [{ orderId: 99, status: "release", operator: 0 }],
  );
  assert(f.state.calls.some((call) => call.name === "cancel-action"));
  assert(f.state.calls.some((call) => call.name === "cancel-intent" && call.args[0] === "pi_old"));
  assert.strictEqual(result.id, 42);
  assert.strictEqual(result.status, "processing");
});

test("cleans a stale kiosk preparation without a Stripe intent before starting a new one", async () => {
  const f = fixture();
  f.state.orders.push({
    id: 99,
    shopid: 7,
    ordernumber: "B99",
    subtotal: "20.00",
    payment: "Carte bancaire - TPE Stripe",
    payment_status: "requires_payment",
    payment_provider: "stripe_terminal",
    stripe_terminal_payment_id: null,
    status: 1,
    client_order_token: "old-token",
  });
  f.state.sessions.push({
    id: 40,
    shopid: 7,
    terminal_reader_id: 21,
    cashier_user_id: 0,
    idempotency_key: "terminal-kiosk:7:4:old",
    stripe_connected_account_id: "acct_shop",
    amount_cents: 2000,
    application_fee_amount: 100,
    currency: "eur",
    status: "creating",
    stripe_payment_intent_id: null,
    stripe_charge_id: null,
    created_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  });
  f.state.allocations.push({
    shopid: 7,
    terminal_payment_id: 40,
    order_id: 99,
    amount_cents: 2000,
  });
  const result = await f.service.startPayment({ shopId: 7, servicePointId: 4, checkoutPayload });
  assert.strictEqual(f.state.sessions[0].status, "canceled");
  assert.deepStrictEqual(f.state.archivedOrders.map((order) => order.id), [99]);
  assert.deepStrictEqual(
    f.state.calls.filter((call) => call.name === "reservations").map((call) => call.args[0]),
    [{ orderId: 99, status: "release", operator: 0 }],
  );
  assert.strictEqual(f.state.calls.some((call) => call.name === "cancel-intent"), false);
  assert.strictEqual(result.id, 42);
  assert.strictEqual(result.status, "processing");
});

test("polling expires a kiosk terminal payment after thirty seconds", async () => {
  const f = fixture();
  await f.service.startPayment({ shopId: 7, servicePointId: 4, checkoutPayload });
  f.state.sessions[0].created_at = new Date(Date.now() - 31 * 1000).toISOString();
  f.state.intent.status = "requires_payment_method";
  f.state.remote.action = {
    type: "process_payment_intent",
    status: "in_progress",
    process_payment_intent: { payment_intent: "pi_kiosk" },
  };
  const result = await f.service.getPaymentStatus({ shopId: 7, servicePointId: 4, paymentId: 41 });
  assert.strictEqual(result.outcome, "canceled");
  assert.strictEqual(f.state.sessions[0].status, "canceled");
  assert.deepStrictEqual(f.state.orders, []);
  assert.deepStrictEqual(f.state.archivedOrders.map((order) => order.id), [100]);
  assert.deepStrictEqual(
    f.state.calls.filter((call) => call.name === "reservations").map((call) => call.args[0]),
    [{ orderId: 100, status: "release", operator: 0 }],
  );
  assert(f.state.calls.some((call) => call.name === "cancel-action"));
  assert(f.state.calls.some((call) => call.name === "cancel-intent" && call.args[0] === "pi_kiosk"));
  assert.strictEqual(f.state.calls.some((call) => call.name === "counter-fallback"), false);
});

test("reader lock timeout cancels the kiosk intent and falls back to counter payment", async () => {
  const f = fixture();
  f.terminalStore.withReaderActionLock = async () => null;
  const result = await f.service.startPayment({ shopId: 7, servicePointId: 4, checkoutPayload });
  assert.strictEqual(result.outcome, "failed");
  assert.strictEqual(result.status, "failed");
  assert.strictEqual(f.state.calls.filter((call) => call.name === "process").length, 0);
  assert.strictEqual(f.state.calls.filter((call) => call.name === "cancel-intent").length, 1);
  assert.strictEqual(f.state.orders[0].payment, "Paiement au comptoir");
  assert.strictEqual(f.state.orders[0].payment_status, "unpaid");
});

test("success reconciliation marks the kiosk order paid and exposes only safe card-ticket fields", async () => {
  const f = fixture();
  await f.service.startPayment({ shopId: 7, servicePointId: 4, checkoutPayload });
  f.state.intent.status = "succeeded";
  f.state.intent.latest_charge = {
    id: "ch_terminal",
    payment_method_details: {
      card_present: {
        brand: "visa",
        last4: "4242",
        network: "cartes_bancaires",
        network_transaction_id: "net_123",
        read_method: "contactless_emv",
        generated_card: "raw-secret",
        fingerprint: "raw-fingerprint",
        receipt: {
          authorization_code: "123456",
          authorization_response_code: "00",
          application_preferred_name: "CB",
          dedicated_file_name: "A0000000421010",
          application_cryptogram: "9F2608ABCDEF12345678",
          terminal_verification_results: "8000008000",
          transaction_status_information: "E800",
          cardholder_verification_method: "online_pin",
          account_type: "credit",
        },
      },
    },
  };
  const paid = await f.service.getPaymentStatus({ shopId: 7, servicePointId: 4, paymentId: 41 });
  assert.strictEqual(paid.outcome, "paid");
  assert.deepStrictEqual(paid.cardTicket, {
    brand: "visa",
    last4: "4242",
    network: "cartes_bancaires",
    networkTransactionId: "net_123",
    readMethod: "contactless_emv",
    authorizationCode: "123456",
    authorizationResponseCode: "00",
    applicationPreferredName: "CB",
    dedicatedFileName: "A0000000421010",
    applicationCryptogram: "9F2608ABCDEF12345678",
    terminalVerificationResults: "8000008000",
    transactionStatusInformation: "E800",
    cardholderVerificationMethod: "online_pin",
    accountType: "credit",
    chargeId: "ch_terminal",
    terminalPaymentId: 41,
    amountCents: 2000,
  });
  assert.deepStrictEqual(JSON.parse(f.state.sessions[0].card_receipt_details), {
    brand: "visa",
    last4: "4242",
    network: "cartes_bancaires",
    networkTransactionId: "net_123",
    readMethod: "contactless_emv",
    authorizationCode: "123456",
    authorizationResponseCode: "00",
    applicationPreferredName: "CB",
    dedicatedFileName: "A0000000421010",
    applicationCryptogram: "9F2608ABCDEF12345678",
    terminalVerificationResults: "8000008000",
    transactionStatusInformation: "E800",
    cardholderVerificationMethod: "online_pin",
    accountType: "credit",
  });
  assert.strictEqual(f.state.orders[0].payment_status, "paid");
  assert.strictEqual(f.state.orders[0].payment_provider, "stripe_terminal");
  assert.strictEqual(f.state.orders[0].stripe_terminal_payment_id, 41);
  assert(!JSON.stringify(paid).includes("raw-secret"));
  assert(!JSON.stringify(paid).includes("raw-fingerprint"));
});

test("failed reader action leaves the kiosk order payable at the counter", async () => {
  const f = fixture();
  await f.service.startPayment({ shopId: 7, servicePointId: 4, checkoutPayload });
  f.state.remote.action.status = "failed";
  const result = await f.service.getPaymentStatus({ shopId: 7, servicePointId: 4, paymentId: 41 });
  assert(["failed", "canceled"].includes(result.outcome));
  assert.strictEqual(f.state.orders[0].payment, "Paiement au comptoir");
  assert.strictEqual(f.state.orders[0].payment_status, "unpaid");
  assert.strictEqual(f.state.orders[0].payment_provider, null);
});

test("explicit kiosk cancel cancels the Terminal payment and removes the prepared order", async () => {
  const f = fixture();
  await f.service.startPayment({ shopId: 7, servicePointId: 4, checkoutPayload });
  const result = await f.service.cancelPayment({ shopId: 7, servicePointId: 4, paymentId: 41 });
  assert.strictEqual(result.outcome, "canceled");
  assert.strictEqual(result.orderId, 100);
  assert.deepStrictEqual(f.state.orders, []);
  assert.deepStrictEqual(f.state.archivedOrders.map((order) => order.id), [100]);
  assert(f.state.calls.some((call) => call.name === "cancel-intent"));
  assert(f.state.calls.some((call) => call.name === "archive-order"));
  assert.deepStrictEqual(
    f.state.calls.filter((call) => call.name === "reservations").map((call) => call.args[0]),
    [{ orderId: 100, status: "release", operator: 0 }],
  );
  assert.strictEqual(f.state.calls.some((call) => call.name === "counter-fallback"), false);
});

(async () => {
  for (const { name, run } of tests) {
    await run();
    console.log(`PASS ${name}`);
  }
  console.log(`stripe terminal kiosk payment tests passed (${tests.length} tests)`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
