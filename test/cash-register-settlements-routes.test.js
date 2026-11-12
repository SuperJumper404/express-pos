const assert = require("assert");
const fs = require("fs");
const DomainError = require("../src/helpers/domainError");
const auth = require("../src/helpers/middleware/auth");
const {
  buildCashRegisterSettlementsController,
} = require("../src/controllers/c_cashRegisterSettlements");

const tests = [];
const test = (name, run) => tests.push({ name, run });

const receipt = (overrides = {}) => ({
  id: 501,
  tableReference: "Table 9",
  paymentMethod: "Especes",
  subtotalBeforeDiscount: 20,
  discountType: "amount",
  discountValue: 2,
  discountAmount: 2,
  totalAmount: 18,
  terminalPaymentId: null,
  archivedOrders: [{ id: 801, ordernumber: "O-12" }],
  vatBreakdown: [{ vatRate: "10.00", totalHt: 16.36, totalVat: 1.64, totalTtc: 18 }],
  idempotentReplay: false,
  request_fingerprint: "internal-fingerprint",
  stripe_secret: "provider-secret",
  ...overrides,
});

const invoke = async (handler, overrides = {}) => {
  const req = {
    shopid: 7,
    id: 44,
    access: 1,
    sessionSubject: "staff",
    params: { id: "501" },
    body: {},
    ...overrides,
  };
  const res = {
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return body; },
  };
  await handler(req, res);
  return res;
};

test("settlement routes use Terminal cashier authentication and authorization", () => {
  const routerPath = require.resolve("../src/routers/r_cashRegisterSettlements");
  delete require.cache[routerPath];
  const router = require(routerPath);
  for (const [verb, path] of [
    ["post", "/cash-register/settlements"],
    ["get", "/cash-register/settlements/:id"],
  ]) {
    const layer = router.stack.find((candidate) => (
      candidate.route && candidate.route.path === path && candidate.route.methods[verb]
    ));
    assert(layer, `Missing ${verb.toUpperCase()} ${path}`);
    assert.deepStrictEqual(
      layer.route.stack.slice(0, 2).map((entry) => entry.handle),
      [auth.authentication, auth.authorizeCashRegister],
    );
  }
});

test("settlement router is mounted under the API prefix", () => {
  const indexSource = fs.readFileSync(require.resolve("../index"), "utf8");
  assert.match(indexSource, /require\("\.\/src\/routers\/r_cashRegisterSettlements"\)/);
  assert.match(indexSource, /app\.use\(`\$\{prefix\}`, routerCashRegisterSettlements\)/);
});

test("create maps only client settlement fields and authenticated identity", async () => {
  let received;
  const controller = buildCashRegisterSettlementsController({
    settlementService: {
      createSettlement: async (input) => { received = input; return receipt(); },
    },
    logger: { error: () => {} },
  });
  const response = await invoke(controller.createSettlement, {
    body: {
      shopId: 999,
      actorId: 888,
      orderIds: [31, 12],
      paymentMethod: "Especes",
      discount: { discountType: "amount", discountValue: 2 },
      idempotencyKey: "settlement-1",
      terminalPaymentId: null,
      totalAmount: 1,
    },
  });
  assert.strictEqual(response.statusCode, 201);
  assert.deepStrictEqual(received, {
    shopId: 7,
    actorId: 44,
    orderIds: [31, 12],
    paymentMethod: "Especes",
    discountType: "amount",
    discountValue: 2,
    idempotencyKey: "settlement-1",
    terminalPaymentId: null,
  });
  assert.strictEqual(response.body.data.request_fingerprint, undefined);
  assert.strictEqual(response.body.data.stripe_secret, undefined);
});

test("create returns 200 for an idempotent replay", async () => {
  const controller = buildCashRegisterSettlementsController({
    settlementService: {
      createSettlement: async () => receipt({ idempotentReplay: true }),
    },
    logger: { error: () => {} },
  });
  const response = await invoke(controller.createSettlement, {
    body: {
      orderIds: [12],
      paymentMethod: "Especes",
      discount: { discountType: "none", discountValue: 0 },
      idempotencyKey: "settlement-1",
    },
  });
  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(response.body.data.idempotentReplay, true);
});

