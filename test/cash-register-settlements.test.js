const assert = require("assert");
const DomainError = require("../src/helpers/domainError");
const { normalizePaymentMethod } = require("../src/helpers/paymentMethod");
const {
  buildCashRegisterSettlementModule,
} = require("../src/modules/m_cashRegisterSettlements");
const {
  buildCashRegisterSettlementService,
} = require("../src/services/cashRegisterSettlements");

const tests = [];
const test = (name, run) => tests.push({ name, run });
const clone = (value) => JSON.parse(JSON.stringify(value));

const baseOrders = () => [
  { id: 31, shopid: 7, status: 3, payment_status: "unpaid", subtotal: "6.67", service_point_id: 9, service_point_name: "Table 9", service_point_type: "table", customerID: 90 },
  { id: 12, shopid: 7, status: 3, payment_status: "unpaid", subtotal: "6.67", service_point_id: 9, service_point_name: "Table 9", service_point_type: "table", customerID: 90 },
  { id: 22, shopid: 7, status: 3, payment_status: "unpaid", subtotal: "6.66", service_point_id: 9, service_point_name: "Table 9", service_point_type: "table", customerID: 90 },
];

const fixture = ({ orders = baseOrders(), terminalPayment = null, terminalAllocations = [] } = {}) => {
  const state = {
    orders: clone(orders),
    settlements: [],
    archives: [],
    terminalPayment: clone(terminalPayment),
    terminalAllocations: clone(terminalAllocations),
    events: [],
    archiveCalls: 0,
    failArchiveAt: null,
  };

  const receipt = (settlement) => {
    const archivedOrders = state.archives
      .filter((archive) => archive.cash_register_settlement_id === settlement.id)
      .sort((left, right) => left.sourceOrderId - right.sourceOrderId)
      .map(clone);
    const vat = new Map();
    for (const archive of archivedOrders) {
      for (const detail of archive.details) {
        const key = Number(detail.vat_rate).toFixed(2);
        const current = vat.get(key) || { vatRate: key, totalHt: 0, totalVat: 0, totalTtc: 0 };
        current.totalHt += Math.round(Number(detail.total_ht) * 100);
        current.totalVat += Math.round(Number(detail.total_vat) * 100);
        current.totalTtc += Math.round(Number(detail.total) * 100);
        vat.set(key, current);
      }
    }
    return {
      ...clone(settlement),
      archivedOrders,
      vatBreakdown: [...vat.values()].map((row) => ({
        vatRate: row.vatRate,
        totalHt: row.totalHt / 100,
        totalVat: row.totalVat / 100,
        totalTtc: row.totalTtc / 100,
      })),
    };
  };

  const store = {
    withTransaction: async (work) => {
      const before = clone({
        orders: state.orders,
        settlements: state.settlements,
        archives: state.archives,
      });
      const connection = { transaction: true };
      state.events.push("begin");
      try {
        const result = await work({ ...store, connection });
        state.events.push("commit");
        return result;
      } catch (error) {
        state.orders = before.orders;
        state.settlements = before.settlements;
        state.archives = before.archives;
        state.events.push("rollback");
        throw error;
      }
    },
    lockShop: async ({ shopId }) => {
      state.events.push(`shop:${shopId}`);
      return shopId === 7 ? { id: 7 } : null;
    },
    lockOrders: async ({ shopId, orderIds }) => {
      state.events.push(`orders:${orderIds.join(",")}`);
      return clone(state.orders.filter((order) => (
        order.shopid === shopId && orderIds.includes(order.id)
      )).sort((left, right) => left.id - right.id));
    },
    listEligibleTableOrders: async ({ shopId, servicePointId, customerId }) => clone(
      (state.events.push(`eligible:${servicePointId == null ? `legacy-${customerId}` : servicePointId}`),
      state.orders.filter((order) => order.shopid === shopId
        && order.status === 3 && order.payment_status === "unpaid"
        && (servicePointId == null
          ? order.service_point_id == null && order.customerID === customerId
          : order.service_point_id === servicePointId))
        .sort((left, right) => left.id - right.id)),
    ),
    findByIdempotencyKey: async ({ shopId, idempotencyKey }) => clone(
      state.settlements.find((row) => row.shopid === shopId
        && row.idempotency_key === idempotencyKey) || null,
    ),
    insertSettlement: async (data) => {
      const row = { id: 501 + state.settlements.length, ...clone(data) };
      state.settlements.push(row);
      state.events.push(`settlement:${row.id}`);
      return clone(row);
    },
    findTerminalPayment: async ({ shopId, paymentId }) => (
      state.terminalPayment && state.terminalPayment.shopid === shopId
        && state.terminalPayment.id === paymentId ? clone(state.terminalPayment) : null
    ),
    listTerminalAllocations: async ({ shopId, paymentId }) => clone(
      state.terminalAllocations.filter((row) => row.shopid === shopId
        && row.terminal_payment_id === paymentId)
        .sort((left, right) => left.order_id - right.order_id),
    ),
    getSettlementReceipt: async ({ shopId, settlementId }) => {
      const settlement = state.settlements.find((row) => row.shopid === shopId
        && row.id === settlementId);
      return settlement ? receipt(settlement) : null;
    },
  };

  const archiveOrderInTransaction = async ({ connection, orderId, paymentMethod,
    shopId, discount, settlementId, lockedOrder }) => {
    assert.strictEqual(connection.transaction, true);
    state.archiveCalls += 1;
    if (state.archiveCalls === state.failArchiveAt) throw new Error("archive failed");
    const orderIndex = state.orders.findIndex((candidate) => candidate.id === orderId);
    assert(orderIndex >= 0);
    assert.strictEqual(lockedOrder.id, orderId);
    const order = state.orders[orderIndex];
    const grossCents = Math.round(Number(order.subtotal) * 100);
    const allocation = state.terminalAllocations.find((row) => row.order_id === orderId
      && row.terminal_payment_id === order.stripe_terminal_payment_id);
    const discountCents = allocation
      ? grossCents - allocation.amount_cents
      : Math.round(Number(discount.discountValue) * 100);
    const totalCents = grossCents - discountCents;
    const totalHtCents = Math.round(totalCents / 1.1);
    const archive = {
      id: 801 + state.archives.length,
      sourceOrderId: order.id,
      shopid: shopId,
      ordernumber: `O-${order.id}`,
      customer: order.service_point_name || `Table ${order.customerID}`,
      service_point_id: order.service_point_id,
      payment: paymentMethod,
      subtotal_before_discount: grossCents / 100,
      discount_type: discountCents ? "amount" : "none",
      discount_value: discountCents / 100,
      discount_amount: discountCents / 100,
      subtotal: totalCents / 100,
      cash_register_settlement_id: settlementId,
      token: `token-${order.id}`,
      details: [{ vat_rate: 10, total_ht: totalHtCents / 100,
        total_vat: (totalCents - totalHtCents) / 100, total: totalCents / 100 }],
    };
    state.archives.push(archive);
    state.orders.splice(orderIndex, 1);
    state.events.push(`archive:${orderId}`);
    return { archiveId: archive.id, token: archive.token, archive: clone(archive), details: clone(archive.details) };
  };

  return {
    state,
    service: buildCashRegisterSettlementService({ settlementStore: store, archiveOrderInTransaction }),
  };
};

