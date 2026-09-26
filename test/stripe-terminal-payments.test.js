const assert = require("assert");
const { buildStripeTerminalPaymentService } = require("../src/services/stripeTerminalPayments");
const { buildStripeTerminalController } = require("../src/controllers/c_stripeTerminal");
const auth = require("../src/helpers/middleware/auth");

const tests = [];
const test = (name, run) => tests.push({ name, run });
const input = { shopId: 7, cashierUserId: 11, orderIds: [31, 12], discountType: "percent", discountValue: 12.5 };
const scope = { shopId: 7, cashierUserId: 11, paymentId: 41 };
const clone = (value) => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const fixture = () => {
  const state = {
    reader: { id: 21, shopid: 7, assigned_user_id: 11, is_active: 1, stripe_reader_id: "tmr_server" },
    orders: [12, 31].map((id, i) => ({ id, shopid: 7, status: 1, payment_status: "unpaid", subtotal: i ? "12.00" : "8.00", stripe_terminal_payment_id: null })),
    shop: { id: 7, stripe_account_id: "acct_shop", stripe_charges_enabled: 1, stripe_commission_percent: 5 },
    sessions: [], allocations: [], calls: [], events: [], remote: { id: "tmr_server", status: "online", action: null },
    intent: null, locked: false, intentsByKey: new Map(), intentsById: new Map(), creationLocks: new Set(),
  };
  let queue = Promise.resolve();
  const readerQueues = new Map();
  const terminalStore = {
    withReaderActionLock: async ({ shopId, readerId }, work) => {
      const key = `${shopId}:${readerId}`;
      const previous = readerQueues.get(key);
      const released = deferred();
      readerQueues.set(key, released.promise);
      if (previous && state.readerWaiting) state.readerWaiting.resolve();
      await previous;
      try { return await work(terminalStore); }
      finally {
        if (readerQueues.get(key) === released.promise) readerQueues.delete(key);
        released.resolve();
      }
    },
    withPaymentCreationLock: async ({ paymentId }, work) => {
      if (state.creationLocks.has(paymentId)) return null;
      state.creationLocks.add(paymentId);
      try { return await work(terminalStore); }
      finally { state.creationLocks.delete(paymentId); }
    },
    withTransaction: async (work) => {
      const previous = queue;
      let release;
      queue = new Promise((resolve) => { release = resolve; });
      await previous;
      state.locked = true;
      const before = clone({ sessions: state.sessions, allocations: state.allocations, orders: state.orders });
      state.events.push("begin");
      try { const result = await work(terminalStore); state.events.push("commit"); return result; }
      catch (error) { Object.assign(state, before); state.events.push("rollback"); throw error; }
      finally { state.locked = false; release(); }
    },
    lockReaderAndOrders: async ({ shopId, userId, orderIds }) => {
      assert(state.locked, "reservation must use a transaction");
      const reader = await terminalStore.findAssignedReader({ shopId, userId });
      if (!reader) throw new Error("No active assigned Terminal reader");
      const orders = state.orders.filter((o) => o.shopid === shopId && orderIds.includes(o.id));
      if (orders.length !== orderIds.length || orders.some((o) => o.status !== 1 || o.payment_status !== "unpaid" || o.stripe_terminal_payment_id != null)) throw new Error("Invalid Terminal order selection");
      if (state.competing) throw new Error("Order has an active Terminal payment");
      return { reader: clone(reader), orders: clone(orders), activePayment: clone(state.sessions.find((s) => s.shopid === shopId && s.terminal_reader_id === reader.id && ["creating", "processing"].includes(s.status)) || null) };
    },
    findAssignedReader: async ({ shopId, userId }) => state.reader && state.reader.shopid === shopId && state.reader.assigned_user_id === userId && state.reader.is_active === 1 ? clone(state.reader) : null,
    findReader: async ({ shopId, readerId }) => state.reader && state.reader.shopid === shopId && state.reader.id === readerId ? clone(state.reader) : null,
    createPaymentSession: async (data) => {
      assert(state.locked);
      const id = 41 + state.sessions.length;
      state.sessions.push({ id, shopid: data.shopId, terminal_reader_id: data.readerId, cashier_user_id: data.cashierUserId, idempotency_key: data.idempotencyKey, stripe_connected_account_id: data.connectedAccountId, amount_cents: data.amountCents, application_fee_amount: data.applicationFeeAmount, currency: data.currency || "eur", discount_type: data.discountType, discount_value: data.discountValue, status: "creating", stripe_payment_intent_id: null, created_at: new Date().toISOString() });
      state.events.push("session");
      return { insertId: id, affectedRows: 1 };
    },
    createAllocations: async ({ shopId, paymentId, allocations }) => {
      assert(state.locked);
      state.allocations.push(...allocations.map((a) => ({ shopid: shopId, terminal_payment_id: paymentId, order_id: a.orderId, amount_cents: a.amountCents })));
    },
    findPaymentSession: async ({ shopId, paymentId }) => clone(state.sessions.find((s) => s.shopid === shopId && s.id === paymentId) || null),
    lockPaymentSession: async (data) => {
      assert(state.locked);
      return { payment: await terminalStore.findPaymentSession(data) };
    },
    listPaymentAllocations: async ({ shopId, paymentId }) => clone(state.allocations.filter((a) => a.shopid === shopId && a.terminal_payment_id === paymentId)),
    updatePaymentSession: async (data) => {
      const session = state.sessions.find((s) => s.shopid === data.shopId && s.id === data.paymentId);
      assert.notStrictEqual(data.status, "succeeded");
      if (!session || session.status === "succeeded") return { affectedRows: 0 };
      for (const [key, column] of Object.entries({ stripePaymentIntentId: "stripe_payment_intent_id", stripeChargeId: "stripe_charge_id", status: "status", failureCode: "failure_code", failureMessage: "failure_message" })) {
        if (data[key] !== undefined) session[column] = data[key];
      }
      state.events.push(data.stripePaymentIntentId ? "intent-saved" : `status:${data.status}`);
      return { affectedRows: 1 };
    },
    finalizePaymentSucceeded: async ({ shopId, paymentId, stripePaymentIntentId, stripeChargeId }) => {
      assert(state.locked);
      const session = state.sessions.find((s) => s.shopid === shopId && s.id === paymentId);
      assert.strictEqual(session.stripe_payment_intent_id, stripePaymentIntentId);
      if (session.status === "succeeded") return { finalized: false };
      session.status = "succeeded";
      session.stripe_charge_id = stripeChargeId;
      const orderIds = state.allocations.filter((a) => a.terminal_payment_id === paymentId).map((a) => a.order_id);
      state.orders.filter((o) => orderIds.includes(o.id)).forEach((o) => { o.payment_status = "paid"; o.payment_provider = "stripe_terminal"; o.stripe_terminal_payment_id = paymentId; });
      return { finalized: true };
    },
  };
  const call = (name, run) => async (...args) => {
    state.calls.push({ name, args });
    state.events.push(name);
    if (state.errors && state.errors[name]) throw state.errors[name];
    return run(...args);
  };
  const stripe = {
    paymentIntents: {
      create: call("create", (params, options) => {
        assert(state.events.indexOf("commit") > state.events.indexOf("session"), "commit creating session before Stripe");
        assert.strictEqual(state.sessions.at(-1).status, "creating");
        assert.strictEqual(state.allocations.filter((a) => a.terminal_payment_id === state.sessions.at(-1).id).length, 2);
        assert.strictEqual(options.idempotencyKey, state.sessions.at(-1).idempotency_key);
        if (state.intentsByKey.has(options.idempotencyKey)) {
          const previous = state.intentsByKey.get(options.idempotencyKey);
          assert.deepStrictEqual(params, previous.params, "replay must use the persisted payment parameters");
          return clone(previous.intent);
        }
        state.intent = { ...params, id: state.sessions.length === 1 ? "pi_terminal" : `pi_terminal_${state.sessions.at(-1).id}`, status: "requires_payment_method", client_secret: "raw-secret", latest_charge: null };
        state.intentsById.set(state.intent.id, state.intent);
        state.intentsByKey.set(options.idempotencyKey, { params: clone(params), intent: clone(state.intent) });
        return clone(state.intent);
      }),
      retrieve: call("retrieve-intent", (id) => clone(state.intentsById.get(id))),
      cancel: call("cancel-intent", (id) => { const intent = state.intentsById.get(id); intent.status = "canceled"; return clone(intent); }),
    },
    terminal: { readers: {
      retrieve: call("retrieve-reader", () => clone(state.remote)),
      processPaymentIntent: call("process", (id, params) => {
        assert.strictEqual(state.sessions.at(-1).stripe_payment_intent_id, params.payment_intent);
        state.remote.action = { type: "process_payment_intent", status: "in_progress", process_payment_intent: { payment_intent: params.payment_intent } };
        return clone(state.remote);
      }),
      cancelAction: call("cancel-action", () => { state.remote.action = null; return clone(state.remote); }),
    } },
  };
  const shopStore = { findShop: async ({ shopId }) => state.shop && state.shop.id === shopId ? clone(state.shop) : null };
  const service = buildStripeTerminalPaymentService({ stripe, terminalStore, shopStore });
  return { state, terminalStore, stripe, shopStore, service };
};
const rejects = (run, code) => assert.rejects(run, (error) => {
  assert.strictEqual(error.code, code);
  assert(!error.stack.includes("raw-secret"));
  assert.strictEqual(error.cause, undefined);
  return true;
});
const invoke = async (handler, overrides = {}) => {
  const req = { shopid: 7, id: 11, access: 1, sessionSubject: "staff", params: { id: "41" }, body: {}, ...overrides };
  const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return body; } };
  await handler(req, res);
  return res;
};

