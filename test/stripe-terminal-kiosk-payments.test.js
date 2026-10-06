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
      if (data.status !== undefined) session.status = data.status;
      if (data.failureCode !== undefined) session.failure_code = data.failureCode;
      if (data.failureMessage !== undefined) session.failure_message = data.failureMessage;
      return { affectedRows: 1 };
    },
    finalizeKioskPaymentSucceeded: async ({ shopId, paymentId, stripePaymentIntentId, stripeChargeId }) => {
      const session = state.sessions.find((row) => row.shopid === shopId && row.id === paymentId);
      assert.strictEqual(session.stripe_payment_intent_id, stripePaymentIntentId);
      session.status = "succeeded";
      session.stripe_charge_id = stripeChargeId;
      for (const allocation of state.allocations.filter((row) => row.terminal_payment_id === paymentId)) {
        const order = state.orders.find((row) => row.id === allocation.order_id);
        order.status = 3;
        order.payment = "Carte bancaire - TPE Stripe";
        order.payment_status = "paid";
        order.payment_provider = "stripe_terminal";
        order.stripe_terminal_payment_id = paymentId;
      }
      state.calls.push({ name: "finalize-success", args: [{ shopId, paymentId, stripePaymentIntentId, stripeChargeId }] });
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
        assert.strictEqual(options.idempotencyKey, state.sessions[0].idempotency_key);
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
    service: buildStripeTerminalKioskPaymentService({
      stripe,
      terminalStore,
      checkout,
      shopStore,
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
        generated_card: "raw-secret",
      },
    },
  };
  const paid = await f.service.getPaymentStatus({ shopId: 7, servicePointId: 4, paymentId: 41 });
  assert.strictEqual(paid.outcome, "paid");
  assert.deepStrictEqual(paid.cardTicket, {
    brand: "visa",
    last4: "4242",
    chargeId: "ch_terminal",
    terminalPaymentId: 41,
    amountCents: 2000,
  });
  assert.strictEqual(f.state.orders[0].payment_status, "paid");
  assert.strictEqual(f.state.orders[0].payment_provider, "stripe_terminal");
  assert.strictEqual(f.state.orders[0].stripe_terminal_payment_id, 41);
  assert(!JSON.stringify(paid).includes("raw-secret"));
});

for (const [name, action] of [
  ["failed reader action", (f) => { f.state.remote.action.status = "failed"; }],
  ["cancel", async (f) => { await f.service.cancelPayment({ shopId: 7, servicePointId: 4, paymentId: 41 }); }],
]) test(`${name} leaves the kiosk order payable at the counter`, async () => {
  const f = fixture();
  await f.service.startPayment({ shopId: 7, servicePointId: 4, checkoutPayload });
  if (typeof action === "function") await action(f);
  const result = name === "cancel"
    ? await f.service.getPaymentStatus({ shopId: 7, servicePointId: 4, paymentId: 41 })
    : await f.service.getPaymentStatus({ shopId: 7, servicePointId: 4, paymentId: 41 });
  assert(["failed", "canceled"].includes(result.outcome));
  assert.strictEqual(f.state.orders[0].payment, "Paiement au comptoir");
  assert.strictEqual(f.state.orders[0].payment_status, "unpaid");
  assert.strictEqual(f.state.orders[0].payment_provider, null);
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
