const assert = require("node:assert/strict");
const { test } = require("node:test");
const { buildDeliveryCheckoutPayments } = require("../src/services/deliveryCheckoutPayments");
const { buildCourierDeliveryPayments } = require("../src/services/courierDeliveryPayments");

const actor = { subject: "staff", id: 11, shopId: 7, access: 6 };
const deliveryId = "9007199254740993";
const request = { actor, deliveryId, action: "start", expectedVersion: 2 };
const origin = "https://example.test/livraison/paiement-confirme";

function checkoutFixture() {
  const order = { id: 31, status: 3, subtotal: "24.00", payment_status: "unpaid", payment_provider: null };
  const delivery = { id: deliveryId, shopid: 7, courier_id: 11, delivery_status: "in_transit", version: 2 };
  const shop = { id: 7, stripe_charges_enabled: 1, stripe_account_id: "acct_fixture", stripe_commission_percent: 5 };
  const payments = [];
  const sessions = new Map();
  let active;
  let transaction = Promise.resolve();
  const connection = { async query(sql, values) {
    if (sql.includes("SELECT id,stripe_account_id")) return [[shop]];
    if (sql.includes("SELECT id FROM users")) return [[{ id: actor.id }]];
    if (sql.includes("stripe_terminal_payment_orders")) return [connection.activeTerminal ? [{ id: 14 }] : []];
    if (sql.includes("SELECT * FROM delivery_checkout_sessions")) return [active ? [active] : []];
    if (sql.includes("INSERT INTO delivery_checkout_sessions")) active = values[0];
    else if (sql.includes("DELETE FROM delivery_checkout_sessions")) active = undefined;
    else if (sql.includes("UPDATE orders SET ?")) Object.assign(order, values[0]);
    else if (sql.includes("UPDATE orders SET payment_provider")) Object.assign(order, { payment_provider: values[0], payment_status: "requires_payment" });
    else if (sql.includes("INSERT INTO payments")) payments.push(values[0]);
    else assert.fail(sql);
    return [{ affectedRows: 1 }];
  } };
  const savedRequests = [];
  const checkout = buildDeliveryCheckoutPayments({
    run: work => {
      const result = transaction.then(() => work(connection));
      transaction = result.catch(() => {});
      return result;
    },
    resolve: async () => ({ order, delivery, orderKind: "active" }),
    findSession: async () => active && { ...active, delivery_id: delivery.id },
    returnUrl: () => origin, clock: () => Date.UTC(2026, 10, 23), loyalty: null,
    stripe: () => ({ checkout: { sessions: {
      async create(params) {
        const id = `cs_test_${savedRequests.push(params)}`;
        const session = { id, url: `https://checkout.stripe.com/c/pay/${id}`, expires_at: params.expires_at,
          status: "open", payment_status: "unpaid", currency: "eur", amount_total: params.line_items[0].price_data.unit_amount,
          metadata: params.metadata };
        sessions.set(id, session);
        return session;
      },
      async retrieve(id) { return sessions.get(id); },
      async expire(id) { sessions.get(id).status = "expired"; },
    } } }),
  });
  return { checkout, connection, order, payments, savedRequests, sessions };
}

test("two courier requests share one Checkout session and charge the server total", async () => {
  const { checkout, order, savedRequests } = checkoutFixture();
  const [first, second] = await Promise.all([checkout.courier(request), checkout.courier(request)]);
  assert.deepEqual(first, second);
  assert.equal(first.status, "pending");
  assert.equal(savedRequests.length, 1);
  assert.equal(savedRequests[0].success_url, origin);
  assert.deepEqual(savedRequests[0].payment_method_types, ["card"]);
  assert.equal(savedRequests[0].line_items[0].price_data.unit_amount, 2400);
  assert.equal(savedRequests[0].payment_intent_data.transfer_data.destination, "acct_fixture");
  assert.equal(order.payment_status, "requires_payment");
});

test("a confirmed Apple Pay charge settles the linked order exactly once", async () => {
  const { checkout, order, payments, sessions } = checkoutFixture();
  const { attemptId } = await checkout.courier(request);
  Object.assign(sessions.get(attemptId), {
    status: "complete", payment_status: "paid",
    payment_intent: {
      id: "pi_fixture", status: "succeeded", amount_received: 2400, currency: "eur",
      metadata: { source: "delivery_checkout", shop_id: "7", order_id: "31", delivery_id: deliveryId },
      transfer_data: { destination: "acct_fixture" }, application_fee_amount: 120,
      latest_charge: { id: "ch_fixture", payment_method_details: { type: "card", card: { wallet: { type: "apple_pay" } } } },
    },
  });
  // The session paid just before the courier asked to cancel it.
  const canceled = await checkout.courier({ ...request, action: "cancel", attemptId });
  assert.equal(canceled.status, "paid");
  assert.equal((await checkout.courier({ ...request, action: "read" })).status, "paid");
  assert.equal(payments.length, 1);
  assert.equal(payments[0].payment_method, "Apple Pay");
  assert.equal(order.payment_status, "paid");
  assert.equal(order.stripe_payment_intent_id, "pi_fixture");
});

test("an old cancel cannot expire a new QR, and a confirmed expiration releases the order", async () => {
  const { checkout, order, sessions } = checkoutFixture();
  const first = await checkout.courier(request);
  assert.equal((await checkout.courier({ ...request, action: "cancel", attemptId: first.attemptId })).status, "idle");
  assert.equal(order.payment_status, "unpaid");
  const second = await checkout.courier(request);
  const stale = await checkout.courier({ ...request, action: "cancel", attemptId: first.attemptId });
  assert.equal(stale.attemptId, second.attemptId);
  assert.equal(sessions.get(second.attemptId).status, "open");
});

test("a foreign courier, a stale version and an active TPE all prevent QR creation", async () => {
  const { checkout, connection, savedRequests } = checkoutFixture();
  await assert.rejects(checkout.courier({ ...request, actor: { ...actor, id: 12 } }), { code: "DELIVERY_NOT_FOUND" });
  await assert.rejects(checkout.courier({ ...request, expectedVersion: 1 }), { code: "DELIVERY_PAYMENT_NOT_SETTLED" });
  connection.activeTerminal = true;
  await assert.rejects(checkout.courier(request), { code: "TERMINAL_PAYMENT_IN_PROGRESS" });
  assert.equal(savedRequests.length, 0);
});

test("the courier TPE route supplies the linked order and never accepts a foreign mission", async () => {
  const calls = [];
  const courier = buildCourierDeliveryPayments({
    resolve: async () => ({ order: { id: 31, payment_status: "unpaid" }, delivery: { shopid: 7, courier_id: 11 } }),
    findPayment: async () => undefined,
    terminal: () => ({ startPayment: async input => { calls.push(input); return { status: "processing", id: 123 }; } }),
  });
  const result = await courier.payment({ ...request, method: "terminal", orderId: 99, amountCents: 1 });
  assert.equal(result.status, "processing");
  assert.deepEqual(calls, [{ shopId: 7, cashierUserId: 11, orderId: 31, orderIds: [31],
    courierDelivery: { id: deliveryId, expectedVersion: 2 } }]);
  await assert.rejects(courier.payment({ ...request, method: "terminal", actor: { ...actor, id: 12 } }), { code: "DELIVERY_NOT_FOUND" });
  assert.equal(calls.length, 1);
});