test("aggregates persisted order amounts, allocates discount and creates a platform destination charge", async () => {
  const f = fixture();
  const result = await f.service.startPayment({ ...input, readerId: "tmr_attacker", total: 1 });
  assert.deepStrictEqual(f.state.calls.find((c) => c.name === "create").args[0], {
    amount: 1750, currency: "eur", payment_method_types: ["card_present"], capture_method: "automatic", application_fee_amount: 88,
    on_behalf_of: "acct_shop", transfer_data: { destination: "acct_shop" }, metadata: { terminal_payment_id: "41", shop_id: "7" },
  });
  assert.deepStrictEqual(f.state.calls.find((c) => c.name === "process").args.slice(0, 2), ["tmr_server", { payment_intent: "pi_terminal" }]);
  assert.deepStrictEqual(result, { id: 41, readerId: 21, status: "processing", amountCents: 1750, currency: "eur", orderIds: [12, 31], failureCode: null, failureMessage: null });
  assert.deepStrictEqual(f.state.allocations.map((a) => [a.order_id, a.amount_cents]), [[12, 700], [31, 1050]]);
  for (const c of f.state.calls) assert(!c.args.some((a) => a && a.stripeAccount));
  assert(f.state.events.indexOf("session") < f.state.events.indexOf("commit"));
  assert(f.state.events.indexOf("commit") < f.state.events.indexOf("create"));
  assert(f.state.events.indexOf("intent-saved") < f.state.events.indexOf("process"));
  assert(f.state.events.indexOf("process") < f.state.events.indexOf("status:processing"));
});

test("idempotent retry returns the active session without additional Stripe calls", async () => {
  const f = fixture();
  const first = await f.service.startPayment(input);
  const calls = f.state.calls.length;
  assert.deepStrictEqual(await f.service.startPayment(input), first);
  assert.strictEqual(f.state.calls.length, calls);
});

