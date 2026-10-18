const assert = require("assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const mysql = require("mysql2/promise");
const { withDeliveryDatabase } = require("./helpers/deliveryDatabase");

async function main() {
  await withDeliveryDatabase(async db => {
    await db.seedScenario();
    require.cache[require.resolve("../src/config/dbPool")] = { exports: db.pool };
    require.cache[require.resolve("../src/config/db")] = { exports: db.pool.pool };
    if (Number(process.versions.node.split(".")[0]) === 18) require.cache[require.resolve("nanoid")] = { exports: await import("nanoid") };
    const { buildDeliveryDispatch } = require("../src/modules/m_deliveryDispatch");
    const dispatch = buildDeliveryDispatch();
    const cash = require("../src/modules/m_courierCash").buildCourierCash();
    const collect = require("../src/modules/m_deliveryCollections").buildDeliveryCollections();
    const admin = { subject: "staff", id: 14, shopId: 7, access: 0 };
    const operator = { subject: "staff", id: 10, shopId: 7, access: 1 };
    const courier = { subject: "staff", id: 11, shopId: 7, access: 6 };
    await db.pool.query("UPDATE users SET courier_available=1,module_permissions='[\"delivery\"]'");
    await db.pool.query(`INSERT INTO users (id,shopid,username,email,password,phone,access,status,created,clearpass)
      VALUES (14,7,'Admin','admin@example.test','fixture','',0,1,NOW(),''),
      (15,7,'Other courier','other@example.test','fixture','',6,1,NOW(),'')`);
    await db.pool.query("UPDATE users SET courier_available=1 WHERE id=15");
    let next = 100;
    async function make(payment = "paid", fee = 0) {
      const id = next++;
      await db.pool.query(`INSERT INTO orders (id,shopid,ordernumber,customer,customerID,operator,subtotal,subtotal_before_discount,discount_amount,payment_status,status,created,finished,is_takeaway)
        VALUES (?,7,?,'Fixture',10,10,?,12.50,0,?,3,NOW(),NOW(),1)`, [id, `T13-${id}`, fee ? 16.50 : 12.50, payment]);
      await db.pool.query(`INSERT INTO deliveries (id,shopid,origin_order_id,order_reference,address_snapshot,contact_snapshot,latitude,longitude,distance_meters,settings_revision,client_order_token,confirmation_secret_hash,tracking_token_hash,tracking_expires_at)
        SELECT ?,7,?,?,address_snapshot,contact_snapshot,latitude,longitude,distance_meters,1,?,SHA2(?,256),SHA2(?,256),tracking_expires_at FROM deliveries WHERE id=41`,
      [String(id), id, `T13-${id}`, `t13-${id}`, `confirmation-${id}`, `tracking-${id}`]);
      await db.pool.query("UPDATE orders SET delivery_id=?,fulfillment_type='delivery' WHERE id=?", [String(id), id]);
      await db.pool.query("INSERT INTO orderdetail (orderid,productid,qty,price,total) VALUES (?,21,1,12.50,12.50)", [id]);
      await db.pool.query(`INSERT INTO delivery_charge_snapshots (shopid,delivery_id,revision,band_fee_cents,free_delivery_applied,fee_cents,total_excl_tax_cents,tax_cents,vat_rate,fiscal_policy)
        VALUES (7,?,1,?,0,?,?,?,10,'{"mode":"configured_rate","vatRate":10}')`, [String(id), fee, fee, fee ? 364 : 0, fee ? 36 : 0]);
      return String(id);
    }
    const input = (id, actor, expectedVersion, key, extra = {}) => ({ actor, deliveryId: id, expectedVersion, idempotencyKey: `${id}-${key}`, ...extra });
    async function terminal(kind = "delivered", prior = "in_transit", payment = "paid") {
      const id = await make(payment);
      await dispatch.assign(input(id, operator, 1, "assign", { courierId: 11 }));
      let version = 2;
      if (prior === "in_transit") { await dispatch.pickup(input(id, courier, version++, "pickup")); }
      if (kind === "delivered" && payment === "paid") return { id, result: await dispatch.deliver(input(id, courier, version, "deliver")) };
      await dispatch.reportIssue(input(id, operator, version++, "issue", { reason: "Original issue" }));
      return { id, result: await dispatch.resolveIssue(input(id, operator, version, "close", {
        action: kind === "failed" ? "fail" : kind === "canceled" ? "cancel" : "confirm_unpaid_delivery", reason: "Original resolution",
      })) };
    }
    async function unchanged(id) {
      const result = {};
      for (const table of ["orders", "archives", "orderdetail", "archivesdetail", "products", "payments", "delivery_charge_snapshots", "delivery_payment_collections", "courier_cash_remittances", "courier_cash_remittance_allocations", "courier_cash_adjustments", "courier_cash_refund_impacts", "delivery_manual_refunds"]) {
        result[table] = await db.readRows(`SELECT * FROM ${table} ORDER BY id`);
      }
      result.privacy = await db.readRows("SELECT tracking_token_hash,tracking_expires_at,created_at,confirmation_secret_hash FROM deliveries WHERE id=?", [id]);
      return result;
    }
    const item = await terminal();
    assert.equal(typeof dispatch.correctTerminal, "function", "Task13 requires the administrative terminal correction command");
    const before = await unchanged(item.id);
    const old = (await db.readRows("SELECT closed_at FROM deliveries WHERE id=?", [item.id]))[0];
    const mutation = input(item.id, admin, item.result.version, "correct", { reason: "Wrong terminal entry" });
    await db.pool.query("ALTER TABLE delivery_events AUTO_INCREMENT=9007199254740993");
    const fixtureUrl = new URL(process.env.DELIVERY_TEST_DATABASE_URL);
    const nativePool = mysql.createPool({ host: fixtureUrl.hostname, port: Number(fixtureUrl.port), user: decodeURIComponent(fixtureUrl.username),
      password: decodeURIComponent(fixtureUrl.password), database: db.database, timezone: "Z", supportBigNumbers: false, bigNumberStrings: false });
    let corrected;
    try {
      const nativeDispatch = buildDeliveryDispatch({ runInTransaction: require("../src/helpers/withTransaction").createTransactionRunner(nativePool) });
      corrected = await nativeDispatch.correctTerminal(mutation);
    } finally { await nativePool.end(); }
    assert.equal(corrected.eventId, "9007199254740993");
    assert.equal(corrected.deliveryStatus, "issue");
    assert.equal(corrected.version, item.result.version + 1);
    assert.deepEqual(await unchanged(item.id), before);
    const event = (await db.readRows("SELECT *,CAST(id AS CHAR) exactId FROM delivery_events WHERE delivery_id=? AND event_type='correctTerminal'", [item.id]))[0];
    const parsed = value => typeof value === "string" ? JSON.parse(value) : value;
    const proof = parsed(event.result);
    assert.equal(event.reason, mutation.reason);
    assert.equal(event.actor_id, String(admin.id));
    assert.equal(parsed(event.previous_state).deliveryStatus, "delivered");
    assert.equal(proof.sourceEventId, item.result.eventId);
    assert.equal(proof.issueOrigin.deliveryStatus, "in_transit");
    assert.equal(new Date(proof.privacyClosedAt).getTime(), old.closed_at.getTime());
    assert.equal((await dispatch.correctTerminal(mutation)).idempotentReplay, true);
    await assert.rejects(dispatch.correctTerminal({ ...mutation, reason: "Changed" }), { code: "DELIVERY_IDEMPOTENCY_CONFLICT" });
    await assert.rejects(dispatch.correctTerminal({ ...mutation, idempotencyKey: "new-stale" }), { code: "DELIVERY_VERSION_CONFLICT" });
    await dispatch.resolveIssue(input(item.id, operator, corrected.version, "resume", { action: "resume", reason: "Physical context checked" }));
    assert.equal((await dispatch.get({ actor: operator, deliveryId: item.id })).deliveryStatus, "in_transit");
    console.log("PASS SQL correction preserves finances/stock/token and audits immutable terminal/source/reason; replay and ordinary issue resolution");

    for (const kind of ["failed", "canceled", "delivered"]) {
      const closed = await terminal(kind, kind === "delivered" ? "in_transit" : "assigned", kind === "delivered" ? "unpaid" : "paid");
      const opened = await dispatch.correctTerminal(input(closed.id, admin, closed.result.version, "correct", { reason: "Administrative mistake" }));
      await dispatch.resolveIssue(input(closed.id, operator, opened.version, "resume", { action: "resume", reason: "Checked" }));
      assert.equal((await dispatch.get({ actor: operator, deliveryId: closed.id })).deliveryStatus, kind === "delivered" ? "in_transit" : "assigned");
    }
    console.log("PASS SQL failed/canceled/unpaid-delivered origins are derived from immutable issue history");

    const race = await terminal();
    const contenders = await Promise.allSettled(["a", "b"].map(key => dispatch.correctTerminal(input(race.id, admin, race.result.version, key, { reason: "Race" }))));
    assert.equal(contenders.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(contenders.find(result => result.status === "rejected").reason.code, "DELIVERY_VERSION_CONFLICT");
    const replayItem = await terminal();
    const same = input(replayItem.id, admin, replayItem.result.version, "same", { reason: "Same request" });
    const replayPair = await Promise.all([dispatch.correctTerminal(same), dispatch.correctTerminal(same)]);
    assert.equal(replayPair[0].eventId, replayPair[1].eventId);
    assert.equal(replayPair.filter(result => result.idempotentReplay).length, 1);
    console.log("PASS SQL same/different-key concurrent corrections serialize without duplicate events");

    const archived = await terminal();
    await require("../src/modules/m_orders").mArchiveOrder(Number(archived.id), undefined, 7);
    const archivedBefore = await unchanged(archived.id);
    const firstCorrection = await dispatch.correctTerminal(input(archived.id, admin, archived.result.version, "archived-correct", { reason: "Archived terminal entry" }));
    assert.deepEqual(await unchanged(archived.id), archivedBefore);
    await dispatch.resolveIssue(input(archived.id, operator, firstCorrection.version, "archived-resume", { action: "resume", reason: "Checked parcel" }));
    const laterDispatch = buildDeliveryDispatch({ clock: () => new Date(Date.now() + 86400000) });
    const reclosed = await laterDispatch.deliver(input(archived.id, courier, firstCorrection.version + 1, "archived-reclose"));
    await dispatch.correctTerminal(input(archived.id, admin, reclosed.version, "archived-correct-again", { reason: "Second correction" }));
    const corrections = await db.readRows("SELECT result FROM delivery_events WHERE delivery_id=? AND event_type='correctTerminal' ORDER BY version", [archived.id]);
    assert.equal(parsed(corrections[0].result).privacyClosedAt, parsed(corrections[1].result).privacyClosedAt);
    assert.deepEqual(await unchanged(archived.id), archivedBefore);
    console.log("PASS SQL archived correction and repeated terminal closure preserve original privacy ceiling and commercial snapshots");

    const rollbackItem = await terminal();
    await db.pool.query(`CREATE TRIGGER task13_refuse_correction BEFORE INSERT ON delivery_events FOR EACH ROW
      BEGIN IF NEW.event_type='correctTerminal' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fixture late failure'; END IF; END`);
    await assert.rejects(dispatch.correctTerminal(input(rollbackItem.id, admin, rollbackItem.result.version, "rollback", { reason: "Must roll back" })));
    assert.equal((await dispatch.get({ actor: operator, deliveryId: rollbackItem.id })).deliveryStatus, "delivered");
    assert.equal((await dispatch.get({ actor: operator, deliveryId: rollbackItem.id })).version, rollbackItem.result.version);
    await db.pool.query("DROP TRIGGER task13_refuse_correction");
    const held = await db.pool.getConnection();
    await held.beginTransaction();
    await held.query("SELECT id FROM shop WHERE id=7 FOR UPDATE");
    const queued = dispatch.correctTerminal(input(rollbackItem.id, admin, rollbackItem.result.version, "queued", { reason: "Wait for financial barrier" }));
    const watched = Promise.allSettled([queued]);
    try {
      const deadline = Date.now() + 5000;
      let waiting = false;
      while (Date.now() < deadline) {
        const rows = await db.readRows(`SELECT COUNT(*) n FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks l
          ON l.ENGINE=w.ENGINE AND l.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID WHERE l.OBJECT_SCHEMA=? AND l.OBJECT_NAME='shop'`, [db.database]);
        if (Number(rows[0].n) > 0) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(waiting, true, "Correction must acquire the shop barrier before commercial/dossier locks");
      const unchangedVersion = (await db.readRows("SELECT version FROM deliveries WHERE id=?", [rollbackItem.id]))[0].version;
      assert.equal(unchangedVersion, rollbackItem.result.version);
    } finally { await held.commit(); held.release(); await watched; }
    assert.equal((await queued).deliveryStatus, "issue");
    console.log("PASS SQL late journal failure rolls back dossier and correction queues at the shop barrier");

    const missing = await make();
    await db.pool.query("UPDATE deliveries SET delivery_status='failed',closed_at=UTC_TIMESTAMP() WHERE id=?", [missing]);
    await assert.rejects(dispatch.correctTerminal(input(missing, admin, 1, "missing", { reason: "No history" })), { code: "DELIVERY_TERMINAL_HISTORY_REQUIRED" });
    const deny = await terminal();
    for (const actor of [operator, courier, { ...admin, subject: "customer" }, { ...admin, shopId: 8 }]) {
      await assert.rejects(dispatch.correctTerminal(input(deny.id, actor, deny.result.version, "deny", { reason: "Denied" })), error => [403, 404].includes(error.status));
    }
    for (const access of [1, 6, null]) {
      await db.pool.query("UPDATE users SET access=? WHERE id=14", [access]);
      await assert.rejects(dispatch.correctTerminal(input(deny.id, admin, deny.result.version, "stale", { reason: "Denied" })), { status: 403 });
    }
    await db.pool.query("UPDATE users SET access=0,status=0 WHERE id=14");
    await assert.rejects(dispatch.correctTerminal(input(deny.id, admin, deny.result.version, "inactive", { reason: "Denied" })), { status: 403 });
    await db.pool.query("UPDATE users SET status=1 WHERE id=14");
    await assert.rejects(dispatch.correctTerminal(input(deny.id, admin, deny.result.version, "blank", { reason: " " })), { status: 400 });
    await assert.rejects(dispatch.correctTerminal({ ...input(deny.id, admin, deny.result.version, "next", { reason: "No arbitrary next state" }), nextState: "assigned" }), { status: 400 });
    await assert.rejects(dispatch.correctTerminal({ ...input(deny.id, admin, deny.result.version, "numeric", { reason: "Exact delivery identifier required" }), deliveryId: Number(deny.id) }), { status: 400 });
    console.log("PASS SQL current-account denials, missing journal refusal and strict input");

    const external = await make("unpaid", 400);
    await dispatch.assign(input(external, operator, 1, "assign", { courierId: 11 }));
    await dispatch.pickup(input(external, courier, 2, "pickup"));
    await collect.collect(input(external, courier, 3, "card", { method: "external_card" }));
    const externalEligibility = await dispatch.refundEligibility({ actor: operator, deliveryId: external });
    assert.equal(externalEligibility.eligible, true);
    assert.equal(externalEligibility.amountCents, 1650);
    assert.deepEqual(externalEligibility.returnSources, ["external_card"]);
    await dispatch.deliver(input(external, courier, 4, "close-card"));
    const externalBefore = await unchanged(external);
    await dispatch.correctTerminal(input(external, admin, 5, "card-correction", { reason: "Card logistics mistake" }));
    assert.deepEqual(await unchanged(external), externalBefore);
    console.log("PASS SQL fee-inclusive independent-card eligibility and correction leaves manual payment untouched");

    const financial = await make("unpaid");
    await dispatch.assign(input(financial, operator, 1, "assign", { courierId: 11 }));
    await dispatch.pickup(input(financial, courier, 2, "pickup"));
    await collect.collect(input(financial, courier, 3, "cash", { method: "cash" }));
    await dispatch.reportIssue(input(financial, operator, 4, "issue", { reason: "Transfer" }));
    await dispatch.resolveIssue(input(financial, operator, 5, "retry", { action: "retry", courierId: 15, reason: "Transferred parcel", physicalTransferConfirmed: true }));
    const httpItem = await terminal();
    await db.pool.query("UPDATE users SET access=1,status=0 WHERE id=11");
    assert.equal((await dispatch.couriers({ actor: operator })).some(row => row.id === 11), false);
    const holders = await dispatch.couriers({ actor: operator, financialHolders: true });
    assert.equal(holders.some(row => row.id === 11), true);
    assert.equal(holders.some(row => row.id === 12 || row.id === 14), false);
    assert.equal(holders.some(row => "email" in row || "password" in row || "module_permissions" in row), false);
    const eligibility = await dispatch.refundEligibility({ actor: operator, deliveryId: financial });
    assert.equal(eligibility.eligible, true);
    assert.equal(eligibility.originalCourierId, 11);
    assert.equal(eligibility.amountCents, 1250);
    const balance = await cash.balance({ actor: operator, courierId: 11 });
    await cash.remit({ actor: operator, courierId: 11, receivedCents: 500, expectedBalanceVersion: balance.version, idempotencyKey: "former-holder-remit" });
    assert.equal((await cash.balance({ actor: operator, courierId: 11 })).remainingDueCents, 750);
    const refunds = require("../src/modules/m_deliveryRefunds").buildDeliveryRefunds();
    await assert.rejects(refunds.refund({ actor: operator, deliveryId: financial, returnSource: "courier", reason: "Original holder cannot cover full return", idempotencyKey: "insufficient-former-holder" }), { code: "DELIVERY_REFUND_CUSTODY_INSUFFICIENT" });
    assert.equal((await dispatch.get({ actor: operator, deliveryId: financial })).paymentStatus, "paid");
    const registerRefund = await refunds.refund({ actor: operator, deliveryId: financial, returnSource: "register", reason: "Register physically returned full amount", idempotencyKey: "former-holder-register-return" });
    assert.equal(registerRefund.amountCents, 1250);
    assert.equal(registerRefund.providerVerified, false);
    assert.equal((await cash.balance({ actor: operator, courierId: 11 })).remainingDueCents, 750);
    assert.equal((await dispatch.refundEligibility({ actor: operator, deliveryId: financial })).eligible, false);
    console.log("PASS SQL promoted inactive holder remains discoverable/remittable; refund source is original holder, not new assignee");

    const app = express();
    app.use(express.json());
    app.use(require("../src/routers/r_delivery"));
    const server = app.listen(0, "127.0.0.1");
    try {
      await new Promise(resolve => server.once("listening", resolve));
      const request = async (actor, path, body) => {
        const token = jwt.sign({ id: actor.id, shopid: actor.shopId, access: 0, session_subject: "staff" }, process.env.JWTKEY);
        const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body && { body: JSON.stringify(body) }) });
        return { status: response.status, body: await response.json(), cache: response.headers.get("cache-control") };
      };
      const body = { expectedVersion: httpItem.result.version, idempotencyKey: "http-correction", reason: "HTTP admin correction" };
      assert.equal((await request(operator, `/deliveries/${httpItem.id}/correct-terminal`, body)).status, 403);
      const http = await request(admin, `/deliveries/${httpItem.id}/correct-terminal`, body);
      assert.equal(http.status, 200);
      assert.equal(http.body.data.deliveryStatus, "issue");
      assert.equal(http.cache, "no-store");
      const holderHttp = await request(operator, "/delivery/couriers?financialHolders=true");
      assert.equal(holderHttp.status, 200);
      assert.equal(holderHttp.body.data.some(row => row.id === 11), true);
      assert.equal((await request(operator, `/deliveries/${financial}/refund-eligibility`)).body.data.eligible, false);
      const currentCourier = { subject: "staff", id: 15, shopId: 7, access: 6 };
      for (const path of ["/delivery/couriers?financialHolders=true", `/deliveries/${financial}/refund-eligibility`]) assert.equal((await request(currentCourier, path)).status, 403);
      assert.equal((await request({ ...admin, shopId: 8 }, `/deliveries/${httpItem.id}/correct-terminal`, body)).status, 403);
      console.log("PASS actual HTTP admin-only correction and cashier protected financial projections");
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
