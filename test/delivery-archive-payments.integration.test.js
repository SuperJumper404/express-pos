const assert = require("assert");
const { withDeliveryDatabase } = require("./helpers/deliveryDatabase");

const response = () => ({ status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });

async function main() {
  await withDeliveryDatabase(async db => {
    await db.seedScenario();
    require.cache[require.resolve("../src/config/dbPool")] = { exports: db.pool };
    require.cache[require.resolve("../src/config/db")] = { exports: db.pool.pool };
    let defaultStripeProvider;
    require.cache[require.resolve("../src/config/stripe")] = { exports: { getStripe: () => {
      if (!defaultStripeProvider) throw new Error("Unexpected provider boundary");
      return defaultStripeProvider;
    } } };
    if (Number(process.versions.node.split(".")[0]) < 22) {
      require.cache[require.resolve("nanoid")] = { exports: await import("nanoid") };
    }
    const { createTransactionRunner } = require("../src/helpers/withTransaction");
    const run = createTransactionRunner(db.pool);
    const waitForSqlWait = async threadId => {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const [rows] = await db.pool.query(`SELECT 1 FROM performance_schema.data_lock_waits w
          JOIN performance_schema.threads t ON t.THREAD_ID = w.REQUESTING_THREAD_ID
          WHERE t.PROCESSLIST_ID = ?`, [threadId]);
        if (rows.length) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.fail("Operation must reach an actual SQL lock wait");
    };
    const deliveryOrders = require("../src/modules/m_deliveryOrders");
    const orders = require("../src/modules/m_orders");
    const payments = require("../src/modules/m_payments");
    const controllers = require("../src/controllers/c_orders");
    const { buildRefundPaidOrderController, buildQrTablePaymentIntentController, buildTerminalOrderRefundService, buildStripeWebhookEventHandler, regenerateOrderPaymentIntent } = require("../src/controllers/c_stripe");
    const { transitionOrderStatus } = require("../src/modules/m_orderTransitions");
    const { buildStripeTerminalModule } = require("../src/modules/m_stripeTerminal");
    const { buildStripeTerminalPaymentService } = require("../src/services/stripeTerminalPayments");
    let nextId = 100;
    const make = async ({ status = 2, paymentStatus = "unpaid", stripe = false, discount = false, deliveryId } = {}) => {
      const id = nextId++;
      deliveryId = deliveryId || String(id);
      await db.pool.query(`INSERT INTO orders
        (id, shopid, ordernumber, customer, customerID, operator, subtotal, subtotal_before_discount,
         discount_type, discount_value, discount_amount, payment, payment_status, payment_provider,
         stripe_payment_intent_id, status, created, finished, is_takeaway)
        VALUES (?, 7, ?, 'Fixture', 10, 10, ?, 20, ?, ?, ?, 'Paiement au comptoir', ?, ?, ?, ?, NOW(), '2026-10-16 12:00:00', 1)`,
      [id, `TASK4-${id}`, discount ? 22 : 24, discount ? "amount" : "none", discount ? 2 : 0,
        discount ? 2 : 0, paymentStatus, stripe ? "stripe" : null, stripe ? `pi_task4_${id}` : null, status]);
      await db.pool.query(`INSERT INTO deliveries
        (id, shopid, origin_order_id, order_reference, courier_id, delivery_status, address_snapshot,
         contact_snapshot, latitude, longitude, distance_meters, settings_revision, client_order_token,
         confirmation_secret_hash, tracking_token_hash, tracking_expires_at)
        SELECT ?, 7, ?, ?, 11, 'assigned', address_snapshot, contact_snapshot, latitude, longitude,
          distance_meters, 1, ?, SHA2(?,256), SHA2(?,256), tracking_expires_at FROM deliveries WHERE id = 41`,
      [deliveryId, id, `TASK4-${id}`, `task4-${id}`, `confirmation-${id}`, `tracking-${id}`]);
      await db.pool.query("UPDATE orders SET delivery_id = ?, fulfillment_type = 'delivery' WHERE id = ?", [deliveryId, id]);
      await db.pool.query(`INSERT INTO delivery_charge_snapshots
        (shopid, delivery_id, revision, band_fee_cents, free_delivery_applied, fee_cents,
         total_excl_tax_cents, tax_cents, vat_rate, fiscal_policy)
        VALUES (7, ?, 1, 400, 0, 400, 364, 36, 10, '{"mode":"configured_rate","vatRate":10}')`, [deliveryId]);
      await db.pool.query(`INSERT INTO orderdetail
        (orderid, productid, qty, price, total, vat_rate, unit_price_ht, unit_vat, total_ht, total_vat)
        VALUES (?, 21, 1, 20, ?, 5.5, 18.96, 1.04, ?, ?)`, [id, discount ? 18 : 20, discount ? 17.06 : 18.96, discount ? 0.94 : 1.04]);
      await db.pool.query(`INSERT INTO orderdetail_customization_snapshots
        (orderdetail_id, step_name, step_position, choice_type, choice_name, choice_position, unit_extra_price, created)
        SELECT id, 'Fixture step', 1, 'simple', 'Accepted choice', 1, 0, NOW() FROM orderdetail WHERE orderid = ?`, [id]);
      await db.pool.query(`INSERT INTO order_stock_reservations (order_id, product_id, quantity, status, created)
        VALUES (?, 21, 1, ?, NOW())`, [id, stripe ? "reserved" : "committed"]);
      if (stripe) await db.pool.query(`INSERT INTO payments
        (order_id, shop_id, stripe_payment_intent_id, stripe_charge_id, amount, amount_cents,
         application_fee_amount, currency, status, created)
        VALUES (?, 7, ?, ?, 24, 2400, 0, 'eur', ?, NOW())`,
      [id, `pi_task4_${id}`, `ch_task4_${id}`, paymentStatus === "paid" ? "succeeded" : "requires_payment_method"]);
      return { id, deliveryId, intent: { id: `pi_task4_${id}`, latest_charge: `ch_task4_${id}`, payment_method_types: ["card"] } };
    };
    const view = async item => deliveryOrders.toDeliveryView(await deliveryOrders.resolveDeliveryOrder({ shopId: 7, deliveryId: item.deliveryId }));
    const originalDetail = async id => (await db.readRows("SELECT total, vat_rate, unit_price_ht, unit_vat, total_ht, total_vat FROM orderdetail WHERE orderid = ?", [id]))[0];
    const failures = [];
    const test = async (name, work) => {
      if (process.env.TASK4_TEST_FILTER && !process.env.TASK4_TEST_FILTER.split("|").some(part => name.includes(part))) return;
      try { await work(); console.log(`PASS SQL ${name}`); }
      catch (error) { failures.push(name); console.log(`FAIL SQL ${name}: ${error.code || error.name}`); }
    };

    await test("frozen checkout replay cannot start another Stripe payment after paid or archive", async () => {
      const item = await make({ status: 3, paymentStatus: "paid", stripe: true });
      const accepted = { orderId: item.id, total: 24, payment_status: "requires_payment", delivery: { id: item.deliveryId, paymentStatus: "requires_payment" } };
      await db.pool.query(`INSERT INTO delivery_events (shopid, delivery_id, version, event_type, actor_subject,
        actor_id, previous_state, next_state, idempotency_key, request_hash, result)
        VALUES (7, ?, 1, 'checkout_created', 'staff', '10', '{}', '{}', ?, REPEAT('c',64), ?)`, [item.deliveryId, `checkout-task4-${item.id}`, JSON.stringify(accepted)]);
      const replay = () => deliveryOrders.findCheckoutReplay({ shopId: 7, token: `task4-${item.id}`, requestHash: "c".repeat(64) });
      let calls = 0;
      const controller = buildQrTablePaymentIntentController({
        createCheckout: replay,
        getShopInfo: async () => [{ id: 7, qr_payment_mode: "stripe", stripe_account_id: "acct_fixture", stripe_charges_enabled: 1 }],
        isStripePaymentAllowed: () => true,
        getStripe: () => ({ paymentIntents: {
          create: async () => { calls++; return { id: "pi_forbidden", status: "requires_payment_method" }; },
          cancel: async () => ({ status: "canceled" }),
        } }), logger: { error() {} },
      });
      for (const archived of [false, true]) {
        if (archived) await orders.mArchiveOrder(item.id, undefined, 7);
        const res = response();
        await controller({ shopid: 7, id: 10, body: { client_order_token: `task4-${item.id}` } }, res);
        assert.equal(res.code, 409);
        assert.equal(calls, 0, "Authoritative settled order must be checked before provider creation");
        assert.deepStrictEqual(await replay(), { ...accepted, idempotent_replay: true });
      }
    });

    await test("stale delivery replacement cannot adopt a newer accepted payment attempt", async () => {
      const item = await make({ status: 1, stripe: true });
      await db.pool.query("UPDATE orders SET stripe_payment_intent_id = NULL, stripe_replacement_attempt_token = 'current-attempt' WHERE id = ?", [item.id]);
      const [current] = await db.readRows("SELECT orders.*, CAST(delivery_id AS CHAR) AS delivery_id FROM orders WHERE id = ?", [item.id]);
      await db.pool.query("UPDATE shop SET stripe_account_id = 'acct_fixture', stripe_charges_enabled = 1, stripe_commission_percent = 0 WHERE id = 7");
      let calls = 0;
      defaultStripeProvider = { paymentIntents: {
          create: async params => { calls++; return { ...params, id: "pi_stale_replacement", client_secret: "fixture-client-secret", status: "requires_payment_method" }; },
          cancel: async () => ({ status: "canceled" }),
        } };
      // Task3's immediate post-amendment producer intentionally passes this bare shape.
      const bare = { ...current };
      delete bare.delivery_id;
      await assert.rejects(regenerateOrderPaymentIntent({ order: { ...bare, stripe_replacement_attempt_token: "older-attempt" }, contentRevision: "older-content" }), { code: "ORDER_EDIT_CONFLICT" });
      assert.equal(calls, 0);
      assert.equal((await db.readRows("SELECT stripe_payment_intent_id FROM orders WHERE id = ?", [item.id]))[0].stripe_payment_intent_id, null);
      const result = await regenerateOrderPaymentIntent({ order: bare, contentRevision: "current-content" });
      assert.equal(result.paymentIntentId, "pi_stale_replacement");
      assert.equal(calls, 1);
      await payments.markPaymentSucceeded({ id: result.paymentIntentId, payment_method_types: ["card"] });
      for (const archived of [false, true]) {
        if (archived) {
          await db.pool.query("UPDATE orders SET status = 3 WHERE id = ?", [item.id]);
          await orders.mArchiveOrder(item.id, undefined, 7);
        }
        await assert.rejects(regenerateOrderPaymentIntent({ order: bare, contentRevision: "current-content" }), { code: "DELIVERY_PAYMENT_NOT_SETTLED" });
        assert.equal(calls, 1);
      }
    });

    await test("paidDoesNotFinishKitchenAndArchiveDoesNotFinishDelivery", async () => {
      const item = await make({ paymentStatus: "requires_payment", stripe: true });
      const before = await originalDetail(item.id);
      await payments.markPaymentSucceeded(item.intent);
      assert.equal((await view(item)).preparationStatus, 2);
      await assert.rejects(orders.mArchiveOrder(item.id, undefined, 7), { code: "DELIVERY_PREPARATION_NOT_FINISHED" });
      assert.equal((await db.readRows("SELECT id FROM orders WHERE id = ?", [item.id])).length, 1);
      await transitionOrderStatus({ orderId: item.id, shopId: 7, nextStatus: 3, operator: 10 });
      await orders.mArchiveOrder(item.id, undefined, 7);
      assert.equal((await db.readRows("SELECT id FROM orders WHERE id = ?", [item.id])).length, 0);
      const resolved = await deliveryOrders.resolveDeliveryOrder({ shopId: 7, deliveryId: item.deliveryId });
      assert.equal(resolved.orderKind, "archive");
      const after = await view(item);
      assert.equal(after.deliveryStatus, "assigned");
      assert.equal(after.courierId, 11);
      assert.equal(after.preparationStatus, 3);
      assert.equal(after.remainingDueCents, 0);
      assert.equal(after.financials.grand_total, 24);
      assert.equal(after.financials.delivery_charge.taxCents, 36);
      const [archived] = await db.readRows("SELECT id FROM archives WHERE delivery_id = ?", [item.deliveryId]);
      assert.notEqual(archived.id, item.id);
      assert.deepStrictEqual((await db.readRows("SELECT total, vat_rate, unit_price_ht, unit_vat, total_ht, total_vat FROM archivesdetail WHERE orderId = ?", [archived.id]))[0], before);
      assert.equal((await db.readRows(`SELECT s.choice_name FROM archivesdetail_customization_snapshots s
        JOIN archivesdetail d ON d.id = s.archivesdetail_id WHERE d.orderId = ?`, [archived.id]))[0].choice_name, "Accepted choice");
      const stock = await db.readRows("SELECT stock FROM products WHERE id = 21");
      const journals = await db.readRows("SELECT id FROM stocks WHERE productid = 21");
      const webhook = buildStripeWebhookEventHandler({ getStripe: () => ({ charges: { retrieve: async () => ({ id: item.intent.latest_charge }) } }) });
      assert.equal((await webhook({ type: "payment_intent.succeeded", data: { object: { ...item.intent, status: "succeeded" } } })).alreadyPaid, true);
      assert.deepStrictEqual(await db.readRows("SELECT stock FROM products WHERE id = 21"), stock);
      assert.deepStrictEqual(await db.readRows("SELECT id FROM stocks WHERE productid = 21"), journals);
      assert.equal((await db.readRows("SELECT id FROM payments WHERE order_id = ?", [item.id])).length, 1);
      let refundAmountCents;
      const refundRows = [];
      const refund = buildRefundPaidOrderController({ getStripe: () => ({
        paymentIntents: { retrieve: async () => ({ ...item.intent, status: "succeeded" }) },
        refunds: {
          list: async () => ({ data: refundRows, has_more: false }),
          create: async input => { refundAmountCents = input.amount; const result = { id: `re_${item.id}`, ...input, status: "succeeded", currency: "eur", charge: item.intent.latest_charge }; refundRows.push(result); return result; },
        },
      }) });
      const res = response();
      await refund({ params: { id: String(item.id) }, shopid: 7, id: 10 }, res);
      assert.equal(res.code, 200);
      assert.equal(refundAmountCents, 2400);
      assert.equal((await view(item)).paymentStatus, "refunded");
      assert.equal((await view(item)).preparationStatus, 3);
      assert.equal((await view(item)).deliveryStatus, "assigned");
      assert.equal((await orders.mAllArchivedOrders(7)).find(row => row.delivery_id === item.deliveryId).originalorderID, item.id);
      assert.equal((await orders.mDetailArchivedOrder(archived.id))[0].payment_order_id, item.id);
      assert.deepStrictEqual(await payments.getPaidOrderForRefund(item.id, 8), []);
      assert.equal((await payments.getPaidOrderForRefund(item.id, 7))[0].id, item.id);
    });

    await test("delivery archive rollback restores active rows and durable preparation snapshot", async () => {
      const item = await make({ status: 3, paymentStatus: "paid" });
      const before = await originalDetail(item.id);
      const archive = orders.buildOrderArchiveModule({ withTransaction: work => run(connection => work(new Proxy(connection, { get(target, key) {
        if (key === "query") return async (...args) => {
          const result = await target.query(...args);
          if (/DELETE FROM orders WHERE/.test(args[0])) throw new Error("Injected after active deletion");
          return result;
        };
        const value = target[key];
        return typeof value === "function" ? value.bind(target) : value;
      } }))) });
      await assert.rejects(archive.mArchiveOrder(item.id, undefined, 7), /Injected after active deletion/);
      assert.deepStrictEqual(await originalDetail(item.id), before);
      assert.equal((await db.readRows("SELECT preparation_status FROM deliveries WHERE id = ?", [item.deliveryId]))[0].preparation_status, 1);
      assert.equal((await db.readRows("SELECT id FROM archives WHERE delivery_id = ?", [item.deliveryId])).length, 0);
      assert.equal((await db.readRows(`SELECT s.id FROM orderdetail_customization_snapshots s
        JOIN orderdetail d ON d.id = s.orderdetail_id WHERE d.orderid = ?`, [item.id])).length, 1);
    });

    await test("legacy driver preserves exact BIGINT dossier through production archive", async () => {
      const mysql = require("mysql2/promise");
      const config = db.pool.pool.config.connectionConfig;
      const legacyPool = mysql.createPool({ host: config.host, port: config.port, user: config.user,
        password: config.password, database: db.database, timezone: "Z", supportBigNumbers: false });
      try {
        const item = await make({ status: 3, paymentStatus: "paid", deliveryId: "9007199254740993" });
        const archive = orders.buildOrderArchiveModule({ withTransaction: createTransactionRunner(legacyPool) });
        await archive.mArchiveOrder(item.id, undefined, 7);
        const resolved = await deliveryOrders.resolveDeliveryOrder({ shopId: 7, deliveryId: item.deliveryId, connection: legacyPool });
        assert.equal(resolved.delivery.id, "9007199254740993");
        assert.equal(resolved.order.delivery_id, "9007199254740993");
        assert.equal(resolved.orderKind, "archive");
        assert.equal((await orders.mAllArchivedOrders(7)).find(row => row.originalorderID === item.id).delivery_id, "9007199254740993");
      } finally { await legacyPool.end(); }
    });

    await test("kitchen archive cannot collect and cashier preserves accepted discount", async () => {
      const unpaid = await make({ status: 3, discount: true });
      await assert.rejects(orders.mArchiveOrder(unpaid.id, undefined, 7), { code: "DELIVERY_PAYMENT_NOT_SETTLED" });
      await assert.rejects(orders.mArchiveOrder(unpaid.id, "Especes", 7, { discountType: "amount", discountValue: 1 }), { code: "DELIVERY_REQUOTE_REQUIRED" });
      const before = await originalDetail(unpaid.id);
      await orders.mArchiveOrder(unpaid.id, "Especes", 7, { discountType: "none", discountValue: 0 }, 10);
      const after = await view(unpaid);
      assert.equal(after.paymentStatus, "paid");
      assert.equal(after.financials.items_discount, 2);
      assert.equal(after.financials.grand_total, 22);
      const [archive] = await db.readRows("SELECT id FROM archives WHERE delivery_id = ?", [unpaid.deliveryId]);
      assert.deepStrictEqual((await db.readRows("SELECT total, vat_rate, unit_price_ht, unit_vat, total_ht, total_vat FROM archivesdetail WHERE orderId = ?", [archive.id]))[0], before);
      const pending = await make({ status: 3, paymentStatus: "requires_payment", stripe: true });
      await assert.rejects(orders.mArchiveOrder(pending.id, "Especes", 7), { code: "DELIVERY_PAYMENT_NOT_SETTLED" });
      const [beforeFallback] = await db.readRows("SELECT finished FROM orders WHERE id = ?", [pending.id]);
      await payments.markStripeOrderPayAtCounter(pending.id, 7, pending.intent.id);
      assert.equal((await view(pending)).preparationStatus, 3);
      assert.equal((await db.readRows("SELECT finished FROM orders WHERE id = ?", [pending.id]))[0].finished.getTime(), beforeFallback.finished.getTime());
    });

    await test("manual delivery collection refuses duplicate pending Stripe and inline discounts", async () => {
      const item = await make({ discount: true });
      const [cashier] = await db.readRows("SELECT id, shopid, access, status FROM users WHERE id = 10 AND shopid = 7");
      const request = (id, extra = {}) => ({ params: { id: String(id) }, shopid: 7,
        sessionSubject: "staff", id: cashier.id, access: cashier.access, currentUser: cashier,
        body: { payment_method: "Especes", ...extra } });
      const rejected = response();
      await controllers.collectOrderPayment(request(item.id, { discount_type: "amount", discount_value: 1 }), rejected);
      assert.equal(rejected.code, 409);
      assert.equal(rejected.body.data.code, "DELIVERY_REQUOTE_REQUIRED");
      const results = await Promise.all([1, 2].map(async () => { const res = response(); await controllers.collectOrderPayment(request(item.id), res); return res; }));
      assert.deepStrictEqual(results.map(r => r.code).sort(), [200, 409]);
      assert.equal((await view(item)).financials.grand_total, 22);
      assert.equal((await view(item)).preparationStatus, 2);
      const pending = await make({ paymentStatus: "requires_payment", stripe: true });
      const res = response();
      await controllers.collectOrderPayment(request(pending.id), res);
      assert.equal(res.code, 409);
      assert.equal((await view(pending)).paymentStatus, "requires_payment");
      const [success, refused] = await Promise.all([
        payments.markPaymentSucceeded(pending.intent),
        orders.collectDeliveryOrderPayment({ orderId: pending.id, shopId: 7, paymentMethod: "Especes" }).then(() => null, error => error.code),
      ]);
      assert.equal(success.paid, true);
      assert.equal(refused, "DELIVERY_PAYMENT_NOT_SETTLED");
      assert.equal((await db.readRows("SELECT payment_provider FROM orders WHERE id = ?", [pending.id]))[0].payment_provider, "stripe");
    });

    await test("standalone resolver and commercial-first mutation have no SQL lock cycle", async () => {
      const item = await make();
      const a = await db.pool.getConnection();
      const b = await db.pool.getConnection();
      let resolving;
      try {
        await a.beginTransaction(); await b.beginTransaction();
        await a.query("SET innodb_lock_wait_timeout = 5"); await b.query("SET innodb_lock_wait_timeout = 5");
        await a.query("SELECT id FROM orders WHERE id = ? FOR UPDATE", [item.id]);
        resolving = deliveryOrders.resolveDeliveryOrder({ shopId: 7, deliveryId: item.deliveryId, connection: b, forUpdate: true });
        resolving.catch(() => {});
        await waitForSqlWait(b.threadId);
        await a.query(`INSERT INTO delivery_charge_snapshots
          (shopid, delivery_id, revision, band_fee_cents, free_delivery_applied, fee_cents,
           total_excl_tax_cents, tax_cents, vat_rate, fiscal_policy)
          SELECT shopid, delivery_id, 2, 300, 0, 300, 273, 27, vat_rate, fiscal_policy
          FROM delivery_charge_snapshots WHERE delivery_id = ? AND revision = 1`, [item.deliveryId]);
        await a.query("UPDATE orders SET subtotal = 23 WHERE id = ?", [item.id]);
        await a.query("UPDATE deliveries SET version = version + 1, charge_revision = 2 WHERE id = ?", [item.deliveryId]);
        await a.commit();
        const resolved = await resolving;
        assert.equal(resolved.delivery.version, 2);
        assert.equal(resolved.delivery.charge.feeCents, 300);
        assert.equal(deliveryOrders.toDeliveryView(resolved).financials.grand_total, 23);
        await b.commit();
      } finally {
        await a.rollback();
        if (resolving) await resolving.catch(() => {});
        await b.rollback();
        a.release(); b.release();
      }
    });

    await test("actual amendment and archive serialize with standalone dossier resolution", async () => {
      const { buildOrderEditingModule } = require("../src/modules/m_orderEditing");
      for (const archive of [false, true]) {
        const item = await make(archive ? { status: 3, paymentStatus: "paid" } : {});
        let announce, release;
        const locked = new Promise(resolve => { announce = resolve; });
        const gate = new Promise(resolve => { release = resolve; });
        let paused = false;
        const pausedRun = work => run(connection => work(new Proxy(connection, { get(target, key) {
          if (key === "query") return async (...args) => {
            const result = await target.query(...args);
            if (!paused && /FROM orders/.test(args[0]) && /FOR UPDATE/.test(args[0])) {
              paused = true; announce(); await gate;
            }
            return result;
          };
          const value = target[key];
          return typeof value === "function" ? value.bind(target) : value;
        } })));
        const mutation = (archive
          ? orders.buildOrderArchiveModule({ withTransaction: pausedRun }).mArchiveOrder(item.id, undefined, 7)
          : buildOrderEditingModule({ withTransaction: pausedRun }).amendOrder({ orderId: item.id, shopId: 7,
            operatorId: 10, contentRevision: "lock-characterization", items: [], expectedTotal: 0 }))
          .then(result => ({ result }), error => ({ error }));
        const connection = await db.pool.getConnection();
        let resolving;
        try {
          await Promise.race([locked, mutation.then(() => assert.fail("Mutation must reach its actual commercial lock"))]);
          await connection.beginTransaction();
          await connection.query("SET innodb_lock_wait_timeout = 5");
          resolving = deliveryOrders.resolveDeliveryOrder({ shopId: 7, deliveryId: item.deliveryId, connection, forUpdate: true });
          resolving.catch(() => {});
          await waitForSqlWait(connection.threadId);
          release();
          const completed = await mutation;
          if (archive) assert.equal(completed.error, undefined);
          else assert.equal(completed.error && completed.error.code, "DELIVERY_EDIT_NOT_ALLOWED");
          const resolved = await resolving;
          assert.equal(resolved.orderKind, archive ? "archive" : "active");
          assert.equal(resolved.delivery.delivery_status, "assigned");
          assert.equal(deliveryOrders.toDeliveryView(resolved).preparationStatus, archive ? 3 : 2);
          await connection.commit();
        } finally {
          release(); await mutation;
          if (resolving) await resolving.catch(() => {});
          await connection.rollback(); connection.release();
        }
      }
    });

    // Real module/store, with only the remote provider replaced.
    await db.pool.query(`INSERT INTO stripe_terminal_locations (id, shopid, stripe_location_id, display_name, address_line1, postal_code, city)
      VALUES (1, 7, 'tml_task4', 'Fixture', 'Fixture', '75001', 'Paris')`);
    await db.pool.query(`INSERT INTO stripe_terminal_readers (id, shopid, terminal_location_id, stripe_reader_id, label, status, assigned_user_id)
      VALUES (1, 7, 1, 'tmr_task4', 'Fixture', 'online', 10)`);
    const store = buildStripeTerminalModule({ connection: db.pool });
    store.withTransaction = work => run(connection => work(buildStripeTerminalModule({ connection })));
    const intents = new Map();
    let providerCalls = 0;
    const stripe = {
      paymentIntents: {
        create: async params => { providerCalls++; const intent = { ...params, id: `pi_terminal_${intents.size}`, status: "requires_payment_method" }; intents.set(intent.id, intent); return intent; },
        retrieve: async id => intents.get(id),
      },
      terminal: { readers: { retrieve: async () => ({ status: "online" }), processPaymentIntent: async () => ({}) } },
    };
    const terminal = buildStripeTerminalPaymentService({ stripe, terminalStore: store, shopStore: { findShop: async () => ({ id: 7, stripe_account_id: "acct_fixture", stripe_charges_enabled: 1, stripe_commission_percent: 0 }) } });
    await test("mixed Terminal selection rejects new discount before provider and allocation", async () => {
      const item = await make({ status: 3 });
      await db.pool.query("UPDATE orders SET status = 3, subtotal = 10, payment_status = 'unpaid' WHERE id = 33");
      const calls = providerCalls;
      await assert.rejects(terminal.startPayment({ shopId: 7, cashierUserId: 10, orderIds: [33, item.id], discountType: "percent", discountValue: 10 }), { code: "DELIVERY_REQUOTE_REQUIRED" });
      assert.equal(providerCalls, calls);
      assert.equal((await db.readRows("SELECT * FROM stripe_terminal_payment_orders WHERE order_id = ?", [item.id])).length, 0);
    });
    await test("pending Terminal allocation blocks cashier archive and manual collection", async () => {
      await db.pool.query("UPDATE stripe_terminal_payments SET status = 'canceled' WHERE status IN ('creating','processing')");
      const item = await make({ status: 3 });
      await run(async connection => {
        const current = buildStripeTerminalModule({ connection });
        const session = await current.createPaymentSession({ shopId: 7, readerId: 1, cashierUserId: 10,
          idempotencyKey: `pending-${item.id}`, connectedAccountId: "acct_fixture", amountCents: 2400, applicationFeeAmount: 0 });
        await current.createAllocations({ shopId: 7, paymentId: session.insertId, allocations: [{ orderId: item.id, amountCents: 2400 }] });
      });
      await assert.rejects(orders.mArchiveOrder(item.id, "Especes", 7), { code: "DELIVERY_PAYMENT_NOT_SETTLED" });
      await assert.rejects(orders.collectDeliveryOrderPayment({ orderId: item.id, shopId: 7, paymentMethod: "Especes" }), { code: "DELIVERY_PAYMENT_NOT_SETTLED" });
      assert.equal((await view(item)).paymentStatus, "unpaid");
      assert.equal((await db.readRows("SELECT id FROM archives WHERE delivery_id = ?", [item.deliveryId])).length, 0);
    });
    await test("actual grouped Terminal finalization start and archive have no SQL lock cycle", async () => {
      await db.pool.query("UPDATE stripe_terminal_payments SET status = 'canceled' WHERE status IN ('creating','processing')");
      const first = await make({ status: 3 });
      const second = await make({ status: 3 });
      const session = await run(async connection => {
        const current = buildStripeTerminalModule({ connection });
        await current.lockReaderAndOrders({ shopId: 7, userId: 10, orderIds: [second.id, first.id] });
        const saved = await current.createPaymentSession({ shopId: 7, readerId: 1, cashierUserId: 10,
          idempotencyKey: `group-race-${first.id}`, connectedAccountId: "acct_fixture", amountCents: 4800, applicationFeeAmount: 0 });
        await current.createAllocations({ shopId: 7, paymentId: saved.insertId,
          allocations: [first, second].map(item => ({ orderId: item.id, amountCents: 2400 })) });
        await current.updatePaymentSession({ shopId: 7, paymentId: saved.insertId, status: "processing", stripePaymentIntentId: `pi_race_${first.id}` });
        return saved.insertId;
      });
      let announce, release;
      const locked = new Promise(resolve => { announce = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      let paused = false;
      const finalizing = run(connection => buildStripeTerminalModule({ connection: new Proxy(connection, { get(target, key) {
        if (key === "query") return async (...args) => {
          const result = await target.query(...args);
          if (!paused && /FROM orders o/.test(args[0]) && /FOR UPDATE/.test(args[0])) { paused = true; announce(); await gate; }
          return result;
        };
        const value = target[key];
        return typeof value === "function" ? value.bind(target) : value;
      } }) }).finalizePaymentSucceeded({ shopId: 7, paymentId: session, stripePaymentIntentId: `pi_race_${first.id}`, timestamp: new Date() }))
        .then(result => ({ result }), error => ({ error }));
      const contender = await db.pool.getConnection();
      let starting, archiving;
      try {
        await Promise.race([locked, finalizing.then(() => assert.fail("Finalization must reach its actual order locks"))]);
        await contender.beginTransaction(); await contender.query("SET innodb_lock_wait_timeout = 5");
        starting = buildStripeTerminalModule({ connection: contender }).lockReaderAndOrders({ shopId: 7, userId: 10, orderIds: [second.id, first.id] })
          .then(result => ({ result }), error => ({ error }));
        await waitForSqlWait(contender.threadId);
        archiving = orders.mArchiveOrder(first.id, undefined, 7).then(result => ({ result }), error => ({ error }));
        release();
        assert.equal((await finalizing).error, undefined);
        assert.equal((await starting).error.message, "Invalid Terminal order selection");
        await contender.rollback();
        assert.equal((await archiving).error, undefined);
        assert.equal((await view(first)).paymentStatus, "paid");
        assert.equal((await view(second)).paymentStatus, "paid");
      } finally {
        release(); await finalizing;
        if (starting) await starting;
        await contender.rollback(); contender.release();
        if (archiving) await archiving;
      }
    });
    await test("Terminal settles full accepted fee and archive preserves product VAT", async () => {
      // A failed RED must not leave a processing reader session for this case.
      await db.pool.query("UPDATE stripe_terminal_payments SET status = 'canceled' WHERE status IN ('creating','processing')");
      const item = await make({ status: 3 });
      const before = await originalDetail(item.id);
      const [beforeCollection] = await db.readRows("SELECT finished FROM orders WHERE id = ?", [item.id]);
      await db.pool.query("UPDATE orders SET status = 3, subtotal = 10, payment_status = 'unpaid', payment_provider = NULL, stripe_terminal_payment_id = NULL WHERE id = 33");
      const started = await terminal.startPayment({ shopId: 7, cashierUserId: 10, orderIds: [item.id, 33] });
      assert.equal(started.amountCents, 3400);
      const [allocation] = await db.readRows("SELECT amount_cents FROM stripe_terminal_payment_orders WHERE order_id = ?", [item.id]);
      assert.equal(allocation.amount_cents, 2400);
      const [session] = await db.readRows("SELECT * FROM stripe_terminal_payments WHERE id = ?", [started.id]);
      intents.get(session.stripe_payment_intent_id).status = "succeeded";
      await terminal.getPaymentStatus({ shopId: 7, cashierUserId: 10, paymentId: started.id });
      assert.equal((await db.readRows("SELECT finished FROM orders WHERE id = ?", [item.id]))[0].finished.getTime(), beforeCollection.finished.getTime());
      const calls = providerCalls;
      await assert.rejects(terminal.startPayment({ shopId: 7, cashierUserId: 10, orderIds: [item.id] }), { code: "TERMINAL_INVALID_ORDERS" });
      await assert.rejects(orders.collectDeliveryOrderPayment({ orderId: item.id, shopId: 7, paymentMethod: "Especes" }), { code: "DELIVERY_PAYMENT_NOT_SETTLED" });
      assert.equal(providerCalls, calls);
      await orders.mArchiveOrder(item.id, undefined, 7);
      await assert.rejects(terminal.startPayment({ shopId: 7, cashierUserId: 10, orderIds: [item.id] }), { code: "TERMINAL_INVALID_ORDERS" });
      assert.equal(providerCalls, calls);
      assert.equal((await view(item)).financials.grand_total, 24);
      const [archive] = await db.readRows("SELECT id FROM archives WHERE delivery_id = ?", [item.deliveryId]);
      assert.deepStrictEqual((await db.readRows("SELECT total, vat_rate, unit_price_ht, unit_vat, total_ht, total_vat FROM archivesdetail WHERE orderId = ?", [archive.id]))[0], before);
      let refundAmount;
      const refundService = buildTerminalOrderRefundService({ terminalStore: store, getStripe: () => ({
        paymentIntents: { retrieve: async () => ({ ...intents.get(session.stripe_payment_intent_id), on_behalf_of: "acct_fixture", transfer_data: { destination: "acct_fixture" } }) },
        refunds: { list: async () => ({ data: [], has_more: false }), create: async input => { refundAmount = input.amount; return { ...input, id: `re_terminal_${item.id}`, status: "succeeded", currency: "eur" }; } },
      }) });
      assert.equal((await refundService.refundTerminalOrder({ shopId: 7, orderId: item.id, actorId: 10 })).refundStatus, "succeeded");
      assert.equal(refundAmount, 2400);
      assert.equal((await view(item)).paymentStatus, "refunded");
      assert.equal((await view(item)).preparationStatus, 3);
      const { buildStripeTerminalWebhookHandler } = require("../src/services/stripeTerminalWebhooks");
      const duplicate = await buildStripeTerminalWebhookHandler({ terminalStore: store })({
        type: "payment_intent.succeeded", created: Math.floor(Date.now() / 1000),
        data: { object: intents.get(session.stripe_payment_intent_id) },
      });
      assert.equal(duplicate.finalized, false);
      assert.equal((await view(item)).paymentStatus, "refunded");
    });
    assert.deepStrictEqual(failures, [], "Delivery settlement/archive regressions must pass");
  });
  console.log("delivery archive/payment SQL tests passed");
}

main().catch(error => { console.error(error.code || error.name, error instanceof assert.AssertionError ? error.message : "Disposable SQL test failed"); process.exitCode = 1; });
