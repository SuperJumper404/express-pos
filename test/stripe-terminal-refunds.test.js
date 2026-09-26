const assert = require("assert");
require.cache[require.resolve("../src/config/db")] = { exports: {} };
const { buildOrderArchiveModule, mUpdateTerminalRefundState } = require("../src/modules/m_orders");
const { buildArchiveOrderController } = require("../src/controllers/c_orders");
const stripeController = require("../src/controllers/c_stripe");
const { buildCashRegisterArchiveFields } = require("../src/helpers/cashRegisterPayment");
const { buildStripeTerminalModule } = require("../src/modules/m_stripeTerminal");
const { buildStripeTerminalPaymentService } = require("../src/services/stripeTerminalPayments");

const tests = [];
const test = (name, work) => tests.push({ name, work });
const clone = (value) => JSON.parse(JSON.stringify(value));
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
  const state = { order: paidOrder(), refunds: [], calls: [], transitions: [], status: "succeeded", amount: 1000, failPersist: false };
  const terminalStore = buildStripeTerminalModule({ connection: { query: async (sql, params) => {
    if (sql.includes("FROM stripe_terminal_payment_orders a")) {
      assert.deepStrictEqual(params, [7, 12, 41, 7]);
      assert(sql.includes("p.status = 'succeeded'"));
      return [[{ shopid: 7, order_id: 12, terminal_payment_id: 41, amount_cents: state.amount }]];
    }
    if (sql.includes("FROM stripe_terminal_payments p")) {
      assert.deepStrictEqual(params, [7, 41]);
      return [[{ id: 41, shopid: 7, status: state.status, stripe_payment_intent_id: "pi_group", amount_cents: 1500, currency: "eur" }]];
    }
    throw new Error(`Unexpected SQL ${sql}`);
  } } });
  const stripe = { refunds: {
    list: async (params) => {
      assert.deepStrictEqual(params, { payment_intent: "pi_group", limit: 100 });
      return { data: clone(state.refunds), has_more: false };
    },
    create: async (params, options) => {
      state.calls.push({ params, options });
      const refund = { id: "re_order12", status: "succeeded", amount: params.amount,
        payment_intent: params.payment_intent, currency: "eur", metadata: params.metadata };
      state.refunds.push(refund);
      return clone(refund);
    },
  } };
  const service = stripeController.buildTerminalOrderRefundService({
    terminalStore, getStripe: () => stripe,
    findOrderById: async (id, shopId) => state.order && state.order.id === id && state.order.shopid === shopId ? [clone(state.order)] : [],
    updateRefundState: async (scope) => {
      state.transitions.push(scope);
      assert.deepStrictEqual([scope.shopId, scope.orderId, scope.paymentId], [7, 12, 41]);
      if (state.failPersist && scope.paymentStatus === "refunded") throw new Error("raw SQL secret");
      if (!state.order) return { affectedRows: 0 };
      if (state.order.payment_status === "refunded") return { affectedRows: 0 };
      state.order.payment_status = scope.paymentStatus;
      return { affectedRows: 1 };
    },
  });
  return { state, stripe, terminalStore, service, input: { shopId: 7, orderId: 12, actorId: 11 } };
};

test("refund uses successful shop/order/payment allocation and a stable key, never group total", async () => {
  const f = refundFixture();
  const result = await f.service.refundTerminalOrder(f.input);
  assert.deepStrictEqual(result, { refundId: "re_order12", refundStatus: "succeeded" });
  assert.deepStrictEqual(f.state.calls, [{ params: { payment_intent: "pi_group", amount: 1000,
    reverse_transfer: true, refund_application_fee: true,
    metadata: { shop_id: "7", order_id: "12", terminal_payment_id: "41" } },
  options: { idempotencyKey: "terminal-refund:7:41:12" } }]);
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
  const pool = require("../src/config/dbPool");
  const original = pool.query;
  let attempts = 0;
  pool.query = async (sql, params) => {
    assert.match(sql, /shopid = \? AND id = \? AND stripe_terminal_payment_id = \?/);
    assert.match(sql, /payment_status IN \('paid', 'refund_pending'\)/);
    assert.deepStrictEqual(params, ["refunded", 7, 12, 41]);
    attempts += 1;
    if (attempts <= 2) throw Object.assign(new Error("raw DB error"), { errno: 1205 });
    return [{ affectedRows: 1 }];
  };
  try {
    assert.deepStrictEqual(await mUpdateTerminalRefundState({ shopId: 7, orderId: 12, paymentId: 41, paymentStatus: "refunded" }), { affectedRows: 1 });
    assert.strictEqual(attempts, 3);
  } finally { pool.query = original; }
});

test("refund pagination recovers its own allocation without refunding another grouped order", async () => {
  const f = refundFixture();
  const queries = [];
  const own = { id: "re_12", status: "succeeded", amount: 1000, currency: "eur", payment_intent: "pi_group",
    metadata: { shop_id: "7", order_id: "12", terminal_payment_id: "41" } };
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
      metadata: { shop_id: "7", order_id: "12", terminal_payment_id: "41" }, ...patch }];
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

(async () => {
  let failures = 0;
  for (const { name, work } of tests) {
    try { await work(); console.log(`PASS ${name}`); }
    catch (error) { failures += 1; console.error(`FAIL ${name}: ${error.stack}`); }
  }
  console.log(`stripe terminal refund/archive tests: ${tests.length - failures}/${tests.length} passed`);
  process.exitCode = failures ? 1 : 0;
})();