const manualInput = (overrides = {}) => ({
  shopId: 7,
  actorId: 44,
  orderIds: [31, 12, 22],
  paymentMethod: "Especes",
  discountType: "amount",
  discountValue: 0.02,
  idempotencyKey: "settlement-manual-1",
  ...overrides,
});

const expectCode = (run, code, status) => assert.rejects(run, (error) => {
  assert(error instanceof DomainError);
  assert.strictEqual(error.code, code);
  assert.strictEqual(error.status, status);
  return true;
});

test("settles every eligible order at a table in one transaction", async () => {
  const f = fixture();
  const result = await f.service.createSettlement(manualInput());
  assert.deepStrictEqual(f.state.events, [
    "begin", "shop:7", "orders:12,22,31", "eligible:9", "settlement:501",
    "archive:12", "archive:22", "archive:31", "commit",
  ]);
  assert.strictEqual(result.id, 501);
  assert.strictEqual(result.tableReference, "Table 9");
  assert.strictEqual(result.paymentMethod, normalizePaymentMethod("Especes"));
  assert.strictEqual(result.subtotalBeforeDiscount, 20);
  assert.strictEqual(result.discountAmount, 0.02);
  assert.strictEqual(result.totalAmount, 19.98);
  assert.strictEqual(result.idempotentReplay, false);
  assert.deepStrictEqual(result.archivedOrders.map((row) => row.sourceOrderId), [12, 22, 31]);
  assert.strictEqual(result.archivedOrders.reduce((sum, row) => (
    sum + Math.round(row.subtotal * 100)
  ), 0), 1998);
  assert.deepStrictEqual(result.vatBreakdown, [
    { vatRate: "10.00", totalHt: 18.15, totalVat: 1.83, totalTtc: 19.98 },
  ]);
});

