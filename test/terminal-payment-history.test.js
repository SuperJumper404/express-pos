const assert = require("assert/strict");
const test = require("node:test");

let buildTerminalPaymentHistoryModule;
let buildTerminalPaymentHistoryController;
try {
  ({ buildTerminalPaymentHistoryModule } = require("../src/modules/m_terminalPaymentHistory"));
  ({ buildTerminalPaymentHistoryController } = require("../src/controllers/c_terminalPaymentHistory"));
} catch (error) {
  if (error.code !== "MODULE_NOT_FOUND") throw error;
}

const payment = { id: 123, shopid: 7, payment_kind: "standalone", cashier_user_id: 11,
  terminal_reader_id: 21, amount_cents: 5000, currency: "eur", status: "succeeded",
  created_at: "2026-10-28 10:00:00", confirmed_at: "2026-10-28 10:01:00" };
const archive = { id: 123, shopid: 7, ordernumber: "A123", subtotal: "40.00", status: 3,
  payment_status: "unpaid", created: "2026-10-27 09:00:00", archived_at: "2026-10-28 10:01:00",
  customer: "Alice", service_point_name: "Table 2", hidden_from_history: 0 };

const fixture = () => {
  const state = { payments: [{ ...payment }], archives: [{ ...archive }], attachments: [], calls: [], transaction: false };
  const connection = { query: async (sql, values = []) => {
    state.calls.push({ sql, values });
    if (/INSERT INTO stripe_terminal_payment_attachments/.test(sql)) {
      assert(state.transaction, "attachments must be added in one transaction");
      const row = values[0];
      if (!state.attachments.some(a => a.terminal_payment_id === row.terminal_payment_id && a.archive_id === row.archive_id)) state.attachments.push({ ...row, created_at: "2026-10-28 11:00:00" });
      return [{ affectedRows: 1 }];
    }
    if (/DELETE FROM stripe_terminal_payment_attachments/.test(sql)) {
      assert(state.transaction);
      const [shopId, paymentId, archiveId] = values;
      state.attachments = state.attachments.filter(a => !(a.shopid === shopId && a.terminal_payment_id === paymentId && a.archive_id === archiveId));
      return [{ affectedRows: 1 }];
    }
    if (/FROM stripe_terminal_payment_attachments a/.test(sql)) {
      const [shopId, paymentId] = values;
      return [state.attachments.filter(a => a.shopid === shopId && a.terminal_payment_id === paymentId).map(a => ({ ...a,
        available: state.archives.some(o => o.id === a.archive_id && o.shopid === shopId && !o.hidden_from_history) ? 1 : 0 }))];
    }
    if (/FROM stripe_terminal_payments p/.test(sql) && !/UNION ALL/.test(sql)) {
      const [shopId, paymentId] = values;
      return [state.payments.filter(p => p.shopid === shopId && p.id === paymentId && p.payment_kind === "standalone").map(p => ({ ...p,
        attachments_count: state.attachments.filter(a => a.shopid === shopId && a.terminal_payment_id === p.id).length }))];
    }
    if (/FROM archives a/.test(sql) && !/UNION ALL/.test(sql)) {
      const [shopId, ...ids] = values;
      return [state.archives.filter(a => a.shopid === shopId && ids.includes(a.id) && !a.hidden_from_history).map(a => ({ ...a }))];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
  const withTransaction = async work => {
    const before = JSON.stringify(state.attachments);
    state.transaction = true;
    try { return await work(connection); }
    catch (error) { state.attachments = JSON.parse(before); throw error; }
    finally { state.transaction = false; }
  };
  return { state, connection, module: buildTerminalPaymentHistoryModule({ connection, withTransaction }) };
};

test("history exposes its module and controller contracts", () => {
  assert.equal(typeof buildTerminalPaymentHistoryModule, "function", "missing standalone history feature");
  assert.equal(typeof buildTerminalPaymentHistoryController, "function");
});

test("a 50 EUR payment accepts a 40 EUR unpaid archive without mutating either record", async () => {
  const f = fixture();
  const before = JSON.stringify([f.state.payments, f.state.archives]);
  const result = await f.module.addAttachments({ shopId: 7, userId: 99, paymentId: 123, archiveIds: [123] });
  assert.equal(result.payment.attachmentsCount, 1);
  assert.deepEqual(result.attachments, [{ archiveId: 123, orderNumber: "A123", amountCents: 4000,
    attachedAt: "2026-10-28 11:00:00", available: true }]);
  assert.equal(JSON.stringify([f.state.payments, f.state.archives]), before);
  assert.equal(f.state.attachments[0].attached_by_user_id, 99);
  assert(!f.state.calls.some(c => /UPDATE (orders|archives|stripe_terminal_payments)|stripe_terminal_payment_orders/.test(c.sql)));
});

test("attachment additions and removals are idempotent and archives may be shared by payments", async () => {
  const f = fixture();
  f.state.payments.push({ ...payment, id: 124 });
  await f.module.addAttachments({ shopId: 7, userId: 11, paymentId: 123, archiveIds: [123, 123] });
  await f.module.addAttachments({ shopId: 7, userId: 11, paymentId: 123, archiveIds: [123] });
  await f.module.addAttachments({ shopId: 7, userId: 11, paymentId: 124, archiveIds: [123] });
  assert.equal(f.state.attachments.length, 2);
  await f.module.removeAttachment({ shopId: 7, userId: 11, paymentId: 123, archiveId: 123 });
  const result = await f.module.removeAttachment({ shopId: 7, userId: 11, paymentId: 123, archiveId: 123 });
  assert.equal(result.attachments.length, 0);
  assert.equal(f.state.attachments.length, 1);
});

test("deleting or hiding an archive retains the attachment snapshot and disables its link", async () => {
  const f = fixture();
  await f.module.addAttachments({ shopId: 7, userId: 11, paymentId: 123, archiveIds: [123] });
  f.state.archives[0].hidden_from_history = 1;
  let result = await f.module.getAttachments({ shopId: 7, paymentId: 123 });
  assert.equal(result.attachments[0].available, false);
  f.state.archives = [];
  result = await f.module.getAttachments({ shopId: 7, paymentId: 123 });
  assert.deepEqual(result.attachments[0], { archiveId: 123, orderNumber: "A123", amountCents: 4000,
    attachedAt: "2026-10-28 11:00:00", available: false });
});

test("attachments reject foreign, hidden, active, unconfirmed and wrong-kind records atomically", async () => {
  const f = fixture();
  await assert.rejects(() => f.module.getAttachments({ shopId: 8, paymentId: 123 }), { code: "TERMINAL_PAYMENT_NOT_FOUND" });
  f.state.archives.push({ ...archive, id: 124, shopid: 8 });
  await assert.rejects(() => f.module.addAttachments({ shopId: 7, userId: 11, paymentId: 123, archiveIds: [123, 124] }), { code: "TERMINAL_INVALID_ATTACHMENTS" });
  assert.equal(f.state.attachments.length, 0);
  f.state.archives[0].hidden_from_history = 1;
  await assert.rejects(() => f.module.addAttachments({ shopId: 7, userId: 11, paymentId: 123, archiveIds: [123] }), { code: "TERMINAL_INVALID_ATTACHMENTS" });
  f.state.payments[0].status = "processing";
  await assert.rejects(() => f.module.removeAttachment({ shopId: 7, userId: 11, paymentId: 123, archiveId: 123 }), { code: "TERMINAL_PAYMENT_NOT_SETTLED" });
  f.state.payments[0].payment_kind = "order";
  await assert.rejects(() => f.module.getAttachments({ shopId: 7, paymentId: 123 }), { code: "TERMINAL_PAYMENT_NOT_FOUND" });
});

test("history paginates one SQL union and preserves colliding IDs as separate row types", async () => {
  const calls = [];
  const connection = { query: async (sql, values) => {
    calls.push({ sql, values });
    if (/COUNT\(\*\) AS total/.test(sql)) return [[{ total: 3 }]];
    if (/UNION ALL/.test(sql)) return [[{ id: 123, entry_type: "order", event_at: "2026-10-28 10:01:00" },
      { id: 123, entry_type: "terminal_payment", event_at: "2026-10-28 10:01:00" }]];
    if (/FROM archives a/.test(sql)) return [[{ ...archive }]];
    if (/FROM stripe_terminal_payments p/.test(sql)) return [[{ ...payment, attachments_count: 0 }]];
    throw new Error(sql);
  } };
  const result = await buildTerminalPaymentHistoryModule({ connection }).listEntries({ shopId: 7, search: "Alice", page: 2, itemsPerPage: 2, sortBy: "eventAt", sortDesc: true });
  assert.equal(result.total, 3);
  assert.deepEqual(result.items.map(i => i.rowKey), ["order:123", "terminal-payment:123"]);
  assert.equal(result.items[0].subtotal, "40.00");
  assert.equal(result.items[1].subtotal, 50);
  assert.equal(result.items[1].customer, null);
  assert.equal(result.items[1].terminalPayment.paymentKind, "standalone");
  const pageQuery = calls.find(c => /UNION ALL/.test(c.sql) && !/COUNT\(\*\) AS total/.test(c.sql));
  assert.match(pageQuery.sql, /ORDER BY event_at DESC, entry_type ASC, id DESC/);
  assert.match(pageQuery.sql, /COALESCE\(a.hidden_from_history, 0\) = 0/);
  assert.match(pageQuery.sql, /p.payment_kind = 'standalone'/);
  assert.match(pageQuery.sql, /a.shopid = \?/);
  assert.match(pageQuery.sql, /p.shopid = \?/);
  assert.deepEqual(pageQuery.values.slice(-2), [2, 2]);
  assert(!pageQuery.sql.includes("Alice"));
  assert(pageQuery.values.filter(v => v === "%Alice%").length >= 2);
  assert.match(pageQuery.sql, /COALESCE\(sp.name, a.username\)/, "a removed service point retains its archive table name");
});

test("standalone history displays cashier and reader with tenant-scoped search and cashier sorting", async () => {
  const calls = [];
  const connection = { query: async (sql, values) => {
    calls.push({ sql, values });
    if (/COUNT\(\*\) AS total/.test(sql)) return [[{ total: 1 }]];
    if (/UNION ALL/.test(sql)) return [[{ id: 123, entry_type: "terminal_payment", event_at: "2026-10-28 10:01:00" }]];
    return [[{ ...payment, attachments_count: 0, cashier_name: "Camille", reader_label: "Comptoir" }]];
  } };
  const result = await buildTerminalPaymentHistoryModule({ connection }).listEntries({
    shopId: 7, search: "Camille", sortBy: "taken_by_name", sortDesc: false,
  });
  assert.equal(result.items[0].taken_by_name, "Camille");
  assert.equal(result.items[0].readerLabel, "Comptoir");
  assert.equal(result.items[0].terminalPayment.paymentKind, "standalone");
  assert(!Object.prototype.hasOwnProperty.call(result.items[0].terminalPayment, "readerLabel"));
  for (const call of calls) {
    assert.match(call.sql, /LEFT JOIN users cashier ON cashier.id = p.cashier_user_id AND cashier.shopid = p.shopid/);
    assert.match(call.sql, /LEFT JOIN stripe_terminal_readers reader ON reader.id = p.terminal_reader_id AND reader.shopid = p.shopid/);
  }
  const pageQuery = calls.find(c => /UNION ALL/.test(c.sql) && !/COUNT\(\*\) AS total/.test(c.sql));
  assert.match(pageQuery.sql, /NULL, NULL, cashier.username, NULL, p.amount_cents/);
  assert.match(pageQuery.sql, /cashier.username, reader.label\) LIKE \?/);
  assert.match(pageQuery.sql, /ORDER BY taken_by_name ASC, event_at DESC, entry_type ASC, id DESC/);
  assert(!pageQuery.sql.includes("Camille"));
});

test("invalid pagination, sort injection and malformed IDs cannot reach the database", async () => {
  const f = fixture();
  for (const invalid of [{ page: 0 }, { itemsPerPage: -1 }, { itemsPerPage: 101 }, { page: "2x" },
    { sortBy: "id;DROP TABLE archives" }, { search: [] }, { sortDesc: "yes" }]) {
    await assert.rejects(() => f.module.listEntries({ shopId: 7, ...invalid }), { code: "TERMINAL_INVALID_INPUT" });
  }
  await assert.rejects(() => f.module.addAttachments({ shopId: 7, userId: 11, paymentId: 123, archiveIds: [true] }), { code: "TERMINAL_INVALID_INPUT" });
  await assert.rejects(() => f.module.addAttachments({ shopId: 7, userId: 11, paymentId: 123, archiveIds: ["123"] }), { code: "TERMINAL_INVALID_INPUT" });
  assert.equal(f.state.calls.length, 0);
});

test("candidate search is tenant scoped and paginated with server-owned amounts", async () => {
  const calls = [];
  const connection = { query: async (sql, values) => {
    calls.push({ sql, values });
    if (/COUNT\(\*\) AS total/.test(sql)) return [[{ total: 2 }]];
    return [[{ ...archive }]];
  } };
  const result = await buildTerminalPaymentHistoryModule({ connection }).listAttachmentCandidates({
    shopId: 7, page: "2", itemsPerPage: "1", search: "Alice",
  });
  assert.deepEqual(result, { items: [{ archiveId: 123, orderNumber: "A123", amountCents: 4000,
    createdAt: "2026-10-27 09:00:00", tableName: "Table 2", customer: "Alice" }], total: 2 });
  assert.deepEqual(calls[1].values, [7, "%Alice%", 1, 1]);
  assert.match(calls[1].sql, /a.shopid = \? AND COALESCE\(a.hidden_from_history, 0\) = 0/);
  assert(!calls[1].sql.includes("payment_status ="), "paid and unpaid archives are eligible");
});

test("candidate DTO rejects corrupt stored amounts instead of emitting NaN", async () => {
  const connection = { query: async sql => /COUNT\(\*\) AS total/.test(sql) ? [[{ total: 1 }]] : [[{ ...archive, subtotal: "not-money" }]] };
  await assert.rejects(() => buildTerminalPaymentHistoryModule({ connection }).listAttachmentCandidates({ shopId: 7 }), { code: "TERMINAL_INVALID_ATTACHMENTS" });
});

test("delivery archive entries preserve the financial decoration of existing history", async () => {
  const connection = { query: async sql => {
    if (/COUNT\(\*\) AS total/.test(sql)) return [[{ total: 1 }]];
    if (/UNION ALL/.test(sql)) return [[{ id: 123, entry_type: "order", event_at: "2026-10-28 10:01:00" }]];
    return [[{ ...archive, delivery_id: "88" }]];
  } };
  const deliveryStore = {
    resolveDeliveryOrder: async input => {
      assert.equal(input.shopId, 7);
      assert.equal(input.deliveryId, "88");
      return { delivery: { id: "88", customer_account_id: "900", origin_order_id: 777 } };
    },
    toDeliveryView: () => ({ financials: { grandTotalCents: 4000 }, deliveryStatus: "delivered" }),
  };
  const result = await buildTerminalPaymentHistoryModule({ connection, deliveryStore }).listEntries({ shopId: 7 });
  assert.equal(result.items[0].payment_order_id, 777);
  assert.equal(result.items[0].customer_account_id, "900");
  assert.equal(result.items[0].delivery_status, "delivered");
  assert.deepEqual(result.items[0].financials, { grandTotalCents: 4000 });
});

test("an attachment write failure rolls back the whole submitted batch", async () => {
  const f = fixture();
  f.state.archives.push({ ...archive, id: 124, subtotal: "60.00" });
  const originalQuery = f.connection.query;
  f.connection.query = async (sql, values) => {
    if (/INSERT INTO stripe_terminal_payment_attachments/.test(sql) && values[0].archive_id === 124) throw new Error("write failed");
    return originalQuery(sql, values);
  };
  await assert.rejects(() => f.module.addAttachments({ shopId: 7, userId: 11, paymentId: 123, archiveIds: [123, 124] }), /write failed/);
  assert.equal(f.state.attachments.length, 0);
  assert.equal(f.state.payments[0].confirmed_at, "2026-10-28 10:01:00");
});

test("controller enforces typed staff history permissions and takes tenant only from session", async () => {
  const calls = [];
  const controller = buildTerminalPaymentHistoryController({ historyStore: { listEntries: async input => { calls.push(input); return { items: [], total: 0 }; } } });
  const invoke = async overrides => {
    const req = { access: 1, id: 11, shopid: 7, sessionSubject: "staff", query: { shopId: 8, page: "1" },
      currentUser: { id: 11, shopid: 7, status: 1, access: 1, module_permissions: '["history"]' }, ...overrides };
    const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return body; } };
    await controller.listEntries(req, res);
    return res;
  };
  assert.equal((await invoke({})).statusCode, 200);
  assert.equal(calls[0].shopId, 7);
  assert.equal(calls[0].userId, 11);
  for (const overrides of [{ access: 6 }, { access: "1" }, { sessionSubject: "service_point" },
    { currentUser: { id: 11, shopid: 7, status: 1, access: 1, module_permissions: '["cashregister"]' } }]) {
    assert.equal((await invoke(overrides)).statusCode, 403);
  }
  assert.equal(calls.length, 1);
});
