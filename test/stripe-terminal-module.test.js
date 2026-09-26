const assert = require("assert");
const { buildStripeTerminalModule } = require("../src/modules/m_stripeTerminal");

const makeStore = (respond) => {
  const calls = [];
  const connection = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return [respond(sql, params)];
    },
  };
  return { store: buildStripeTerminalModule({ connection }), calls };
};

const hasShopFilter = (call, alias, shopId) => {
  assert.match(call.sql, new RegExp(`${alias}\\.shopid\\s*=\\s*\\?`));
  assert.ok(call.params.includes(shopId));
};

(async () => {
  const shopId = 7;
  const userId = 11;
  const reader = { id: 3, shopid: shopId, assigned_user_id: userId, is_active: 1 };
  const { store, calls } = makeStore((sql) => {
    if (/^INSERT INTO stripe_terminal_payments/.test(sql)) return { affectedRows: 1, insertId: 42 };
    if (/^INSERT INTO stripe_terminal_payment_orders/.test(sql)) return { affectedRows: 1 };
    if (/FROM stripe_terminal_readers r/.test(sql)) return [reader];
    if (/FROM orders o/.test(sql)) return [{ id: 21, shopid: shopId, status: 1, payment_status: "unpaid" }];
    if (/FROM stripe_terminal_payments p/.test(sql)) return [];
    if (/FROM stripe_terminal_payment_orders a/.test(sql)) return [];
    return { affectedRows: 1, insertId: 42 };
  });

  assert.deepStrictEqual(await store.findAssignedReader({ shopId, userId, forUpdate: true }), reader);
  hasShopFilter(calls[0], "r", shopId);
  assert.match(calls[0].sql, /FOR UPDATE/);

  const locked = await store.lockReaderAndOrders({ shopId, userId, orderIds: [21] });
  assert.deepStrictEqual(locked, {
    reader,
    orders: [{ id: 21, shopid: shopId, status: 1, payment_status: "unpaid" }],
    activePayment: null,
  });
  assert.ok(calls.every((call) => !/BEGIN|COMMIT|ROLLBACK/.test(call.sql)));
  hasShopFilter(calls.find((call) => /FROM orders o/.test(call.sql)), "o", shopId);
  assert.match(calls.find((call) => /FROM orders o/.test(call.sql)).sql, /FOR UPDATE/);
  hasShopFilter(calls.find((call) => /FROM stripe_terminal_payments p/.test(call.sql)), "p", shopId);

  const session = { shopId, readerId: 3, cashierUserId: userId,
    idempotencyKey: "terminal-42", connectedAccountId: "acct_reserved", amountCents: 1200, applicationFeeAmount: 20 };
  await store.createPaymentSession(session);
  const insert = calls.find((call) => /INSERT INTO stripe_terminal_payments/.test(call.sql));
  assert.match(insert.sql, /FROM stripe_terminal_readers r/);
  assert.match(insert.sql, /r\.shopid = \?/);
  assert.match(insert.sql, /r\.assigned_user_id = \?/);
  assert.ok(insert.params.includes(shopId));
  assert.ok(insert.params.includes("terminal-42"));
  assert.match(insert.sql, /stripe_connected_account_id/);
  assert.deepStrictEqual(insert.params, ["terminal-42", "acct_reserved", 1200, 20, "eur", null, null, 7, 3, 11]);

  await store.findPaymentSession({ shopId, paymentId: 42 });
  hasShopFilter(calls.at(-1), "p", shopId);

  await store.createAllocations({ shopId, paymentId: 42, allocations: [
    { orderId: 21, amountCents: 1200 },
  ] });
  const allocation = calls.find((call) => /INSERT INTO stripe_terminal_payment_orders/.test(call.sql));
  assert.deepStrictEqual(allocation.params, [1200, 21, 42, shopId]);

  const final = makeStore((sql) => {
    if (/FROM stripe_terminal_payments p/.test(sql)) return [{ id: 42, shopid: shopId,
      stripe_payment_intent_id: "pi_test", status: "processing" }];
    if (/FROM stripe_terminal_payment_orders a/.test(sql)) return [{ order_id: 21 }];
    if (/FROM orders o/.test(sql)) return [{ id: 21, shopid: shopId, status: 1, payment_status: "unpaid" }];
    return { affectedRows: 1 };
  });
  assert.deepStrictEqual(await final.store.finalizePaymentSucceeded({
    shopId, paymentId: 42, stripePaymentIntentId: "pi_test", stripeChargeId: "ch_test",
    timestamp: "2026-09-26 10:00:00",
  }), { finalized: true });
  assert(final.calls.findIndex((call) => /FROM orders o/.test(call.sql))
    < final.calls.findIndex((call) => /FROM stripe_terminal_payments p/.test(call.sql)));
  assert.match(final.calls.find((call) => /FROM orders o/.test(call.sql)).sql, /FOR UPDATE/);
  const sessionUpdate = final.calls.find((call) => /UPDATE stripe_terminal_payments/.test(call.sql));
  const orderUpdate = final.calls.find((call) => /UPDATE orders/.test(call.sql));
  assert.ok(sessionUpdate && orderUpdate);
  hasShopFilter(sessionUpdate, "stripe_terminal_payments", shopId);
  hasShopFilter(orderUpdate, "o", shopId);
  assert.match(orderUpdate.sql, /stripe_terminal_payment_id/);

  const duplicate = makeStore((sql) => {
    if (/FROM stripe_terminal_payments p/.test(sql)) return [{ id: 42, shopid: shopId, stripe_payment_intent_id: "pi_test", status: "succeeded" }];
    if (/FROM stripe_terminal_payment_orders a/.test(sql)) return [{ order_id: 21 }];
    if (/FROM orders o/.test(sql)) return [];
    throw new Error("A finalized payment must not be mutated again");
  });
  assert.deepStrictEqual(await duplicate.store.finalizePaymentSucceeded({
    shopId, paymentId: 42, stripePaymentIntentId: "pi_test",
  }), { finalized: false });
  assert.strictEqual(duplicate.calls.filter((call) => /UPDATE stripe_terminal_payments|UPDATE orders/.test(call.sql)).length, 0);

  for (const status of ["failed", "canceled"]) {
    const lateSuccess = makeStore((sql) => {
      if (/FROM stripe_terminal_payments p/.test(sql)) return [{ id: 42, shopid: shopId,
        stripe_payment_intent_id: "pi_test", status }];
      if (/FROM stripe_terminal_payment_orders a/.test(sql)) return [{ order_id: 21 }];
      if (/FROM orders o/.test(sql)) return [{ id: 21, shopid: shopId, status: 1, payment_status: "unpaid" }];
      return { affectedRows: 1 };
    });
    assert.deepStrictEqual(await lateSuccess.store.finalizePaymentSucceeded({
      shopId, paymentId: 42, stripePaymentIntentId: "pi_test", timestamp: "2026-09-26 10:00:00",
    }), { finalized: true });
  }

  await assert.rejects(() => duplicate.store.finalizePaymentSucceeded({
    shopId, paymentId: 42, stripePaymentIntentId: "pi_other",
  }), /Terminal payment cannot be finalized/);

  const invalid = makeStore((sql) => {
    if (/FROM stripe_terminal_readers r/.test(sql)) return [reader];
    if (/FROM orders o/.test(sql)) return [{ id: 21, shopid: shopId, status: 1, payment_status: "unpaid" }];
    return [];
  });
  await assert.rejects(() => invalid.store.lockReaderAndOrders({
    shopId, userId, orderIds: [21, 22],
  }), /Invalid Terminal order selection/);
  assert.strictEqual(invalid.calls.filter((call) => /FROM stripe_terminal_payments p/.test(call.sql)).length, 0);

  for (const badOrder of [
    { id: 21, shopid: 8, status: 1, payment_status: "unpaid" },
    { id: 21, shopid: 7, status: 2, payment_status: "unpaid" },
    { id: 21, shopid: 7, status: 1, payment_status: "paid" },
  ]) {
    const rejected = makeStore((sql) => {
      if (/FROM stripe_terminal_readers r/.test(sql)) return [reader];
      if (/FROM orders o/.test(sql)) return [badOrder];
      return [];
    });
    await assert.rejects(() => rejected.store.lockReaderAndOrders({
      shopId, userId, orderIds: [21],
    }), /Invalid Terminal order selection/);
  }

  const active = makeStore((sql) => {
    if (/FROM stripe_terminal_readers r/.test(sql)) return [reader];
    if (/FROM orders o/.test(sql)) return [{ id: 21, shopid: shopId,
      status: 1, payment_status: "unpaid" }];
    if (/FROM stripe_terminal_payments p/.test(sql)) return [{ id: 42, status: "creating" }];
    return [];
  });
  assert.strictEqual((await active.store.lockReaderAndOrders({
    shopId, userId, orderIds: [21],
  })).activePayment.id, 42);

  const competing = makeStore((sql) => {
    if (/FROM stripe_terminal_readers r/.test(sql)) return [reader];
    if (/FROM orders o/.test(sql)) return [{ id: 21, shopid: shopId,
      status: 1, payment_status: "unpaid" }];
    if (/FROM stripe_terminal_payments p/.test(sql)) return [];
    if (/FROM stripe_terminal_payment_orders a/.test(sql)) return [{ order_id: 21 }];
    return [];
  });
  await assert.rejects(() => competing.store.lockReaderAndOrders({
    shopId, userId, orderIds: [21],
  }), /active Terminal payment/);

  const shortUpdate = makeStore((sql) => {
    if (/FROM stripe_terminal_payments p/.test(sql)) return [{ id: 42,
      stripe_payment_intent_id: "pi_test", status: "processing" }];
    if (/FROM stripe_terminal_payment_orders a/.test(sql)) return [{ order_id: 21 }, { order_id: 22 }];
    if (/FROM orders o/.test(sql)) return [21, 22].map((id) => ({ id, shopid: shopId, status: 1, payment_status: "unpaid" }));
    return { affectedRows: 1 };
  });
  await assert.rejects(() => shortUpdate.store.finalizePaymentSucceeded({
    shopId, paymentId: 42, stripePaymentIntentId: "pi_test",
    timestamp: "2026-09-26 10:00:00",
  }), /Terminal order finalization incomplete/);
  assert.ok(!shortUpdate.calls.some((call) => /UPDATE stripe_terminal_payments/.test(call.sql)));

  const management = makeStore(() => ({ affectedRows: 1 }));
  await management.store.findLocation({ shopId });
  await management.store.createLocation({ shopId, stripeLocationId: "tml_test",
    displayName: "Shop", address: { line1: "1 Rue", postalCode: "75001", city: "Paris" } });
  await management.store.updateLocation({ shopId, stripeLocationId: "tml_test",
    displayName: "Shop", address: { line1: "2 Rue", postalCode: "75001", city: "Paris" } });
  await management.store.listReaders({ shopId });
  await management.store.findReader({ shopId, readerId: 3 });
  await management.store.createReader({ shopId, locationId: 2, stripeReaderId: "tmr_test",
    label: "Till", status: "online" });
  const readerInsert = management.calls.find((call) => /INSERT INTO stripe_terminal_readers/.test(call.sql));
  assert.ok(!readerInsert.params.includes(undefined));
  await management.store.updateReader({ shopId, readerId: 3, assignedUserId: userId });
  await management.store.findPaymentByIntent({ shopId, stripePaymentIntentId: "pi_test" });
  await management.store.findPaymentByIdempotencyKey({ shopId, idempotencyKey: "terminal-42" });
  await management.store.updatePaymentSession({ shopId, paymentId: 42, status: "processing" });
  assert.throws(() => management.store.updatePaymentSession({
    shopId, paymentId: 42, status: "succeeded",
  }), /finalizePaymentSucceeded/);
  await management.store.listPaymentAllocations({ shopId, paymentId: 42 });
  await management.store.findOrderAllocation({ shopId, orderId: 21, paymentId: 42 });
  assert.ok(management.calls.every((call) => (
    call.params.includes(shopId) || (call.params[0] && call.params[0].shopid === shopId)
  )));
  assert.ok(!management.calls.some((call) => /registration_code/i.test(call.sql)));

  const attempts = [
    { shopid: shopId, order_id: 21, terminal_payment_id: 41, amount_cents: 900 },
    { shopid: shopId, order_id: 21, terminal_payment_id: 42, amount_cents: 1200 },
  ];
  const paymentStatuses = new Map([[41, "failed"], [42, "succeeded"]]);
  const allocationLookup = makeStore((sql, params) => {
    if (!/FROM stripe_terminal_payment_orders a/.test(sql)) return [];
    const matches = attempts.filter((attempt) => (
      attempt.shopid === params[0] && attempt.order_id === params[1]
      && (!/a\.terminal_payment_id = \?/.test(sql)
        || attempt.terminal_payment_id === params[2])
      && (!/p\.status = 'succeeded'/.test(sql)
        || paymentStatuses.get(attempt.terminal_payment_id) === "succeeded")
    ));
    return matches.slice(0, 1);
  });
  assert.deepStrictEqual(await allocationLookup.store.findOrderAllocation({
    shopId, orderId: 21, paymentId: 42,
  }), attempts[1]);
  assert.deepStrictEqual(allocationLookup.calls[0].params, [shopId, 21, 42, shopId]);
  assert.match(allocationLookup.calls[0].sql, /p\.status = 'succeeded'/);
  await assert.rejects(() => allocationLookup.store.findOrderAllocation({
    shopId, orderId: 21,
  }), /paymentId is required/);

  const callbackCalls = [];
  const callbackStore = buildStripeTerminalModule({ connection: {
    promise: () => ({}),
    query: (sql, params, callback) => {
      callbackCalls.push({ sql, params });
      callback(null, [{ id: 2, shopid: shopId }]);
    },
  } });
  assert.strictEqual((await callbackStore.findLocation({ shopId })).id, 2);
  assert.deepStrictEqual(callbackCalls[0].params, [shopId]);

  for (const scenario of ["success", "work-failure", "timeout", "acquire-null", "acquire-failure", "release-failure", "release-null"]) {
    const events = [];
    const dedicated = {
      query: async (sql, params) => {
        events.push({ sql, params });
        if (sql.includes("GET_LOCK")) {
          if (scenario === "acquire-failure") throw new Error("lock transport failure");
          return [[{ acquired: scenario === "timeout" ? 0 : scenario === "acquire-null" ? null : 1 }]];
        }
        if (sql.includes("RELEASE_LOCK")) {
          if (scenario === "release-failure") throw new Error("release transport failure");
          return [[{ released: scenario === "release-null" ? null : 1 }]];
        }
        if (sql.includes("FROM users")) return [[{ id: userId, shopid: shopId, access: 1, status: 1 }]];
        return [[{ id: 5, shopid: shopId }]];
      },
      release: () => events.push("release"),
      destroy: () => events.push("destroy"),
    };
    const poolStore = buildStripeTerminalModule({ connection: {
      query: () => { throw new Error("Registration work must use its dedicated connection"); },
      getConnection: async () => { events.push("checkout"); return dedicated; },
    } });
    let ran = false;
    const run = () => poolStore.withRegistrationLock({ shopId }, async ({ terminalStore, staffStore }) => {
      ran = true;
      assert.deepStrictEqual(await staffStore.findUserByIdAndShop({ id: userId, shopId }), {
        id: userId, shopid: shopId, access: 1, status: 1,
      });
      assert.strictEqual((await terminalStore.findLocation({ shopId })).id, 5);
      if (scenario === "work-failure") throw new Error("work failed");
      return "saved";
    });
    if (scenario === "timeout" || scenario === "acquire-null") {
      await assert.rejects(run, (error) => error.code === "TERMINAL_REGISTRATION_BUSY");
      assert.strictEqual(ran, false);
    } else if (scenario === "acquire-failure") {
      await assert.rejects(run, /lock transport failure/);
      assert.strictEqual(ran, false);
    } else if (scenario === "work-failure") {
      await assert.rejects(run, /work failed/);
    } else {
      assert.strictEqual(await run(), "saved");
    }
    assert.match(events[1].sql, /GET_LOCK\(\?, 10\)/);
    assert.deepStrictEqual(events[1].params, ["pos:terminal-registration:7"]);
    const unlock = events.find((event) => event.sql && event.sql.includes("RELEASE_LOCK"));
    if (ran) assert.deepStrictEqual(unlock.params, ["pos:terminal-registration:7"]);
    else assert.strictEqual(unlock, undefined);
    assert.strictEqual(events.at(-1), ["acquire-null", "acquire-failure", "release-failure", "release-null"].includes(scenario) ? "destroy" : "release");
    const userQuery = events.find((event) => event.sql && event.sql.includes("FROM users"));
    if (ran) {
      assert.match(userQuery.sql, /id = \? AND shopid = \?/);
      assert.deepStrictEqual(userQuery.params, [userId, shopId]);
    }
  }

  console.log("stripe terminal module tests passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
