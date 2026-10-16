const assert = require("assert");
const { withDeliveryDatabase } = require("./helpers/deliveryDatabase");

async function main() {
  await withDeliveryDatabase(async (db) => {
    await db.seedScenario();
    // Exercise production repositories against SQL; never load application credentials.
    require.cache[require.resolve("../src/config/dbPool")] = { exports: db.pool };
    const { createTransactionRunner } = require("../src/helpers/withTransaction");
    const { buildCheckoutModule } = require("../src/modules/m_checkout");
    const { buildDeliveryQuotes } = require("../src/modules/m_deliveryQuotes");
    const { buildSqlDeliverySettingsRepository } = require("../src/modules/m_deliverySettings");
    const { buildDeliveryTokenCodec, signAddressResolution } = require("../src/helpers/deliveryAddress");
    const runInTransaction = createTransactionRunner(db.pool);
    let time = new Date("2026-10-17T12:00:00Z");
    const clock = () => time;
    const tokenCodec = buildDeliveryTokenCodec({ secret: "disposable-checkout-signing-fixture-only" });
    const quotes = buildDeliveryQuotes({
      repository: buildSqlDeliverySettingsRepository({ pool: db.pool }), clock, tokenCodec,
      geocoder: { resolve() { throw new Error("No provider calls allowed"); } },
    });
    await db.pool.query("UPDATE products SET price = 20, track_stock = 1, vat_rate_dine_in = 20, vat_rate_takeaway = 5.5 WHERE id = 21");
    await db.pool.query(`INSERT INTO service_points (id, shopid, name, type, system_key, created)
      VALUES (70, 7, 'Counter', 'counter', 'counter', NOW()),
      (71, 7, 'Web', 'click_collect', 'click_collect', NOW()),
      (72, 7, 'Table', 'table', NULL, NOW()), (73, 7, 'Kiosk', 'kiosk', NULL, NOW())`);
    await db.pool.query(`UPDATE shop_delivery_settings SET enabled = 1, revision = 1,
      origin_latitude = 48.8566, origin_longitude = 2.3522, max_distance_meters = 5000,
      minimum_items_cents = 0, free_delivery_enabled = 0, fiscal_mode = 'configured_rate', vat_rate = 10 WHERE shopid = 7`);
    await db.pool.query("INSERT INTO shop_delivery_fee_bands (shopid, up_to_meters, fee_cents) VALUES (7, 5000, 400)");
    const address = {
      street: "7 rue Test", postalCode: "75001", city: "Paris", country: "FR",
      latitude: 48.857, longitude: 2.353, instructions: "Private bell fixture",
    };
    const makeAttempt = async (token, overrides = {}) => {
      const items = overrides.items || [{ productId: 21, quantity: 1, selectedChoiceIds: [] }];
      const discount = overrides.discount || { type: "none", value: 0 };
      const addressResolutionToken = signAddressResolution({ shopId: 7, addressSnapshot: overrides.address || address, now: clock(), tokenCodec });
      const quote = await quotes.createQuote({ shopId: 7, items, discount, addressResolutionToken });
      return {
        shopId: 7, actorId: 10, customer: { id: 70, name: "Guest", phone: "0700000000" },
        items, expectedTotal: quote.grandTotalCents / 100,
        discountType: discount.type, discountValue: discount.value,
        isTakeaway: false, paymentMode: "cash", clientOrderToken: token,
        fulfillmentType: "delivery", deliveryQuoteToken: quote.quoteToken, addressResolutionToken,
        deliveryConfirmationSecret: "0123456789abcdef".repeat(4),
      };
    };
    const checkout = buildCheckoutModule({ withTransaction: runInTransaction, deliveryQuotes: quotes, now: clock });
    const attempt = await makeAttempt("delivery-attempt-1");
    const first = await checkout.createCheckout(attempt);
    const [order] = await db.readRows("SELECT * FROM orders WHERE id = ?", [first.orderId]);
    assert.equal(Number(order.subtotal), 24);
    assert.equal(Number(order.subtotal_before_discount), 20);
    assert.equal(order.customerID, 70);
    assert.equal(order.order_source, "pos");
    assert.equal(order.customer_account_id, null);
    assert.equal(order.fulfillment_type, "delivery");
    assert.equal(order.is_takeaway, 1);
    const [detail] = await db.readRows("SELECT * FROM orderdetail WHERE orderid = ?", [first.orderId]);
    assert.equal(Number(detail.total), 20);
    assert.equal(Number(detail.vat_rate), 5.5);
    assert.equal(first.delivery.id, String(order.delivery_id));
    assert.equal(typeof first.delivery.id, "string");
    assert.equal(first.delivery.financials.delivery_fee, 4);
    assert.equal(first.delivery.financials.grand_total, 24);
    const { hashTrackingToken } = require("../src/helpers/deliveryTrackingToken");
    const previousToken = first.tracking_url.split("/").pop();
    assert.equal(Buffer.from(previousToken, "base64url").length, 32);
    const [delivery] = await db.readRows("SELECT * FROM deliveries WHERE id = ?", [order.delivery_id]);
    assert.equal(delivery.tracking_token_hash, hashTrackingToken(previousToken));
    assert.equal(delivery.confirmation_secret_hash, hashTrackingToken(attempt.deliveryConfirmationSecret));
    const eventsBefore = await db.readRows("SELECT * FROM delivery_events WHERE delivery_id = ?", [delivery.id]);
    assert.equal(eventsBefore.length, 1);
    const journal = JSON.stringify(eventsBefore);
    assert(!journal.includes(previousToken));
    assert(!journal.includes(attempt.deliveryConfirmationSecret));
    const [stockAfterFirst] = await db.readRows("SELECT stock FROM products WHERE id = 21");
    assert.equal(stockAfterFirst.stock, 19);
    assert.equal((await db.readRows("SELECT * FROM stocks WHERE productid = 21")).length, 1);
    time = new Date("2026-10-17T13:00:00Z");
    await db.pool.query("UPDATE shop_delivery_settings SET enabled = 0, revision = 2 WHERE shopid = 7");
    const replay = await checkout.createCheckout(attempt);
    assert.equal(replay.orderId, first.orderId);
    assert.deepStrictEqual(replay.delivery, first.delivery);
    assert.equal(replay.idempotent_replay, true);
    assert.equal(replay.tracking_url, undefined);
    assert.equal((await db.readRows("SELECT * FROM deliveries WHERE client_order_token = ?", [attempt.clientOrderToken])).length, 1);
    assert.equal((await db.readRows("SELECT * FROM delivery_events WHERE delivery_id = ?", [delivery.id])).length, 1);
    assert.equal((await db.readRows("SELECT stock FROM products WHERE id = 21"))[0].stock, stockAfterFirst.stock);
    assert.equal((await db.readRows("SELECT tracking_token_hash FROM deliveries WHERE id = ?", [delivery.id]))[0].tracking_token_hash, hashTrackingToken(previousToken));
    await db.pool.query("UPDATE shop_delivery_settings SET enabled = 1, revision = 1 WHERE shopid = 7");
    await assert.rejects(checkout.createCheckout(await makeAttempt("delivery-attempt-1", { address: { ...address, street: "8 rue Test" } })), { code: "DELIVERY_IDEMPOTENCY_CONFLICT" });
    console.log("PASS SQL delivery totals, single stock movement, expired/suspended exact replay, address conflict, tracking privacy");

    const { buildDeliveryOrders } = require("../src/modules/m_deliveryOrders");
    const deliveryOrders = buildDeliveryOrders({ clock });
    const faulty = buildCheckoutModule({
      withTransaction: runInTransaction, deliveryQuotes: quotes, now: clock,
      deliveryOrders: {
        ...deliveryOrders,
        async createDeliveryForOrder(input) {
          await deliveryOrders.createDeliveryForOrder(input);
          throw new Error("Injected after durable dossier insertion");
        },
      },
    });
    const counts = async () => Promise.all(["orders", "deliveries", "delivery_events", "delivery_charge_snapshots", "stocks", "order_stock_reservations", "orderdetail"].map(async table => (await db.readRows(`SELECT COUNT(*) AS n FROM ${table}`))[0].n));
    const beforeCounts = await counts();
    await assert.rejects(faulty.createCheckout(await makeAttempt("delivery-rollback")), /Injected after durable dossier/);
    assert.deepStrictEqual(await counts(), beforeCounts);
    assert.equal((await db.readRows("SELECT stock FROM products WHERE id = 21"))[0].stock, 19);
    console.log("PASS SQL rollback includes order, delivery, charge, events, detail, reservation and stock");

    const webAttempt = { ...await makeAttempt("delivery-web"), actorId: null, sessionSubject: "service_point", servicePointId: 71, orderSource: "web", customerAccountId: "999" };
    const web = await checkout.createCheckout(webAttempt);
    assert.equal((await db.readRows("SELECT order_source, customer_account_id FROM orders WHERE id = ?", [web.orderId]))[0].order_source, "web");
    assert.equal((await db.readRows("SELECT customer_account_id FROM deliveries WHERE id = ?", [web.delivery.id]))[0].customer_account_id, null);
    for (const [point, source] of [[72, "table_qr"], [73, "kiosk"], [71, "table_qr"]]) {
      await assert.rejects(checkout.createCheckout({ ...webAttempt, clientOrderToken: `forbidden-${point}-${source}`, servicePointId: point, orderSource: source }), { code: "DELIVERY_FORBIDDEN" });
    }
    const discounted = await makeAttempt("discounted", { discount: { type: "percent", value: 10 } });
    await assert.rejects(checkout.createCheckout({ ...discounted, actorId: 11 }), { code: "DELIVERY_FORBIDDEN" });
    await assert.rejects(checkout.createCheckout({ ...discounted, actorId: null, sessionSubject: "service_point", servicePointId: 71, orderSource: "web" }), { code: "DELIVERY_FORBIDDEN" });
    await assert.rejects(checkout.createCheckout({ ...attempt, clientOrderToken: "missing-proof", deliveryQuoteToken: undefined }), { code: "CHECKOUT_REQUEST_INVALID" });
    console.log("PASS SQL POS/web-only origins, verified discount caller and guest account isolation");

    const concurrentAttempt = await makeAttempt("concurrent-checkout");
    const winners = await Promise.all([checkout.createCheckout(concurrentAttempt), checkout.createCheckout(concurrentAttempt)]);
    assert.equal(winners[0].orderId, winners[1].orderId);
    assert.equal(winners.filter(value => value.tracking_url).length, 1);
    assert.equal((await db.readRows("SELECT * FROM deliveries WHERE client_order_token = 'concurrent-checkout'")).length, 1);
    const changed = await makeAttempt("changed-settings");
    await db.pool.query("UPDATE shop_delivery_settings SET revision = 2 WHERE shopid = 7");
    await assert.rejects(checkout.createCheckout(changed), { code: "DELIVERY_QUOTE_CHANGED" });
    await db.pool.query("UPDATE shop_delivery_settings SET revision = 1 WHERE shopid = 7");
    await db.pool.query("UPDATE products SET price = 1.05 WHERE id = 21");
    await db.pool.query("UPDATE shop_delivery_settings SET free_delivery_enabled = 1, free_delivery_threshold_cents = 95 WHERE shopid = 7");
    const half = await checkout.createCheckout(await makeAttempt("half-cent", { discount: { type: "percent", value: 10 } }));
    assert.equal(half.total, 4.94);
    assert.equal(half.delivery.financials.items_discount, 0.11);
    assert.equal(half.delivery.financials.delivery_fee, 4);
    assert.equal(Number((await db.readRows("SELECT total FROM orderdetail WHERE orderid = ?", [half.orderId]))[0].total), 0.94);
    await db.pool.query("UPDATE products SET price = 20 WHERE id = 21");
    await db.pool.query("UPDATE shop_delivery_settings SET free_delivery_enabled = 0 WHERE shopid = 7");
    const fixed = await checkout.createCheckout(await makeAttempt("fixed-half-cent", { discount: { type: "amount", value: 1.005 } }));
    assert.equal(fixed.total, 22.99);
    assert.equal(fixed.delivery.financials.items_discount, 1.01);
    const pending = await checkout.createCheckout({ ...await makeAttempt("pending-stripe"), paymentMode: "stripe" });
    assert.equal(pending.delivery.acceptanceStatus, "payment_pending");
    assert.deepStrictEqual(pending.delivery.allowedActions, []);
    console.log("PASS SQL concurrent replay, settings reprice, 105c/10% half-up threshold and provisional payment");

    const { buildOrderEditingModule } = require("../src/modules/m_orderEditing");
    const editing = buildOrderEditingModule({ withTransaction: runInTransaction, deliveryQuotes: quotes, deliveryOrders, now: clock });
    const editable = await editing.getEditableOrder({ orderId: first.orderId, shopId: 7 });
    const editBase = {
      orderId: first.orderId, shopId: 7, operatorId: 10, contentRevision: editable.content_revision,
      items: attempt.items, expectedTotal: 20,
    };
    await assert.rejects(editing.amendOrder(editBase), { code: "DELIVERY_QUOTE_CHANGED" });
    const editAttempt = await makeAttempt("delivery-edit-1", { items: [{ productId: 21, quantity: 2, selectedChoiceIds: [] }], address: { ...address, street: "9 rue Test" }, discount: { type: "amount", value: 1 } });
    const edit = {
      ...editBase, items: editAttempt.items, expectedTotal: 43,
      deliveryQuoteToken: editAttempt.deliveryQuoteToken, addressResolutionToken: editAttempt.addressResolutionToken,
      discountType: "amount", discountValue: 1, deliveryExpectedVersion: 1, deliveryIdempotencyKey: "explicit-edit-1",
    };
    const amended = await editing.amendOrder(edit);
    assert.equal(amended.total, 43);
    const current = await deliveryOrders.resolveDeliveryOrder({ shopId: 7, deliveryId: first.delivery.id });
    assert.equal(current.delivery.version, 2);
    assert.equal(current.delivery.charge_revision, 2);
    assert.equal(current.delivery.settings_revision, 1);
    const currentAddress = typeof current.delivery.address_snapshot === "string" ? JSON.parse(current.delivery.address_snapshot) : current.delivery.address_snapshot;
    assert.equal(currentAddress.street, "9 rue Test");
    assert.equal(Number(current.order.subtotal), 43);
    assert.equal(Number(current.order.discount_amount), 1);
    assert.equal((await db.readRows("SELECT * FROM delivery_charge_snapshots WHERE delivery_id = ?", [first.delivery.id])).length, 2);
    const audit = await db.readRows("SELECT * FROM delivery_events WHERE delivery_id = ? ORDER BY version", [first.delivery.id]);
    const previous = typeof audit[1].previous_state === "string" ? JSON.parse(audit[1].previous_state) : audit[1].previous_state;
    assert.equal(previous.delivery.financials.grand_total, 24);
    assert.equal(previous.delivery.addressSnapshot.street, "7 rue Test");
    assert.equal((await db.readRows("SELECT tracking_token_hash FROM deliveries WHERE id = ?", [first.delivery.id]))[0].tracking_token_hash, hashTrackingToken(previousToken));
    assert.deepStrictEqual(await checkout.createCheckout(attempt), replay);
    const countsAfterEdit = await counts();
    const editReplay = await editing.amendOrder(edit);
    assert.equal(editReplay.idempotent_replay, true);
    assert.equal(editReplay.total, 43);
    assert.deepStrictEqual(await counts(), countsAfterEdit);
    await assert.rejects(editing.amendOrder({ ...edit, expectedTotal: 42 }), { code: "DELIVERY_IDEMPOTENCY_CONFLICT" });
    await db.pool.query("UPDATE orders SET payment_status = 'paid' WHERE id = ?", [first.orderId]);
    await assert.rejects(editing.amendOrder({ ...edit, deliveryIdempotencyKey: "paid-edit" }), { code: "DELIVERY_EDIT_NOT_ALLOWED" });
    await db.pool.query("UPDATE orders SET payment_status = 'unpaid' WHERE id = ?", [first.orderId]);
    await db.pool.query("UPDATE deliveries SET delivery_status = 'in_transit' WHERE id = ?", [first.delivery.id]);
    await assert.rejects(editing.amendOrder({ ...edit, deliveryIdempotencyKey: "picked-up-edit" }), { code: "DELIVERY_EDIT_NOT_ALLOWED" });
    console.log("PASS SQL explicit unpaid edit, immutable previous revision, edit replay/conflict, paid/picked-up refusal");

    const mysql = require("mysql2/promise");
    const url = new URL(process.env.DELIVERY_TEST_DATABASE_URL);
    const legacyPool = mysql.createPool({
      host: url.hostname, port: Number(url.port), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
      database: db.database, timezone: "Z", supportBigNumbers: false, connectionLimit: 2,
    });
    try {
      await db.pool.query("ALTER TABLE deliveries AUTO_INCREMENT = 9007199254740993");
      const legacyCheckout = buildCheckoutModule({ withTransaction: createTransactionRunner(legacyPool), deliveryQuotes: quotes, now: clock });
      const large = await legacyCheckout.createCheckout(await makeAttempt("large-id"));
      assert.equal(large.delivery.id, "9007199254740993");
      const connection = await legacyPool.getConnection();
      try {
        const resolved = await deliveryOrders.resolveDeliveryOrder({ shopId: 7, deliveryId: large.delivery.id, connection });
        assert.equal(resolved.delivery.id, "9007199254740993");
        assert.equal(resolved.order.delivery_id, "9007199254740993");
      } finally { connection.release(); }
    } finally { await legacyPool.end(); }
    console.log("PASS SQL production-style driver preserves BIGINT delivery IDs as strings");

    const { buildCheckoutController, normalizeCheckoutRequestBody } = require("../src/modules/m_checkout");
    const { normalizeAmendBody } = require("../src/controllers/c_orderEditing");
    const normalized = normalizeCheckoutRequestBody({
      fulfillment_type: "delivery", delivery_quote_token: "quote", address_resolution_token: "address",
      delivery_confirmation_secret: "secret", customer_account_id: "999", items: [],
    });
    assert.equal(normalized.fulfillmentType, "delivery");
    assert.equal(normalized.customerAccountId, undefined);
    assert.equal(normalizeAmendBody({ items: [], delivery_quote_token: "quote", delivery_expected_version: 2, delivery_idempotency_key: "edit", address_resolution_token: "address" }).deliveryExpectedVersion, 2);
    const logs = [];
    const controller = buildCheckoutController({
      checkout: { async createCheckout() { throw new Error("SQL private bell fixture and tracking secret"); } },
      getShopInfo: async () => [{ kitchen_closed: 0 }], logger: { error: (...args) => logs.push(args) },
    });
    const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await controller({ shopid: 7, id: 10, body: { fulfillment_type: "delivery" } }, res);
    assert.equal(res.statusCode, 500);
    assert(!JSON.stringify(logs).includes("private bell"));
    assert(!JSON.stringify(logs).includes("tracking secret"));
    console.log("PASS HTTP delivery request/explicit amendment mapping, account isolation and unexpected-error privacy");

    const reviewFailures = [];
    const reviewCase = async (name, work) => {
      try { await work(); console.log(`PASS ${name}`); }
      catch (error) { reviewFailures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
    };
    await reviewCase("SQL public caller cannot declare counter-paid delivery", async () => {
      await assert.rejects(checkout.createCheckout({ ...webAttempt, clientOrderToken: "public-counter-paid", paymentMode: "counter_pay_before:cash" }), { code: "DELIVERY_FORBIDDEN" });
    });
    await reviewCase("SQL delivery cannot enter kiosk terminal payment", async () => {
      await assert.rejects(checkout.createCheckout({ ...await makeAttempt("kiosk-terminal"), paymentMode: "stripe_terminal_kiosk" }), { code: "DELIVERY_FORBIDDEN" });
    });
    await reviewCase("SQL delivery repricing must settle an engaged payment first", async () => {
      const pendingEditable = await editing.getEditableOrder({ orderId: pending.orderId, shopId: 7 });
      const next = await makeAttempt("pending-edit-quote");
      await assert.rejects(editing.amendOrder({
        orderId: pending.orderId, shopId: 7, operatorId: 10, contentRevision: pendingEditable.content_revision,
        items: next.items, expectedTotal: 24, deliveryQuoteToken: next.deliveryQuoteToken,
        addressResolutionToken: next.addressResolutionToken, deliveryExpectedVersion: 1, deliveryIdempotencyKey: "pending-edit",
      }), { code: "DELIVERY_EDIT_NOT_ALLOWED" });
    });
    await reviewCase("SQL durable replay and key conflict survive commercial archive", async () => {
      // Fixture-only archival, not a Task4 archive implementation.
      const original = await makeAttempt("archive-replay");
      const accepted = await checkout.createCheckout(original);
      await db.pool.query(`INSERT INTO archives
        (shopid, ordernumber, customer, customerID, operator, subtotal, subtotal_before_discount,
         discount_type, discount_value, discount_amount, payment_status, payment_provider, status,
         created, finished, token, is_takeaway, fulfillment_type, order_source, delivery_id)
        SELECT shopid, ordernumber, customer, customerID, operator, subtotal, subtotal_before_discount,
         discount_type, discount_value, discount_amount, payment_status, payment_provider, status,
         created, finished, 'disposable-archive-fixture', is_takeaway, fulfillment_type, order_source, delivery_id
        FROM orders WHERE id = ?`, [accepted.orderId]);
      await db.pool.query("DELETE FROM order_stock_reservations WHERE order_id = ?", [accepted.orderId]);
      await db.pool.query("DELETE FROM orderdetail WHERE orderid = ?", [accepted.orderId]);
      await db.pool.query("DELETE FROM orders WHERE id = ?", [accepted.orderId]);
      const resolved = await deliveryOrders.resolveDeliveryOrder({ shopId: 7, deliveryId: accepted.delivery.id });
      assert.equal(resolved.orderKind, "archive");
      assert.equal(resolved.delivery.id, accepted.delivery.id);
      assert.equal((await checkout.createCheckout(original)).orderId, accepted.orderId);
      await assert.rejects(checkout.createCheckout({ ...original, fulfillmentType: "takeaway", isTakeaway: true, expectedTotal: 20 }), { code: "IDEMPOTENCY_KEY_REUSED" });
    });
    assert.deepStrictEqual(reviewFailures, [], "Self-review regressions must pass");
  });
  console.log("delivery checkout SQL tests passed");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