test("create rejects a missing or non-integer order array before calling the service", async () => {
  let calls = 0;
  const controller = buildCashRegisterSettlementsController({
    settlementService: {
      createSettlement: async () => { calls += 1; return receipt(); },
    },
    logger: { error: () => {} },
  });
  for (const orderIds of [undefined, [], [12.5], [true], [0]]) {
    const response = await invoke(controller.createSettlement, { body: { orderIds } });
    assert.strictEqual(response.statusCode, 400);
    assert.deepStrictEqual(response.body.data, { code: "SETTLEMENT_INVALID_INPUT" });
  }
  assert.strictEqual(calls, 0);
});

test("get validates the integer id and scopes reads to the authenticated shop", async () => {
  let received;
  const controller = buildCashRegisterSettlementsController({
    settlementService: {
      getSettlement: async (scope) => { received = scope; return receipt(); },
    },
    logger: { error: () => {} },
  });
  const response = await invoke(controller.getSettlement, {
    shopid: 7,
    params: { id: "501" },
    body: { shopId: 999 },
  });
  assert.strictEqual(response.statusCode, 200);
  assert.deepStrictEqual(received, { shopId: 7, settlementId: 501 });
  assert.strictEqual(response.body.data.request_fingerprint, undefined);

  for (const id of ["", "1.5", "0", "unsafe"]) {
    const invalid = await invoke(controller.getSettlement, { params: { id } });
    assert.strictEqual(invalid.statusCode, 400);
  }
});

test("create and get recursively expose only receipt-safe settlement fields", async () => {
  const unsafeReceipt = receipt({
    createdAt: "2026-09-27T10:11:00.000Z",
    created_at: "2026-09-27 10:11:00.000000",
    shopid: 7,
    idempotency_key: "private-key",
    request_fingerprint: "private-fingerprint",
    raw_sql: "SELECT * FROM private_table",
    archivedOrders: [{
      id: 801,
      token: "public-archive-token",
      ordernumber: "O-12",
      customer: "Table client",
      service_point_name: "Table 9",
      subtotal_before_discount: 20,
      discount_type: "amount",
      discount_value: 2,
      discount_amount: 2,
      subtotal: 18,
      payment: "Especes",
      paymentStatus: "refunded",
      refundStatus: "succeeded",
      status: 3,
      created: "2026-09-27T10:00:00.000Z",
      finished: "2026-09-27T10:10:00.000Z",
      archived_at: "2026-09-27T10:11:00.000Z",
      remark: "Sans sel",
      is_takeaway: 0,
      order_source: "pos",
      taken_by_name: "Alice",
      prepared_by_name: "Bob",
      shopid: 7,
      customerID: 90,
      service_point_id: 9,
      operator: 44,
      cash_register_settlement_id: 501,
      payment_provider: "stripe_terminal",
      stripe_payment_intent_id: "pi_secret",
      stripe_terminal_payment_id: 41,
      request_fingerprint: "nested-fingerprint",
      arbitrary_secret: "archive-secret",
      details: [{
        name: "Menu midi",
        qty: 2,
        price: 10,
        total: 18,
        remark: "Cuisson normale",
        vat_rate: 10,
        unit_price_ht: 8.18,
        unit_vat: 0.82,
        total_ht: 16.36,
        total_vat: 1.64,
        id: 901,
        orderId: 801,
        productid: 77,
        stripe_price_id: "price_secret",
        raw_column: "detail-secret",
        customizationList: [{
          step_name: "Sauce",
          step_position: 1,
          name: "Poivre",
          choice_position: 2,
          price: 0.5,
          id: 1001,
          archivesdetail_id: 901,
          product_customization_step_id: 20,
          product_customization_step_choice_id: 21,
          linked_product_id: 77,
          provider_reference: "customization-secret",
        }],
      }],
    }],
    vatBreakdown: [{
      vatRate: "10.00",
      totalHt: 16.36,
      totalVat: 1.64,
      totalTtc: 18,
      raw_sql_total: "vat-secret",
    }],
  });
  const controller = buildCashRegisterSettlementsController({
    settlementService: {
      createSettlement: async () => unsafeReceipt,
      getSettlement: async () => unsafeReceipt,
    },
    logger: { error: () => {} },
  });
  const createResponse = await invoke(controller.createSettlement, {
    body: {
      orderIds: [12],
      paymentMethod: "Especes",
      discount: { discountType: "amount", discountValue: 2 },
      idempotencyKey: "settlement-1",
    },
  });
  const getResponse = await invoke(controller.getSettlement);
  const expected = {
    id: 501,
    tableReference: "Table 9",
    paymentMethod: "Especes",
    subtotalBeforeDiscount: 20,
    discountType: "amount",
    discountValue: 2,
    discountAmount: 2,
    totalAmount: 18,
    terminalPaymentId: null,
    createdAt: "2026-09-27T10:11:00.000Z",
    archivedOrders: [{
      id: 801,
      token: "public-archive-token",
      ordernumber: "O-12",
      customer: "Table client",
      service_point_name: "Table 9",
      subtotal_before_discount: 20,
      discount_type: "amount",
      discount_value: 2,
      discount_amount: 2,
      subtotal: 18,
      payment: "Especes",
      paymentStatus: "refunded",
      refundStatus: "succeeded",
      status: 3,
      created: "2026-09-27T10:00:00.000Z",
      finished: "2026-09-27T10:10:00.000Z",
      archived_at: "2026-09-27T10:11:00.000Z",
      remark: "Sans sel",
      is_takeaway: 0,
      order_source: "pos",
      taken_by_name: "Alice",
      prepared_by_name: "Bob",
      details: [{
        name: "Menu midi",
        qty: 2,
        price: 10,
        total: 18,
        remark: "Cuisson normale",
        vat_rate: 10,
        unit_price_ht: 8.18,
        unit_vat: 0.82,
        total_ht: 16.36,
        total_vat: 1.64,
        customizationList: [{
          step_name: "Sauce",
          step_position: 1,
          name: "Poivre",
          choice_position: 2,
          price: 0.5,
        }],
      }],
    }],
    vatBreakdown: [{
      vatRate: "10.00",
      totalHt: 16.36,
      totalVat: 1.64,
      totalTtc: 18,
    }],
    idempotentReplay: false,
  };
  assert.deepStrictEqual(createResponse.body.data, expected);
  assert.deepStrictEqual(getResponse.body.data, expected);
});