for (const enabled of [1, 0]) test(`round2 ambiguous creation replays byte-equivalent params after the shop account changes (enabled=${enabled})`, async () => {
  const f = fixture();
  const create = f.stripe.paymentIntents.create;
  let first = true;
  f.stripe.paymentIntents.create = async (...args) => {
    const result = await create(...args);
    if (first) { first = false; throw new Error("raw-secret ambiguous create"); }
    return result;
  };
  await rejects(() => f.service.startPayment(input), "TERMINAL_STRIPE_ERROR");
  f.state.shop.stripe_account_id = "acct_changed";
  f.state.shop.stripe_charges_enabled = enabled;
  f.state.shop.stripe_commission_percent = 99;
  const result = await f.service.startPayment({ ...input, discountValue: 1 });
  assert.strictEqual(result.status, "processing");
  const calls = f.state.calls.filter((c) => c.name === "create");
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(JSON.stringify(calls[0].args), JSON.stringify(calls[1].args));
  assert.strictEqual(f.state.sessions[0].stripe_connected_account_id, "acct_shop");
  assert.strictEqual(f.state.intentsByKey.size, 1);
  assert.strictEqual(f.state.sessions.length, 1);
});

for (const cents of [1, 49]) test(`round2 rejects ${cents} cents before reservation and allows a corrected 50-cent retry`, async () => {
  const f = fixture();
  await rejects(() => f.service.startPayment({ ...input, discountType: "amount", discountValue: 2000 - cents }), "TERMINAL_INVALID_INPUT");
  assert.strictEqual(f.state.sessions.length, 0);
  assert.strictEqual(f.state.allocations.length, 0);
  assert.strictEqual(f.state.calls.length, 0);
  const result = await f.service.startPayment({ ...input, discountType: "amount", discountValue: 1950 });
  assert.strictEqual(result.status, "processing");
  assert.strictEqual(result.amountCents, 50);
  assert.strictEqual(f.state.sessions.length, 1);
  assert.strictEqual(f.state.intentsByKey.size, 1);
});

for (const pauseAt of ["reader-read", "cancel-action"]) test(`round2 delayed cancel at ${pauseAt} cannot cancel B after A succeeds and B attempts handoff`, async () => {
  const f = fixture();
  const other = buildStripeTerminalPaymentService(f);
  await f.service.startPayment(input);
  const captured = deferred();
  const resume = deferred();
  const handoff = deferred();
  f.state.readerWaiting = handoff;
  const retrieve = f.stripe.terminal.readers.retrieve;
  let pause = true;
  f.stripe.terminal.readers.retrieve = async (...args) => {
    const snapshot = await retrieve(...args);
    if (pause && pauseAt === "reader-read") { pause = false; captured.resolve(); await resume.promise; }
    return snapshot;
  };
  const process = f.stripe.terminal.readers.processPaymentIntent;
  f.stripe.terminal.readers.processPaymentIntent = async (...args) => {
    const result = await process(...args);
    handoff.resolve();
    return result;
  };
  const canceledActions = [];
  const cancel = f.stripe.terminal.readers.cancelAction;
  f.stripe.terminal.readers.cancelAction = async (...args) => {
    if (pause && pauseAt === "cancel-action") { pause = false; captured.resolve(); await resume.promise; }
    canceledActions.push(clone(f.state.remote.action));
    return cancel(...args);
  };
  const canceling = f.service.cancelPayment(scope);
  await captured.promise;
  f.state.intent.status = "succeeded";
  f.state.remote.action = null;
  assert.strictEqual((await other.getPaymentStatus(scope)).status, "succeeded");
  f.state.orders.push(...[52, 71].map((id) => ({ id, shopid: 7, status: 1, payment_status: "unpaid", subtotal: "10.00", stripe_terminal_payment_id: null })));
  const starting = other.startPayment({ ...input, orderIds: [52, 71] });
  // Wait for B to reach the reader lock (or, on broken code, process B).
  await handoff.promise;
  resume.resolve();
  const [a, b] = await Promise.all([canceling, starting]);
  assert.strictEqual(a.status, "succeeded");
  assert.strictEqual(b.status, "processing");
  assert(!canceledActions.some((action) => action && action.process_payment_intent.payment_intent === "pi_terminal_42"), "delayed A cancellation canceled B");
  assert.strictEqual(f.state.remote.action.process_payment_intent.payment_intent, "pi_terminal_42");
  assert.deepStrictEqual(f.state.sessions.map((s) => s.status), ["succeeded", "processing"]);
  assert.deepStrictEqual(f.state.orders.map((o) => o.payment_status), ["paid", "paid", "unpaid", "unpaid"]);
});

test("round2 cancel rereads the local session after waiting for the reader lock", async () => {
  const f = fixture();
  await f.service.startPayment(input);
  const lock = f.terminalStore.withReaderActionLock;
  f.terminalStore.withReaderActionLock = (data, work) => {
    f.state.sessions[0].status = "succeeded";
    return lock(data, work);
  };
  // A stale Stripe read must not authorize cancellation of a locally final payment.
  assert.strictEqual((await f.service.cancelPayment(scope)).status, "succeeded");
  assert(!f.state.calls.some((c) => c.name === "cancel-action" || c.name === "cancel-intent"));
});

test("round2 process rereads local session and reader action after acquiring the reader lock", async () => {
  for (const change of ["finalized", "busy"]) {
    const f = fixture();
    const lock = f.terminalStore.withReaderActionLock;
    f.terminalStore.withReaderActionLock = (data, work) => {
      if (change === "finalized") f.state.sessions[0].status = "succeeded";
      else f.state.remote.action = { type: "process_payment_intent", status: "in_progress", process_payment_intent: { payment_intent: "pi_other" } };
      return lock(data, work);
    };
    if (change === "finalized") assert.strictEqual((await f.service.startPayment(input)).status, "succeeded");
    else await rejects(() => f.service.startPayment(input), "TERMINAL_READER_BUSY");
    assert(!f.state.calls.some((c) => c.name === "process" || c.name === "cancel-action"));
  }
});

test("round2 reader lock timeout makes no cancellation calls and retains the active session", async () => {
  const f = fixture();
  await f.service.startPayment(input);
  f.state.calls.length = 0;
  f.terminalStore.withReaderActionLock = async () => null;
  await rejects(() => f.service.cancelPayment(scope), "TERMINAL_READER_BUSY");
  assert.strictEqual(f.state.calls.length, 0);
  assert.strictEqual(f.state.sessions[0].status, "processing");
});

