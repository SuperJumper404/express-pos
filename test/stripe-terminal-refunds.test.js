const assert = require("assert");
require.cache[require.resolve("../src/config/db")] = { exports: {} };
const { buildOrderArchiveModule } = require("../src/modules/m_orders");
const { buildArchiveOrderController } = require("../src/controllers/c_orders");
const stripeController = require("../src/controllers/c_stripe");
const { buildCashRegisterArchiveFields } = require("../src/helpers/cashRegisterPayment");
const { buildStripeTerminalModule } = require("../src/modules/m_stripeTerminal");
const { buildStripeTerminalPaymentService } = require("../src/services/stripeTerminalPayments");

const tests = [];
const test = (name, work) => tests.push({ name, work });
const clone = (value) => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const paidOrder = () => ({ id: 12, shopid: 7, status: 1, subtotal: 12, payment_status: "paid",
  payment_provider: "stripe_terminal", payment: "Carte bancaire - TPE Stripe", stripe_terminal_payment_id: 41 });
const response = () => ({ status(code) { this.statusCode = code; return this; }, json(payload) { this.payload = payload; return this; } });

test("archive fields preserve Terminal identity and never recollect or change its method", () => {
  const result = buildCashRegisterArchiveFields({ order: paidOrder(), paymentMethod: "Especes" });
  assert.strictEqual(result.stripe_terminal_payment_id, 41);
  assert.strictEqual(result.payment, "Carte bancaire - TPE Stripe");
  assert.strictEqual(result.used_payment_method, "Carte bancaire - TPE Stripe");
  assert.strictEqual(result.payment_provider, "stripe_terminal");
  for (const payment_status of ["unpaid", "refund_pending", "refunded"]) {
    assert.throws(() => buildCashRegisterArchiveFields({ order: { ...paidOrder(), payment_status }, paymentMethod: "Especes" }));
  }
});

test("archive failure leaves payment paid; retry preserves allocation and cannot charge again", async () => {
  let state = { order: paidOrder(), archives: [], details: [] };
  let fail = true;
  const archive = buildOrderArchiveModule({
    repository: {
      findOrderForArchive: async () => state.order,
      findTerminalAllocationForArchive: async (scope) => {
        assert.deepStrictEqual([scope.shopId, scope.orderId, scope.paymentId], [7, 12, 41]);
        return { amount_cents: 1000, shopid: 7, order_id: 12, terminal_payment_id: 41 };
      },
      findOrderDetails: async () => [{ id: 1, qty: 1, total: 12, price: 12, vat_rate: 20 }],
      insertArchive: async ({ archive: row }) => { state.archives.push(row); return { insertId: 100 }; },
      findActiveSnapshots: async () => [],
      insertArchiveDetail: async ({ detail }) => {
        if (fail) throw new Error("archive unavailable");
        state.details.push(detail); return { insertId: 200 };
      },
      deleteActiveSnapshots: async () => {}, deleteLegacyCustomizations: async () => {}, deleteOrderDetails: async () => {},
      deleteOrder: async () => { state.order = null; return { affectedRows: 1 }; },
    },
    withTransaction: async (work) => {
      const before = clone(state);
      try { return await work({ transaction: true }); }
      catch (error) { state = before; throw error; }
    },
    createToken: () => "terminal-archive",
  });
  await assert.rejects(() => archive.mArchiveOrder(12, "Especes", 7), /archive unavailable/);
  assert.strictEqual(state.order.payment_status, "paid");
  assert.strictEqual(state.order.stripe_terminal_payment_id, 41);
  assert.strictEqual(state.archives.length, 0);
  const store = buildStripeTerminalModule({ connection: { query: async (sql) => {
    if (sql.includes("FROM stripe_terminal_readers r")) return [[{ id: 21, shopid: 7 }]];
    if (sql.includes("FROM orders o")) return [[state.order]];
    throw new Error(`Unexpected SQL ${sql}`);
  } } });
  let stripeCalls = 0;
  const payments = buildStripeTerminalPaymentService({
    stripe: { paymentIntents: { create: async () => { stripeCalls += 1; } } },
    terminalStore: { ...store, withTransaction: async (work) => work(store) },
    shopStore: { findShop: async () => ({ id: 7 }) },
  });
  await assert.rejects(() => payments.startPayment({ shopId: 7, cashierUserId: 11, orderIds: [12] }),
    (error) => error.code === "TERMINAL_INVALID_ORDERS");
  assert.strictEqual(stripeCalls, 0);
  fail = false;
  await archive.mArchiveOrder(12, "Especes", 7, { discountType: "percent", discountValue: 99 });
  assert.strictEqual(state.order, null);
  assert.strictEqual(state.archives[0].stripe_terminal_payment_id, 41);
  assert.strictEqual(state.archives[0].payment_status, "paid");
  assert.strictEqual(state.archives[0].subtotal, 10);
  assert.strictEqual(state.details[0].total, 10);
});

