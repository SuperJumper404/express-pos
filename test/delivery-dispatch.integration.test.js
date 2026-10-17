const assert = require("assert");
const express = require("express");
const jwt = require("jsonwebtoken");
const mysql = require("mysql2/promise");
const { withDeliveryDatabase } = require("./helpers/deliveryDatabase");

async function captureRegistrationDiagnostic(work) {
  const originalLog = console.log;
  const diagnostics = [];
  console.log = (...args) => {
    if (args.length === 1 && args[0] === "GOOD") diagnostics.push(args[0]);
    else originalLog.apply(console, args);
  };
  try {
    const result = await work();
    assert.deepEqual(diagnostics, ["GOOD"]);
    return result;
  } finally { console.log = originalLog; }
}

async function main() {
  await withDeliveryDatabase(async db => {
    await db.seedScenario();
    require.cache[require.resolve("../src/config/dbPool")] = { exports: db.pool };
    require.cache[require.resolve("../src/config/db")] = { exports: db.pool.pool };
    if (Number(process.versions.node.split(".")[0]) < 22) require.cache[require.resolve("nanoid")] = { exports: await import("nanoid") };
    if (process.env.TASK5_REVIEW_FILTER) return runReviewRegressions(db, process.env.TASK5_REVIEW_FILTER);
    const { buildDeliveryDispatch } = require("../src/modules/m_deliveryDispatch");
    const dispatch = buildDeliveryDispatch();
    const operator = { subject: "staff", id: 10, shopId: 7, access: 1 };
    const courier = { subject: "staff", id: 11, shopId: 7, access: 6 };
    await db.pool.query(`UPDATE users SET courier_available = 1, module_permissions = '["orders","stocks","delivery"]' WHERE access = 6`);
    await db.pool.query(`UPDATE users SET module_permissions = '["delivery"]' WHERE id = 10`);
    await db.pool.query("UPDATE orders SET subtotal_before_discount = 12.50, discount_amount = 0, status = 3, payment_status = 'paid' WHERE id = 31");
    await db.pool.query(`INSERT INTO delivery_charge_snapshots
      (shopid,delivery_id,revision,band_fee_cents,free_delivery_applied,fee_cents,total_excl_tax_cents,tax_cents,vat_rate,fiscal_policy)
      VALUES (7,'41',1,0,0,0,0,0,10,'{"mode":"configured_rate","vatRate":10}')`);
    await db.pool.query("INSERT INTO orderdetail (orderid,productid,qty,price,total) VALUES (31,21,1,12.50,12.50)");
    const input = (actor, version, key, extra = {}) => ({ actor, deliveryId: "41", expectedVersion: version, idempotencyKey: key, ...extra });
    const attempts = await Promise.allSettled([
      dispatch.assign(input(operator, 1, "assign-a", { courierId: 11 })),
      dispatch.assign(input(operator, 1, "assign-b", { courierId: 11 })),
    ]);
    assert.equal(attempts.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(attempts.find(r => r.status === "rejected").reason.code, "DELIVERY_VERSION_CONFLICT");
    const acceptedKey = attempts[0].status === "fulfilled" ? "assign-a" : "assign-b";
    assert.equal((await dispatch.assign(input(operator, 1, acceptedKey, { courierId: 11 }))).version, 2);
    await assert.rejects(dispatch.assign(input(operator, 1, acceptedKey, { courierId: 12 })), { code: "DELIVERY_IDEMPOTENCY_CONFLICT" });
    await assert.rejects(dispatch.get({ actor: { ...courier, shopId: 8 }, deliveryId: "41" }), { status: 404 });
    const detail = await dispatch.get({ actor: courier, deliveryId: "41" });
    assert.equal(detail.contactSnapshot.phone, "0700000000");
    assert.equal(detail.items[0].name, "Fixture product");
    await db.pool.query("UPDATE orders SET status = 2 WHERE id = 31");
    await assert.rejects(dispatch.pickup(input(courier, 2, "pickup-not-ready")), { code: "DELIVERY_PREPARATION_NOT_FINISHED" });
    await db.pool.query("UPDATE orders SET status = 3 WHERE id = 31");
    await db.pool.query("UPDATE users SET courier_available = 0 WHERE id = 11");
    const picked = await dispatch.pickup(input(courier, 2, "pickup"));
    assert.equal(picked.deliveryStatus, "in_transit");
    const stock = await db.readRows("SELECT stock FROM products WHERE id = 21");
    await dispatch.reportIssue(input(courier, 3, "issue", { reason: "Absent" }));
    await assert.rejects(dispatch.deliver(input(courier, 4, "blocked")), { code: "DELIVERY_TRANSITION_INVALID" });
    await assert.rejects(dispatch.resolveIssue(input(operator, 4, "no-transfer", { action: "retry", courierId: 11, reason: "Retry" })), { code: "DELIVERY_PHYSICAL_CONFIRMATION_REQUIRED" });
    await dispatch.resolveIssue(input(operator, 4, "resume", { action: "resume", reason: "Contact restored" }));
    await db.pool.query("UPDATE orders SET payment_status = 'unpaid' WHERE id = 31");
    await assert.rejects(dispatch.deliver(input(courier, 5, "unpaid")), { code: "DELIVERY_PAYMENT_NOT_SETTLED" });
    await dispatch.reportIssue(input(courier, 5, "issue-unpaid", { reason: "Already handed over" }));
    const closed = await dispatch.resolveIssue(input(operator, 6, "unpaid-resolution", { action: "confirm_unpaid_delivery", reason: "Restaurant confirms handover" }));
    assert.equal(closed.remainingDueCents, 1250);
    const privateRead = await dispatch.get({ actor: courier, deliveryId: "41" });
    assert.equal(privateRead.addressSnapshot, undefined);
    assert.equal(privateRead.contactSnapshot, undefined);
    assert.equal(privateRead.orderReference, "FIXTURE-31");
    const replay = await dispatch.pickup(input(courier, 2, "pickup"));
    assert.equal(replay.addressSnapshot, undefined);
    assert.equal(replay.contactSnapshot, undefined);
    assert.equal(replay.deliveryStatus, "delivered");
    assert.deepEqual(await db.readRows("SELECT stock FROM products WHERE id = 21"), stock);
    assert.equal((await db.readRows("SELECT payment_status FROM orders WHERE id = 31"))[0].payment_status, "unpaid");
    await db.pool.query("UPDATE users SET status = 0 WHERE id = 11");
    await assert.rejects(dispatch.get({ actor: courier, deliveryId: "41" }), { status: 403 });
    assert.equal((await dispatch.get({ actor: operator, deliveryId: "41" })).remainingDueCents, 1250);
    console.log("PASS SQL assignment race/version/idempotence, own detail, ready pickup, issue resolution, unpaid and closed replay privacy");

    await db.pool.query("UPDATE users SET status = 1, courier_available = 1 WHERE id = 11");
    await db.pool.query(`INSERT INTO users (id, shopid, username, email, password, phone, access, status, created, clearpass, courier_available)
      VALUES (13,7,'Courier 13','13@example.test','not-a-login','',6,1,NOW(),'',1),
      (14,7,'Admin','14@example.test','not-a-login','',0,1,NOW(),'',0),
      (15,7,'Server','15@example.test','not-a-login','',4,1,NOW(),'',0),
      (16,7,'Kitchen','16@example.test','not-a-login','',5,1,NOW(),'',0),
      (17,7,'Legacy customer','17@example.test','not-a-login','',3,1,NOW(),'',0),
      (18,7,'Legacy cashier','18@example.test','not-a-login','',1,1,NOW(),'',0)`);
    await db.pool.query("UPDATE users SET module_permissions = '[]' WHERE id = 18");
    let next = 100;
    const make = async ({ status = 3, payment = "paid", deliveryId } = {}) => {
      const id = next++;
      deliveryId = deliveryId || String(id);
      await db.pool.query(`INSERT INTO orders (id,shopid,ordernumber,customer,customerID,operator,subtotal,subtotal_before_discount,discount_amount,payment_status,status,created,finished,is_takeaway)
        VALUES (?,7,?,'Fixture',10,10,12.50,12.50,0,?,?,NOW(),NOW(),1)`, [id, `TASK5-${id}`, payment, status]);
      await db.pool.query(`INSERT INTO deliveries (id,shopid,origin_order_id,order_reference,address_snapshot,contact_snapshot,latitude,longitude,distance_meters,settings_revision,client_order_token,confirmation_secret_hash,tracking_token_hash,tracking_expires_at)
        SELECT ?,7,?,?,address_snapshot,contact_snapshot,latitude,longitude,distance_meters,1,?,SHA2(?,256),SHA2(?,256),tracking_expires_at FROM deliveries WHERE id = 41`,
      [deliveryId, id, `TASK5-${id}`, `task5-${id}`, `confirmation-${id}`, `tracking-${id}`]);
      await db.pool.query("UPDATE orders SET delivery_id = ?, fulfillment_type = 'delivery' WHERE id = ?", [deliveryId, id]);
      await db.pool.query(`INSERT INTO delivery_charge_snapshots (shopid,delivery_id,revision,band_fee_cents,free_delivery_applied,fee_cents,total_excl_tax_cents,tax_cents,vat_rate,fiscal_policy)
        VALUES (7,?,1,0,0,0,0,0,10,'{"mode":"configured_rate","vatRate":10}')`, [deliveryId]);
      await db.pool.query("INSERT INTO orderdetail (orderid,productid,qty,price,total) VALUES (?,21,1,12.50,12.50)", [id]);
      await db.pool.query(`INSERT INTO orderdetail_customization_snapshots (orderdetail_id, step_name, step_position, choice_type, choice_name, choice_position, unit_extra_price, created)
        SELECT id,'Size',1,'simple','Large',1,0,NOW() FROM orderdetail WHERE orderid = ?`, [id]);
      return { id, deliveryId };
    };
    const mutation = (item, actor, version, key, extra = {}) => ({ actor, deliveryId: item.deliveryId, expectedVersion: version, idempotencyKey: key, ...extra });
    const a = await make();
    const b = await make();
    for (const item of [a, b]) await dispatch.assign(mutation(item, operator, 1, `multi-${item.id}`, { courierId: 11 }));
    assert.equal((await dispatch.list({ actor: courier })).filter(view => view.deliveryStatus === "assigned").length, 2);
    await assert.rejects(dispatch.assign(mutation(a, courier, 2, "courier-self-assign", { courierId: 11 })), { status: 403 });
    await assert.rejects(dispatch.assign(mutation(a, operator, 2, "other-shop", { courierId: 12 })), { code: "DELIVERY_COURIER_UNAVAILABLE" });
    await dispatch.assign(mutation(a, operator, 2, "reassign", { courierId: 13 }));
    await assert.rejects(dispatch.get({ actor: courier, deliveryId: a.deliveryId }), { status: 404 });
    await assert.rejects(dispatch.pickup(mutation(a, courier, 2, "old-pickup")), { status: 404 });
    await assert.rejects(dispatch.assign(mutation(a, courier, 1, `multi-${a.id}`, { courierId: 11 })), { status: 404 });
    await dispatch.pickup(mutation(b, courier, 2, "transfer-pickup"));
    await assert.rejects(dispatch.assign(mutation(b, operator, 3, "direct-transfer", { courierId: 13 })), { code: "DELIVERY_TRANSITION_INVALID" });
    await dispatch.reportIssue(mutation(b, courier, 3, "transfer-issue", { reason: "Vehicle" }));
    await dispatch.resolveIssue(mutation(b, operator, 4, "physical-transfer", { action: "retry", courierId: 13, reason: "Handover", physicalTransferConfirmed: true }));
    await assert.rejects(dispatch.pickup(mutation(b, courier, 2, "transfer-pickup")), { status: 404 });
    assert.equal((await dispatch.get({ actor: { ...courier, id: 13 }, deliveryId: b.deliveryId })).courierId, 13);
    const pending = await make({ payment: "requires_payment" });
    await assert.rejects(dispatch.assign(mutation(pending, operator, 1, "pending-assign", { courierId: 11 })), { code: "DELIVERY_TRANSITION_INVALID" });
    await db.pool.query("UPDATE orders SET payment_status = 'canceled' WHERE id = ?", [pending.id]);
    await assert.rejects(dispatch.assign(mutation(pending, operator, 1, "canceled-payment", { courierId: 11 })), { code: "DELIVERY_TRANSITION_INVALID" });
    await db.pool.query("UPDATE orders SET payment_status = 'paid' WHERE id = ?", [pending.id]);
    await dispatch.assign(mutation(pending, operator, 1, "reconciled", { courierId: 11 }));
    console.log("PASS SQL multiassignment, reassign privacy, physical transfer and current payment acceptance");

    const archive = await make({ deliveryId: "9007199254740993" });
    await dispatch.assign(mutation(archive, operator, 1, "archive-assign", { courierId: 11 }));
    const orders = require("../src/modules/m_orders");
    await orders.mArchiveOrder(archive.id, undefined, 7);
    const archivedDetail = await dispatch.get({ actor: courier, deliveryId: archive.deliveryId });
    assert.equal(archivedDetail.id, "9007199254740993");
    assert.equal(archivedDetail.preparationStatus, 3);
    assert.equal(archivedDetail.items[0].customizations[0].choice, "Large");
    await dispatch.pickup(mutation(archive, courier, 2, "archive-pickup"));
    const fixtureUrl = new URL(process.env.DELIVERY_TEST_DATABASE_URL);
    const legacyPool = mysql.createPool({ host: fixtureUrl.hostname, port: Number(fixtureUrl.port), user: decodeURIComponent(fixtureUrl.username),
      password: decodeURIComponent(fixtureUrl.password), database: db.database, supportBigNumbers: false, bigNumberStrings: false, timezone: "Z" });
    try {
      await db.pool.query("ALTER TABLE delivery_events AUTO_INCREMENT = 9007199254740993");
      const { createTransactionRunner } = require("../src/helpers/withTransaction");
      const actualDriverDispatch = buildDeliveryDispatch({ runInTransaction: createTransactionRunner(legacyPool) });
      const final = await actualDriverDispatch.deliver(mutation(archive, courier, 3, "archive-deliver"));
      assert.equal(final.eventId, "9007199254740993");
      assert.equal(final.id, "9007199254740993");
      assert.equal(final.addressSnapshot, undefined);
      assert.equal((await actualDriverDispatch.pickup(mutation(archive, courier, 2, "archive-pickup"))).contactSnapshot, undefined);
    } finally { await legacyPool.end(); }
    console.log("PASS SQL archived ready pickup, customization and production-driver BIGINT event/delivery projection");

    const waitForLocks = async count => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const [rows] = await db.pool.query(`SELECT COUNT(*) AS n FROM performance_schema.data_lock_waits w
          JOIN performance_schema.data_locks l ON l.ENGINE = w.ENGINE AND l.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID
          WHERE l.OBJECT_SCHEMA = ?`, [db.database]);
        if (Number(rows[0].n) >= count) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.fail("Expected actual SQL lock waits");
    };
    const duringArchive = await make();
    await dispatch.assign(mutation(duringArchive, operator, 1, "during-archive-assign", { courierId: 11 }));
    let archiveReady;
    let releaseArchive;
    const ready = new Promise(resolve => { archiveReady = resolve; });
    const resume = new Promise(resolve => { releaseArchive = resolve; });
    const heldArchiver = orders.buildOrderArchiveModule({ withTransaction: work => require("../src/helpers/withTransaction").createTransactionRunner(db.pool)(async connection => {
      const result = await work(connection);
      archiveReady();
      await resume;
      return result;
    }) });
    const archiving = heldArchiver.mArchiveOrder(duringArchive.id, undefined, 7);
    let waitingPickup;
    try {
      await Promise.race([ready, archiving.then(() => assert.fail("Archive must wait at commit"))]);
      waitingPickup = dispatch.pickup(mutation(duringArchive, courier, 2, "during-archive-pickup"));
      const watched = Promise.allSettled([waitingPickup]);
      await waitForLocks(1);
      releaseArchive();
      await archiving;
      const [result] = await watched;
      assert.equal(result.status, "fulfilled", result.reason && result.reason.code);
      assert.equal(result.value.items.length, 1, "Current archived items must survive the pre-archive RR snapshot");
      assert.equal(result.value.items[0].customizations[0].choice, "Large");
    } finally { releaseArchive(); await archiving; if (waitingPickup) await waitingPickup.catch(() => {}); }
    console.log("PASS SQL pickup waits for actual archive commit and reads current archived items/customizations");
    const revised = await make();
    const barrier = await db.pool.getConnection();
    let revision;
    try {
      await barrier.beginTransaction();
      await barrier.query("SELECT id FROM orders WHERE id = ? FOR UPDATE", [revised.id]);
      revision = dispatch.assign(mutation(revised, operator, 1, "after-charge-revision", { courierId: 11 }));
      const watched = Promise.allSettled([revision]);
      await waitForLocks(1);
      await barrier.query(`INSERT INTO delivery_charge_snapshots (shopid,delivery_id,revision,band_fee_cents,free_delivery_applied,fee_cents,total_excl_tax_cents,tax_cents,vat_rate,fiscal_policy)
        VALUES (7,?,2,100,0,100,91,9,10,'{"mode":"configured_rate","vatRate":10}')`, [revised.deliveryId]);
      await barrier.query("UPDATE deliveries SET charge_revision = 2 WHERE id = ?", [revised.deliveryId]);
      await barrier.query("UPDATE orders SET subtotal = 13.50 WHERE id = ?", [revised.id]);
      await barrier.commit();
      const [outcome] = await watched;
      assert.equal(outcome.status, "fulfilled", outcome.reason && outcome.reason.code);
      const result = outcome.value;
      assert.equal(result.financials.delivery_fee, 1);
      assert.equal(result.financials.grand_total, 13.5);
    } finally { await barrier.rollback(); barrier.release(); if (revision) await revision.catch(() => {}); }
    const racingArchive = await make();
    const blocker = await db.pool.getConnection();
    let racing = [];
    try {
      await blocker.beginTransaction();
      await blocker.query("SELECT id FROM orders WHERE id = ? FOR UPDATE", [racingArchive.id]);
      racing = [dispatch.assign(mutation(racingArchive, operator, 1, "race-archive", { courierId: 11 })), orders.mArchiveOrder(racingArchive.id, undefined, 7)];
      const results = Promise.allSettled(racing);
      await waitForLocks(2);
      await blocker.commit();
      const completed = await results;
      for (const result of completed) assert.equal(result.status, "fulfilled", result.reason && result.reason.code);
      const view = await dispatch.get({ actor: courier, deliveryId: racingArchive.deliveryId });
      assert.equal(view.deliveryStatus, "assigned");
      assert.equal(view.preparationStatus, 3);
    } finally { await blocker.rollback(); blocker.release(); await Promise.allSettled(racing); }
    console.log("PASS SQL observed commercial waits, current locked charge revision and actual dispatch/archive overlap");

    const rollback = await make();
    const { createTransactionRunner } = require("../src/helpers/withTransaction");
    const transaction = createTransactionRunner(db.pool);
    const failing = buildDeliveryDispatch({ runInTransaction: work => transaction(async connection => {
      await work(connection);
      throw new Error("Injected transaction failure");
    }) });
    await assert.rejects(failing.assign(mutation(rollback, operator, 1, "rollback", { courierId: 11 })), /Injected transaction failure/);
    assert.equal((await dispatch.get({ actor: operator, deliveryId: rollback.deliveryId })).version, 1);
    assert.equal((await db.readRows("SELECT id FROM delivery_events WHERE idempotency_key = 'rollback'")).length, 0);
    for (const action of ["return", "fail", "cancel"]) {
      const item = await make();
      await dispatch.assign(mutation(item, operator, 1, `close-assign-${action}`, { courierId: 11 }));
      await dispatch.pickup(mutation(item, courier, 2, `close-pickup-${action}`));
      await dispatch.reportIssue(mutation(item, courier, 3, `close-issue-${action}`, { reason: "Problem" }));
      const result = await dispatch.resolveIssue(mutation(item, operator, 4, `close-resolution-${action}`, { action, reason: "Restaurant decision", physicalTransferConfirmed: true }));
      assert.equal(result.deliveryStatus, action === "return" ? "unassigned" : action === "fail" ? "failed" : "canceled");
      assert.equal((await db.readRows("SELECT payment_status FROM orders WHERE id = ?", [item.id]))[0].payment_status, "paid");
      if (action !== "return") {
        const summary = await dispatch.get({ actor: courier, deliveryId: item.deliveryId });
        assert.equal(summary.addressSnapshot, undefined);
        assert.equal(summary.contactSnapshot, undefined);
      }
    }
    assert.deepEqual(await db.readRows("SELECT stock FROM products WHERE id = 21"), stock);
    assert.equal((await db.readRows("SELECT id FROM delivery_payment_collections")).length, 0);
    console.log("PASS SQL atomic rollback, return/fail/cancel journal, no automatic financial or stock changes");

    const app = express();
    app.use(express.json());
    app.use("/baseurl/api/v1", require("../src/helpers/middleware/auth").authenticationIfPresent);
    app.use("/baseurl/api/v1", require("../src/routers/r_courier"));
    app.use("/baseurl/api/v1", require("../src/routers/r_delivery"));
    app.use("/baseurl/api/v1", require("../src/routers/r_orders"));
    app.use("/baseurl/api/v1", require("../src/routers/r_products"));
    app.use("/baseurl/api/v1", require("../src/routers/stocks"));
    app.use("/baseurl/api/v1", require("../src/routers/r_users"));
    const server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    const url = `http://127.0.0.1:${server.address().port}/baseurl/api/v1`;
    const http = async (path, { method = "GET", id = 11, access = 0, body, claims = {} } = {}) => {
      const token = jwt.sign({ id, access, shopid: 7, module_permissions: ["orders", "stocks", "delivery"], ...claims }, process.env.JWTKEY);
      const res = await fetch(url + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, cache: res.headers.get("cache-control"), body: await res.text() };
    };
    try {
      assert.equal((await http("/courier/deliveries")).status, 200);
      assert.equal((await http("/courier/deliveries/" + pending.deliveryId)).cache, "no-store");
      assert.equal((await http("/orders")).status, 403);
      for (const path of ["/users", "/metrics", "/detailorder/31", "/products", "/stocks"]) assert.equal((await http(path)).status, 403, path);
      assert.equal((await http("/product/21", { method: "PATCH", body: { stock: 100 } })).status, 403);
      assert.equal((await http("/stocks", { method: "POST", body: { productid: 21 } })).status, 403);
      assert.equal((await http("/courier/cash-balance")).status, 404);
      assert.equal((await http("/courier/deliveries/41/collect-payment", { method: "POST", body: {} })).status, 404);
      assert.equal((await http("/deliveries", { id: 10 })).status, 200);
      assert.equal((await http("/delivery/settings", { id: 10 })).status, 403);
      assert.equal((await http("/courier/deliveries/" + a.deliveryId)).status, 404);
      const unavailable = await make();
      assert.equal((await http("/courier/availability", { method: "PATCH", body: { available: false } })).status, 200);
      await assert.rejects(dispatch.assign(mutation(unavailable, operator, 1, "unavailable", { courierId: 11 })), { code: "DELIVERY_COURIER_UNAVAILABLE" });
      const pickup = await http(`/courier/deliveries/${pending.deliveryId}/pickup`, { method: "POST", body: { expectedVersion: 2, idempotencyKey: "http-pickup" } });
      assert.equal(pickup.status, 200, pickup.body);
      const delivery = await http(`/courier/deliveries/${pending.deliveryId}/deliver`, { method: "POST", body: { expectedVersion: 3, idempotencyKey: "http-deliver" } });
      assert.equal(delivery.status, 200, delivery.body);
      assert.equal(JSON.parse(delivery.body).data.addressSnapshot, undefined);
      await db.pool.query("UPDATE users SET status = 0 WHERE id = 11");
      assert.equal((await http("/courier/deliveries")).status, 403);
      assert.equal((await http("/deliveries/41", { id: 10 })).status, 200);
      await db.pool.query("UPDATE users SET status = 1 WHERE id = 11");
      const created = await captureRegistrationDiagnostic(() => http("/register", { method: "POST", id: 14, body: { username: "New courier", access: 6, module_permissions: ["orders", "stocks", "delivery"], service_point_id: 999 } }));
      assert.equal(created.status, 200, created.body);
      const credentials = JSON.parse(created.body).data;
      const [account] = await db.readRows("SELECT id, access, module_permissions, service_point_id FROM users WHERE staff_login_id = ?", [credentials.staff_login_id]);
      assert.equal(account.access, 6);
      assert.equal(account.module_permissions, "[]");
      assert.equal(account.service_point_id, null);
      const login = await fetch(url + "/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ staff_login_id: credentials.staff_login_id, pin: credentials.staff_pin }) });
      assert.equal(login.status, 200);
      const session = (await login.json()).data[0];
      assert.equal(session.id, account.id);
      assert.equal(session.access, 6);
      assert.equal(session.password, undefined);
      assert.equal(session.staff_pin_hash, undefined);
      console.log("PASS SQL actual HTTP courier/operator routes, stale admin JWT, availability and active-account reload");
      await db.pool.query("UPDATE users SET courier_available = 1 WHERE id = 11");
      const failures = [];
      const test = async (name, work) => {
        try { await work(); console.log(`PASS SQL ${name}`); }
        catch (error) { failures.push(name); console.log(`FAIL SQL ${name}: ${error.code || error.name} actual=${error.actual} expected=${error.expected}`); }
      };
      const issue = async payment => {
        const item = await make({ payment });
        await dispatch.assign(mutation(item, operator, 1, `issue-assign-${item.id}`, { courierId: 11 }));
        await dispatch.reportIssue(mutation(item, courier, 2, `issue-${item.id}`, { reason: "Restaurant resolution required" }));
        return item;
      };
      await test("unresolved issue blocks actual manual collection then reasoned resume permits legacy cashier", async () => {
        const item = await issue("unpaid");
        const collection = await http(`/orders/collect/${item.id}`, { method: "POST", id: 10, body: { payment_method: "cash" } });
        assert.equal(collection.status, 409, collection.body);
        assert.equal(JSON.parse(collection.body).data.code, "DELIVERY_TRANSITION_INVALID");
        assert.equal((await db.readRows("SELECT payment_status FROM orders WHERE id = ?", [item.id]))[0].payment_status, "unpaid");
        await dispatch.resolveIssue(mutation(item, operator, 3, `resume-${item.id}`, { action: "resume", reason: "Restaurant authorizes retry before settlement" }));
        const accepted = await http(`/orders/collect/${item.id}`, { method: "POST", id: 18, body: { payment_method: "cash" } });
        assert.equal(accepted.status, 200, accepted.body);
        const view = await dispatch.get({ actor: operator, deliveryId: item.deliveryId });
        assert.equal(view.paymentStatus, "paid");
        assert.equal(view.deliveryStatus, "assigned");
        assert.equal(view.version, 4);
        const events = await db.readRows("SELECT reason, actor_id FROM delivery_events WHERE delivery_id = ? AND event_type = 'resolveIssue'", [item.deliveryId]);
        assert.equal(events.length, 1);
        assert.equal(events[0].actor_id, "10");
        assert.equal(events[0].reason, "Restaurant authorizes retry before settlement");
      });
      await test("unpaid issue blocks actual archive settlement without changing active rows", async () => {
        const item = await issue("unpaid");
        await assert.rejects(orders.mArchiveOrder(item.id, "cash", 7), { code: "DELIVERY_TRANSITION_INVALID", status: 409 });
        const archived = await http(`/orders/archive/${item.id}`, { method: "POST", id: 10, body: { payment_method: "cash" } });
        assert.equal(archived.status, 409, archived.body);
        assert.equal(JSON.parse(archived.body).data.code, "DELIVERY_TRANSITION_INVALID");
        assert.equal((await db.readRows("SELECT payment_status FROM orders WHERE id = ?", [item.id]))[0].payment_status, "unpaid");
        assert.equal((await db.readRows("SELECT id FROM archives WHERE delivery_id = ?", [item.deliveryId])).length, 0);
        await dispatch.resolveIssue(mutation(item, operator, 3, `archive-resume-${item.id}`, { action: "resume", reason: "Incident resolved before settlement" }));
        assert.equal((await http(`/orders/archive/${item.id}`, { method: "POST", id: 18, body: { payment_method: "cash" } })).status, 200);
        assert.equal((await dispatch.get({ actor: operator, deliveryId: item.deliveryId })).deliveryStatus, "assigned");
      });
      for (const [id, label, claims] of [[15, "server", {}], [16, "kitchen", {}], [17, "legacy customer", {}],
        [14, "customer subject", { subject_type: "customer" }], [14, "point3", { subject_type: "service_point", access: 3, service_point_id: 701 }],
        [14, "point2", { subject_type: "service_point", access: 2, service_point_id: 702 }]]) {
        await test(`${label} cannot manually settle or archive an unpaid delivery`, async () => {
          const item = await make({ payment: "unpaid" });
          const forged = { payment_method: "cash", actor: { subject: "staff", id: 14, access: 0 }, access: 0, currentUser: { id: 14, access: 0, status: 1 } };
          const collection = await http(`/orders/collect/${item.id}`, { method: "POST", id, claims, body: forged });
          assert.equal(collection.status, 403, collection.body);
          assert.equal((await http(`/orders/archive/${item.id}`, { method: "POST", id, claims, body: forged })).status, 403);
          assert.equal((await db.readRows("SELECT payment_status FROM orders WHERE id = ?", [item.id]))[0].payment_status, "unpaid");
        });
      }
      for (const claims of [{ subject_type: "service_point", access: 3, service_point_id: 701 }, { subject_type: "customer" }]) {
        await test(`${claims.subject_type} cannot archive a paid delivery`, async () => {
          const item = await make();
          assert.equal((await http(`/orders/archive/${item.id}`, { method: "POST", id: 14, claims, body: {} })).status, 403);
          assert.equal((await db.readRows("SELECT id FROM orders WHERE id = ?", [item.id])).length, 1);
        });
      }
      await test("active staff preparation roles archive paid or refunded issues without clearing logistics", async () => {
        for (const [id, payment] of [[14, "paid"], [10, "paid"], [15, "refunded"], [16, "paid"], [16, "refunded"]]) {
          const item = await issue(payment);
          const archived = await http(`/orders/archive/${item.id}`, { method: "POST", id, body: {} });
          assert.equal(archived.status, 200, archived.body);
          const view = await dispatch.get({ actor: operator, deliveryId: item.deliveryId });
          assert.equal(view.paymentStatus, payment);
          assert.equal(view.preparationStatus, 3);
          assert.equal(view.deliveryStatus, "issue");
          assert.equal(view.version, 3);
        }
        const item = await make();
        await db.pool.query("UPDATE users SET status = 0 WHERE id = 16");
        try { assert.equal((await http(`/orders/archive/${item.id}`, { method: "POST", id: 16, body: {} })).status, 403); }
        finally { await db.pool.query("UPDATE users SET status = 1 WHERE id = 16"); }
        const guest = await fetch(url + `/orders/archive/${item.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        assert.equal(guest.status, 401);
      });
      await test("admin manual settlement and non-delivery legacy permissions remain unchanged", async () => {
        const item = await make({ payment: "unpaid" });
        assert.equal((await http(`/orders/collect/${item.id}`, { method: "POST", id: 14, body: { payment_method: "cash" } })).status, 200);
        const id = next++;
        await db.pool.query(`INSERT INTO orders (id,shopid,ordernumber,customer,customerID,operator,subtotal,subtotal_before_discount,discount_amount,payment_status,status,created,finished,is_takeaway)
          VALUES (?,7,?,'Legacy',10,10,12.50,12.50,0,'unpaid',3,NOW(),NOW(),1)`, [id, `TASK5-LEGACY-${id}`]);
        await db.pool.query("INSERT INTO orderdetail (orderid,productid,qty,price,total) VALUES (?,21,1,12.50,12.50)", [id]);
        assert.equal((await http(`/orders/collect/${id}`, { method: "POST", id: 15, body: { payment_method: "cash" } })).status, 200);
        assert.equal((await http(`/orders/archive/${id}`, { method: "POST", claims: { subject_type: "service_point", access: 3, service_point_id: 701 }, body: {} })).status, 200);
      });
      await test("locked issue wins against queued manual collection and unpaid archive", async () => {
        for (const action of ["collect", "archive"]) {
          const item = await make({ payment: "unpaid" });
          await dispatch.assign(mutation(item, operator, 1, `racing-assign-${item.id}`, { courierId: 11 }));
          const gate = await db.pool.getConnection();
          let racing = [];
          try {
            await gate.beginTransaction();
            await gate.query("SELECT id FROM orders WHERE id = ? FOR UPDATE", [item.id]);
            racing.push(dispatch.reportIssue(mutation(item, courier, 2, `racing-issue-${item.id}`, { reason: "Incident wins commercial lock" })));
            const incident = Promise.allSettled(racing);
            await waitForLocks(1);
            racing.push(action === "collect" ? orders.collectDeliveryOrderPayment({ orderId: item.id, shopId: 7, paymentMethod: "cash" }) : orders.mArchiveOrder(item.id, "cash", 7));
            const outcomes = Promise.allSettled(racing);
            await waitForLocks(2);
            await gate.commit();
            const [reported, rejected] = await outcomes;
            assert.equal(reported.status, "fulfilled");
            assert.equal(rejected.status, "rejected");
            assert.equal(rejected.reason.code, "DELIVERY_TRANSITION_INVALID");
            assert.equal((await incident)[0].status, "fulfilled");
            assert.equal((await db.readRows("SELECT payment_status FROM orders WHERE id = ?", [item.id]))[0].payment_status, "unpaid");
          } finally { await gate.rollback(); gate.release(); await Promise.allSettled(racing); }
        }
      });
      await test("engaged provider reconciliation remains allowed during issue", async () => {
        const item = await issue("unpaid");
        const intentId = `pi_task5_issue_${item.id}`;
        await db.pool.query("UPDATE orders SET payment_status = 'requires_payment', payment_provider = 'stripe', stripe_payment_intent_id = ? WHERE id = ?", [intentId, item.id]);
        await db.pool.query(`INSERT INTO payments (order_id,shop_id,stripe_payment_intent_id,amount,amount_cents,application_fee_amount,currency,status,created)
          VALUES (?,7,?,12.50,1250,0,'eur','requires_payment_method',NOW())`, [item.id, intentId]);
        const payment = await require("../src/modules/m_payments").markPaymentSucceeded({ id: intentId, latest_charge: `ch_${intentId}`, payment_method_types: ["card"] });
        assert.equal(payment.paid, true);
        const view = await dispatch.get({ actor: operator, deliveryId: item.deliveryId });
        assert.equal(view.paymentStatus, "paid");
        assert.equal(view.deliveryStatus, "issue");
        assert.equal(view.preparationStatus, 3);
        assert.equal(view.version, 3);
      });
      assert.deepEqual(failures, [], "All bounded completion SQL/HTTP contracts must pass");
    } finally { await new Promise(resolve => server.close(resolve)); }
    await runReviewRegressions(db);
  });
}

async function runReviewRegressions(db, filter) {
  const { buildDeliveryDispatch } = require("../src/modules/m_deliveryDispatch");
  const { createTransactionRunner } = require("../src/helpers/withTransaction");
  await db.pool.query("UPDATE orders SET subtotal_before_discount = COALESCE(subtotal_before_discount, subtotal), discount_amount = COALESCE(discount_amount, 0) WHERE id = 31");
  await db.pool.query(`INSERT IGNORE INTO delivery_charge_snapshots (shopid,delivery_id,revision,band_fee_cents,free_delivery_applied,fee_cents,total_excl_tax_cents,tax_cents,vat_rate,fiscal_policy)
    VALUES (7,'41',1,0,0,0,0,0,10,'{"mode":"configured_rate","vatRate":10}')`);
  await db.pool.query(`INSERT IGNORE INTO users (id, shopid, username, email, password, phone, access, status, created, clearpass, courier_available, image)
    VALUES (13,7,'Courier 13','13@example.test','fixture','',6,1,NOW(),'',1,'defaultuser.png'),
    (14,7,'Admin','14@example.test','fixture','',0,1,NOW(),'',0,'defaultuser.png'),
    (15,7,'Server','15@example.test','fixture','',4,1,NOW(),'',0,'defaultuser.png'),
    (16,7,'Kitchen','16@example.test','fixture','',5,1,NOW(),'',0,'defaultuser.png'),
    (900,7,'Account target','900@example.test','fixture','',1,1,NOW(),'',0,'defaultuser.png')`);
  await db.pool.query("UPDATE users SET courier_available = 1 WHERE id IN (11,13)");
  await db.pool.query(`UPDATE users SET module_permissions = '["delivery"]' WHERE id = 10`);
  const operator = { subject: "staff", id: 10, shopId: 7, access: 1 };
  const courier = id => ({ subject: "staff", id, shopId: 7, access: 6 });
  const dispatch = buildDeliveryDispatch();
  let next = 5000;
  const mission = async ({ status = "unassigned", courierId = null, shopId = 7, created = "2026-01-01 00:00:00" } = {}) => {
    const id = next++;
    const deliveryId = String(800000 + id);
    await db.pool.query(`INSERT INTO orders (id,shopid,ordernumber,customer,customerID,operator,subtotal,subtotal_before_discount,discount_amount,payment_status,status,created,finished,is_takeaway)
      VALUES (?,?,?,'Review fixture',?,?,12.50,12.50,0,'paid',3,?,?,1)`, [id, shopId, `REVIEW-${id}`, shopId === 7 ? 10 : 12, shopId === 7 ? 10 : 12, created, created]);
    await db.pool.query(`INSERT INTO deliveries (id,shopid,origin_order_id,order_reference,courier_id,delivery_status,address_snapshot,contact_snapshot,latitude,longitude,distance_meters,settings_revision,client_order_token,confirmation_secret_hash,tracking_token_hash,tracking_expires_at,created_at,closed_at)
      SELECT ?,?,?,?,?,?,address_snapshot,contact_snapshot,latitude,longitude,distance_meters,1,?,SHA2(?,256),SHA2(?,256),tracking_expires_at,?,?
      FROM deliveries WHERE id = 41`, [deliveryId, shopId, id, `REVIEW-${id}`, courierId, status, `review-${id}`, `review-confirm-${id}`, `review-track-${id}`, created, ["delivered", "failed", "canceled"].includes(status) ? created : null]);
    await db.pool.query("UPDATE orders SET delivery_id = ?, fulfillment_type = 'delivery' WHERE id = ?", [deliveryId, id]);
    await db.pool.query(`INSERT INTO delivery_charge_snapshots (shopid,delivery_id,revision,band_fee_cents,free_delivery_applied,fee_cents,total_excl_tax_cents,tax_cents,vat_rate,fiscal_policy)
      VALUES (?,?,1,0,0,0,0,0,10,'{"mode":"configured_rate","vatRate":10}')`, [shopId, deliveryId]);
    return { id, deliveryId };
  };
  const mutation = (item, actor, key, expectedVersion = 1, extra = {}) => ({ actor, deliveryId: item.deliveryId, expectedVersion, idempotencyKey: key, ...extra });
  const failures = [];
  const test = async (name, work) => {
    if (filter && !filter.split("|").some(part => name.startsWith(part))) return;
    try { await work(); console.log(`PASS SQL ${name}`); }
    catch (error) { failures.push(name); console.log(`FAIL SQL ${name}: ${error.code || error.name} actual=${error.actual} expected=${error.expected}`); }
  };
  const app = express();
  app.use(express.json());
  app.use("/baseurl/api/v1", require("../src/helpers/middleware/auth").authenticationIfPresent);
  app.use("/baseurl/api/v1", require("../src/routers/r_users"));
  app.use("/baseurl/api/v1", require("../src/routers/r_courier"));
  app.use("/baseurl/api/v1", require("../src/routers/r_delivery"));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}/baseurl/api/v1`;
  const http = async (path, { method = "GET", id = 14, body, claims = {} } = {}) => {
    const token = jwt.sign({ id, shopid: 7, access: 0, ...claims }, process.env.JWTKEY);
    const result = await fetch(url + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: result.status, body: await result.json() };
  };
  try {
    await test("C1 current nonadmins cannot self-promote through encoded user IDs", async () => {
      for (const [id, role, claims] of [[10,1,{}],[15,4,{}],[16,5,{}],[10,1,{ subject_type: "service_point", access: 3, service_point_id: 701 }]]) {
        try {
          const result = await http(`/user/${id}%2Fextra`, { method: "PATCH", id, claims, body: { access: 0 } });
          assert.equal(result.status, 403);
          assert.equal((await db.readRows("SELECT access FROM users WHERE id = ?", [id]))[0].access, role);
        } finally { await db.pool.query("UPDATE users SET access = ? WHERE id = ?", [role, id]); }
      }
    });
    await test("C1 admin rejects whole invalid IDs before update credential delete and read SQL", async () => {
      for (const id of ["900%2Fextra", "900%5Cextra", "900.0", "900e0", "900%20", "0", "2147483648"]) {
        for (const [method, suffix] of [["PATCH", ""], ["PATCH", "/staff-credentials"], ["DELETE", ""], ["GET", ""]]) {
          assert.equal((await http(`/user/${id}${suffix}`, { method, body: method === "PATCH" ? { username: "Invalid prefix" } : undefined })).status, 400, `${method} ${id}${suffix}`);
        }
      }
      assert.equal((await db.readRows("SELECT username FROM users WHERE id = 900"))[0].username, "Account target");
      assert.equal((await http("/user/900", { method: "PATCH", body: { username: "Authorized admin update" } })).status, 200);
      assert.equal((await db.readRows("SELECT username FROM users WHERE id = 900"))[0].username, "Authorized admin update");
      assert.equal((await http("/user/900/staff-credentials", { method: "PATCH", body: {} })).status, 200);
      assert.equal((await http("/user/900", { method: "DELETE" })).status, 200);
      assert.equal((await db.readRows("SELECT id FROM users WHERE id = 900")).length, 0);
    });
    await test("I1 independent pickups survive a one-shot real missing-journal gap deadlock", async () => {
      const first = await mission();
      const second = await mission();
      await dispatch.assign(mutation(first, operator, "review-assign-a", 1, { courierId: 11 }));
      await dispatch.assign(mutation(second, operator, "review-assign-b", 1, { courierId: 13 }));
      const stock = await db.readRows("SELECT stock FROM products WHERE id = 21");
      const reached = new Set();
      let release;
      let rollbackCount = 0;
      let sqlDeadlockCount = 0;
      const barrier = new Promise(resolve => { release = resolve; });
      const racing = buildDeliveryDispatch({ runInTransaction: createTransactionRunner({ getConnection: async () => {
        const connection = await db.pool.getConnection();
        return new Proxy(connection, { get(target, property) {
          if (property === "query") return async (sql, values) => {
            let result;
            try { result = await target.query(sql, values); }
            catch (error) { if (error.code === "ER_LOCK_DEADLOCK") sqlDeadlockCount++; throw error; }
            if (/FROM delivery_events.*idempotency_key/.test(sql) && values[1].startsWith("zz-review-pickup-") && !reached.has(values[1])) {
              assert.equal(result[0].length, 0);
              reached.add(values[1]);
              if (reached.size === 2) release();
              await barrier;
            }
            return result;
          };
          if (property === "rollback") return async () => { await target.rollback(); rollbackCount++; };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        } });
      } }) });
      const results = await Promise.allSettled([
        racing.pickup(mutation(first, courier(11), "zz-review-pickup-a", 2)),
        racing.pickup(mutation(second, courier(13), "zz-review-pickup-b", 2)),
      ]);
      assert.equal(reached.size, 2);
      for (const result of results) assert.equal(result.status, "fulfilled", result.reason && result.reason.code);
      assert.ok(rollbackCount >= 1, "Actual deadlock victim must finish rollback before retry");
      assert.ok(sqlDeadlockCount >= 1, "The barrier must produce the real SQL deadlock");
      for (const item of [first, second]) {
        const [row] = await db.readRows("SELECT version, delivery_status FROM deliveries WHERE id = ?", [item.deliveryId]);
        assert.equal(row.version, 3);
        assert.equal(row.delivery_status, "in_transit");
        assert.equal((await db.readRows("SELECT id FROM delivery_events WHERE delivery_id = ? AND event_type = 'pickup'", [item.deliveryId])).length, 1);
      }
      assert.equal((await racing.pickup(mutation(first, courier(11), "zz-review-pickup-a", 2))).idempotentReplay, true);
      await assert.rejects(racing.pickup(mutation(first, courier(11), "zz-review-pickup-a", 3)), { code: "DELIVERY_IDEMPOTENCY_CONFLICT" });
      assert.deepEqual(await db.readRows("SELECT stock FROM products WHERE id = 21"), stock);
    });
    await test("I1 retry is bounded and excludes unconfirmed rollback begin commit and network errors", async () => {
      for (const mode of ["work-deadlock", "rollback-failure", "after-work-deadlock", "network", "begin-deadlock"]) {
        const item = await mission();
        await dispatch.assign(mutation(item, operator, `policy-assign-${item.id}`, 1, { courierId: 11 }));
        let attempts = 0;
        const failure = code => Object.assign(new Error("Dispatch fault fixture"), { code });
        const source = createTransactionRunner(db.pool);
        const guarded = buildDeliveryDispatch({ runInTransaction: async work => {
          attempts++;
          if (mode === "begin-deadlock") throw failure("ER_LOCK_DEADLOCK");
          return source(async connection => {
            const proxy = new Proxy(connection, { get(target, property) {
              if (property === "query") return async (sql, values) => {
                const result = await target.query(sql, values);
                if (["work-deadlock", "rollback-failure"].includes(mode) && /FROM delivery_events.*idempotency_key/.test(sql)) throw failure("ER_LOCK_DEADLOCK");
                return result;
              };
              if (property === "rollback" && mode === "rollback-failure") return async () => { throw failure("ROLLBACK_UNCONFIRMED"); };
              const value = Reflect.get(target, property);
              return typeof value === "function" ? value.bind(target) : value;
            } });
            await work(proxy);
            throw failure(mode === "network" ? "ECONNRESET" : "ER_LOCK_DEADLOCK");
          });
        } });
        await assert.rejects(guarded.pickup(mutation(item, courier(11), `policy-pickup-${item.id}`, 2)), {
          code: mode === "rollback-failure" ? "ROLLBACK_UNCONFIRMED" : mode === "network" ? "ECONNRESET" : "ER_LOCK_DEADLOCK",
        });
        assert.equal(attempts, mode === "work-deadlock" ? 3 : 1, mode);
        assert.equal((await db.readRows("SELECT version FROM deliveries WHERE id = ?", [item.deliveryId]))[0].version, 2);
        assert.equal((await db.readRows("SELECT id FROM delivery_events WHERE idempotency_key = ?", [`policy-pickup-${item.id}`])).length, 0);
      }
    });
    await test("I2 all old operational work remains enumerable beyond 100 newer terminal missions", async () => {
      const active = [];
      for (const status of ["assigned", "in_transit", "issue"]) active.push(await mission({ status, courierId: 11 }));
      const unassigned = await mission();
      const foreignOwner = await mission({ status: "assigned", courierId: 13 });
      const foreignShop = await mission({ status: "assigned", courierId: 12, shopId: 8 });
      for (let index = 0; index < 103; index++) await mission({ status: ["delivered", "failed", "canceled"][index % 3], courierId: 11, created: "2026-10-17 12:00:00" });
      const own = await http("/courier/deliveries", { id: 11 });
      assert.equal(own.status, 200);
      assert.ok(Array.isArray(own.body.data));
      for (const item of active) assert.ok(own.body.data.some(view => view.id === item.deliveryId), `Missing own operational ${item.deliveryId}`);
      assert.equal(own.body.data.some(view => [foreignOwner.deliveryId, foreignShop.deliveryId, unassigned.deliveryId].includes(view.id)), false);
      const history = own.body.data.filter(view => ["delivered", "failed", "canceled"].includes(view.deliveryStatus));
      assert.equal(history.length, 100);
      for (const view of history) {
        assert.equal(view.addressSnapshot, undefined);
        assert.equal(view.contactSnapshot, undefined);
        assert.equal(view.items, undefined);
      }
      const restaurant = await http("/deliveries", { id: 10 });
      assert.equal(restaurant.status, 200);
      for (const item of [...active, unassigned, foreignOwner]) assert.ok(restaurant.body.data.some(view => view.id === item.deliveryId));
      assert.equal(restaurant.body.data.some(view => view.id === foreignShop.deliveryId), false);
    });
    await test("M1 known registration diagnostic is captured without stdout noise", async () => {
      const originalWrite = process.stdout.write;
      const output = [];
      let created;
      process.stdout.write = function (chunk, ...args) { output.push(String(chunk)); return originalWrite.call(this, chunk, ...args); };
      try { created = await captureRegistrationDiagnostic(() => http("/register", { method: "POST", body: { username: "Review registration", access: 6 } })); }
      finally { process.stdout.write = originalWrite; }
      assert.equal(created.status, 200);
      assert.equal(output.some(chunk => chunk.trim() === "GOOD"), false);
    });
    assert.deepEqual(failures, [], "Review regressions must pass");
  } finally { await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
