const assert = require("assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const { withDeliveryDatabase } = require("./helpers/deliveryDatabase");

async function main() {
  await withDeliveryDatabase(async db => {
    await db.seedScenario();
    require.cache[require.resolve("../src/config/dbPool")] = { exports: db.pool };
    require.cache[require.resolve("../src/config/db")] = { exports: db.pool.pool };
    require.cache[require.resolve("../src/config/stripe")] = { exports: { getStripe() { throw new Error("No provider operations"); } } };
    if (Number(process.versions.node.split(".")[0]) === 18) require.cache[require.resolve("nanoid")] = { exports: await import("nanoid") };
    const { buildCheckoutModule } = require("../src/modules/m_checkout");
    const { buildDeliveryQuotes } = require("../src/modules/m_deliveryQuotes");
    const { buildSqlDeliverySettingsRepository } = require("../src/modules/m_deliverySettings");
    const { buildDeliveryTokenCodec, signAddressResolution } = require("../src/helpers/deliveryAddress");
    await db.pool.query("DELETE FROM archives WHERE id=32");
    await db.pool.query("UPDATE orders SET subtotal_before_discount=12.50,discount_amount=0 WHERE id=31");
    await db.pool.query(`INSERT INTO delivery_charge_snapshots (shopid,delivery_id,revision,band_fee_cents,free_delivery_applied,
      fee_cents,total_excl_tax_cents,tax_cents,vat_rate,fiscal_policy) VALUES (7,41,1,0,0,0,0,0,10,'{"mode":"configured_rate","vatRate":10}')`);
    await db.pool.query("INSERT INTO service_points (id,shopid,name,type,system_key,created) VALUES (70,7,'Counter','counter','counter',NOW())");
    await db.pool.query("UPDATE users SET courier_available=0,module_permissions='[\"delivery\",\"cashregister\",\"orders\"]' WHERE id=10");
    await db.pool.query(`INSERT INTO users (id,shopid,username,email,password,phone,access,status,created,clearpass)
      VALUES (14,7,'Admin','admin@example.test','fixture','',0,1,NOW(),'')`);
    await db.pool.query("UPDATE products SET price=20,track_stock=1,stock=100,vat_rate_takeaway=5.5 WHERE id=21");
    await db.pool.query(`UPDATE shop_delivery_settings SET enabled=1,revision=1,origin_latitude=48.8566,
      origin_longitude=2.3522,max_distance_meters=5000,minimum_items_cents=0,
      free_delivery_enabled=0,fiscal_mode='configured_rate',vat_rate=10 WHERE shopid=7`);
    await db.pool.query("INSERT INTO shop_delivery_fee_bands (shopid,up_to_meters,fee_cents) VALUES (7,5000,400)");
    const clock = () => new Date();
    const tokenCodec = buildDeliveryTokenCodec({ secret: "final-fixes-disposable-signing-only" });
    const quotes = buildDeliveryQuotes({ repository: buildSqlDeliverySettingsRepository({ pool: db.pool }), clock, tokenCodec,
      geocoder: { resolve() { throw new Error("No geocoding operations"); } } });
    const checkout = buildCheckoutModule({ deliveryQuotes: quotes, now: clock });
    const attempt = async (key, paymentMode = "cash") => {
      const items = [{ productId: 21, quantity: 1, selectedChoiceIds: [] }];
      const addressResolutionToken = signAddressResolution({ shopId: 7, now: clock(), tokenCodec,
        addressSnapshot: { street: "7 rue Test", postalCode: "75001", city: "Paris", country: "FR", latitude: 48.857, longitude: 2.353 } });
      const quote = await quotes.createQuote({ shopId: 7, items, discount: { type: "none", value: 0 }, addressResolutionToken });
      return { shopId: 7, actorId: 10, customer: { id: 70, name: "Fixture", phone: "0700000000" }, items,
        expectedTotal: 24, paymentMode, clientOrderToken: key, fulfillmentType: "delivery", deliveryQuoteToken: quote.quoteToken,
        addressResolutionToken, deliveryConfirmationSecret: "0123456789abcdef".repeat(4) };
    };
    const app = express();
    app.use(express.json());
    app.use(require("../src/routers/r_delivery"));
    app.use(require("../src/routers/r_orders"));
    app.use(require("../src/routers/r_courier"));
    const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const call = async (url, body, claims = { id: 10, shopid: 7, access: 0 }) => {
      const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { method: body === undefined ? "GET" : "POST",
        signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${jwt.sign(claims, process.env.JWTKEY)}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: res.status, body: await res.json() };
    };
    const refundBody = (key, returnSource = "register") => ({ returnSource, reason: "Full return confirmed", idempotencyKey: key });
    const snapshot = async () => {
      const result = {};
      for (const table of ["products", "stocks", "payments", "delivery_payment_collections", "courier_cash_adjustments", "delivery_manual_refunds"])
        result[table] = await db.readRows(`SELECT * FROM ${table} ORDER BY id`);
      return result;
    };
    const checks = [];
    const check = (name, run) => checks.push({ name, run });
    check("initial POS paid-before cash creates immutable fee-inclusive register source and exact full-refund HTTP replay", async () => {
      const input = await attempt("fix-initial", "counter_pay_before:cash");
      const created = await checkout.createCheckout(input);
      const url = `/deliveries/${created.delivery.id}`;
      assert.equal((await call(`${url}/refund-eligibility`)).body.data.eligible, true);
      const source = (await db.readRows("SELECT * FROM delivery_register_payments WHERE delivery_id=?", [created.delivery.id]))[0];
      assert.equal(Number(source.amount_cents), 2400);
      assert.equal(source.operator_id, 10);
      assert.equal(source.method, "cash");
      await checkout.createCheckout(input);
      assert.equal((await db.readRows("SELECT * FROM delivery_register_payments WHERE delivery_id=?", [created.delivery.id])).length, 1);
      const before = await snapshot();
      const body = refundBody("fix-initial-refund");
      const result = await call(`${url}/refund`, body);
      assert.equal(result.status, 200, JSON.stringify(result));
      assert.equal(result.body.data.paymentOrigin, "register");
      assert.equal(result.body.data.amountCents, 2400);
      assert.equal(result.body.data.providerVerified, false);
      assert.equal(result.body.data.originalCourierId, undefined);
      assert.deepEqual((await call(`${url}/refund`, body)).body.data, result.body.data);
      assert.equal((await call(`${url}/refund`, refundBody("different-full-return"))).status, 409);
      assert.equal((await call(`${url}/refund`, { ...body, reason: "Changed" })).status, 409);
      assert.equal((await call(`${url}/refund`, body, { id: 11, shopid: 7, access: 0 })).status, 403);
      assert.equal((await call(`${url}/refund`, body, { id: 12, shopid: 8, access: 0 })).status, 403);
      await db.pool.query("UPDATE users SET status=0 WHERE id=10");
      assert.equal((await call(`${url}/refund`, body)).status, 403);
      await db.pool.query("UPDATE users SET status=1 WHERE id=10");
      const after = await snapshot();
      for (const table of ["products", "stocks", "delivery_payment_collections", "courier_cash_adjustments", "delivery_manual_refunds"])
        assert.deepEqual(after[table], before[table]);
      await assert.rejects(db.pool.query("UPDATE delivery_register_payments SET amount_cents=1 WHERE id=?", [source.id]));
      await assert.rejects(db.pool.query("DELETE FROM delivery_register_payments WHERE id=?", [source.id]));
    });
    check("later cashier collection and archive settlement preserve original payment and produce refund-only later Z", async () => {
      const created = await checkout.createCheckout(await attempt("fix-later"));
      const id = created.delivery.id;
      assert.equal((await call(`/orders/collect/${created.orderId}`, { payment_method: "cash" })).status, 200);
      await db.pool.query("UPDATE orders SET status=3 WHERE id=?", [created.orderId]);
      assert.equal((await call(`/orders/archive/${created.orderId}`, {})).status, 200);
      const { buildCashClosures } = require("../src/modules/m_cashClosures");
      await db.pool.query("UPDATE archives SET archived_at='2026-10-24 21:55:00.000000' WHERE delivery_id=?", [id]);
      const first = await buildCashClosures({ clock: () => "2026-10-24 22:00:00.000000" }).mCloseCurrentCashClosure({ shopId: 7, userId: 10 });
      const service = require("../src/modules/m_deliveryRefunds").buildDeliveryRefunds({ clock: () => "2026-10-25 01:10:00.000001" });
      const returned = await service.refund({ actor: { subject: "staff", id: 10, shopId: 7 }, deliveryId: id, ...refundBody("later-z") });
      assert.equal(returned.amountCents, 2400);
      const next = await buildCashClosures({ clock: () => "2026-10-25 01:15:00.000000" }).mCloseCurrentCashClosure({ shopId: 7, userId: 10 });
      assert.equal(next.orders_count, 0);
      assert.equal(next.total_revenue, 0);
      assert.deepEqual(next.vat_summary, []);
      assert.equal(next.courier_cash.cash_refunded_by_register_cents, 2400);
      assert.equal(next.courier_cash.outstanding_cents, 0);
      const frozen = await buildCashClosures().mGetCashClosureById({ shopId: 7, id: first.id });
      for (const field of ["total_revenue", "vat_summary", "payments_summary", "courier_cash"]) assert.deepEqual(frozen[field], first[field]);
      assert.equal((await db.readRows("SELECT order_id FROM payments WHERE id=?", [returned.paymentId]))[0].order_id, created.orderId);
      const atArchive = await checkout.createCheckout(await attempt("fix-archive-settlement"));
      await db.pool.query("UPDATE orders SET status=3 WHERE id=?", [atArchive.orderId]);
      assert.equal((await call(`/orders/archive/${atArchive.orderId}`, { payment_method: "cash" })).status, 200);
      assert.equal((await call(`/deliveries/${atArchive.delivery.id}/refund`, refundBody("archive-full"))).status, 200);
    });
    check("all offered manual register methods keep explicit identity and noncash declarations", async () => {
      for (const [offered, method, returnSource] of [["card", "external_card", "external_card"], ["cheque", "cheque", "cheque"], ["Ticket restaurant", "meal_voucher", "meal_voucher"]]) {
        for (const initial of [true, false]) {
          const item = await checkout.createCheckout(await attempt(`fix-${method}-${initial}`, initial ? `counter_pay_before:${offered}` : "cash"));
          if (!initial) assert.equal((await call(`/orders/collect/${item.orderId}`, { payment_method: offered })).status, 200);
          const url = `/deliveries/${item.delivery.id}`;
          const eligibility = (await call(`${url}/refund-eligibility`)).body.data;
          assert.equal(eligibility.method, method);
          assert.deepEqual(eligibility.returnSources, [returnSource]);
          assert.equal((await call(`${url}/refund`, refundBody(`wrong-${method}-${initial}`))).status, 409);
          const result = await call(`${url}/refund`, refundBody(`full-${method}-${initial}`, returnSource));
          assert.equal(result.status, 200, JSON.stringify(result));
          assert.equal(result.body.data.physicalHolderId, null);
          assert.equal(result.body.data.providerVerified, false);
        }
      }
      await assert.rejects(checkout.createCheckout(await attempt("unknown-method", "counter_pay_before:unknown")), { code: "DELIVERY_PAYMENT_METHOD_INVALID" });
    });
    check("unassigned restaurant issue cancel/fail is versioned current-authorized and financially separate", async () => {
      for (const [key, payment, action] of [["unpaid", "cash", "cancel"], ["prepaid", "counter_pay_before:cash", "fail"]]) {
        const item = await checkout.createCheckout(await attempt(`fix-${key}`, payment));
        const url = `/deliveries/${item.delivery.id}`;
        const before = await snapshot();
        const issue = { reason: "Cannot fulfill without courier", expectedVersion: 1, idempotencyKey: `issue-${key}` };
        assert.equal((await call(`${url}/report-issue`, issue, { id: 11, shopid: 7, access: 0 })).status, 403);
        const reported = await call(`${url}/report-issue`, issue);
        assert.equal(reported.status, 200, JSON.stringify(reported));
        assert.equal(reported.body.data.courierId, null);
        assert.deepEqual(reported.body.data.allowedResolutions, ["resume", "retry", "fail", "cancel"]);
        assert.equal((await call(`${url}/report-issue`, issue)).status, 200);
        assert.equal((await call(`${url}/resolve-issue`, { ...issue, action, idempotencyKey: `stale-${key}` })).status, 409);
        for (const invalid of ["return", "confirm_unpaid_delivery"]) assert.equal((await call(`${url}/resolve-issue`, { ...issue, expectedVersion: 2, action: invalid, idempotencyKey: `${key}-${invalid}` })).status, 409);
        const close = { ...issue, expectedVersion: 2, action, idempotencyKey: `close-${key}` };
        const result = await call(`${url}/resolve-issue`, close);
        assert.equal(result.status, 200, JSON.stringify(result));
        assert.equal(result.body.data.deliveryStatus, action === "fail" ? "failed" : "canceled");
        assert.equal((await call(`${url}/resolve-issue`, close)).status, 200);
        assert.equal((await call(`${url}/report-issue`, { ...issue, expectedVersion: 3, idempotencyKey: `reopen-${key}` })).status, 409);
        assert.deepEqual(await snapshot(), before);
        const rows = (await call("/deliveries")).body.data;
        assert.equal(rows.find(row => row.id === item.delivery.id).allowedActions.length, 0);
        const tracking = await call("/delivery/tracking/read", { token: item.tracking_url.split("#")[1] });
        assert.equal(tracking.status, 200);
        const corrected = await call(`${url}/correct-terminal`, { reason: "Wrong closure", expectedVersion: 3, idempotencyKey: `correction-${key}` }, { id: 14, shopid: 7, access: 0 });
        assert.equal(corrected.status, 200, JSON.stringify(corrected));
        assert.equal(corrected.body.data.courierId, null);
        assert.deepEqual(corrected.body.data.allowedResolutions, ["resume", "retry", "fail", "cancel"]);
        const correction = (await db.readRows("SELECT result FROM delivery_events WHERE delivery_id=? AND event_type='correctTerminal'", [item.delivery.id]))[0].result;
        const proof = typeof correction === "string" ? JSON.parse(correction) : correction;
        assert.equal(proof.issueOrigin.deliveryStatus, "unassigned");
        assert.equal(proof.issueOrigin.courierId, null);
        assert.ok(proof.privacyClosedAt);
        assert.deepEqual(await snapshot(), before);
      }
    });
    check("register sources and returns roll back late SQL failures and serialize concurrent real producers", async () => {
      const countTables = ["orders", "orderdetail", "stocks", "payments", "deliveries", "delivery_register_payments"];
      const counts = async () => Promise.all(countTables.map(async table => Number((await db.readRows(`SELECT COUNT(*) n FROM ${table}`))[0].n)));
      const input = await attempt("fix-concurrent", "counter_pay_before:cash");
      const pair = await Promise.all([checkout.createCheckout(input), checkout.createCheckout(input)]);
      assert.equal(pair[0].orderId, pair[1].orderId);
      assert.equal((await db.readRows("SELECT * FROM delivery_register_payments WHERE delivery_id=?", [pair[0].delivery.id])).length, 1);
      const before = await counts();
      await db.pool.query(`CREATE TRIGGER final_fix_source_failure BEFORE INSERT ON delivery_register_payments FOR EACH ROW
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fixture late source failure'`);
      await assert.rejects(checkout.createCheckout(await attempt("fix-source-rollback", "counter_pay_before:cash")), /fixture late source failure/);
      assert.deepEqual(await counts(), before);
      const later = await checkout.createCheckout(await attempt("fix-later-rollback"));
      assert.equal((await call(`/orders/collect/${later.orderId}`, { payment_method: "cash" })).status, 500);
      assert.equal((await db.readRows("SELECT payment_status FROM orders WHERE id=?", [later.orderId]))[0].payment_status, "unpaid");
      assert.equal((await db.readRows("SELECT * FROM payments WHERE order_id=?", [later.orderId])).length, 0);
      await db.pool.query("DROP TRIGGER final_fix_source_failure");
      const collections = await Promise.all([1, 2].map(() => call(`/orders/collect/${later.orderId}`, { payment_method: "cash" })));
      assert.deepEqual(collections.map(row => row.status).sort(), [200, 409]);
      const id = pair[0].delivery.id;
      const source = (await db.readRows("SELECT * FROM delivery_register_payments WHERE delivery_id=?", [id]))[0];
      await assert.rejects(db.pool.query(`INSERT INTO delivery_payment_collections
        (shopid,delivery_id,courier_id,payment_id,method,amount_cents,idempotency_key,request_hash,result)
        VALUES (7,?,11,?,'cash',2400,'cross-origin-source',REPEAT('a',64),'{}')`, [id, source.payment_id]), /register origin/);
      await db.pool.query(`CREATE TRIGGER final_fix_refund_failure BEFORE UPDATE ON payments FOR EACH ROW
        BEGIN IF NEW.status='refunded' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fixture late refund failure'; END IF; END`);
      const body = refundBody("fix-late-refund");
      assert.equal((await call(`/deliveries/${id}/refund`, body)).status, 503);
      assert.equal((await db.readRows("SELECT payment_status FROM orders WHERE id=?", [pair[0].orderId]))[0].payment_status, "paid");
      assert.equal((await db.readRows("SELECT * FROM delivery_register_refunds WHERE delivery_id=?", [id])).length, 0);
      await db.pool.query("DROP TRIGGER final_fix_refund_failure");
      const { createTransactionRunner } = require("../src/helpers/withTransaction");
      const run = createTransactionRunner(db.pool);
      const inputRefund = { actor: { subject: "staff", id: 10, shopId: 7 }, deliveryId: id, ...body };
      const uncertain = require("../src/modules/m_deliveryRefunds").buildDeliveryRefunds({ runInTransaction: async work => {
        await run(work); throw new Error("Fixture committed response lost");
      } });
      await assert.rejects(uncertain.refund(inputRefund), /committed response lost/);
      const replay = await call(`/deliveries/${id}/refund`, body);
      assert.equal(replay.status, 200);
      const stored = (await db.readRows("SELECT result FROM delivery_register_refunds WHERE delivery_id=?", [id]))[0].result;
      const parsed = typeof stored === "string" ? JSON.parse(stored) : stored;
      assert.deepEqual(replay.body.data, { refundId: replay.body.data.refundId, ...parsed });
      const returns = await Promise.all(["one", "two"].map(key => call(`/deliveries/${later.delivery.id}/refund`, refundBody(`concurrent-return-${key}`))));
      assert.deepEqual(returns.map(row => row.status).sort(), [200, 409]);
      await db.pool.query("UPDATE users SET access=4 WHERE id=10");
      assert.equal((await call(`/deliveries/${id}/refund`, body)).status, 403);
      await db.pool.query("UPDATE users SET access=1 WHERE id=10");
      const legacy = await checkout.createCheckout(await attempt("legacy-paid-no-proof"));
      await db.pool.query("UPDATE orders SET payment_status='paid' WHERE id=?", [legacy.orderId]);
      assert.equal((await call(`/deliveries/${legacy.delivery.id}/refund-eligibility`)).body.data.eligible, false);
      assert.equal((await call(`/deliveries/${legacy.delivery.id}/refund`, refundBody("no-backfill"))).status, 409);
    });
    check("returned unassigned cancellation and repeated correction retain earliest privacy ceiling under suspension", async () => {
      const item = await checkout.createCheckout(await attempt("returned-unassigned"));
      const id = item.delivery.id;
      const url = `/deliveries/${id}`;
      const command = (expectedVersion, key, extra = {}) => ({ expectedVersion, idempotencyKey: `${id}-${key}`, reason: "Fixture logistics reason", ...extra });
      await db.pool.query("UPDATE users SET courier_available=1 WHERE id=11");
      assert.equal((await call(`${url}/assign`, { expectedVersion: 1, idempotencyKey: `${id}-assign`, courierId: 11 })).status, 200);
      assert.equal((await call(`${url}/report-issue`, command(2, "assigned-issue"))).status, 200);
      assert.equal((await call(`${url}/resolve-issue`, command(3, "return", { action: "return" }))).status, 200);
      await db.pool.query("UPDATE users SET courier_available=0 WHERE id=11");
      await db.pool.query("UPDATE shop_delivery_settings SET enabled=0 WHERE shopid=7");
      const before = await snapshot();
      const issue = command(4, "unassigned-issue");
      assert.equal((await call(`${url}/report-issue`, issue)).status, 200);
      assert.equal((await call(`${url}/resolve-issue`, command(5, "retry-unavailable", { action: "retry", courierId: 11 }))).status, 409);
      assert.equal((await call(`${url}/resolve-issue`, command(5, "close", { action: "cancel" }))).status, 200);
      const closed = (await db.readRows("SELECT closed_at FROM deliveries WHERE id=?", [id]))[0].closed_at;
      const token = item.tracking_url.split("#")[1];
      assert.equal((await call("/delivery/tracking/read", { token })).body.data.stage, "restaurant_intervention");
      assert.equal((await call(`${url}/report-issue`, issue, { id: 12, shopid: 8, access: 0 })).status, 403);
      await db.pool.query("UPDATE users SET module_permissions='[\"orders\"]' WHERE id=10");
      assert.equal((await call(`${url}/report-issue`, issue)).status, 403);
      await db.pool.query("UPDATE users SET module_permissions='[\"delivery\",\"cashregister\",\"orders\"]' WHERE id=10");
      const { buildDeliveryDispatch } = require("../src/modules/m_deliveryDispatch");
      const dispatch = buildDeliveryDispatch({ clock: () => new Date(closed.getTime() + 86400000) });
      const actor = { subject: "staff", id: 14, shopId: 7 };
      const reopened = await dispatch.correctTerminal({ actor, deliveryId: id, ...command(6, "correct") });
      assert.equal(reopened.courierId, null);
      await dispatch.resolveIssue({ actor, deliveryId: id, ...command(7, "close-again", { action: "fail" }) });
      await dispatch.correctTerminal({ actor, deliveryId: id, ...command(8, "correct-again") });
      const history = await db.readRows("SELECT result FROM delivery_events WHERE delivery_id=? AND event_type='correctTerminal' ORDER BY version", [id]);
      const proofs = history.map(row => typeof row.result === "string" ? JSON.parse(row.result) : row.result);
      assert.equal(proofs[0].privacyClosedAt, closed.toISOString());
      assert.equal(proofs[1].privacyClosedAt, proofs[0].privacyClosedAt);
      const tracking = require("../src/modules/m_deliveryTracking").buildDeliveryTracking({ clock: () => new Date(closed.getTime() + 7 * 86400000) });
      await assert.rejects(tracking.read({ token }), { code: "DELIVERY_NOT_FOUND" });
      assert.deepEqual(await snapshot(), before);
      const resumed = await dispatch.resolveIssue({ actor, deliveryId: id, ...command(9, "resume", { action: "resume" }) });
      assert.equal(resumed.deliveryStatus, "unassigned");
      assert.equal(resumed.courierId, null);
      await db.pool.query("UPDATE shop_delivery_settings SET enabled=1 WHERE shopid=7");
      await dispatch.reportIssue({ actor, deliveryId: id, ...command(10, "retry-issue") });
      await db.pool.query("UPDATE users SET courier_available=1 WHERE id=11");
      const retried = await dispatch.resolveIssue({ actor, deliveryId: id, ...command(11, "explicit-retry", { action: "retry", courierId: 11 }) });
      assert.equal(retried.deliveryStatus, "assigned");
      assert.equal(retried.courierId, 11);
      const missing = await checkout.createCheckout(await attempt("missing-terminal-history"));
      await db.pool.query("UPDATE deliveries SET delivery_status='canceled',closed_at=UTC_TIMESTAMP() WHERE id=?", [missing.delivery.id]);
      assert.equal((await call(`/deliveries/${missing.delivery.id}/correct-terminal`, command(1, "missing-history"), { id: 14, shopid: 7, access: 0 })).status, 409);
    });
    check("register refund posting clock is sampled after the actual shop lock with microsecond UTC precision", async () => {
      const item = await checkout.createCheckout(await attempt("queued-register-refund", "counter_pay_before:cash"));
      const held = await db.pool.getConnection();
      let pending;
      let floor;
      try {
        await held.beginTransaction();
        await held.query("SELECT id FROM shop WHERE id=7 FOR UPDATE");
        const [[{ blocker }]] = await held.query("SELECT CONNECTION_ID() blocker");
        pending = call(`/deliveries/${item.delivery.id}/refund`, refundBody("queued-register-return"));
        let waits = [];
        const deadline = Date.now() + 5000;
        while (!waits.length && Date.now() < deadline) {
          waits = await db.readRows(`SELECT 1 FROM performance_schema.data_lock_waits w
            JOIN performance_schema.threads t ON t.THREAD_ID=w.BLOCKING_THREAD_ID WHERE t.PROCESSLIST_ID=?`, [blocker]);
          if (!waits.length) await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.ok(waits.length, "actual refund must wait on the shop barrier");
        floor = (await db.readRows("SELECT DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%d %H:%i:%s.%f') now"))[0].now;
        await held.commit();
      } finally { await held.rollback(); held.release(); }
      const result = await pending;
      assert.equal(result.status, 200);
      assert.match(result.body.data.createdAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/);
      assert.ok(result.body.data.createdAt > floor);
      const [row] = await db.readRows("SELECT DATE_FORMAT(created_at,'%Y-%m-%d %H:%i:%s.%f') now FROM delivery_register_refunds WHERE delivery_id=?", [item.delivery.id]);
      assert.equal(row.now, result.body.data.createdAt);
    });
    check("register migration preserves populated courier proof/refund impacts and cross-origin keys", async () => {
      const item = await checkout.createCheckout(await attempt("courier-origin-preserved"));
      const id = item.delivery.id;
      await db.pool.query("UPDATE orders SET status=3 WHERE id=?", [item.orderId]);
      await db.pool.query("UPDATE users SET courier_available=1 WHERE id=11");
      const operator = { subject: "staff", id: 10, shopId: 7 };
      const courier = { subject: "staff", id: 11, shopId: 7 };
      const dispatch = require("../src/modules/m_deliveryDispatch").buildDeliveryDispatch();
      await dispatch.assign({ actor: operator, deliveryId: id, expectedVersion: 1, idempotencyKey: "preserved-assign", courierId: 11 });
      await dispatch.pickup({ actor: courier, deliveryId: id, expectedVersion: 2, idempotencyKey: "preserved-pickup" });
      await require("../src/modules/m_deliveryCollections").buildDeliveryCollections().collect({ actor: courier, deliveryId: id,
        expectedVersion: 3, idempotencyKey: "preserved-collection", method: "cash" });
      const source = (await db.readRows("SELECT * FROM delivery_payment_collections WHERE delivery_id=?", [id]))[0];
      await assert.rejects(db.pool.query(`INSERT INTO delivery_register_payments
        (shopid,delivery_id,payment_id,operator_id,method,payment_label,amount_cents,created_at)
        VALUES (7,?,?,10,'cash','Especes',2400,UTC_TIMESTAMP(6))`, [id, source.payment_id]), /courier origin/);
      assert.equal((await call(`/deliveries/${id}/refund`, refundBody("fix-initial-refund"))).status, 409);
      assert.equal((await call(`/deliveries/${id}/refund`, refundBody("preserved-refund"))).status, 200);
      const tables = ["delivery_payment_collections", "delivery_manual_refunds", "courier_cash_refund_impacts"];
      const rows = async () => Promise.all(tables.map(table => db.readRows(`SELECT * FROM ${table} ORDER BY id`)));
      const before = await rows();
      const fs = require("fs");
      const path = require("path");
      const sections = fs.readFileSync(path.join(__dirname, "../db/migrations/20261018120000_delivery_register_payments.sql"), "utf8").split(/^-- migrate:(?:up|down)\s*$/m);
      await db.pool.query(sections[2]);
      assert.deepEqual(await rows(), before);
      await db.pool.query(sections[1]);
      assert.deepEqual(await rows(), before);
      assert.equal((await db.readRows("SELECT * FROM delivery_register_payments")).length, 0, "No unverifiable paid backfill");
    });
    let failures = 0;
    try {
      for (const { name, run } of checks) {
        try { await run(); console.log(`PASS ${name}`); }
        catch (error) { failures++; console.error(`FAIL ${name}`, error); }
      }
    } finally { await new Promise(resolve => server.close(resolve)); }
    assert.equal(failures, 0, `${failures} final-fixes acceptance groups failed`);
  });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