test("two service instances starting simultaneously reserve one session and call Stripe once", async () => {
  const f = fixture();
  const second = buildStripeTerminalPaymentService(f);
  const [a, b] = await Promise.all([f.service.startPayment(input), second.startPayment(input)]);
  assert.strictEqual(a.id, b.id);
  assert.strictEqual(f.state.sessions.length, 1);
  assert.strictEqual(f.state.calls.filter((c) => c.name === "create").length, 1);
  assert.strictEqual(f.state.calls.filter((c) => c.name === "process").length, 1);
});

for (const [name, change, code] of [
  ["no reader", (s) => { s.reader = null; }, "TERMINAL_NO_READER"],
  ["inactive reader", (s) => { s.reader.is_active = 0; }, "TERMINAL_NO_READER"],
  ["other cashier reader", (s) => { s.reader.assigned_user_id = 12; }, "TERMINAL_NO_READER"],
  ["foreign orders", (s) => { s.orders[0].shopid = 8; }, "TERMINAL_INVALID_ORDERS"],
  ["paid orders", (s) => { s.orders[0].payment_status = "paid"; }, "TERMINAL_INVALID_ORDERS"],
  ["web payment pending", (s) => { s.orders[0].payment_status = "requires_payment"; }, "TERMINAL_INVALID_ORDERS"],
  ["inactive orders", (s) => { s.orders[0].status = 0; }, "TERMINAL_INVALID_ORDERS"],
  ["already attached orders", (s) => { s.orders[0].stripe_terminal_payment_id = 9; }, "TERMINAL_INVALID_ORDERS"],
  ["other reader order lock", (s) => { s.competing = true; }, "TERMINAL_ORDER_BUSY"],
  ["missing connect account", (s) => { s.shop.stripe_account_id = null; }, "TERMINAL_CONNECT_NOT_READY"],
  ["disabled charges", (s) => { s.shop.stripe_charges_enabled = 0; }, "TERMINAL_CONNECT_NOT_READY"],
]) test(`rejects ${name} before Stripe mutation`, async () => {
  const f = fixture(); change(f.state);
  await rejects(() => f.service.startPayment(input), code);
  assert(!f.state.calls.some((c) => ["create", "process"].includes(c.name)));
  assert.strictEqual(f.state.sessions.length, 0);
});

for (const invalid of [{ orderIds: [] }, { orderIds: [12, 12] }, { orderIds: [true] }, { orderIds: [1.2] }, { shopId: true }, { cashierUserId: null }, { discountType: "amount", discountValue: 1.5 }, { discountType: "percent", discountValue: 100 }]) {
  test(`rejects invalid input ${JSON.stringify(invalid)}`, async () => {
    const f = fixture();
    await rejects(() => f.service.startPayment({ ...input, ...invalid }), "TERMINAL_INVALID_INPUT");
    assert(!f.state.calls.some((c) => c.name === "create"));
    assert.strictEqual(f.state.sessions.length, 0);
  });
}

for (const [name, remote, code] of [
  ["offline", { status: "offline" }, "TERMINAL_READER_OFFLINE"],
  ["busy", { action: { status: "in_progress", type: "process_payment_intent", process_payment_intent: { payment_intent: "pi_other" } } }, "TERMINAL_READER_BUSY"],
]) test(`rejects ${name} reader and retains the retryable reservation`, async () => {
  const f = fixture(); Object.assign(f.state.remote, remote);
  await rejects(() => f.service.startPayment(input), code);
  assert(!f.state.calls.some((c) => c.name === "create"));
  assert.strictEqual(f.state.sessions[0].status, "creating");
});

test("definitive creation failure retains the durable key without raw failure details", async () => {
  const f = fixture();
  f.state.errors = { create: Object.assign(new Error("raw-secret Stripe"), { type: "StripeInvalidRequestError", statusCode: 400 }) };
  await rejects(() => f.service.startPayment(input), "TERMINAL_STRIPE_ERROR");
  assert.strictEqual(f.state.sessions[0].status, "creating");
  assert(!JSON.stringify(f.state.sessions).includes("raw-secret"));
});

test("ambiguous creation timeout retains reservation and retry does not create a second intent", async () => {
  const f = fixture();
  const create = f.stripe.paymentIntents.create;
  let attempts = 0;
  f.stripe.paymentIntents.create = async (...args) => {
    const result = await create(...args);
    if (++attempts === 1) throw new Error("raw-secret timeout after creation");
    return result;
  };
  await rejects(() => f.service.startPayment(input), "TERMINAL_STRIPE_ERROR");
  assert.strictEqual((await f.service.startPayment({ ...input, discountType: "none", discountValue: 0 })).status, "processing");
  assert.strictEqual(f.state.calls.filter((c) => c.name === "create").length, 2);
  assert.strictEqual(f.state.intentsByKey.size, 1);
  assert.strictEqual(f.state.sessions.length, 1);
  assert.strictEqual(f.state.intent.amount, 1750);
});

for (const statusCode of [401, 403, 429]) test(`round1 recovers a ${statusCode} creation rejection with the durable key`, async () => {
  const f = fixture();
  f.state.errors = { create: Object.assign(new Error("raw-secret Stripe rejection"), { statusCode }) };
  await rejects(() => f.service.startPayment(input), "TERMINAL_STRIPE_ERROR");
  const key = f.state.sessions[0].idempotency_key;
  assert.strictEqual(f.state.sessions[0].stripe_payment_intent_id, null);
  f.state.errors = null;
  f.state.shop.stripe_commission_percent = 99;
  const result = await f.service.startPayment({ ...input, discountValue: 50, total: 1, readerId: "tmr_attacker" });
  assert.strictEqual(result.status, "processing");
  assert.strictEqual(result.amountCents, 1750);
  assert.strictEqual(f.state.intent.application_fee_amount, 88);
  assert.strictEqual(f.state.sessions.length, 1);
  assert.strictEqual(f.state.intentsByKey.size, 1);
  assert(f.state.calls.filter((c) => c.name === "create").every((c) => c.args[1].idempotencyKey === key));
});

