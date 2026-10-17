const assert = require("assert");
const express = require("express");
const jwt = require("jsonwebtoken");
const mysql = require("mysql2/promise");
const { withDeliveryDatabase } = require("./helpers/deliveryDatabase");

async function main() {
  await withDeliveryDatabase(async db => {
    await db.seedScenario();
    // Exercise the application's actual BIGINT defaults, using only the disposable DB.
    const configured = db.pool.pool.config.connectionConfig;
    const appPool = mysql.createPool({ host: configured.host, port: configured.port, user: configured.user,
      password: configured.password, database: db.database, charset: "utf8mb4", timezone: "Z", connectionLimit: 8 });
    try {
      require.cache[require.resolve("../src/config/dbPool")] = { exports: appPool };
      require.cache[require.resolve("../src/config/db")] = { exports: appPool.pool };
      require.cache[require.resolve("../src/config/stripe")] = { exports: { getStripe() { throw new Error("Unexpected provider call"); } } };
      if (Number(process.versions.node.split(".")[0]) < 22) require.cache[require.resolve("nanoid")] = { exports: await import("nanoid") };
      const { buildCourierRouter } = require("../src/routers/r_courier");
      const app = express();
      app.use(express.json());
      app.use(buildCourierRouter());
      const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
      const url = `http://127.0.0.1:${server.address().port}`;
      const token = (id = 11, shopid = 7, access = 6) => jwt.sign({ id, shopid, access }, process.env.JWTKEY);
      const request = async (deliveryId, body, bearer = token()) => {
        const response = await fetch(`${url}/courier/deliveries/${deliveryId}/collect-payment`, {
          method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` }, body: JSON.stringify(body),
        });
        const payload = await response.text();
        return { status: response.status, body: response.headers.get("content-type").includes("application/json") ? JSON.parse(payload) : payload,
          cache: response.headers.get("cache-control") };
      };
      let next = 100;
      const make = async ({ courierId = 11, shopId = 7, deliveryId, status = 3, paymentStatus = "unpaid", state = "in_transit" } = {}) => {
        const id = next++;
        deliveryId = deliveryId || String(id);
        await db.pool.query(`INSERT INTO orders (id,shopid,ordernumber,customer,customerID,operator,subtotal,
          subtotal_before_discount,discount_amount,payment,payment_status,status,created,finished,is_takeaway)
          VALUES (?,?,?,'Fixture',10,10,24,20,0,'Paiement au comptoir',?,?,NOW(),NOW(),1)`, [id, shopId, `TASK6-${id}`, paymentStatus, status]);
        await db.pool.query(`INSERT INTO deliveries (id,shopid,origin_order_id,order_reference,courier_id,delivery_status,
          address_snapshot,contact_snapshot,latitude,longitude,distance_meters,settings_revision,client_order_token,
          confirmation_secret_hash,tracking_token_hash,tracking_expires_at)
          SELECT ?,?,?,?,?, ?,address_snapshot,contact_snapshot,latitude,longitude,distance_meters,1,?,
          SHA2(?,256),SHA2(?,256),tracking_expires_at FROM deliveries WHERE id = 41`,
        [deliveryId, shopId, id, `TASK6-${id}`, courierId, state, `task6-${id}`, `confirm-${id}`, `tracking-${id}`]);
        await db.pool.query("UPDATE orders SET delivery_id = ?, fulfillment_type = 'delivery' WHERE id = ?", [deliveryId, id]);
        await db.pool.query(`INSERT INTO delivery_charge_snapshots (shopid,delivery_id,revision,band_fee_cents,
          free_delivery_applied,fee_cents,total_excl_tax_cents,tax_cents,vat_rate,fiscal_policy)
          VALUES (?,?,1,400,0,400,364,36,10,'{"mode":"configured_rate","vatRate":10}')`, [shopId, deliveryId]);
        await db.pool.query("INSERT INTO orderdetail (orderid,productid,qty,price,total) VALUES (?,21,1,20,20)", [id]);
        await db.pool.query("INSERT INTO order_stock_reservations (order_id,product_id,quantity,status,created) VALUES (?,21,1,'committed',NOW())", [id]);
        return { id, deliveryId };
      };
      const body = (key, extra = {}) => ({ method: "cash", expectedVersion: 1, idempotencyKey: key, ...extra });
      const actor = { subject: "staff", id: 11, shopId: 7, access: 6 };
      const input = (item, key, extra = {}) => ({ ...body(key), actor, deliveryId: item.deliveryId, ...extra });
      const rowsFor = async item => ({
        order: await db.readRows("SELECT payment_status,payment_provider,payment,stripe_payment_intent_id,status FROM orders WHERE id = ?", [item.id]),
        payments: await db.readRows("SELECT * FROM payments WHERE order_id = ?", [item.id]),
        collections: await db.readRows("SELECT CAST(id AS CHAR) AS id,method,amount_cents,payment_id FROM delivery_payment_collections WHERE delivery_id = ?", [item.deliveryId]),
        events: await db.readRows("SELECT version,event_type FROM delivery_events WHERE delivery_id = ?", [item.deliveryId]),
        dossier: await db.readRows("SELECT version,delivery_status FROM deliveries WHERE id = ?", [item.deliveryId]),
        reservations: await db.readRows("SELECT status FROM order_stock_reservations WHERE order_id = ?", [item.id]),
        stock: await db.readRows("SELECT stock FROM products WHERE id = 21"),
        movements: await db.readRows("SELECT id FROM stocks WHERE productid = 21"),
      });
      const failures = [];
      const test = async (name, work) => {
        try { await work(); console.log(`PASS SQL ${name}`); }
        catch (error) { failures.push(name); console.error(`FAIL SQL ${name}: ${error.stack}`); }
      };
      try {
        await test("real HTTP concurrent same key collects 2400 once and lost response replays", async () => {
          const item = await make();
          const before = await rowsFor(item);
          const results = await Promise.all([request(item.deliveryId, body("same-key"), token(11, 7, 0)), request(item.deliveryId, body("same-key"))]);
          assert.deepEqual(results.map(r => r.status), [200, 200]);
          assert.equal(results[0].cache, "no-store");
          const ids = results.map(r => r.body.data.collectionId);
          assert.equal(typeof ids[0], "string");
          assert.equal(ids[0], ids[1]);
          assert.deepEqual(results.map(r => r.body.data.idempotentReplay).sort(), [false, true]);
          const replay = await request(item.deliveryId, body("same-key"));
          assert.equal(replay.body.data.collectionId, ids[0]);
          const after = await rowsFor(item);
          assert.equal(after.payments.length, 1);
          assert.equal(after.collections.length, 1);
          assert.equal(Number(after.collections[0].amount_cents), 2400);
          assert.equal(Number(after.payments[0].amount_cents), 2400);
          assert.equal(after.collections[0].payment_id, after.payments[0].id);
          assert.equal(after.payments[0].order_id, item.id);
          assert.equal(after.payments[0].status, "succeeded");
          assert.match(after.payments[0].stripe_payment_intent_id, /^manual_delivery:/);
          assert.equal(after.order[0].payment_status, "paid");
          assert.equal(after.order[0].payment_provider, null);
          assert.equal(after.order[0].stripe_payment_intent_id, null);
          assert.equal(after.order[0].status, 3);
          assert.equal(after.events.length, 1);
          assert.equal(after.dossier[0].version, 2);
          for (const key of ["stock", "movements", "reservations"]) assert.deepEqual(after[key], before[key]);
          const debt = await db.readRows("SELECT COALESCE(SUM(amount_cents),0) AS cents FROM delivery_payment_collections WHERE delivery_id = ? AND method = 'cash'", [item.deliveryId]);
          assert.equal(Number(debt[0].cents), 2400);
          assert.equal((await request(item.deliveryId, body("different-after-paid", { expectedVersion: 2 }))).status, 409);
          assert.equal((await request(item.deliveryId, body("same-key", { method: "external_card" }))).body.error, "DELIVERY_IDEMPOTENCY_CONFLICT");
          assert.equal((await request(item.deliveryId, body("same-key", { expectedVersion: 2 }))).body.error, "DELIVERY_IDEMPOTENCY_CONFLICT");
          assert.deepEqual(await rowsFor(item), after);
        });
        // Load after the HTTP RED assertion so missing endpoint is the first failure.
        const { buildDeliveryCollections } = require("../src/modules/m_deliveryCollections");
        const service = buildDeliveryCollections();
        await test("shared projection offers collection only on eligible own in-transit missions", async () => {
          const { resolveDeliveryOrder, toDeliveryView } = require("../src/modules/m_deliveryOrders");
          const item = await make();
          const current = await resolveDeliveryOrder({ shopId: 7, deliveryId: item.deliveryId });
          assert.ok(toDeliveryView({ ...current, actor }).allowedActions.includes("collectPayment"));
          for (const payment_provider of ["stripe", "stripe_terminal", "unknown"]) {
            assert.ok(!toDeliveryView({ ...current, actor, order: { ...current.order, payment_provider } }).allowedActions.includes("collectPayment"));
            await db.pool.query("UPDATE orders SET payment_provider = ? WHERE id = ?", [payment_provider, item.id]);
            await assert.rejects(service.collect(input(item, `provider-${payment_provider}`)), { code: "DELIVERY_PAYMENT_NOT_SETTLED" });
          }
          await db.pool.query("UPDATE orders SET payment_provider = NULL WHERE id = ?", [item.id]);
          await service.collect(input(item, "view-collect"));
          const paid = await resolveDeliveryOrder({ shopId: 7, deliveryId: item.deliveryId });
          assert.ok(!toDeliveryView({ ...paid, actor }).allowedActions.includes("collectPayment"));
        });
        await test("independent shops do not deadlock on missing payment-record gaps", async () => {
          const first = await make();
          const second = await make({ shopId: 8, courierId: 12 });
          let release;
          const gate = new Promise(resolve => { release = resolve; });
          let arrivals = 0;
          const collector = buildDeliveryCollections({ repository: { postingTime: async ({ connection }) => {
            arrivals++;
            if (arrivals === 2) release();
            await gate;
            return (await connection.query("SELECT DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%d %H:%i:%s.%f') AS now"))[0][0].now;
          } } });
          const timer = setTimeout(release, 3000);
          let results;
          try {
            results = await Promise.allSettled([collector.collect(input(first, "shop7")),
              collector.collect(input(second, "shop8", { actor: { ...actor, id: 12, shopId: 8 } }))]);
          } finally { clearTimeout(timer); release(); }
          assert.equal(arrivals, 2);
          assert.ok(results.every(result => result.status === "fulfilled"), results.map(result => result.reason && result.reason.code).join(","));
          assert.equal((await rowsFor(first)).collections.length, 1);
          assert.equal((await rowsFor(second)).collections.length, 1);
        });
        await test("concurrent different keys refuse already paid and external card creates zero cash debt", async () => {
          const item = await make();
          const results = await Promise.allSettled([service.collect(input(item, "race-a", { method: "external_card" })), service.collect(input(item, "race-b", { method: "external_card" }))]);
          assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
          assert.equal(results.find(r => r.status === "rejected").reason.status, 409);
          const rows = await rowsFor(item);
          assert.equal(rows.payments.length, 1);
          assert.equal(rows.collections[0].method, "external_card");
          assert.equal(rows.order[0].payment_provider, null);
          assert.equal(rows.payments[0].stripe_charge_id, null);
          assert.equal(Number((await db.readRows("SELECT COALESCE(SUM(amount_cents),0) AS cents FROM delivery_payment_collections WHERE delivery_id = ? AND method = 'cash'", [item.deliveryId]))[0].cents), 0);
        });
        await test("strict body, method, cents, actor and mission guards leave no financial writes", async () => {
          const numericId = await make();
          await assert.rejects(service.collect(input(numericId, "numeric-id", { deliveryId: Number(numericId.deliveryId) })), { status: 400 });
          const empty = await request((await make()).deliveryId, {});
          assert.equal(empty.status, 400);
          assert.equal(empty.body.error, "DELIVERY_REQUEST_INVALID");
          for (const extra of [{ method: "card" }, { method: "stripe" }, { method: null }, { amount: 1 }, { amountCents: 1 }, { actor: { id: 10 } }, { courierId: 11 }, { expectedVersion: "1" }, { idempotencyKey: " " }]) {
            const item = await make();
            assert.equal((await request(item.deliveryId, body(`invalid-${item.id}`, extra))).status, 400);
            assert.equal((await rowsFor(item)).payments.length, 0);
          }
          for (const options of [{ state: "assigned" }, { state: "issue" }, { state: "delivered" }, { state: "failed" }, { state: "canceled" }, { status: 2 }, { paymentStatus: "paid" }, { paymentStatus: "refunded" }, { paymentStatus: "requires_payment" }, { paymentStatus: "processing" }]) {
            const item = await make(options);
            const before = await rowsFor(item);
            await assert.rejects(service.collect(input(item, `state-${item.id}`)), { status: 409 });
            assert.deepEqual(await rowsFor(item), before);
          }
          const item = await make();
          for (const who of [{ ...actor, id: 10, access: 6 }, { ...actor, id: 12 }, { ...actor, shopId: 8 }, { ...actor, subject: "service_point" }]) {
            await assert.rejects(service.collect(input(item, "forbidden", { actor: who })), error => [403, 404].includes(error.status));
          }
          assert.equal((await request(item.deliveryId, body("staff"), token(10, 7, 6))).status, 403);
          await db.pool.query("UPDATE users SET status = 0 WHERE id = 11");
          await assert.rejects(service.collect(input(item, "inactive")), { status: 403 });
          await db.pool.query("UPDATE users SET status = 1 WHERE id = 11");
          await db.pool.query("UPDATE orders SET subtotal = -1 WHERE id = ?", [item.id]);
          await assert.rejects(service.collect(input(item, "negative")), { code: "DELIVERY_MONEY_INVALID" });
          await db.pool.query("UPDATE orders SET subtotal = 0,subtotal_before_discount = 0 WHERE id = ?", [item.id]);
          await db.pool.query("UPDATE deliveries SET charge_revision = 2 WHERE id = ?", [item.deliveryId]);
          await db.pool.query(`INSERT INTO delivery_charge_snapshots (shopid,delivery_id,revision,band_fee_cents,free_delivery_applied,fee_cents,total_excl_tax_cents,tax_cents,vat_rate,fiscal_policy)
            VALUES (7,?,2,0,0,0,0,0,10,'{}')`, [item.deliveryId]);
          await assert.rejects(service.collect(input(item, "zero")), { status: 409 });
        });
        await test("pending Terminal allocations and detached uncertain provider records block substitution", async () => {
          const item = await make();
          await db.pool.query(`INSERT INTO stripe_terminal_payments (id,shopid,terminal_reader_id,cashier_user_id,idempotency_key,
            stripe_connected_account_id,amount_cents,application_fee_amount,status) VALUES (901,7,1,10,'task6-terminal','acct_fixture',2400,0,'processing')`);
          await db.pool.query("INSERT INTO stripe_terminal_payment_orders (terminal_payment_id,order_id,shopid,amount_cents) VALUES (901,?,7,2400)", [item.id]);
          const before = await rowsFor(item);
          await assert.rejects(service.collect(input(item, "terminal")), { code: "DELIVERY_PAYMENT_NOT_SETTLED" });
          assert.deepEqual(await rowsFor(item), before);
          for (const status of ["processing", "requires_payment_method", "succeeded", "refunded"]) {
            const other = await make();
            await db.pool.query(`INSERT INTO payments (order_id,shop_id,stripe_payment_intent_id,amount,amount_cents,application_fee_amount,status,created)
              VALUES (?,7,?,24,2400,0,?,NOW())`, [other.id, `pi_detached_${other.id}`, status]);
            await assert.rejects(service.collect(input(other, `detached-${other.id}`)), { code: "DELIVERY_PAYMENT_NOT_SETTLED" });
          }
        });
        await test("issue needs restaurant resume and event-key collisions roll back the whole collection", async () => {
          const { buildDeliveryDispatch } = require("../src/modules/m_deliveryDispatch");
          const dispatch = buildDeliveryDispatch();
          await db.pool.query("UPDATE users SET module_permissions = '[\"delivery\"]' WHERE id = 10");
          const item = await make();
          const issue = await dispatch.reportIssue({ actor, deliveryId: item.deliveryId, expectedVersion: 1,
            idempotencyKey: "collection-issue", reason: "Restaurant action needed" });
          await assert.rejects(service.collect(input(item, "issue-blocked", { expectedVersion: issue.version })), { code: "DELIVERY_TRANSITION_INVALID" });
          const resumed = await dispatch.resolveIssue({ actor: { ...actor, id: 10 }, deliveryId: item.deliveryId,
            expectedVersion: issue.version, idempotencyKey: "collection-resume", action: "resume", reason: "Restaurant authorizes collection" });
          const before = await rowsFor(item);
          await assert.rejects(service.collect(input(item, "collection-issue", { expectedVersion: resumed.version })), { code: "DELIVERY_IDEMPOTENCY_CONFLICT" });
          assert.deepEqual(await rowsFor(item), before);
          const collected = await service.collect(input(item, "after-resume", { expectedVersion: resumed.version }));
          assert.equal(collected.delivery.paymentStatus, "paid");
          const [row] = await db.readRows("SELECT result FROM delivery_payment_collections WHERE id = ?", [collected.collectionId]);
          await assert.rejects(db.pool.query("UPDATE delivery_payment_collections SET result = '{}' WHERE id = ?", [collected.collectionId]), { code: "ER_SIGNAL_EXCEPTION" });
          await assert.rejects(db.pool.query("DELETE FROM delivery_payment_collections WHERE id = ?", [collected.collectionId]), { code: "ER_SIGNAL_EXCEPTION" });
          assert.deepEqual((await db.readRows("SELECT result FROM delivery_payment_collections WHERE id = ?", [collected.collectionId]))[0], row);
        });
        await test("actual concurrent Stripe success stays authoritative without second payment or stock movement", async () => {
          const item = await make({ paymentStatus: "requires_payment" });
          const intent = { id: `pi_task6_${item.id}`, latest_charge: `ch_task6_${item.id}`, payment_method_types: ["card"] };
          await db.pool.query("UPDATE orders SET payment_provider = 'stripe',stripe_payment_intent_id = ? WHERE id = ?", [intent.id, item.id]);
          await db.pool.query(`INSERT INTO payments (order_id,shop_id,stripe_payment_intent_id,amount,amount_cents,application_fee_amount,status,created)
            VALUES (?,7,?,24,2400,0,'processing',NOW())`, [item.id, intent.id]);
          const before = await rowsFor(item);
          const { buildStripeWebhookEventHandler } = require("../src/controllers/c_stripe");
          const webhook = buildStripeWebhookEventHandler({ getStripe: () => ({ charges: { retrieve: async () => ({ id: intent.latest_charge }) } }) });
          const barrier = await appPool.getConnection();
          let attempts;
          let results;
          try {
            await barrier.beginTransaction();
            await barrier.query("SELECT id FROM orders WHERE id = ? FOR UPDATE", [item.id]);
            attempts = Promise.allSettled([service.collect(input(item, "stripe-race")),
              webhook({ type: "payment_intent.succeeded", data: { object: { ...intent, status: "succeeded" } } })]);
            const deadline = Date.now() + 5000;
            let waits = [];
            while (Date.now() < deadline) {
              waits = await db.readRows(`SELECT DISTINCT w.REQUESTING_THREAD_ID FROM performance_schema.data_lock_waits w
                JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID
                WHERE l.OBJECT_SCHEMA = ? AND l.OBJECT_NAME = 'orders'`, [db.database]);
              if (waits.length === 2) break;
              await new Promise(resolve => setTimeout(resolve, 20));
            }
            assert.equal(waits.length, 2, "Webhook and collector must both reach an actual commercial-row wait");
          } finally {
            await barrier.commit();
            barrier.release();
            if (attempts) results = await attempts;
          }
          assert.equal(results[0].status, "rejected");
          assert.equal(results[0].reason.code, "DELIVERY_PAYMENT_NOT_SETTLED");
          assert.equal(results[1].status, "fulfilled");
          const after = await rowsFor(item);
          assert.equal(after.order[0].payment_status, "paid");
          assert.equal(after.payments.length, 1);
          assert.equal(after.collections.length, 0);
          for (const key of ["stock", "movements", "reservations"]) assert.deepEqual(after[key], before[key]);
        });
        await test("post-payment pre-collection and post-collection pre-event failures roll back actual rows", async () => {
          for (const boundary of ["appendCollection", "appendEvent"]) {
            const item = await make();
            const before = await rowsFor(item);
            const injected = new Error(`injected ${boundary}`);
            const failing = buildDeliveryCollections({ repository: { [boundary]: async ({ connection }) => {
              const [orders] = await connection.query("SELECT payment_status FROM orders WHERE id = ?", [item.id]);
              const [payments] = await connection.query("SELECT id FROM payments WHERE order_id = ?", [item.id]);
              assert.equal(orders[0].payment_status, "paid");
              assert.equal(payments.length, 1);
              if (boundary === "appendEvent") {
                const [collections] = await connection.query("SELECT id FROM delivery_payment_collections WHERE delivery_id = ?", [item.deliveryId]);
                assert.equal(collections.length, 1);
              }
              throw injected;
            } } });
            await assert.rejects(failing.collect(input(item, `rollback-${item.id}`)), error => error === injected);
            assert.deepEqual(await rowsFor(item), before);
            assert.equal((await service.collect(input(item, `rollback-${item.id}`))).idempotentReplay, false);
          }
        });
        await test("current replay privacy survives archive closure reassignment suspension and role changes", async () => {
          const item = await make();
          const mutation = input(item, "private-replay");
          const first = await service.collect(mutation);
          assert.ok(first.delivery.addressSnapshot);
          const { mArchiveOrder } = require("../src/modules/m_orders");
          await mArchiveOrder(item.id, undefined, 7);
          const [archive] = await db.readRows("SELECT id FROM archives WHERE delivery_id = ?", [item.deliveryId]);
          assert.notEqual(archive.id, item.id);
          assert.equal((await service.collect(mutation)).collectionId, first.collectionId);
          await db.pool.query("UPDATE deliveries SET delivery_status = 'delivered',closed_at = NOW(),version = version + 1 WHERE id = ?", [item.deliveryId]);
          const replay = await service.collect(mutation);
          assert.equal(replay.collectionId, first.collectionId);
          assert.equal(replay.delivery.deliveryStatus, "delivered");
          assert.equal(replay.delivery.addressSnapshot, undefined);
          assert.equal(replay.delivery.contactSnapshot, undefined);
          assert.equal(replay.delivery.items, undefined);
          const records = await db.readRows("SELECT result FROM delivery_payment_collections WHERE delivery_id = ? UNION ALL SELECT result FROM delivery_events WHERE delivery_id = ?", [item.deliveryId, item.deliveryId]);
          for (const row of records) assert.doesNotMatch(JSON.stringify(row.result), /addressSnapshot|contactSnapshot|instructions|0700000000/);
          await db.pool.query("UPDATE deliveries SET courier_id = 10 WHERE id = ?", [item.deliveryId]);
          await assert.rejects(service.collect(mutation), { status: 404 });
          await db.pool.query("UPDATE deliveries SET courier_id = 11 WHERE id = ?", [item.deliveryId]);
          await db.pool.query("UPDATE users SET status = 0 WHERE id = 11");
          await assert.rejects(service.collect(mutation), { status: 403 });
          await db.pool.query("UPDATE users SET status = 1,access = 1 WHERE id = 11");
          await assert.rejects(service.collect(mutation), { status: 403 });
          await db.pool.query("UPDATE users SET access = 6 WHERE id = 11");
          assert.equal((await db.readRows("SELECT order_id FROM payments WHERE id = (SELECT payment_id FROM delivery_payment_collections WHERE id = ?)", [first.collectionId]))[0].order_id, item.id);
        });
        await test("exact BIGINT identities under production pool defaults and cross-dossier key conflicts", async () => {
          await db.pool.query("ALTER TABLE delivery_payment_collections AUTO_INCREMENT = 9007199254740993");
          await db.pool.query("ALTER TABLE delivery_events AUTO_INCREMENT = 9007199254740993");
          const item = await make({ deliveryId: "9007199254740993" });
          const result = await service.collect(input(item, "big-id"));
          assert.equal(result.collectionId, "9007199254740993");
          assert.equal(result.delivery.id, "9007199254740993");
          assert.equal((await db.readRows("SELECT CAST(id AS CHAR) AS id FROM delivery_events WHERE delivery_id = ?", [item.deliveryId]))[0].id, "9007199254740993");
          assert.equal((await service.collect(input(item, "big-id"))).collectionId, result.collectionId);
          const other = await make();
          await assert.rejects(service.collect(input(other, "big-id")), { code: "DELIVERY_IDEMPOTENCY_CONFLICT" });
          assert.equal((await rowsFor(other)).payments.length, 0);
        });
        await test("independent couriers serialize at shop before commercial/account locks and clock", async () => {
          await db.pool.query(`INSERT INTO users (id,shopid,username,email,password,phone,access,status,created,clearpass)
            VALUES (13,7,'Courier 13','13@example.test','not-a-login','',6,1,NOW(),'')`);
          const first = await make();
          const second = await make({ courierId: 13 });
          const barrier = await appPool.getConnection();
          const waiting = [];
          const { createTransactionRunner } = require("../src/helpers/withTransaction");
          const run = createTransactionRunner(appPool);
          const runner = work => run(async connection => { waiting.push(connection.threadId); return work(connection); });
          const clocks = [];
          const collector = buildDeliveryCollections({ runInTransaction: runner, clock: async ({ connection }) => {
            const [rows] = await connection.query("SELECT DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%d %H:%i:%s.%f') AS now");
            clocks.push(rows[0].now);
            return rows[0].now;
          } });
          let attempts;
          let results;
          let cutoff;
          try {
            await barrier.query("SET SESSION innodb_lock_wait_timeout = 2");
            await barrier.beginTransaction();
            await barrier.query("SELECT id FROM shop WHERE id = 7 FOR UPDATE");
            attempts = Promise.allSettled([collector.collect(input(first, "independent-a")), collector.collect(input(second, "independent-b", { actor: { ...actor, id: 13 } }))]);
            const deadline = Date.now() + 5000;
            let waits = [];
            while (Date.now() < deadline) {
              waits = await db.readRows(`SELECT t.PROCESSLIST_ID FROM performance_schema.data_lock_waits w
                JOIN performance_schema.threads t ON t.THREAD_ID = w.REQUESTING_THREAD_ID
                JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID
                WHERE t.PROCESSLIST_ID IN (?) AND l.OBJECT_NAME = 'shop'`, [waiting.length ? waiting : [0]]);
              if (new Set(waits.map(row => row.PROCESSLIST_ID)).size === 2) break;
              await new Promise(resolve => setTimeout(resolve, 20));
            }
            assert.equal(new Set(waits.map(row => row.PROCESSLIST_ID)).size, 2, "Both collectors must wait first on the actual shop lock");
            assert.equal(clocks.length, 0);
            await barrier.query("SELECT id FROM orders WHERE id IN (?,?) FOR UPDATE", [first.id, second.id]);
            await barrier.query("SELECT id FROM users WHERE id IN (11,13) FOR UPDATE");
            [cutoff] = (await barrier.query("SELECT DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%d %H:%i:%s.%f') AS now"))[0];
          } finally {
            await barrier.commit();
            barrier.release();
            if (attempts) results = await attempts;
          }
          assert.ok(results.every(result => result.status === "fulfilled"), JSON.stringify(results));
          assert.equal(clocks.length, 2);
          assert.ok(clocks.every(now => now >= cutoff.now));
          assert.equal((await rowsFor(first)).collections.length, 1);
          assert.equal((await rowsFor(second)).collections.length, 1);
        });
        await test("posting boundary preserves six digits for DB and explicit clocks", async () => {
          for (const clock of [undefined, () => "2026-10-17 13:14:15.123456"]) {
            const item = await make();
            const timestamps = [];
            const collector = buildDeliveryCollections({ clock, repository: {
              appendCollection: async ({ collection, connection }) => {
                timestamps.push(collection.created_at);
                await connection.query("INSERT INTO delivery_payment_collections SET ?", [collection]);
                return (await connection.query("SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id"))[0][0].id;
              },
              appendEvent: async ({ event, connection }) => {
                timestamps.push(event.created_at);
                await connection.query("INSERT INTO delivery_events SET ?", [event]);
              },
            } });
            await collector.collect(input(item, `precision-${item.id}`));
            assert.match(timestamps[0], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/);
            assert.equal(timestamps[0], timestamps[1]);
            if (clock) assert.equal(timestamps[0], "2026-10-17 13:14:15.123456");
          }
        });
      } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
      assert.deepEqual(failures, []);
    } finally { await appPool.end(); }
  });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