test("uses largest remainders with order ID tie-breaking and exact cent sums", async () => {
  const f = fixture();
  const result = await f.service.createSettlement(manualInput({ discountValue: 0.01 }));
  assert.deepStrictEqual(result.archivedOrders.map((row) => [
    row.sourceOrderId, Math.round(row.discount_amount * 100), Math.round(row.subtotal * 100),
  ]), [[12, 1, 666], [22, 0, 666], [31, 0, 667]]);
  assert.strictEqual(result.archivedOrders.reduce((sum, row) => (
    sum + Math.round(row.discount_amount * 100)
  ), 0), 1);
});

test("rejects mixed table, foreign shop and ineligible status selections", async () => {
  for (const replacement of [
    { id: 31, shopid: 7, status: 3, payment_status: "unpaid", subtotal: 6.67, service_point_id: 10, service_point_name: "Table 10", service_point_type: "table", customerID: 91 },
    { id: 31, shopid: 8, status: 3, payment_status: "unpaid", subtotal: 6.67, service_point_id: 9, service_point_name: "Table 9", service_point_type: "table", customerID: 90 },
    { id: 31, shopid: 7, status: 2, payment_status: "unpaid", subtotal: 6.67, service_point_id: 9, service_point_name: "Table 9", service_point_type: "table", customerID: 90 },
  ]) {
    const orders = baseOrders();
    orders[0] = replacement;
    const f = fixture({ orders });
    await expectCode(() => f.service.createSettlement(manualInput()), "TABLE_ORDERS_CHANGED", 409);
    assert.strictEqual(f.state.settlements.length, 0);
  }
});

test("rejects a manual settlement that omits another eligible table order", async () => {
  const f = fixture();
  await expectCode(
    () => f.service.createSettlement(manualInput({ orderIds: [31, 12] })),
    "TABLE_ORDERS_CHANGED",
    409,
  );
});

test("rolls back the parent and every archive when a later archive fails", async () => {
  const f = fixture();
  f.state.failArchiveAt = 2;
  await assert.rejects(() => f.service.createSettlement(manualInput()), /archive failed/);
  assert.deepStrictEqual(f.state.orders, baseOrders());
  assert.deepStrictEqual(f.state.settlements, []);
  assert.deepStrictEqual(f.state.archives, []);
  assert.strictEqual(f.state.events.at(-1), "rollback");
});

test("returns the stored authoritative receipt on an exact idempotent replay", async () => {
  const f = fixture();
  const first = await f.service.createSettlement(manualInput());
  const archiveCalls = f.state.archiveCalls;
  const replay = await f.service.createSettlement(manualInput({ orderIds: [22, 31, 12, 12] }));
  assert.deepStrictEqual(replay, { ...first, idempotentReplay: true });
  assert.strictEqual(f.state.archiveCalls, archiveCalls);
});

test("rejects conflicting reuse of an idempotency key", async () => {
  const changes = [
    { orderIds: [12, 22] },
    { actorId: 45 },
    { paymentMethod: "Cheque" },
    { discountType: "percent", discountValue: 0.02 },
    { discountValue: 0.03 },
    { terminalPaymentId: 42 },
  ];
  for (const change of changes) {
    const f = fixture();
    await f.service.createSettlement(manualInput());
    await expectCode(
      () => f.service.createSettlement(manualInput(change)),
      "SETTLEMENT_IDEMPOTENCY_CONFLICT",
      409,
    );
  }
});