test("round1 concurrent recovery loser returns the session without another Stripe call", async () => {
  const f = fixture(); f.state.errors = { create: new Error("raw-secret timeout") };
  await rejects(() => f.service.startPayment(input), "TERMINAL_STRIPE_ERROR");
  f.state.errors = null;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let entered;
  const called = new Promise((resolve) => { entered = resolve; });
  const create = f.stripe.paymentIntents.create;
  f.stripe.paymentIntents.create = async (...args) => { entered(); await gate; return create(...args); };
  const first = f.service.startPayment(input);
  const reachedStripe = await Promise.race([called.then(() => true), first.then(() => false)]);
  try {
    assert(reachedStripe, "stranded session must attempt Stripe recovery");
    const second = await buildStripeTerminalPaymentService(f).startPayment(input);
    assert.strictEqual(second.id, 41);
    assert.strictEqual(second.status, "creating");
    assert.strictEqual(f.state.calls.filter((c) => c.name === "create").length, 1);
  } finally { release(); await first; }
  assert.strictEqual(f.state.calls.filter((c) => c.name === "create").length, 2);
  assert.strictEqual(f.state.calls.filter((c) => c.name === "process").length, 1);
  assert.strictEqual(f.state.intentsByKey.size, 1);
});

test("round1 delayed original starter cannot release an ambiguously created intent", async () => {
  const f = fixture();
  const withLock = f.terminalStore.withPaymentCreationLock;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let waiting;
  const originalWaiting = new Promise((resolve) => { waiting = resolve; });
  let attempts = 0;
  f.terminalStore.withPaymentCreationLock = async (...args) => {
    if (++attempts === 1) { waiting(); await gate; }
    return withLock(...args);
  };
  const create = f.stripe.paymentIntents.create;
  f.stripe.paymentIntents.create = async (...args) => { await create(...args); throw new Error("raw-secret timeout"); };
  const original = f.service.startPayment(input);
  await originalWaiting;
  await rejects(() => buildStripeTerminalPaymentService(f).startPayment(input), "TERMINAL_STRIPE_ERROR");
  f.state.remote.status = "offline";
  release();
  await rejects(() => original, "TERMINAL_READER_OFFLINE");
  assert.strictEqual(f.state.sessions[0].status, "creating");
  assert.strictEqual(f.state.intentsByKey.size, 1);
});

test("round1 refuses to replay creation after the safe idempotency window", async () => {
  const f = fixture(); f.state.errors = { create: new Error("raw-secret timeout") };
  await rejects(() => f.service.startPayment(input), "TERMINAL_STRIPE_ERROR");
  f.state.sessions[0].created_at = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  f.state.errors = null;
  await rejects(() => f.service.startPayment(input), "TERMINAL_RECOVERY_REQUIRED");
  assert.strictEqual(f.state.calls.filter((c) => c.name === "create").length, 1);
});

for (const code of ["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"]) {
  for (const phase of ["reservation", "finalization"]) test(`round1 retries ${code} in database-only ${phase}`, async () => {
    const f = fixture();
    if (phase === "finalization") { await f.service.startPayment(input); f.state.intent.status = "succeeded"; }
    const method = phase === "reservation" ? "createAllocations" : "finalizePaymentSucceeded";
    const original = f.terminalStore[method];
    let attempts = 0;
    f.terminalStore[method] = async (...args) => {
      const result = await original(...args);
      if (++attempts < 3) throw Object.assign(new Error("raw-secret lock failure"), { code });
      return result;
    };
    const result = phase === "reservation" ? await f.service.startPayment(input) : await f.service.getPaymentStatus(scope);
    assert.strictEqual(result.status, phase === "reservation" ? "processing" : "succeeded");
    assert.strictEqual(attempts, 3);
    assert.strictEqual(f.state.sessions.length, 1);
    assert.strictEqual(f.state.calls.filter((c) => c.name === "create").length, 1);
    assert.strictEqual(f.state.calls.filter((c) => c.name === "process").length, 1);
  });
}

test("round1 stops database retries after three attempts and keeps errors sanitized", async () => {
  const f = fixture(); let attempts = 0;
  f.terminalStore.createAllocations = async () => { attempts += 1; throw Object.assign(new Error("raw-secret deadlock"), { code: "ER_LOCK_DEADLOCK" }); };
  await rejects(() => f.service.startPayment(input), "TERMINAL_INTERNAL_ERROR");
  assert.strictEqual(attempts, 3);
  assert.strictEqual(f.state.sessions.length, 0);
  assert.strictEqual(f.state.calls.length, 0);
});

test("round1 retries cancellation persistence without repeating Stripe cancellation", async () => {
  const f = fixture(); await f.service.startPayment(input);
  const update = f.terminalStore.updatePaymentSession;
  let attempts = 0;
  f.terminalStore.updatePaymentSession = async (data) => {
    const result = await update(data);
    if (data.status === "canceled" && ++attempts < 3) throw Object.assign(new Error("raw-secret timeout"), { code: "ER_LOCK_WAIT_TIMEOUT" });
    return result;
  };
  assert.strictEqual((await f.service.cancelPayment(scope)).status, "canceled");
  assert.strictEqual(attempts, 3);
  assert.strictEqual(f.state.calls.filter((c) => c.name === "cancel-action").length, 1);
  assert.strictEqual(f.state.calls.filter((c) => c.name === "cancel-intent").length, 1);
  for (const call of f.state.calls.filter((c) => ["cancel-action", "cancel-intent"].includes(c.name))) {
    assert(call.args[2].idempotencyKey.startsWith(f.state.sessions[0].idempotency_key));
  }
});