test("Terminal archive controller bypasses web synchronization and rejects unpaid links", async () => {
  let order = paidOrder();
  let archives = 0;
  const controller = buildArchiveOrderController({
    findOrderById: async () => [order],
    syncPendingStripeBeforeCashRegisterArchive: async () => { throw new Error("web synchronization must not run"); },
    archiveOrder: async () => { archives += 1; return { affectedRows: 1 }; },
  });
  let res = response();
  await controller({ shopid: 7, params: { id: "12" }, body: {} }, res);
  assert.strictEqual(res.statusCode, 200);
  order = { ...order, payment_status: "unpaid" };
  res = response();
  await controller({ shopid: 7, params: { id: "12" }, body: { payment_method: "Especes" } }, res);
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(archives, 1);
});

const refundFixture = () => {
  assert.strictEqual(typeof stripeController.buildTerminalOrderRefundService, "function", "Terminal refund service must exist");
  const state = { order: paidOrder(), refunds: [], calls: [], queries: [], transitions: [], status: "succeeded", amount: 1000, failPersist: false,
    allocation: { shopid: 7, order_id: 12, terminal_payment_id: 41, amount_cents: 1000,
      stripe_refund_id: null, refund_status: null, refund_generation: 0 },
    inTransaction: false, contention: 0, attempts: 0, destination: "acct_restaurant" };
  const connection = { query: async (sql, params) => {
    state.queries.push({ sql, params });
    if (sql.includes("FROM stripe_terminal_payment_orders a")) {
      if (sql.includes("a.order_id = ?")) {
        assert.deepStrictEqual(params, [7, 12, 41, 7]);
        assert(sql.includes("p.status = 'succeeded'"));
      } else assert.deepStrictEqual(params, [7, 41, 7]);
      return [[{ ...clone(state.allocation), amount_cents: state.amount }]];
    }
    if (sql.includes("FROM stripe_terminal_payments p")) {
      assert.deepStrictEqual(params, [7, 41]);
      return [[{ id: 41, shopid: 7, status: state.status, stripe_payment_intent_id: "pi_group",
        stripe_connected_account_id: "acct_restaurant", amount_cents: 1500, currency: "eur" }]];
    }
    if (sql.includes("FROM orders o")) {
      assert.deepStrictEqual(params, [7, 12]);
      assert(sql.includes("FOR UPDATE"));
      return [state.order ? [clone(state.order)] : []];
    }
    if (sql.startsWith("UPDATE stripe_terminal_payment_orders")) {
      assert(state.inTransaction);
      assert.match(sql, /shopid = \? AND order_id = \? AND terminal_payment_id = \?/);
      const [generation, refundId, status, shopId, orderId, paymentId, expectedGeneration] = params;
      assert.deepStrictEqual([shopId, orderId, paymentId], [7, 12, 41]);
      if (state.allocation.refund_generation !== expectedGeneration) return [{ affectedRows: 0 }];
      Object.assign(state.allocation, { refund_generation: generation, stripe_refund_id: refundId, refund_status: status });
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith("UPDATE orders SET payment_status")) {
      assert(state.inTransaction);
      const [paymentStatus, shopId, orderId, paymentId] = params;
      assert.deepStrictEqual([shopId, orderId, paymentId], [7, 12, 41]);
      assert.match(sql, /shopid = \? AND id = \? AND stripe_terminal_payment_id = \?/);
      if (state.failPersist && paymentStatus === "refunded") throw new Error("raw SQL secret");
      if (!state.order) return [{ affectedRows: 0 }];
      state.order.payment_status = paymentStatus;
      state.transitions.push({ paymentStatus });
      return [{ affectedRows: 1 }];
    }
    throw new Error(`Unexpected SQL ${sql}`);
  } };
  const terminalStore = buildStripeTerminalModule({ connection });
  assert.strictEqual(typeof terminalStore.reserveOrderRefund, "function", "Refund attempts must be reserved transactionally");
  let queue = Promise.resolve();
  terminalStore.withTransaction = (work) => {
    const run = queue.then(async () => {
      state.attempts += 1;
      if (state.contention-- > 0) throw Object.assign(new Error("raw DB contention"), { errno: 1205 });
      const before = clone({ order: state.order, allocation: state.allocation });
      state.inTransaction = true;
      try { return await work(terminalStore); }
      catch (error) { Object.assign(state, before); throw error; }
      finally { state.inTransaction = false; }
    });
    queue = run.catch(() => {});
    return run;
  };
  let refundLocked = false;
  terminalStore.withOrderRefundLock = async (scope, work) => {
    assert.deepStrictEqual(scope, { shopId: 7, orderId: 12, paymentId: 41 });
    if (refundLocked) return null;
    refundLocked = true;
    try { return await work(terminalStore); }
    finally { refundLocked = false; }
  };
  const idempotency = new Map();
  const stripe = { paymentIntents: { retrieve: async (id) => {
    assert(!state.inTransaction);
    assert.strictEqual(id, "pi_group");
    return { id, status: "succeeded", amount: 1500, currency: "eur", on_behalf_of: "acct_restaurant",
      transfer_data: { destination: state.destination }, metadata: { shop_id: "7", terminal_payment_id: "41" } };
  } }, refunds: {
    retrieve: async (id) => {
      assert(!state.inTransaction);
      const found = state.refunds.find((refund) => refund.id === id);
      assert(found, "retrieval must use a tracked refund ID");
      return clone(found);
    },
    list: async (params) => {
      assert(!state.inTransaction);
      assert.deepStrictEqual(params, { payment_intent: "pi_group", limit: 100 });
      return { data: clone(state.refunds), has_more: false };
    },
    create: async (params, options) => {
      assert(!state.inTransaction);
      state.calls.push({ params, options });
      if (idempotency.has(options.idempotencyKey)) return clone(idempotency.get(options.idempotencyKey));
      const generation = params.metadata.refund_attempt_generation || "0";
      const refund = { id: generation === "0" ? "re_order12" : `re_order12_g${generation}`, status: "succeeded", amount: params.amount,
        payment_intent: params.payment_intent, currency: "eur", metadata: params.metadata };
      state.refunds.push(refund);
      idempotency.set(options.idempotencyKey, clone(refund));
      return clone(refund);
    },
  } };
  const service = stripeController.buildTerminalOrderRefundService({
    terminalStore, getStripe: () => stripe,
    findOrderById: async (id, shopId) => state.order && state.order.id === id && state.order.shopid === shopId ? [clone(state.order)] : [],
  });
  return { state, stripe, terminalStore, service, input: { shopId: 7, orderId: 12, actorId: 11 } };
};

