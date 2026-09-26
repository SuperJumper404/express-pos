const assert = require("assert");
const { buildStripeTerminalModule } = require("../src/modules/m_stripeTerminal");

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

// Independent transactions acquire individual rows. Waiting edges detect an actual
// cycle; neither transaction is hidden behind a global serialization queue.
const overlappingTransactions = () => {
  const holders = new Map();
  const waitingFor = new Map();
  const waiters = new Map();
  const finalizerLocked = deferred();
  const startBlocked = deferred();
  const events = [];
  const state = {
    payment: { id: 41, shopid: 7, terminal_reader_id: 21, cashier_user_id: 11, status: "processing", stripe_payment_intent_id: "pi_terminal" },
    orders: [12, 31].map((id) => ({ id, shopid: 7, status: 1, payment_status: "unpaid", stripe_terminal_payment_id: null })),
    allocations: [12, 31].map((id) => ({ order_id: id, shopid: 7, terminal_payment_id: 41, amount_cents: 100 })),
    deadlocks: 0,
  };
  let pausedFinalizer = false;
  const lock = async (owner, key) => {
    while (holders.has(key) && holders.get(key) !== owner) {
      const holder = holders.get(key);
      waitingFor.set(owner, holder);
      events.push(`${owner}:wait:${key}`);
      if (owner === "start") startBlocked.resolve();
      let current = holder;
      while (waitingFor.has(current)) {
        current = waitingFor.get(current);
        if (current === owner) {
          state.deadlocks += 1;
          throw Object.assign(new Error("row lock cycle"), { code: "ER_LOCK_DEADLOCK" });
        }
      }
      const released = deferred();
      if (!waiters.has(key)) waiters.set(key, []);
      waiters.get(key).push(released.resolve);
      await released.promise;
    }
    waitingFor.delete(owner);
    holders.set(key, owner);
    events.push(`${owner}:lock:${key}`);
    if (owner === "finalize" && !pausedFinalizer) {
      pausedFinalizer = true;
      finalizerLocked.resolve();
      await startBlocked.promise;
    }
  };
  const release = (owner) => {
    waitingFor.delete(owner);
    for (const [key, holder] of holders) {
      if (holder !== owner) continue;
      holders.delete(key);
      for (const wake of waiters.get(key) || []) wake();
      waiters.delete(key);
    }
  };
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const connection = (owner) => ({
    query: async (sql, params) => {
      if (sql.includes("FROM stripe_terminal_readers r")) {
        await lock(owner, "reader:21");
        return [[{ id: 21, shopid: 7, assigned_user_id: 11, is_active: 1 }]];
      }
      if (sql.startsWith("SELECT") && sql.includes("FROM orders o")) {
        assert(sql.includes("FOR UPDATE"));
        assert.deepStrictEqual(params, [7, 12, 31]);
        for (const id of params.slice(1)) await lock(owner, `order:${id}`);
        return [copy(state.orders)];
      }
      if (sql.includes("FROM stripe_terminal_payments p")) {
        if (sql.includes("FOR UPDATE")) await lock(owner, "payment:41");
        return [[copy(state.payment)]];
      }
      if (sql.includes("SELECT a.order_id")) return [[]];
      if (sql.includes("COUNT(*)")) return [[{ count: 2 }]];
      if (sql.includes("FROM stripe_terminal_payment_orders a")) return [copy(state.allocations)];
      if (sql.startsWith("UPDATE orders")) {
        for (const id of [12, 31]) await lock(owner, `order:${id}`);
        const orders = state.orders.filter((o) => o.payment_status === "unpaid");
        orders.forEach((o) => { o.payment_status = "paid"; o.stripe_terminal_payment_id = 41; });
        return [{ affectedRows: orders.length }];
      }
      if (sql.startsWith("UPDATE stripe_terminal_payments")) {
        await lock(owner, "payment:41");
        state.payment.status = "succeeded";
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected test SQL: ${sql}`);
    },
  });
  const run = async (owner, operation) => {
    try { return await operation(buildStripeTerminalModule({ connection: connection(owner) })); }
    finally { release(owner); }
  };
  return { run, finalizerLocked, state, events, holders };
};

const run = async () => {
  const db = overlappingTransactions();
  const finalizing = db.run("finalize", (store) => store.finalizePaymentSucceeded({
    shopId: 7, paymentId: 41, stripePaymentIntentId: "pi_terminal", timestamp: new Date(),
  }));
  await db.finalizerLocked.promise;
  const starting = db.run("start", (store) => store.lockReaderAndOrders({ shopId: 7, userId: 11, orderIds: [31, 12] }));
  const [finalized, started] = await Promise.allSettled([finalizing, starting]);
  assert.strictEqual(db.state.deadlocks, 0, `Opposite lock order: ${db.events.join(", ")}`);
  assert.strictEqual(finalized.status, "fulfilled");
  assert.strictEqual(started.status, "rejected");
  assert.match(started.reason.message, /Invalid Terminal order selection/);
  assert.strictEqual(db.state.payment.status, "succeeded");
  assert(db.state.orders.every((order) => order.payment_status === "paid"));
  assert(db.events.some((event) => event === "start:wait:order:12"));
  assert.strictEqual(db.holders.size, 0);
  console.log("PASS overlapping start/finalization waits on rows without a lock cycle and revalidates paid orders");

  for (const scenario of ["success", "work-failure", "busy", "acquire-null", "acquire-failure", "release-failure", "release-null", "rollback-failure"]) {
    const events = [];
    const dedicated = {
      query: async (sql, params) => {
        events.push({ sql, params });
        if (sql.includes("GET_LOCK")) {
          assert(sql.includes("GET_LOCK(?, 0)"));
          assert.deepStrictEqual(params, ["pos:terminal-payment:7:41"]);
          if (scenario === "acquire-failure") throw new Error("lock transport failure");
          return [[{ acquired: scenario === "busy" ? 0 : scenario === "acquire-null" ? null : 1 }]];
        }
        if (sql.includes("RELEASE_LOCK")) {
          if (scenario === "release-failure") throw new Error("release transport failure");
          return [[{ released: scenario === "release-null" ? null : 1 }]];
        }
        return [[{ id: 41, shopid: 7 }]];
      },
      beginTransaction: async () => { events.push("begin"); },
      commit: async () => { events.push("commit"); },
      rollback: async () => { events.push("rollback"); if (scenario === "rollback-failure") throw new Error("rollback transport failure"); },
      release: () => events.push("release"),
      destroy: () => events.push("destroy"),
    };
    const store = buildStripeTerminalModule({ connection: {
      query: () => { throw new Error("Creation must use the lock connection, not checkout another one"); },
      getConnection: async () => { events.push("checkout"); return dedicated; },
    } });
    let workCalls = 0;
    const create = () => store.withPaymentCreationLock({ shopId: 7, paymentId: 41 }, async (lockedStore) => {
      workCalls += 1;
      return lockedStore.withTransaction(async (transactionStore) => {
        assert.strictEqual((await transactionStore.findPaymentSession({ shopId: 7, paymentId: 41 })).id, 41);
        if (["work-failure", "rollback-failure"].includes(scenario)) throw new Error("work failed");
        return "created";
      });
    });
    if (scenario === "busy") assert.strictEqual(await create(), null);
    else if (["work-failure", "rollback-failure", "acquire-null", "acquire-failure"].includes(scenario)) await assert.rejects(create);
    else assert.strictEqual(await create(), "created");
    assert.strictEqual(workCalls, ["busy", "acquire-null", "acquire-failure"].includes(scenario) ? 0 : 1);
    assert.strictEqual(events.filter((event) => event === "checkout").length, 1);
    assert.strictEqual(events.at(-1), ["acquire-null", "acquire-failure", "release-failure", "release-null", "rollback-failure"].includes(scenario) ? "destroy" : "release");
    console.log(`PASS payment creation lock ${scenario}`);
  }
};
let timer;
Promise.race([run(), new Promise((resolve, reject) => {
  timer = setTimeout(() => reject(new Error("Lock scheduler stalled")), 3000);
})]).catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(timer));
