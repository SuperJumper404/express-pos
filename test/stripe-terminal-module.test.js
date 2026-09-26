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
    idempotencyKey: "terminal-42", amountCents: 1200, applicationFeeAmount: 20 };
  await store.createPaymentSession(session);
  const insert = calls.find((call) => /INSERT INTO stripe_terminal_payments/.test(call.sql));
  assert.match(insert.sql, /FROM stripe_terminal_readers r/);
  assert.match(insert.sql, /r\.shopid = \?/);
  assert.match(insert.sql, /r\.assigned_user_id = \?/);
  assert.ok(insert.params.includes(shopId));
  assert.ok(insert.params.includes("terminal-42"));

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
    if (/COUNT\(\*\)/.test(sql)) return [{ count: 1 }];
    return { affectedRows: 1 };
  });
  assert.deepStrictEqual(await final.store.finalizePaymentSucceeded({
    shopId, paymentId: 42, stripePaymentIntentId: "pi_test", stripeChargeId: "ch_test",
    timestamp: "2026-09-26 10:00:00",
  }), { finalized: true });
  assert.match(final.calls[0].sql, /FOR UPDATE/);
  const sessionUpdate = final.calls.find((call) => /UPDATE stripe_terminal_payments/.test(call.sql));
  const orderUpdate = final.calls.find((call) => /UPDATE orders/.test(call.sql));
  assert.ok(sessionUpdate && orderUpdate);
  hasShopFilter(sessionUpdate, "stripe_terminal_payments", shopId);
  hasShopFilter(orderUpdate, "o", shopId);
  assert.match(orderUpdate.sql, /stripe_terminal_payment_id/);

  const duplicate = makeStore((sql) => /FROM stripe_terminal_payments p/.test(sql)
    ? [{ id: 42, shopid: shopId, stripe_payment_intent_id: "pi_test",
      status: "succeeded" }] : { affectedRows: 1 });
  assert.deepStrictEqual(await duplicate.store.finalizePaymentSucceeded({
    shopId, paymentId: 42, stripePaymentIntentId: "pi_test",
  }), { finalized: false });
  assert.strictEqual(duplicate.calls.length, 1);

  for (const status of ["failed", "canceled"]) {
    const lateSuccess = makeStore((sql) => {
      if (/FROM stripe_terminal_payments p/.test(sql)) return [{ id: 42, shopid: shopId,
        stripe_payment_intent_id: "pi_test", status }];
      if (/COUNT\(\*\)/.test(sql)) return [{ count: 1 }];
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
    if (/COUNT\(\*\)/.test(sql)) return [{ count: 2 }];
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
  await management.store.findOrderAllocation({ shopId, orderId: 21 });
  assert.ok(management.calls.every((call) => (
    call.params.includes(shopId) || (call.params[0] && call.params[0].shopid === shopId)
  )));
  assert.ok(!management.calls.some((call) => /registration_code/i.test(call.sql)));

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

  console.log("stripe terminal module tests passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