test("persists a deterministic fingerprint of every normalized request field", async () => {
  const f = fixture();
  await f.service.createSettlement(manualInput({ orderIds: [31, 12, 22, 12] }));
  assert.strictEqual(
    f.state.settlements[0].request_fingerprint,
    "ca4d94d3c920c2977702a3b5facf8db762c25243b195affe3d8ee5dd088f46f7",
  );
});

const terminalFixture = (overrides = {}) => fixture({
  orders: baseOrders().slice(0, 2).map((order) => ({
    ...order,
    payment_status: "paid",
    payment: "Carte bancaire - TPE Stripe",
    payment_provider: "stripe_terminal",
    stripe_terminal_payment_id: 41,
  })),
  terminalPayment: {
    id: 41, shopid: 7, status: "succeeded", amount_cents: 1332,
    discount_type: "amount", discount_value: 2, cashier_user_id: 44, currency: "eur",
    ...overrides.payment,
  },
  terminalAllocations: overrides.allocations || [
    { shopid: 7, terminal_payment_id: 41, order_id: 12, amount_cents: 666 },
    { shopid: 7, terminal_payment_id: 41, order_id: 31, amount_cents: 666 },
  ],
});

const terminalInput = (overrides = {}) => manualInput({
  orderIds: [31, 12],
  paymentMethod: "Carte bancaire - TPE Stripe",
  discountType: "amount",
  discountValue: 0.02,
  idempotencyKey: "settlement-terminal-1",
  terminalPaymentId: 41,
  ...overrides,
});

test("accepts a succeeded Terminal payment only for its exact frozen allocations", async () => {
  const f = terminalFixture();
  const result = await f.service.createSettlement(terminalInput());
  assert.strictEqual(result.totalAmount, 13.32);
  assert.strictEqual(result.terminalPaymentId, 41);
  assert.deepStrictEqual(result.archivedOrders.map((row) => [row.sourceOrderId, row.subtotal]), [
    [12, 6.66], [31, 6.66],
  ]);
});

test("rejects foreign, incomplete, unsuccessful or amount-mismatched Terminal payments", async () => {
  const cases = [
    terminalFixture({ payment: { shopid: 8 } }),
    terminalFixture({ allocations: [{ shopid: 7, terminal_payment_id: 41, order_id: 12, amount_cents: 666 }] }),
    terminalFixture({ payment: { status: "processing" } }),
    terminalFixture({ payment: { amount_cents: 1331 } }),
    terminalFixture({
      payment: { amount_cents: 1331 },
      allocations: [
        { shopid: 7, terminal_payment_id: 41, order_id: 12, amount_cents: 665 },
        { shopid: 7, terminal_payment_id: 41, order_id: 31, amount_cents: 666 },
      ],
    }),
  ];
  for (const f of cases) {
    await expectCode(
      () => f.service.createSettlement(terminalInput()),
      "TERMINAL_PAYMENT_NOT_SETTLED",
      409,
    );
  }
});

test("rejects Terminal payments owned by another cashier or using another currency", async () => {
  for (const payment of [{ cashier_user_id: 45 }, { currency: "usd" }]) {
    const f = terminalFixture({ payment });
    await expectCode(
      () => f.service.createSettlement(terminalInput()),
      "TERMINAL_PAYMENT_NOT_SETTLED",
      409,
    );
  }
});

test("allows a newly eligible order outside frozen Terminal allocations", async () => {
  const f = terminalFixture();
  f.state.orders.push({
    id: 55, shopid: 7, status: 3, payment_status: "unpaid", subtotal: "4.00",
    service_point_id: 9, service_point_name: "Table 9", service_point_type: "table", customerID: 90,
  });
  const result = await f.service.createSettlement(terminalInput());
  assert.deepStrictEqual(result.archivedOrders.map((row) => row.sourceOrderId), [12, 31]);
  assert.strictEqual(f.state.orders.some((order) => order.id === 55), true);
});

test("accepts table service points and legacy table identity but rejects non-table points", async () => {
  for (const type of ["counter", "kiosk", "click_collect"]) {
    const f = fixture({ orders: baseOrders().map((order) => ({
      ...order,
      service_point_type: type,
    })) });
    await expectCode(
      () => f.service.createSettlement(manualInput()),
      "TABLE_ORDERS_CHANGED",
      409,
    );
  }

  const legacyOrders = baseOrders().map((order) => ({
    ...order,
    service_point_id: null,
    service_point_name: null,
    service_point_type: null,
  }));
  const legacy = fixture({ orders: legacyOrders });
  const receipt = await legacy.service.createSettlement(manualInput());
  assert.strictEqual(receipt.tableReference, "90");
});