test("domain and unexpected failures expose only stable sanitized errors", async () => {
  const domainController = buildCashRegisterSettlementsController({
    settlementService: {
      createSettlement: async () => {
        throw new DomainError(409, "TABLE_ORDERS_CHANGED", "Table orders changed.", {
          sql: "SELECT secret FROM orders",
          stripeResponse: { client_secret: "secret" },
        });
      },
    },
    logger: { error: () => {} },
  });
  const body = {
    orderIds: [12],
    paymentMethod: "Especes",
    discount: { discountType: "none", discountValue: 0 },
    idempotencyKey: "settlement-1",
  };
  const domain = await invoke(domainController.createSettlement, { body });
  assert.strictEqual(domain.statusCode, 409);
  assert.strictEqual(domain.body.message, "Table orders changed.");
  assert.deepStrictEqual(domain.body.data, { code: "TABLE_ORDERS_CHANGED" });
  assert(!JSON.stringify(domain.body).includes("SELECT secret"));
  assert(!JSON.stringify(domain.body).includes("client_secret"));

  const unexpectedController = buildCashRegisterSettlementsController({
    settlementService: {
      createSettlement: async () => { throw new Error("raw SQL and Stripe secret"); },
    },
    logger: { error: () => {} },
  });
  const unexpected = await invoke(unexpectedController.createSettlement, { body });
  assert.strictEqual(unexpected.statusCode, 500);
  assert.deepStrictEqual(unexpected.body.data, { code: "INTERNAL_ERROR" });
  assert(!JSON.stringify(unexpected.body).includes("raw SQL"));
  assert(!JSON.stringify(unexpected.body).includes("Stripe secret"));
});

(async () => {
  for (const entry of tests) {
    try {
      await entry.run();
      console.log(`PASS ${entry.name}`);
    } catch (error) {
      console.error(`FAIL ${entry.name}`);
      throw error;
    }
  }
  console.log("cash register settlement route contracts passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
