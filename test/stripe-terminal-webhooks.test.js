const assert = require("assert");
const fs = require("fs");
const { buildStripeTerminalModule } = require("../src/modules/m_stripeTerminal");

const tests = [];
const test = (name, work) => tests.push({ name, work });
const clone = (value) => JSON.parse(JSON.stringify(value));
const fixture = () => {
  const path = "../src/services/stripeTerminalWebhooks";
  assert(fs.existsSync(require("path").join(__dirname, `${path}.js`)), "Terminal webhook handler must exist");
  const { buildStripeTerminalWebhookHandler } = require(path);
  let state = {
    payment: { id: 41, shopid: 7, status: "processing", amount_cents: 1500,
      currency: "eur", stripe_payment_intent_id: "pi_terminal" },
    orders: [12, 31].map((id) => ({ id, shopid: 7, status: 1, payment_status: "unpaid", stripe_terminal_payment_id: null })),
    updates: 0,
  };
  const queries = [];
  let attempts = 0;
  let contention = 0;
  let failCommit = false;
  const connection = { query: async (sql, params) => {
    queries.push({ sql, params });
    if (sql.includes("FROM stripe_terminal_payment_orders a")) return [[
      { shopid: 7, order_id: 12, terminal_payment_id: 41, amount_cents: 1000 },
      { shopid: 7, order_id: 31, terminal_payment_id: 41, amount_cents: 500 },
    ]];
    if (sql.includes("FROM orders o")) return [clone(state.orders)];
    if (sql.includes("FROM stripe_terminal_payments p")) {
      return [Number(params[0]) === 7 && Number(params[1]) === 41 ? [clone(state.payment)] : []];
    }
    if (sql.startsWith("UPDATE orders o")) {
      state.updates += 1;
      state.orders.forEach((order) => Object.assign(order, {
        payment_status: "paid", payment_provider: "stripe_terminal", stripe_terminal_payment_id: params[0],
      }));
      return [{ affectedRows: 2 }];
    }
    if (sql.startsWith("UPDATE stripe_terminal_payments")) {
      state.payment.status = "succeeded";
      state.payment.stripe_charge_id = params[0];
      return [{ affectedRows: 1 }];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
  let queue = Promise.resolve();
  const terminalStore = {
    ...buildStripeTerminalModule({ connection }),
    withTransaction: (work) => {
      const run = queue.then(async () => {
        attempts += 1;
        if (contention-- > 0) throw Object.assign(new Error("raw SQL"), { code: "ER_LOCK_DEADLOCK" });
        const before = clone(state);
        try {
          const result = await work(buildStripeTerminalModule({ connection }));
          if (failCommit) throw new Error("raw commit failure");
          return result;
        } catch (error) { state = before; throw error; }
      });
      queue = run.catch(() => {});
      return run;
    },
  };
  const event = (type = "payment_intent.succeeded", changes = {}) => ({
    id: "evt_terminal", type, created: 1790000000,
    data: { object: { id: "pi_terminal", status: "succeeded", amount: 1500, currency: "eur",
      latest_charge: { id: "ch_terminal" }, metadata: { terminal_payment_id: "41", shop_id: "7" }, ...changes } },
  });
  return { handle: buildStripeTerminalWebhookHandler({ terminalStore }), event, queries,
    state: () => state, attempts: () => attempts,
    contention: (count) => { contention = count; }, failCommit: (value) => { failCommit = value; } };
};

test("browser-independent success finalizes linked orders once under duplicate delivery", async () => {
  const f = fixture();
  await Promise.all([f.handle(f.event()), f.handle(f.event())]);
  await f.handle(f.event());
  assert.strictEqual(f.state().updates, 1);
  assert(f.state().orders.every((o) => o.payment_status === "paid" && o.stripe_terminal_payment_id === 41 && o.status === 1));
  assert.strictEqual(f.state().payment.stripe_charge_id, "ch_terminal");
  const locks = f.queries.filter((q) => q.sql.includes("FOR UPDATE"));
  assert(locks[0].sql.includes("FROM orders o"));
  assert.deepStrictEqual(locks[0].params, [7, 12, 31]);
  assert(locks[1].sql.includes("FROM stripe_terminal_payments p"));
});

test("reader and stale failure events before or after success never finalize or regress payment", async () => {
  const f = fixture();
  const ignored = ["terminal.reader.action_succeeded", "terminal.reader.action_failed", "payment_intent.processing",
    "payment_intent.payment_failed", "payment_intent.canceled"];
  for (const type of ignored) await f.handle(f.event(type));
  assert.strictEqual(f.state().updates, 0);
  assert.strictEqual(f.state().payment.status, "processing");
  await f.handle(f.event());
  for (const type of ignored.reverse()) await f.handle(f.event(type));
  assert.strictEqual(f.state().updates, 1);
  assert.strictEqual(f.state().payment.status, "succeeded");
  f.state().orders = [];
  await f.handle(f.event());
  assert.strictEqual(f.state().updates, 1, "redelivery after archive must be harmless");
});

test("unrelated events fall through and malformed Terminal metadata cannot reach web handlers", async () => {
  const f = fixture();
  assert.strictEqual(await f.handle(f.event("payment_intent.succeeded", { metadata: { order_id: "12", shop_id: "7" } })), null);
  for (const terminal_payment_id of ["", "no", "0", "41.5"]) {
    const result = await f.handle(f.event("payment_intent.succeeded", { metadata: { terminal_payment_id, shop_id: "7" } }));
    assert.strictEqual(result.handled, true);
  }
  assert.strictEqual(f.state().updates, 0);
});

test("success validates tenant, persisted intent, amount, currency and succeeded status", async () => {
  for (const changes of [{ id: "pi_wrong" }, { amount: 1501 }, { currency: "usd" }, { status: "processing" },
    { metadata: { terminal_payment_id: "41", shop_id: "8" } }]) {
    const f = fixture();
    await assert.rejects(() => f.handle(f.event("payment_intent.succeeded", changes)), (e) => !/raw/.test(e.message));
    assert.strictEqual(f.state().updates, 0);
  }
});

test("DB contention retries only transactions and failed commits stay retryable", async () => {
  const f = fixture();
  f.contention(2);
  await f.handle(f.event());
  assert.strictEqual(f.attempts(), 3);
  assert.strictEqual(f.state().updates, 1);
  const failed = fixture();
  failed.failCommit(true);
  await assert.rejects(() => failed.handle(failed.event()), (e) => !/raw/.test(e.message));
  assert.strictEqual(failed.state().payment.status, "processing");
  failed.failCommit(false);
  await failed.handle(failed.event());
  assert.strictEqual(failed.state().updates, 1);
  const exhausted = fixture();
  exhausted.contention(5);
  await assert.rejects(() => exhausted.handle(exhausted.event()));
  assert.strictEqual(exhausted.attempts(), 3);
});

test("controller dispatches Terminal metadata first and keeps raw-body signature verification", async () => {
  require.cache[require.resolve("../src/config/db")] = { exports: {} };
  const config = require("../src/config/stripe");
  let verified = false;
  config.getStripe = () => ({ webhooks: { constructEvent: (body, signature) => {
    assert(Buffer.isBuffer(body));
    assert.strictEqual(signature, "invalid");
    verified = true;
    throw new Error("signature rejected");
  } } });
  const { buildStripeWebhookEventHandler, handleWebhook } = require("../src/controllers/c_stripe");
  const f = fixture();
  let legacy = 0;
  const handle = buildStripeWebhookEventHandler({
    handleTerminalEvent: f.handle,
    getStripe: () => { throw new Error("must not retrieve web charge"); },
    markPaymentSucceeded: async () => { legacy += 1; },
  });
  await handle(f.event());
  assert.strictEqual(f.state().updates, 1);
  assert.strictEqual(legacy, 0);
  await handle(f.event("payment_intent.succeeded", { latest_charge: null, metadata: { order_id: "12" } }));
  assert.strictEqual(legacy, 1);
  const res = { status(code) { this.code = code; return this; }, send(body) { this.body = body; } };
  await handleWebhook({ body: Buffer.from("{}"), headers: { "stripe-signature": "invalid" } }, res);
  assert(verified);
  assert.strictEqual(res.code, 400);
});

(async () => {
  let failures = 0;
  for (const { name, work } of tests) {
    try { await work(); console.log(`PASS ${name}`); }
    catch (error) { failures += 1; console.error(`FAIL ${name}: ${error.stack}`); }
  }
  console.log(`stripe terminal webhook tests: ${tests.length - failures}/${tests.length} passed`);
  process.exitCode = failures ? 1 : 0;
})();
