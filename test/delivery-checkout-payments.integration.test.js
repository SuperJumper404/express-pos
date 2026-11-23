const assert = require("node:assert/strict");
const { withDeliveryDatabase } = require("./helpers/deliveryDatabase");

withDeliveryDatabase(async db => {
  await db.seedScenario();
  require.cache[require.resolve("../src/config/dbPool")] = { exports: db.pool };
  const { buildDeliveryCheckoutPayments } = require("../src/services/deliveryCheckoutPayments");
  const { buildCourierDeliveryPayments } = require("../src/services/courierDeliveryPayments");
  const { buildStripeTerminalModule } = require("../src/modules/m_stripeTerminal");
  const { buildDeliveryCollections } = require("../src/modules/m_deliveryCollections");
  const { withTransaction } = require("../src/helpers/withTransaction");
  await db.pool.query("UPDATE shop SET stripe_account_id='acct_fixture',stripe_charges_enabled=1 WHERE id=7");
  await db.pool.query("UPDATE orders SET status=3, payment_status='unpaid', subtotal_before_discount=subtotal WHERE id=31");
  await db.pool.query("UPDATE deliveries SET courier_id=11,delivery_status='in_transit' WHERE id=41");
  await db.pool.query(`INSERT INTO delivery_charge_snapshots
    (shopid,delivery_id,revision,band_fee_cents,free_delivery_applied,fee_cents,total_excl_tax_cents,tax_cents,vat_rate,fiscal_policy)
    VALUES (7,41,1,0,0,0,0,0,10,'{}')`);

  const equipment = buildCourierDeliveryPayments();
  const courierAccount = { shopId: 7, userId: 11 };
  const requested = await equipment.requestAssignedTerminal(courierAccount);
  assert.ok(requested.requestedAt);
  assert.deepEqual(await equipment.requestAssignedTerminal(courierAccount), requested);
  await assert.rejects(equipment.requestAssignedTerminal({ ...courierAccount, shopId: 8 }), { code: "DELIVERY_FORBIDDEN" });
  await db.pool.query(`INSERT INTO stripe_terminal_locations (id,shopid,stripe_location_id,display_name,address_line1,postal_code,city)
    VALUES (1,7,'tml_fixture','Fixture','1 rue Test','75001','Paris')`);
  await db.pool.query(`INSERT INTO stripe_terminal_readers (id,shopid,terminal_location_id,stripe_reader_id,label,assigned_user_id)
    VALUES (1,7,1,'tmr_fixture','TPE livreur',11)`);
  assert.deepEqual(await equipment.readAssignedTerminal(courierAccount), { assigned: true, label: "TPE livreur", requestedAt: null });
  await db.pool.query("UPDATE stripe_terminal_readers SET is_active=0 WHERE id=1");
  assert.deepEqual(await equipment.readAssignedTerminal(courierAccount), { assigned: false, label: null, requestedAt: null });
  await db.pool.query("UPDATE stripe_terminal_readers SET is_active=1 WHERE id=1");

  let session;
  let creates = 0;
  let intentData;
  const checkout = buildDeliveryCheckoutPayments({
    returnUrl: () => "https://example.test/livraison/paiement-confirme",
    stripe: () => ({ checkout: { sessions: {
      create: async params => {
        const id = `cs_test_${++creates}`;
        intentData = params.payment_intent_data;
        session = { id, url: `https://checkout.stripe.com/c/pay/${id}`, expires_at: params.expires_at,
          status: "open", payment_status: "unpaid", currency: "eur", amount_total: params.line_items[0].price_data.unit_amount,
          metadata: params.metadata };
        return session;
      },
      retrieve: async () => session,
      expire: async () => { session.status = "expired"; },
    } } }),
  });
  const actor = { subject: "staff", access: 6, shopId: 7, id: 11 };
  const start = { actor, deliveryId: "41", action: "start", expectedVersion: 1 };
  const [first, repeated] = await Promise.all([checkout.courier(start), checkout.courier(start)]);
  assert.deepEqual(first, repeated);
  assert.equal(creates, 1);
  await assert.rejects(db.migrateDelivery("down"), { errno: 3819 });
  const lockTerminal = input => withTransaction(connection => buildStripeTerminalModule({ connection }).lockReaderAndOrders({
    shopId: 7, userId: 11, orderIds: [31], courierDelivery: { id: "41", expectedVersion: 1 }, ...input,
  }));
  await assert.rejects(lockTerminal(), /Invalid Terminal order selection/);
  await assert.rejects(buildDeliveryCollections().collect({
    actor, deliveryId: "41", expectedVersion: 1, method: "cash", idempotencyKey: "qr-lock",
  }), { code: "DELIVERY_PAYMENT_NOT_SETTLED" });
  assert.equal((await checkout.courier({ ...start, action: "cancel", attemptId: first.attemptId })).status, "idle");
  assert.equal((await lockTerminal()).orders[0].id, 31);
  await assert.rejects(lockTerminal({ courierDelivery: { id: "41", expectedVersion: 2 } }), /Invalid Terminal order selection/);

  await checkout.courier(start);
  session.payment_intent = {
    id: "pi_delivery_checkout", status: "succeeded", amount_received: 1250, currency: "eur", metadata: intentData.metadata,
    transfer_data: intentData.transfer_data, application_fee_amount: intentData.application_fee_amount,
    latest_charge: { id: "ch_delivery_checkout", payment_method_details: { type: "card", card: { wallet: { type: "apple_pay" } } } },
  };
  const event = { type: "payment_intent.succeeded", data: { object: session.payment_intent } };
  await Promise.all([checkout.webhook(event), checkout.webhook(event)]);
  const [order] = await db.readRows("SELECT payment_status,payment_provider,payment,stripe_payment_intent_id FROM orders WHERE id=31");
  assert.deepEqual({ ...order }, { payment_status: "paid", payment_provider: "stripe", payment: "Apple Pay", stripe_payment_intent_id: "pi_delivery_checkout" });
  const payments = await db.readRows("SELECT amount_cents,payment_method FROM payments WHERE shop_id=7 AND order_id=31");
  assert.deepEqual(payments.map(row => ({ ...row })), [{ amount_cents: 1250, payment_method: "Apple Pay" }]);
  console.log("PASS courier terminal request and assignment, exclusive QR/TPE/cash, and concurrent Apple Pay webhook settlement");
}).catch(error => { console.error(error); process.exitCode = 1; });