test("process failure cancels its intent before freeing the session", async () => {
  const f = fixture(); f.state.errors = { process: new Error("raw-secret process failure") };
  await rejects(() => f.service.startPayment(input), "TERMINAL_STRIPE_ERROR");
  assert.strictEqual(f.state.intent.status, "canceled");
  assert.strictEqual(f.state.sessions[0].status, "failed");
});

test("failed cleanup keeps the intent and reservation recoverable", async () => {
  const f = fixture(); f.state.errors = { process: new Error("raw-secret"), "cancel-intent": new Error("raw-secret") };
  await rejects(() => f.service.startPayment(input), "TERMINAL_CLEANUP_FAILED");
  assert.strictEqual(f.state.sessions[0].stripe_payment_intent_id, "pi_terminal");
  assert(["creating", "processing"].includes(f.state.sessions[0].status));
});

test("allocation failure rolls back before Stripe", async () => {
  const f = fixture(); f.terminalStore.createAllocations = async () => { throw new Error("raw-secret SQL"); };
  await rejects(() => f.service.startPayment(input), "TERMINAL_INTERNAL_ERROR");
  assert.strictEqual(f.state.sessions.length, 0);
  assert.strictEqual(f.state.calls.length, 0);
});

test("polling success finalizes paid orders atomically without archiving them", async () => {
  const f = fixture(); await f.service.startPayment(input);
  f.state.intent.status = "succeeded"; f.state.intent.latest_charge = { id: "ch_terminal", raw: "raw-secret" };
  assert.strictEqual((await f.service.getPaymentStatus(scope)).status, "succeeded");
  assert.strictEqual(f.state.sessions[0].stripe_charge_id, "ch_terminal");
  assert(f.state.orders.every((o) => o.payment_status === "paid" && o.status === 1 && o.stripe_terminal_payment_id === 41));
  const count = f.state.calls.length;
  assert.strictEqual((await f.service.getPaymentStatus(scope)).status, "succeeded");
  assert.strictEqual(f.state.calls.length, count);
});

test("failed success finalization preserves active session for paid-but-not-archived recovery", async () => {
  const f = fixture(); await f.service.startPayment(input); f.state.intent.status = "succeeded";
  f.terminalStore.finalizePaymentSucceeded = async () => { throw new Error("raw-secret DB"); };
  await rejects(() => f.service.getPaymentStatus(scope), "TERMINAL_INTERNAL_ERROR");
  assert.strictEqual(f.state.sessions[0].status, "processing");
  assert(!f.state.calls.some((c) => c.name === "cancel-intent"));
});

for (const method of ["getPaymentStatus", "cancelPayment"]) {
  test(`${method} rejects another shop or cashier before Stripe`, async () => {
    const f = fixture(); await f.service.startPayment(input); f.state.calls.length = 0;
    await rejects(() => f.service[method]({ ...scope, shopId: 8 }), "TERMINAL_PAYMENT_NOT_FOUND");
    await rejects(() => f.service[method]({ ...scope, cashierUserId: 12 }), "TERMINAL_PAYMENT_NOT_FOUND");
    assert.strictEqual(f.state.calls.length, 0);
  });
}

test("cancel stops the matching reader action before canceling the intent and is idempotent", async () => {
  const f = fixture(); await f.service.startPayment(input); f.state.calls.length = 0;
  assert.strictEqual((await f.service.cancelPayment(scope)).status, "canceled");
  const names = f.state.calls.map((c) => c.name);
  assert(names.indexOf("cancel-action") < names.indexOf("cancel-intent"));
  assert.strictEqual(f.state.orders[0].payment_status, "unpaid");
  f.state.calls.length = 0;
  assert.strictEqual((await f.service.cancelPayment(scope)).status, "canceled");
  assert.strictEqual(f.state.calls.length, 0);
});

for (const status of ["processing", "succeeded"]) test(`cancel never cancels a ${status} intent`, async () => {
  const f = fixture(); await f.service.startPayment(input); f.state.intent.status = status; f.state.remote.action = null;
  const result = await f.service.cancelPayment(scope);
  assert.strictEqual(result.status, status);
  assert(!f.state.calls.some((c) => c.name === "cancel-intent"));
});

test("cancel does not interrupt a different reader action", async () => {
  const f = fixture(); await f.service.startPayment(input);
  f.state.remote.action.process_payment_intent.payment_intent = "pi_other";
  await f.service.cancelPayment(scope);
  assert(!f.state.calls.some((c) => c.name === "cancel-action"));
});

test("cancel action failure preserves reservation and never cancels the intent", async () => {
  const f = fixture(); await f.service.startPayment(input); f.state.errors = { "cancel-action": new Error("raw-secret") };
  await rejects(() => f.service.cancelPayment(scope), "TERMINAL_STRIPE_ERROR");
  assert.strictEqual(f.state.sessions[0].status, "processing");
  assert(!f.state.calls.some((c) => c.name === "cancel-intent"));
});

test("controller takes identity from auth and whitelists body fields", async () => {
  let received;
  const controller = buildStripeTerminalController({ paymentService: { startPayment: async (data) => { received = data; return { id: 41 }; } } });
  const response = await invoke(controller.startPayment, { body: { ...input, shopId: 8, cashierUserId: 99, readerId: "attacker", total: 1 } });
  assert.strictEqual(response.statusCode, 200);
  assert.deepStrictEqual(received, input);
});

test("controller rejects service-point sessions and sanitizes unexpected errors", async () => {
  let calls = 0;
  const controller = buildStripeTerminalController({ paymentService: { startPayment: async () => { calls += 1; throw new Error("raw-secret"); } } });
  assert.strictEqual((await invoke(controller.startPayment, { sessionSubject: "service_point" })).statusCode, 403);
  assert.strictEqual(calls, 0);
  const result = await invoke(controller.startPayment);
  assert.strictEqual(result.statusCode, 500);
  assert(!JSON.stringify(result.body).includes("raw-secret"));
});