test("refund uses successful shop/order/payment allocation and a stable key, never group total", async () => {
  const f = refundFixture();
  const result = await f.service.refundTerminalOrder(f.input);
  assert.deepStrictEqual(result, { refundId: "re_order12", refundStatus: "succeeded" });
  assert.deepStrictEqual(f.state.calls, [{ params: { payment_intent: "pi_group", amount: 1000,
    reverse_transfer: true, refund_application_fee: true,
    metadata: { shop_id: "7", order_id: "12", terminal_payment_id: "41", refund_attempt_generation: "0" } },
  options: { idempotencyKey: "terminal-refund:7:41:12:g0" } }]);
  assert.deepStrictEqual(f.state.transitions.map((t) => t.paymentStatus), ["refund_pending", "refunded"]);
  await f.service.refundTerminalOrder({ ...f.input, actorId: 99 });
  assert.strictEqual(f.state.calls.length, 1);
});

test("refund survives local persistence failure and timeout without creating another refund", async () => {
  for (const timeout of [false, true]) {
    const f = refundFixture();
    if (timeout) {
      const create = f.stripe.refunds.create;
      f.stripe.refunds.create = async (...args) => { await create(...args); throw new Error("raw Stripe secret"); };
    } else f.state.failPersist = true;
    await assert.rejects(() => f.service.refundTerminalOrder(f.input), (e) => !/raw|secret/.test(e.message));
    assert.strictEqual(f.state.order.payment_status, "refund_pending");
    f.state.failPersist = false;
    const result = await f.service.refundTerminalOrder({ ...f.input, actorId: 99 });
    assert.strictEqual(result.refundStatus, "succeeded");
    assert.strictEqual(f.state.order.payment_status, "refunded");
    assert.strictEqual(f.state.calls.length, 1);
  }
});

test("pending and failed refunds do not report refunded or expose provider errors", async () => {
  for (const status of ["pending", "requires_action", "failed", "canceled"]) {
    const f = refundFixture();
    f.stripe.refunds.create = async (params) => ({ id: "re_pending", status, amount: params.amount,
      currency: "eur", payment_intent: "pi_group", metadata: params.metadata, failure_reason: "raw secret" });
    const result = await f.service.refundTerminalOrder(f.input);
    assert.strictEqual(result.refundStatus, status);
    assert(!JSON.stringify(result).includes("raw"));
    assert.strictEqual(f.state.order.payment_status, ["failed", "canceled"].includes(status) ? "paid" : "refund_pending");
  }
});

