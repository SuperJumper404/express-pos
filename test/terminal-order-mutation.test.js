const assert = require("assert");
const { test } = require("node:test");

let activeConnection;
require.cache[require.resolve("../src/config/db")] = {
  exports: { query: (sql, params, callback) => activeConnection.query(sql, params)
    .then(([rows]) => callback(null, rows), callback) },
};
require.cache[require.resolve("../src/config/dbPool")] = {
  exports: { getConnection: async () => activeConnection },
};
const { buildOrderArchiveModule, mUpdateOrders } = require("../src/modules/m_orders");
const { buildOrderEditingModule, buildContentRevision } = require("../src/modules/m_orderEditing");
const { buildOrderTransitionModule } = require("../src/modules/m_orderTransitions");

const fixture = (paymentStatus, orderStatus = 1, overrides = {}) => {
  const calls = [];
  const order = { id: 21, shopid: 7, status: orderStatus, subtotal: "10.00",
    payment_status: "unpaid", payment: "Paiement au comptoir", payment_provider: null,
    stripe_terminal_payment_id: null, delivery_id: null, is_takeaway: 1, ...overrides };
  const connection = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/SELECT p.id FROM stripe_terminal_payment_orders/.test(sql)) {
        assert.deepStrictEqual(params, [7, 21]);
        assert.match(sql, /FOR UPDATE/);
        assert.match(sql, /p.shopid = a.shopid/);
        return [[...(["creating", "processing"].includes(paymentStatus) ? [{ id: 42 }] : [])]];
      }
      if (/FROM orders\s+WHERE/.test(sql)) return [[{ ...order }]];
      if (/^SELECT/.test(sql)) return [[]];
      return [{ affectedRows: 1, insertId: 100 }];
    },
    beginTransaction: async () => calls.push({ sql: "BEGIN" }),
    commit: async () => calls.push({ sql: "COMMIT" }),
    rollback: async () => calls.push({ sql: "ROLLBACK" }),
    release: () => {},
  };
  activeConnection = connection;
  const runInTransaction = async (work) => {
    await connection.beginTransaction();
    try { const result = await work(connection); await connection.commit(); return result; }
    catch (error) { await connection.rollback(); throw error; }
  };
  const archive = buildOrderArchiveModule({ withTransaction: runInTransaction, loyalty: null });
  const edit = buildOrderEditingModule({ withTransaction: runInTransaction });
  const transition = buildOrderTransitionModule({ withTransaction: runInTransaction });
  const operations = {
    archive: () => archive.mArchiveOrder(21, "Especes", 7),
    hiddenArchive: () => archive.mArchiveOrder(21, undefined, 7, { hiddenFromHistory: true }),
    amend: () => edit.amendOrder({ orderId: 21, shopId: 7, operatorId: 11,
      contentRevision: buildContentRevision(order, []), expectedTotal: 0, items: [] }),
    cancel: () => transition.transitionOrderStatus({ orderId: 21, shopId: 7, operator: 11, nextStatus: 4 }),
    collect: () => mUpdateOrders({ payment_status: "paid", payment: "Especes" }, 21),
    prepare: () => transition.transitionOrderStatus({ orderId: 21, shopId: 7, operator: 11, nextStatus: 2 }),
  };
  return { calls, operations };
};

for (const paymentStatus of ["creating", "processing"]) {
  for (const operation of ["archive", "hiddenArchive", "amend", "cancel", "collect"]) {
    test(`${operation} rejects an order reserved by a ${paymentStatus} Terminal payment`, async () => {
      const { calls, operations } = fixture(paymentStatus);
      await assert.rejects(operations[operation], error => error.status === 409 && error.code === "TERMINAL_PAYMENT_IN_PROGRESS");
      assert(!calls.some(call => /^(INSERT|UPDATE|DELETE)/.test(call.sql)));
      assert(calls.some(call => call.sql === "ROLLBACK"));
      const orderLock = calls.findIndex(call => /FROM orders/.test(call.sql) && /FOR UPDATE/.test(call.sql));
      const attemptLock = calls.findIndex(call => /SELECT p.id FROM stripe_terminal_payment_orders/.test(call.sql));
      assert(orderLock >= 0 && attemptLock > orderLock, "Lock the commercial order before its Terminal attempt");
    });
  }
  test(`kitchen preparation continues during ${paymentStatus} Terminal payment`, async () => {
    const { calls, operations } = fixture(paymentStatus);
    await operations.prepare();
    assert(calls.some(call => /^UPDATE orders/.test(call.sql)));
  });
}

for (const paymentStatus of ["failed", "canceled", "succeeded"]) {
  for (const operation of ["archive", "hiddenArchive", "amend", "cancel", "collect"]) {
    test(`${operation} is not blocked by a historical ${paymentStatus} attempt`, async () => {
      const { calls, operations } = fixture(paymentStatus);
      await operations[operation]();
      assert(calls.some(call => /^(INSERT|UPDATE|DELETE)/.test(call.sql)));
    });
  }
}

test("manual collection cannot replace a Terminal settlement that won the order lock", async () => {
  const { calls, operations } = fixture("succeeded", 1, {
    stripe_terminal_payment_id: 42, payment_provider: "stripe_terminal", payment_status: "paid",
  });
  await assert.rejects(operations.collect, error => error.code === "TERMINAL_PAYMENT_ALREADY_COLLECTED");
  assert(!calls.some(call => /^UPDATE/.test(call.sql)));
});

for (const status of [1, 2]) for (const operation of ["hiddenArchive", "cancel"]) {
  test(`${operation} cannot discard a paid Terminal order while kitchen status is ${status}`, async () => {
    const { calls, operations } = fixture("succeeded", status, {
      stripe_terminal_payment_id: 42, payment_provider: "stripe_terminal", payment_status: "paid",
    });
    await assert.rejects(operations[operation], error => error.code === "TERMINAL_PAYMENT_REFUND_REQUIRED");
    assert(!calls.some(call => /^(INSERT|UPDATE|DELETE)/.test(call.sql)));
    assert(calls.some(call => call.sql === "ROLLBACK"));
  });
}