test("cashregister authorization rejects staff without permission and allows permitted staff", async () => {
  assert.strictEqual(typeof auth.authorizeCashRegister, "function");
  for (const permissions of ['["orders"]', '["cashregister"]']) {
    let next = false;
    const authorize = auth.buildModuleAuthorization({ moduleKey: "cashregister", findUserByIdAndShop: async () => ({ id: 11, status: 1, access: 1, module_permissions: permissions }) });
    const res = await invoke((req, response) => authorize(req, response, () => { next = true; }));
    assert.strictEqual(next, permissions.includes("cashregister"));
    if (!next) assert.strictEqual(res.statusCode, 403);
  }
});

test("every cashier Terminal route binds authentication and cashregister authorization", () => {
  const paths = ["../src/controllers/c_stripe", "../src/controllers/c_orderEditing", "../src/routers/r_stripe"].map(require.resolve);
  const previous = paths.map((p) => require.cache[p]);
  require.cache[paths[0]] = { exports: Object.fromEntries(["getConnectStatus", "createConnectOnboardingLink", "createQrTablePaymentIntent", "cancelQrTablePaymentIntent", "markQrTablePaymentAtCounter", "refundPaidOrder", "handleWebhook"].map((name) => [name, () => {}])) };
  require.cache[paths[1]] = { exports: { replacementPayment: () => {} } };
  delete require.cache[paths[2]];
  try {
    const { routers } = require(paths[2]);
    for (const [verb, path] of [["get", "/stripe/terminal/current-reader"], ["post", "/stripe/terminal/payments"], ["get", "/stripe/terminal/payments/:id"], ["post", "/stripe/terminal/payments/:id/cancel"]]) {
      const layer = routers.stack.find((r) => r.route && r.route.path === path && r.route.methods[verb]);
      assert(layer, `Missing ${verb} ${path}`);
      assert.deepStrictEqual(layer.route.stack.slice(0, 2).map((l) => l.handle), [auth.authentication, auth.authorizeCashRegister]);
    }
  } finally { paths.forEach((p, i) => { if (previous[i]) require.cache[p] = previous[i]; else delete require.cache[p]; }); }
});

test("cashregister authorization sanitizes database errors", async () => {
  const authorize = auth.buildModuleAuthorization({ moduleKey: "cashregister", findUserByIdAndShop: async () => { throw new Error("raw-secret SQL"); } });
  const response = await invoke((req, res) => authorize(req, res, () => assert.fail("must not authorize")));
  assert.strictEqual(response.statusCode, 500);
  assert(!JSON.stringify(response.body).includes("raw-secret"));
});

test("polling a failed reader action cancels its intent and returns a safe failure", async () => {
  const f = fixture(); await f.service.startPayment(input);
  f.state.remote.action.status = "failed";
  f.state.remote.action.failure_code = "card_declined";
  f.state.remote.action.failure_message = "raw-secret card data";
  const result = await f.service.getPaymentStatus(scope);
  assert.strictEqual(result.status, "failed");
  assert.strictEqual(result.failureCode, "TERMINAL_PAYMENT_FAILED");
  assert.strictEqual(f.state.intent.status, "canceled");
  assert(!JSON.stringify([result, f.state.sessions]).includes("raw-secret"));
});

test("polling does not mistake a waiting customer for a failed payment", async () => {
  const f = fixture(); await f.service.startPayment(input);
  assert.strictEqual((await f.service.getPaymentStatus(scope)).status, "processing");
  assert(!f.state.calls.some((c) => c.name === "cancel-intent"));
});

test("cancel requires Stripe to confirm action cancellation before canceling the intent", async () => {
  const f = fixture(); await f.service.startPayment(input);
  f.stripe.terminal.readers.cancelAction = async () => clone(f.state.remote);
  await rejects(() => f.service.cancelPayment(scope), "TERMINAL_STRIPE_ERROR");
  assert.strictEqual(f.state.sessions[0].status, "processing");
  assert(!f.state.calls.some((c) => c.name === "cancel-intent"));
});

test("cancel reconciles a success racing with intent cancellation", async () => {
  const f = fixture(); await f.service.startPayment(input);
  f.stripe.paymentIntents.cancel = async () => { f.state.intent.status = "succeeded"; throw new Error("raw-secret already paid"); };
  assert.strictEqual((await f.service.cancelPayment(scope)).status, "succeeded");
  assert.strictEqual(f.state.orders[0].payment_status, "paid");
});

test("creating sessions cannot be canceled while the start request owns the Stripe handoff", async () => {
  const f = fixture(); await f.service.startPayment(input); f.state.sessions[0].status = "creating";
  f.state.calls.length = 0;
  await rejects(() => f.service.cancelPayment(scope), "TERMINAL_PAYMENT_CREATING");
  assert.strictEqual(f.state.calls.length, 0);
  assert.strictEqual(f.state.sessions[0].status, "creating");
});

test("success reconciliation rejects a mismatched amount without marking orders paid", async () => {
  const f = fixture(); await f.service.startPayment(input); f.state.intent.status = "succeeded"; f.state.intent.amount = 1;
  await rejects(() => f.service.getPaymentStatus(scope), "TERMINAL_STRIPE_ERROR");
  assert.strictEqual(f.state.orders[0].payment_status, "unpaid");
});

test("shop lookup does not require a second pool connection while a reservation transaction is open", async () => {
  const f = fixture();
  f.shopStore.findShop = async () => { assert(!f.state.locked, "pool exhaustion: nested checkout"); return f.state.shop; };
  assert.strictEqual((await f.service.startPayment(input)).status, "processing");
});

test("a process timeout after handoff stops the reader before releasing the reservation", async () => {
  const f = fixture();
  const process = f.stripe.terminal.readers.processPaymentIntent;
  f.stripe.terminal.readers.processPaymentIntent = async (...args) => { await process(...args); throw new Error("raw-secret timeout"); };
  await rejects(() => f.service.startPayment(input), "TERMINAL_STRIPE_ERROR");
  assert.strictEqual(f.state.remote.action, null);
  assert.strictEqual(f.state.sessions[0].status, "failed");
  assert(f.state.events.indexOf("cancel-action") < f.state.events.indexOf("cancel-intent"));
  assert(f.state.events.indexOf("cancel-intent") < f.state.events.indexOf("status:failed"));
});