test("production store forwards its exact transaction connection and locks completeness before archival", async () => {
  const events = [];
  const settlementRow = {
    id: 501,
    shopid: 7,
    service_point_id: 9,
    table_reference: "Table 9",
    payment_method: normalizePaymentMethod("Especes"),
    subtotal_before_discount: "20.00",
    discount_type: "amount",
    discount_value: "0.02",
    discount_amount: "0.02",
    total_amount: "19.98",
    stripe_terminal_payment_id: null,
    idempotency_key: "settlement-manual-1",
    request_fingerprint: "ca4d94d3c920c2977702a3b5facf8db762c25243b195affe3d8ee5dd088f46f7",
    created_by_user_id: 44,
  };
  const transactionConnection = {
    beginTransaction: async () => events.push("begin"),
    commit: async () => events.push("commit"),
    rollback: async () => events.push("rollback"),
    release: () => events.push("release"),
    query: async (sql) => {
      if (/FROM shop/.test(sql)) { events.push("shop-lock"); return [[{ id: 7 }]]; }
      if (/idempotency_key = \?/.test(sql)) { events.push("idempotency"); return [[]]; }
      if (/orders\.id IN/.test(sql)) { events.push("submitted-lock"); return [baseOrders().sort((a, b) => a.id - b.id)]; }
      if (/orders\.status = 3/.test(sql)) {
        assert.match(sql, /FOR UPDATE\s*$/);
        events.push("eligible-lock");
        return [baseOrders().sort((a, b) => a.id - b.id)];
      }
      if (/INSERT INTO cash_register_settlements/.test(sql)) { events.push("insert"); return [{ insertId: 501 }]; }
      if (/cash_register_settlements WHERE shopid = \? AND id = \?/.test(sql)) return [[settlementRow]];
      if (/FROM cash_register_settlements/.test(sql)) return [[settlementRow]];
      if (/FROM archives/.test(sql)) return [[]];
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const pool = { getConnection: async () => transactionConnection };
  const store = buildCashRegisterSettlementModule({ connection: pool });
  const service = buildCashRegisterSettlementService({
    settlementStore: store,
    archiveOrderInTransaction: async ({ connection, orderId }) => {
      assert.strictEqual(connection, transactionConnection);
      assert(events.includes("eligible-lock"));
      events.push(`archive:${orderId}`);
      return { archiveId: 800 + orderId, archive: {}, details: [] };
    },
  });

  await service.createSettlement(manualInput());
  assert(events.indexOf("shop-lock") < events.indexOf("idempotency"));
  assert(events.indexOf("submitted-lock") < events.indexOf("eligible-lock"));
  assert(events.indexOf("eligible-lock") < events.indexOf("archive:12"));
  assert.deepStrictEqual(events.slice(-2), ["commit", "release"]);
});

test("production transaction-bound store exposes the exact acquired connection", async () => {
  const transactionConnection = {
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
  };
  const store = buildCashRegisterSettlementModule({
    connection: { getConnection: async () => transactionConnection },
  });
  await store.withTransaction(async (transactionStore) => {
    assert.strictEqual(transactionStore.connection, transactionConnection);
  });
});

test("validates input and reports missing receipts with domain errors", async () => {
  const f = fixture();
  await expectCode(
    () => f.service.createSettlement(manualInput({ orderIds: [] })),
    "SETTLEMENT_INVALID_INPUT",
    400,
  );
  await expectCode(
    () => f.service.getSettlement({ shopId: 7, settlementId: 999 }),
    "SETTLEMENT_NOT_FOUND",
    404,
  );
});

(async () => {
  const selectedTests = process.env.TEST_NAME
    ? tests.filter((entry) => entry.name.includes(process.env.TEST_NAME))
    : tests;
  for (const entry of selectedTests) {
    try {
      await entry.run();
      console.log(`PASS ${entry.name}`);
    } catch (error) {
      console.error(`FAIL ${entry.name}`);
      throw error;
    }
  }
  console.log("cash register settlement contracts passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