test("refund rejects foreign shops, unsuccessful sessions, missing allocation and archive races", async () => {
  const foreign = refundFixture();
  await assert.rejects(() => foreign.service.refundTerminalOrder({ ...foreign.input, shopId: 8 }));
  const failed = refundFixture(); failed.state.status = "failed";
  await assert.rejects(() => failed.service.refundTerminalOrder(failed.input));
  const missing = refundFixture(); missing.terminalStore.findOrderAllocation = async () => null;
  await assert.rejects(() => missing.service.refundTerminalOrder(missing.input));
  const archived = refundFixture();
  const lookup = archived.terminalStore.findOrderAllocation;
  archived.terminalStore.findOrderAllocation = async (...args) => { const row = await lookup(...args); archived.state.order = null; return row; };
  await assert.rejects(() => archived.service.refundTerminalOrder(archived.input));
  for (const f of [foreign, failed, missing, archived]) assert.strictEqual(f.state.calls.length, 0);
});

test("existing refund endpoint branches only for a linked Terminal order", async () => {
  const calls = [];
  const controller = stripeController.buildRefundPaidOrderController({
    getPaidOrderForRefund: async () => [paidOrder()],
    refundTerminalOrder: async (scope) => { calls.push(scope); return { refundId: "re_12", refundStatus: "succeeded" }; },
    getStripe: () => { throw new Error("web refund path must not run"); },
  });
  const res = response();
  await controller({ params: { id: "12" }, shopid: 7, id: 11 }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(calls, [{ shopId: 7, orderId: 12, actorId: 11 }]);
  assert.strictEqual(res.payload.data.refundId, "re_12");
});

test("asynchronous Terminal refund webhooks reconcile without browser or legacy refund handlers", async () => {
  const f = refundFixture();
  const create = f.stripe.refunds.create;
  f.stripe.refunds.create = async (...args) => {
    await create(...args);
    f.state.refunds[0].status = "pending";
    return clone(f.state.refunds[0]);
  };
  await f.service.refundTerminalOrder(f.input);
  assert.strictEqual(f.state.order.payment_status, "refund_pending");
  assert.strictEqual(typeof f.service.reconcileTerminalRefund, "function", "Terminal refund reconciliation must exist");
  f.stripe.refunds.retrieve = async (id) => {
    assert.strictEqual(id, "re_order12"); return clone(f.state.refunds[0]);
  };
  const handle = stripeController.buildStripeWebhookEventHandler({
    getStripe: () => f.stripe, reconcileTerminalRefund: f.service.reconcileTerminalRefund,
    reconcileStripeRefund: async () => { throw new Error("legacy refund handler must not run"); },
  });
  const event = { type: "refund.updated", data: { object: clone(f.state.refunds[0]) } };
  f.state.refunds[0].status = "succeeded";
  await handle(event);
  assert.strictEqual(f.state.order.payment_status, "refunded");
  await handle({ ...event, type: "refund.failed" });
  assert.strictEqual(f.state.order.payment_status, "refunded");
  assert.strictEqual(f.state.calls.length, 1);
  f.stripe.refunds.retrieve = async () => { throw new Error("raw Stripe secret"); };
  await assert.rejects(() => handle(event), (error) => !/raw|secret/.test(error.message));
});

test("zero-cent allocations complete locally without a Stripe refund", async () => {
  const f = refundFixture();
  f.state.amount = 0;
  f.stripe.refunds.list = async () => { throw new Error("zero amount must not contact Stripe"); };
  assert.deepStrictEqual(await f.service.refundTerminalOrder(f.input), { refundId: null, refundStatus: "succeeded" });
  assert.strictEqual(f.state.order.payment_status, "refunded");
  assert.strictEqual(f.state.calls.length, 0);
});

test("archive without line details still preserves the successful allocated amount", async () => {
  let saved;
  const archive = buildOrderArchiveModule({
    repository: {
      findOrderForArchive: async () => paidOrder(),
      findTerminalAllocationForArchive: async () => ({ amount_cents: 1000 }),
      findOrderDetails: async () => [], findActiveSnapshots: async () => [],
      insertArchive: async ({ archive: row }) => { saved = row; return { insertId: 100 }; },
      deleteActiveSnapshots: async () => {}, deleteLegacyCustomizations: async () => {}, deleteOrderDetails: async () => {},
      deleteOrder: async () => ({ affectedRows: 1 }),
    },
    withTransaction: async (work) => work({}), createToken: () => "no-details",
  });
  await archive.mArchiveOrder(12, undefined, 7);
  assert.strictEqual(saved.subtotal, 10);
  assert.strictEqual(saved.discount_amount, 2);
  assert.strictEqual(saved.stripe_terminal_payment_id, 41);
});

test("refund state SQL remains scoped and monotonic and retries DB contention only", async () => {
  const f = refundFixture();
  f.state.contention = 2;
  await f.service.refundTerminalOrder(f.input);
  assert.strictEqual(f.state.attempts, 4);
  assert.strictEqual(f.state.calls.length, 1);
  const locks = f.state.queries.filter((query) => query.sql.includes("FOR UPDATE"));
  assert(locks[0].sql.includes("FROM orders o"));
  assert(locks[1].sql.includes("FROM stripe_terminal_payments p"));
  assert(locks[2].sql.includes("FROM stripe_terminal_payment_orders a"));
});

test("refund pagination recovers its own allocation without refunding another grouped order", async () => {
  const f = refundFixture();
  const queries = [];
  const own = { id: "re_12", status: "succeeded", amount: 1000, currency: "eur", payment_intent: "pi_group",
    metadata: { shop_id: "7", order_id: "12", terminal_payment_id: "41", refund_attempt_generation: "0" } };
  f.stripe.refunds.list = async (params) => {
    queries.push(params);
    return params.starting_after
      ? { data: [own], has_more: false }
      : { data: [{ ...own, id: "re_31", amount: 500, metadata: { ...own.metadata, order_id: "31" } }], has_more: true };
  };
  assert.strictEqual((await f.service.refundTerminalOrder(f.input)).refundId, "re_12");
  assert.deepStrictEqual(queries[1], { payment_intent: "pi_group", limit: 100, starting_after: "re_31" });
  assert.strictEqual(f.state.calls.length, 0);
});

test("malformed or mismatched Stripe refund snapshots never trigger another refund or mark refunded", async () => {
  for (const patch of [{ amount: 1500 }, { currency: "usd" }, { payment_intent: "pi_other" }, { status: "unknown" }]) {
    const f = refundFixture();
    f.state.refunds = [{ id: "re_wrong", status: "succeeded", amount: 1000, currency: "eur", payment_intent: "pi_group",
      metadata: { shop_id: "7", order_id: "12", terminal_payment_id: "41", refund_attempt_generation: "0" }, ...patch }];
    await assert.rejects(() => f.service.refundTerminalOrder(f.input));
    assert.strictEqual(f.state.calls.length, 0);
    assert.strictEqual(f.state.order.payment_status, "refund_pending");
  }
});

test("default refund lookup preserves eligible web orders without an extra Terminal lookup", async () => {
  const orders = require("../src/modules/m_orders");
  const payments = require("../src/modules/m_payments");
  const controllerPath = require.resolve("../src/controllers/c_stripe");
  const original = { find: orders.mFindOrderById, paid: payments.getPaidOrderForRefund, controller: require.cache[controllerPath] };
  let terminalLookups = 0;
  let linked = false;
  orders.mFindOrderById = async (orderId, shopId) => {
    terminalLookups += 1;
    assert(linked, "web order must keep its existing lookup path");
    assert.deepStrictEqual([orderId, shopId], [12, 7]);
    return [paidOrder()];
  };
  payments.getPaidOrderForRefund = async () => linked ? [] : [{ payment_status: "refunded", payment_record_status: "refunded" }];
  delete require.cache[controllerPath];
  try {
    const controller = require(controllerPath).buildRefundPaidOrderController({
      refundTerminalOrder: async () => ({ refundId: "re_12", refundStatus: "succeeded" }),
    });
    let res = response();
    await controller({ params: { id: "12" }, shopid: 7, id: 11 }, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(terminalLookups, 0);
    linked = true;
    res = response();
    await controller({ params: { id: "12" }, shopid: 7, id: 11 }, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(terminalLookups, 1);
    assert.strictEqual(res.payload.data.refundId, "re_12");
  } finally {
    orders.mFindOrderById = original.find;
    payments.getPaidOrderForRefund = original.paid;
    require.cache[controllerPath] = original.controller;
  }
});

test("round1 authoritative failure of the same refund corrects local success to paid", async () => {
  for (const status of ["failed", "canceled"]) {
    const f = refundFixture();
    await f.service.refundTerminalOrder(f.input);
    assert.strictEqual(f.state.order.payment_status, "refunded");
    const eventSnapshot = clone(f.state.refunds[0]);
    f.state.refunds[0].status = status;
    const handler = stripeController.buildStripeWebhookEventHandler({
      getStripe: () => f.stripe, reconcileTerminalRefund: f.service.reconcileTerminalRefund,
      reconcileStripeRefund: () => assert.fail("Terminal refunds must not enter web reconciliation"),
    });
    await handler({ type: "refund.updated", data: { object: eventSnapshot } });
    assert.strictEqual(f.state.order.payment_status, "paid");
    assert.strictEqual(f.state.allocation.stripe_refund_id, "re_order12");
    assert.strictEqual(f.state.allocation.refund_status, status);
  }
});

test("round1 failed or canceled refund advances generation and creates a new exact allocation refund", async () => {
  for (const status of ["failed", "canceled"]) {
    const f = refundFixture();
    const create = f.stripe.refunds.create;
    f.stripe.refunds.create = async (...args) => {
      const refund = await create(...args);
      refund.status = f.state.calls.length === 1 ? status : "succeeded";
      f.state.refunds[f.state.refunds.length - 1] = clone(refund);
      return refund;
    };
    await f.service.refundTerminalOrder(f.input);
    await f.service.refundTerminalOrder(f.input);
    assert.strictEqual(f.state.calls.length, 2);
    assert.deepStrictEqual(f.state.calls.map((call) => call.options.idempotencyKey), [
      "terminal-refund:7:41:12:g0", "terminal-refund:7:41:12:g1",
    ]);
    assert(f.state.calls.every((call) => call.params.amount === 1000));
    assert.strictEqual(f.state.allocation.refund_generation, 1);
  }
});

test("round1 delayed pending creation response cannot overwrite webhook failure or block archive", async () => {
  for (const status of ["failed", "canceled"]) {
    const f = refundFixture();
    let release;
    const released = new Promise((resolve) => { release = resolve; });
    let started;
    const created = new Promise((resolve) => { started = resolve; });
    const create = f.stripe.refunds.create;
    f.stripe.refunds.create = async (...args) => {
      const refund = await create(...args);
      refund.status = "pending";
      f.state.refunds[0] = clone(refund);
      started();
      await released;
      return refund;
    };
    const pending = f.service.refundTerminalOrder(f.input);
    await created;
    try {
      f.state.refunds[0].status = status;
      await f.service.reconcileTerminalRefund(clone(f.state.refunds[0]));
    } finally { release(); }
    const result = await pending;
    assert.strictEqual(f.state.order.payment_status, "paid");
    assert.strictEqual(f.state.allocation.refund_status, status);
    assert.strictEqual(result.refundStatus, status);
    assert.strictEqual(buildCashRegisterArchiveFields({ order: f.state.order }).payment_status, "paid");
  }
});

test("round1 old generations and mismatched refund IDs cannot undo the current refund", async () => {
  const f = refundFixture();
  await f.service.refundTerminalOrder(f.input);
  const previous = { ...f.state.refunds[0], status: "failed" };
  f.state.refunds[0] = previous;
  await f.service.reconcileTerminalRefund(previous);
  await f.service.refundTerminalOrder(f.input);
  const current = clone(f.state.allocation);
  await f.service.reconcileTerminalRefund(previous);
  await f.service.reconcileTerminalRefund({ ...f.state.refunds[1], id: "re_wrong", status: "failed" });
  assert.strictEqual(f.state.order.payment_status, "refunded");
  assert.deepStrictEqual(f.state.allocation, current);
  assert.strictEqual(current.stripe_refund_id, "re_order12_g1");
});

const seedRefundAttempt = (f, status) => {
  const refund = { id: "re_order12_g1", status: status === "creating" ? "pending" : status,
    amount: 1000, currency: "eur", payment_intent: "pi_group",
    metadata: { shop_id: "7", order_id: "12", terminal_payment_id: "41", refund_attempt_generation: "1" } };
  f.state.refunds.push(refund);
  Object.assign(f.state.allocation, { refund_generation: 1, refund_status: status,
    stripe_refund_id: status === "creating" ? null : refund.id });
  f.state.order.payment_status = ["failed", "canceled"].includes(status) ? "paid" : "refund_pending";
  return refund;
};

test("round2 creating/pending observer stays pinned when failure arrives before reservation", async () => {
  for (const observedStatus of ["creating", "pending"]) for (const failure of ["failed", "canceled"]) {
    const f = refundFixture();
    const refund = seedRefundAttempt(f, observedStatus);
    const observed = deferred();
    const resume = deferred();
    const retrieve = f.stripe.paymentIntents.retrieve;
    let reads = 0;
    f.stripe.paymentIntents.retrieve = async (...args) => {
      const intent = await retrieve(...args);
      if (++reads === 1) { observed.resolve(); await resume.promise; }
      return intent;
    };
    const stale = f.service.refundTerminalOrder(f.input);
    await observed.promise;
    try {
      refund.status = failure;
      await f.service.reconcileTerminalRefund(clone(refund));
    } finally { resume.resolve(); }
    const result = await stale;
    assert.strictEqual(f.state.allocation.refund_generation, 1, "an ineligible observer must not advance g1");
    assert.deepStrictEqual(result, { refundId: refund.id, refundStatus: failure });
    assert.strictEqual(f.state.calls.length, 0);
    assert.strictEqual(buildCashRegisterArchiveFields({ order: f.state.order }).payment_status, "paid");
    await f.service.refundTerminalOrder(f.input);
    assert.strictEqual(f.state.allocation.refund_generation, 2);
    assert.deepStrictEqual(f.state.calls.map((call) => [call.params.amount, call.options.idempotencyKey]), [
      [1000, "terminal-refund:7:41:12:g2"],
    ]);
  }
});

test("round2 two failed observers advance once and issue exactly one Stripe creation for g2", async () => {
  const f = refundFixture();
  seedRefundAttempt(f, "failed");
  const observed = deferred();
  const callers = [deferred(), deferred()];
  const listing = deferred();
  const resumeList = deferred();
  const retrieve = f.stripe.paymentIntents.retrieve;
  let reads = 0;
  f.stripe.paymentIntents.retrieve = async (...args) => {
    const intent = await retrieve(...args);
    const index = reads++;
    if (reads === 2) observed.resolve();
    if (index < 2) await callers[index].promise;
    return intent;
  };
  const list = f.stripe.refunds.list;
  let listings = 0;
  f.stripe.refunds.list = async (...args) => {
    const snapshot = await list(...args);
    if (++listings === 1) { listing.resolve(); await resumeList.promise; }
    return snapshot;
  };
  const winner = f.service.refundTerminalOrder(f.input);
  const loser = f.service.refundTerminalOrder({ ...f.input, actorId: 99 });
  let reused;
  try {
    await observed.promise;
    callers[0].resolve();
    await listing.promise;
    assert.strictEqual(f.state.allocation.refund_generation, 2);
    callers[1].resolve();
    reused = await loser;
  } finally {
    callers.forEach((caller) => caller.resolve());
    resumeList.resolve();
  }
  const created = await winner;
  assert.strictEqual(f.state.calls.length, 1, "one Stripe create call, not two calls sharing an idempotency key");
  assert.deepStrictEqual(reused, { refundId: null, refundStatus: "creating" });
  assert.strictEqual(created.refundId, "re_order12_g2");
  assert.strictEqual(f.state.allocation.refund_generation, 2);
  assert.strictEqual(f.state.queries.filter(({ sql, params }) => sql.startsWith("UPDATE stripe_terminal_payment_orders")
    && params[0] === 2 && params[2] === "creating").length, 1);
  assert.strictEqual(f.state.calls[0].options.idempotencyKey, "terminal-refund:7:41:12:g2");
  assert.strictEqual((await f.service.refundTerminalOrder(f.input)).refundId, created.refundId);
  assert.strictEqual(f.state.calls.length, 1);
});

test("round2 a caller observing g2 creating cannot duplicate its in-flight Stripe creation", async () => {
  const f = refundFixture();
  seedRefundAttempt(f, "failed");
  const listing = deferred();
  const resume = deferred();
  const list = f.stripe.refunds.list;
  let listings = 0;
  f.stripe.refunds.list = async (...args) => {
    const snapshot = await list(...args);
    if (++listings === 1) { listing.resolve(); await resume.promise; }
    return snapshot;
  };
  const owner = f.service.refundTerminalOrder(f.input);
  let current;
  try {
    await listing.promise;
    assert.strictEqual(f.state.allocation.refund_generation, 2);
    assert.strictEqual(f.state.allocation.refund_status, "creating");
    current = await f.service.refundTerminalOrder({ ...f.input, actorId: 99 });
  } finally { resume.resolve(); }
  const created = await owner;
  assert.strictEqual(f.state.calls.length, 1, "the current creating generation has only one provider owner");
  assert.deepStrictEqual(current, { refundId: null, refundStatus: "creating" });
  assert.strictEqual(created.refundId, "re_order12_g2");
  assert.strictEqual(f.state.allocation.refund_generation, 2);
});

test("round2 stale failed observer cannot take over a newer ambiguous generation after its owner exits", async () => {
  const f = refundFixture();
  seedRefundAttempt(f, "failed");
  const observed = deferred();
  const resume = deferred();
  const retrieve = f.stripe.paymentIntents.retrieve;
  let reads = 0;
  f.stripe.paymentIntents.retrieve = async (...args) => {
    const intent = await retrieve(...args);
    if (++reads === 1) { observed.resolve(); await resume.promise; }
    return intent;
  };
  const stale = f.service.refundTerminalOrder(f.input);
  await observed.promise;
  const list = f.stripe.refunds.list;
  try {
    f.stripe.refunds.list = async () => { throw new Error("raw Stripe unavailable"); };
    await assert.rejects(() => f.service.refundTerminalOrder(f.input), (error) => !/raw|Stripe unavailable/.test(error.message));
    assert.strictEqual(f.state.allocation.refund_generation, 2);
  } finally { f.stripe.refunds.list = list; resume.resolve(); }
  assert.deepStrictEqual(await stale, { refundId: null, refundStatus: "creating" });
  assert.strictEqual(f.state.calls.length, 0, "the losing g1 observer cannot create g2 after lock release");
  await f.service.refundTerminalOrder(f.input);
  assert.strictEqual(f.state.allocation.refund_generation, 2);
  assert.strictEqual(f.state.calls.length, 1);
  assert.strictEqual(f.state.calls[0].options.idempotencyKey, "terminal-refund:7:41:12:g2");
});

test("round2 reservation compares the exact observed terminal status as well as generation", async () => {
  const f = refundFixture();
  seedRefundAttempt(f, "canceled");
  const before = clone(f.state.allocation);
  await f.terminalStore.withTransaction((transaction) => transaction.reserveOrderRefund({
    shopId: 7, orderId: 12, paymentId: 41, generation: 1, observedStatus: "failed",
  }));
  assert.strictEqual(f.state.allocation.refund_generation, 1);
  assert.deepStrictEqual(f.state.allocation, before);
  assert.strictEqual(f.state.order.payment_status, "paid");
});

test("round1 delayed pending retrieval cannot undo a confirmed failure", async () => {
  const f = refundFixture();
  const create = f.stripe.refunds.create;
  f.stripe.refunds.create = async (...args) => {
    await create(...args);
    f.state.refunds[0].status = "pending";
    return clone(f.state.refunds[0]);
  };
  await f.service.refundTerminalOrder(f.input);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let started;
  const retrieved = new Promise((resolve) => { started = resolve; });
  f.stripe.refunds.retrieve = async () => {
    const snapshot = clone(f.state.refunds[0]);
    started();
    await gate;
    return snapshot;
  };
  const request = f.service.refundTerminalOrder(f.input);
  await retrieved;
  try {
    f.state.refunds[0].status = "failed";
    await f.service.reconcileTerminalRefund(clone(f.state.refunds[0]));
  } finally { release(); }
  assert.strictEqual((await request).refundStatus, "failed");
  assert.strictEqual(f.state.order.payment_status, "paid");
  assert.strictEqual(f.state.allocation.refund_generation, 0);
});

test("round1 ambiguous outcomes retain their generation and persisted refund identity", async () => {
  const f = refundFixture();
  const create = f.stripe.refunds.create;
  f.stripe.refunds.create = async (...args) => { await create(...args); throw new Error("raw timeout"); };
  await assert.rejects(() => f.service.refundTerminalOrder(f.input));
  assert.strictEqual(f.state.allocation.refund_generation, 0);
  assert.strictEqual(f.state.allocation.refund_status, "creating");
  f.stripe.refunds.list = async () => { throw new Error("raw unavailable"); };
  await assert.rejects(() => f.service.refundTerminalOrder(f.input));
  assert.strictEqual(f.state.allocation.refund_generation, 0);
  f.stripe.refunds.list = async () => ({ data: clone(f.state.refunds), has_more: false });
  await f.service.refundTerminalOrder(f.input);
  assert.strictEqual(f.state.calls.length, 1);
  assert.strictEqual(f.state.allocation.stripe_refund_id, "re_order12");
});

test("round1 destination ownership is verified against the persisted connected account", async () => {
  for (const destination of ["acct_other", null]) {
    const f = refundFixture();
    f.state.destination = destination;
    await assert.rejects(() => f.service.refundTerminalOrder(f.input), (error) => !/raw|acct_other/.test(error.message));
    assert.strictEqual(f.state.calls.length, 0);
    assert.strictEqual(f.state.order.payment_status, "paid");
  }
});

test("round1 missing or mismatched retrieval identity never creates another refund", async () => {
  for (const missing of [true, false]) {
    const f = refundFixture();
    await f.service.refundTerminalOrder(f.input);
    f.stripe.refunds.retrieve = async () => missing ? null : { ...f.state.refunds[0], id: "re_other" };
    await assert.rejects(() => f.service.refundTerminalOrder(f.input));
    assert.strictEqual(f.state.calls.length, 1);
    assert.strictEqual(f.state.allocation.stripe_refund_id, "re_order12");
    assert.strictEqual(f.state.order.payment_status, "refunded");
  }
});

(async () => {
  let failures = 0;
  for (const { name, work } of tests) {
    let timer;
    try {
      await Promise.race([work(), new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Refund scheduler stalled")), 3000);
      })]);
      console.log(`PASS ${name}`);
    }
    catch (error) { failures += 1; console.error(`FAIL ${name}: ${error.stack}`); }
    finally { clearTimeout(timer); }
  }
  console.log(`stripe terminal refund/archive tests: ${tests.length - failures}/${tests.length} passed`);
  process.exitCode = failures ? 1 : 0;
})();