test("failure to save the intent never hands an untracked payment to the reader", async () => {
  const f = fixture(); const update = f.terminalStore.updatePaymentSession;
  f.terminalStore.updatePaymentSession = async (data) => {
    if (data.stripePaymentIntentId) throw new Error("raw-secret SQL");
    return update(data);
  };
  await rejects(() => f.service.startPayment(input), "TERMINAL_INTERNAL_ERROR");
  assert(!f.state.calls.some((c) => c.name === "process"));
  assert.strictEqual(f.state.intent.status, "canceled");
  assert.strictEqual(f.state.sessions[0].status, "failed");
});

test("a paid intent discovered during process cleanup is finalized without cancellation", async () => {
  const f = fixture();
  f.stripe.terminal.readers.processPaymentIntent = async () => { f.state.intent.status = "succeeded"; throw new Error("raw-secret timeout"); };
  assert.strictEqual((await f.service.startPayment(input)).status, "succeeded");
  assert.strictEqual(f.state.orders[0].payment_status, "paid");
  assert(!f.state.calls.some((c) => c.name === "cancel-intent"));
});

test("default controller wires reservation SQL to one transaction connection and commits before Stripe", async () => {
  const f = fixture();
  const calls = [];
  let inTransaction = false;
  const execute = async (sql, params, dedicated) => {
    calls.push({ sql, params, dedicated });
    if (sql.includes("GET_LOCK")) { assert(dedicated && !inTransaction); return [{ acquired: 1 }]; }
    if (sql.includes("RELEASE_LOCK")) { assert(dedicated && !inTransaction); return [{ released: 1 }]; }
    if (sql.includes("FROM shop")) { assert(!inTransaction); return [f.state.shop]; }
    if (sql.startsWith("SELECT") && sql.includes("FROM stripe_terminal_readers r")) {
      assert(dedicated && inTransaction);
      assert(sql.includes("FOR UPDATE"));
      assert.deepStrictEqual(params, [7, 11]);
      return [f.state.reader];
    }
    if (sql.includes("FROM orders o")) {
      assert(dedicated && inTransaction);
      assert(sql.includes("FOR UPDATE"));
      assert.deepStrictEqual(params, [7, 12, 31]);
      return f.state.orders;
    }
    if (sql.includes("SELECT a.order_id")) return [];
    if (sql.startsWith("SELECT") && sql.includes("FROM stripe_terminal_payments p")) {
      if (sql.includes("p.terminal_reader_id")) return [];
      return f.state.sessions.filter((s) => s.shopid === params[0] && s.id === params[1]);
    }
    if (sql.includes("FROM stripe_terminal_payment_orders a")) return f.state.allocations;
    if (sql.includes("INSERT INTO stripe_terminal_payments")) {
      assert(dedicated && inTransaction);
      f.state.locked = true;
      return f.terminalStore.createPaymentSession({ idempotencyKey: params[0], connectedAccountId: params[1], amountCents: params[2], applicationFeeAmount: params[3], currency: params[4], discountType: params[5], discountValue: params[6], shopId: params[7], readerId: params[8], cashierUserId: params[9] });
    }
    if (sql.includes("INSERT INTO stripe_terminal_payment_orders")) {
      assert(dedicated && inTransaction);
      await f.terminalStore.createAllocations({ shopId: params[3], paymentId: params[2], allocations: [{ orderId: params[1], amountCents: params[0] }] });
      return { affectedRows: 1 };
    }
    if (sql.startsWith("UPDATE stripe_terminal_payments")) {
      assert(dedicated && inTransaction);
      return f.terminalStore.updatePaymentSession({ shopId: params[1], paymentId: params[2], ...(sql.includes("stripe_payment_intent_id =") ? { stripePaymentIntentId: params[0] } : { status: params[0] }) });
    }
    throw new Error(`Unexpected test SQL: ${sql}`);
  };
  const pool = {
    query: async (sql, params) => [await execute(sql, params, false)],
    getConnection: async () => ({
      beginTransaction: async () => { assert(!inTransaction); inTransaction = true; },
      commit: async () => { inTransaction = false; f.state.locked = false; f.state.events.push("commit"); },
      rollback: async () => { inTransaction = false; },
      release: () => { assert(!inTransaction); calls.push({ released: true }); },
      query: async (sql, params) => [await execute(sql, params, true)],
    }),
  };
  const paths = ["../src/config/dbPool", "../src/config/stripe", "../src/helpers/withTransaction", "../src/controllers/c_stripeTerminal"].map(require.resolve);
  const previous = paths.map((p) => require.cache[p]);
  require.cache[paths[0]] = { loaded: true, exports: pool };
  require.cache[paths[1]] = { loaded: true, exports: { getStripe: () => f.stripe } };
  delete require.cache[paths[2]]; delete require.cache[paths[3]];
  try {
    const controller = require(paths[3]);
    const response = await invoke(controller.startPayment, { body: input });
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.body.data.status, "processing");
    assert.strictEqual(calls.filter((c) => c.released).length, 2);
    assert.strictEqual(f.state.sessions.length, 1);
    assert.deepStrictEqual(f.state.allocations.map((a) => a.amount_cents), [700, 1050]);
  } finally { paths.forEach((p, i) => { if (previous[i]) require.cache[p] = previous[i]; else delete require.cache[p]; }); }
});

(async () => {
  const selected = tests.filter(({ name }) => !process.argv[2] || name.includes(process.argv[2]));
  assert(selected.length);
  for (const { name, run } of selected) {
    let timer;
    try {
      await Promise.race([run(), new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Test stalled: ${name}`)), 3000);
      })]);
      console.log(`PASS ${name}`);
    } finally { clearTimeout(timer); }
  }
  console.log(`stripe terminal payment tests passed (${selected.length} tests)`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
