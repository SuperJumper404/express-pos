const assert = require("assert");
const fs = require("fs");
const path = require("path");
const express = require("express");
const jwt = require("jsonwebtoken");
const mysql = require("mysql2/promise");
const { withDeliveryDatabase } = require("./helpers/deliveryDatabase");

const tests = [];
const test = (name, work) => tests.push({ name, work });
const actor = (id = 10, access = 1, shopId = 7) => ({ subject: "staff", id, access, shopId });
const request = (extra = {}) => ({ actor: actor(), deliveryId: "41", returnSource: "courier", reason: "Confirmed full cash return", idempotencyKey: "refund", ...extra });

async function fixture(work) {
  await withDeliveryDatabase(async db => {
    await db.seedScenario();
    for (const key of Object.keys(require.cache)) if (key.startsWith(path.resolve(__dirname, "../src") + path.sep)) delete require.cache[key];
    const config = db.pool.pool.config.connectionConfig;
    const appPool = mysql.createPool({ host: config.host, port: config.port, user: config.user, password: config.password,
      database: db.database, charset: "utf8mb4", timezone: "Z", connectionLimit: 8 });
    require.cache[require.resolve("../src/config/dbPool")] = { exports: appPool };
    require.cache[require.resolve("../src/config/db")] = { exports: appPool.pool };
    require.cache[require.resolve("../src/config/stripe")] = { exports: { getStripe() { throw new Error("Unexpected provider operation"); } } };
    if (Number(process.versions.node.split(".")[0]) < 22) require.cache[require.resolve("nanoid")] = { exports: await import("nanoid") };
    try {
      await db.pool.query("DELETE FROM archives WHERE id=32");
      await db.pool.query(`UPDATE users SET module_permissions='["delivery","cashregister"]' WHERE id=10`);
      for (const [id, access] of [[14, 0], [15, 4]]) await db.pool.query(`INSERT INTO users
        (id,shopid,username,email,password,phone,access,status,created,clearpass,module_permissions)
        VALUES (?,7,?,?, 'fixture','0700000000',?,1,NOW(),'','["orders"]')`, [id, `User ${id}`, `${id}@example.test`, access]);
      await db.pool.query(`UPDATE orders SET subtotal=30,subtotal_before_discount=26,discount_amount=0,status=3,
        payment_status='unpaid',payment='Paiement au comptoir',payment_provider=NULL WHERE id=31`);
      await db.pool.query("UPDATE deliveries SET courier_id=11,delivery_status='in_transit' WHERE id=41");
      await db.pool.query(`INSERT INTO delivery_charge_snapshots (shopid,delivery_id,revision,band_fee_cents,
        free_delivery_applied,fee_cents,total_excl_tax_cents,tax_cents,vat_rate,fiscal_policy)
        VALUES (7,41,1,400,0,400,364,36,10,'{"mode":"configured_rate","vatRate":10}')`);
      await db.pool.query("INSERT INTO orderdetail (orderid,productid,qty,price,total) VALUES (31,21,1,26,26)");
      const collect = (method = "cash", time = "2026-10-24 21:50:00.123456") => require("../src/modules/m_deliveryCollections").buildDeliveryCollections({ clock: () => time }).collect({
        actor: actor(11, 6), deliveryId: "41", method, expectedVersion: 1, idempotencyKey: "collection" });
      const refunds = (options = {}) => require("../src/modules/m_deliveryRefunds").buildDeliveryRefunds({ clock: () => "2026-10-24 21:55:00.234567", ...options });
      const cash = (options = {}) => require("../src/modules/m_courierCash").buildCourierCash(options);
      const balance = () => cash().balance({ actor: actor(), courierId: 11 });
      const archive = () => require("../src/modules/m_orders").mArchiveOrder(31, undefined, 7);
      const remit = async amount => cash().remit({ actor: actor(), courierId: 11, receivedCents: amount,
        expectedBalanceVersion: (await balance()).version, idempotencyKey: "handover" });
      const http = async work => {
        const app = express();
        app.use(express.json());
        app.use(require("../src/routers/r_delivery"));
        app.use(require("../src/routers/r_courier"));
        app.use(require("../src/routers/r_orders"));
        const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
        const call = async (url = "/deliveries/41/refund", { id = 10, shopid = 7, access = 0, claims, method = "POST", body = { returnSource: "courier", reason: "Confirmed full return", idempotencyKey: "http-refund" } } = {}) => {
          const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { method,
            headers: { Authorization: `Bearer ${jwt.sign(claims || { id, shopid, access }, process.env.JWTKEY)}`, "Content-Type": "application/json" },
            ...(method === "GET" ? {} : { body: JSON.stringify(body) }) });
          const raw = await response.text();
          return { status: response.status, body: raw.startsWith("{") ? JSON.parse(raw) : raw, cache: response.headers.get("cache-control") };
        };
        try { await work(call); } finally { await new Promise(resolve => server.close(resolve)); }
      };
      await work({ db, appPool, collect, refunds, cash, balance, archive, remit, http });
    } finally { await appPool.end(); }
  });
}

test("HTTP real full courier refund includes fee and preserves preparation stock and sale identity", async ({ db, collect, http, balance, cash }) => {
  const collected = await collect("cash", new Date());
  const before = await db.readRows("SELECT version,delivery_status,address_snapshot,charge_revision FROM deliveries WHERE id=41");
  const stock = await db.readRows("SELECT stock FROM products WHERE id=21");
  await http(async call => {
    const result = await call();
    assert.equal(result.status, 200, JSON.stringify(result));
    const refund = result.body.data;
    assert.equal(result.cache, "no-store");
    assert.equal(typeof refund.refundId, "string");
    assert.equal(refund.collectionId, collected.collectionId);
    assert.equal(refund.amountCents, 3000);
    assert.equal(refund.method, "cash");
    assert.equal(refund.returnSource, "courier");
    assert.equal(refund.physicalHolderId, 11);
    assert.equal(refund.authorizedById, 10);
    assert.equal(refund.providerVerified, false);
    assert.equal(refund.confirmation, "restaurant_declaration");
    assert.match(refund.createdAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/);
    assert.equal((await db.readRows("SELECT DATE_FORMAT(created_at,'%Y-%m-%d %H:%i:%s.%f') t FROM delivery_manual_refunds WHERE id=?", [refund.refundId]))[0].t, refund.createdAt);
    assert.deepEqual((await call()).body.data, refund);
    assert.equal((await call(undefined, { body: { returnSource: "register", reason: "Confirmed full return", idempotencyKey: "http-refund" } })).status, 409);
    assert.equal((await balance()).remainingDueCents, 0);
    assert.equal((await balance()).courierRefundedCents, 3000);
    await assert.rejects(cash().adjust({ actor: actor(14, 0), courierId: 11, collectionId: collected.collectionId, remittanceId: null,
      deltaDueCents: 3000, reason: "Cannot undo confirmed return", idempotencyKey: "undo-return" }), { status: 409 });
  });
  assert.deepEqual(await db.readRows("SELECT version,delivery_status,address_snapshot,charge_revision FROM deliveries WHERE id=41"), before);
  assert.deepEqual(await db.readRows("SELECT stock FROM products WHERE id=21"), stock);
  const order = (await db.readRows("SELECT payment_status,status,subtotal FROM orders WHERE id=31"))[0];
  assert.equal(order.payment_status, "refunded");
  assert.equal(order.status, 3);
  assert.equal(order.subtotal, 30);
  const payment = (await db.readRows("SELECT status,refund_status,stripe_refund_id,amount_cents FROM payments WHERE order_id=31"))[0];
  assert.equal(payment.status, "refunded");
  assert.equal(payment.refund_status, "succeeded");
  assert.equal(payment.stripe_refund_id, null);
  assert.equal(Number(payment.amount_cents), 3000);
});

test("register refund after archive leaves original courier debt and posts next-period drawer outflow", async ({ db, collect, refunds, balance, archive, cash }) => {
  await collect();
  await archive();
  await db.pool.query("UPDATE archives SET archived_at='2026-10-24 21:55:00.000000' WHERE delivery_id=41");
  const { buildCashClosures } = require("../src/modules/m_cashClosures");
  const first = await buildCashClosures({ clock: () => "2026-10-24 22:00:00.000000" }).mCloseCurrentCashClosure({ shopId: 7, userId: 10 });
  const result = await refunds({ clock: () => "2026-10-25 01:10:00.000001" }).refund(request({ returnSource: "register" }));
  assert.equal(result.physicalHolderId, 10);
  assert.equal((await balance()).remainingDueCents, 3000);
  assert.equal((await balance()).registerRefundedCents, 3000);
  assert.equal((await db.readRows("SELECT payment_status FROM archives WHERE delivery_id=41"))[0].payment_status, "refunded");
  const service = buildCashClosures({ clock: () => "2026-10-25 01:15:00.000000" });
  const second = await service.mCloseCurrentCashClosure({ shopId: 7, userId: 10 });
  assert.equal(second.orders_count, 0);
  assert.equal(second.total_revenue, 0);
  assert.equal(second.courier_cash.cash_refunded_by_register_cents, 3000);
  assert.equal(second.courier_cash.cash_refunded_by_courier_cents, 0);
  assert.equal(second.courier_cash.outstanding_cents, 3000);
  assert.equal(second.courier_cash.manual_refunded_cents, 3000);
  assert.deepEqual((await service.mGetCashClosureById({ shopId: 7, id: first.id })).courier_cash, first.courier_cash);
  await cash({ clock: () => "2026-10-25 01:20:00.000000" }).remit({ actor: actor(), courierId: 11,
    receivedCents: 3000, expectedBalanceVersion: (await balance()).version, idempotencyKey: "cash-after-register-refund" });
  const third = await buildCashClosures({ clock: () => "2026-10-25 01:25:00.000000" }).mCloseCurrentCashClosure({ shopId: 7, userId: 10 });
  assert.equal(third.orders_count, 0);
  assert.equal(third.total_revenue, 0);
  assert.equal(third.courier_cash.received_cents, 3000);
  assert.equal(third.courier_cash.outstanding_cents, 0);
  assert.deepEqual((await service.mGetCashClosureById({ shopId: 7, id: second.id })).courier_cash, second.courier_cash);
});

test("external card refund is reasoned restaurant declaration with no cash debt or drawer movement", async ({ collect, refunds, balance, archive, db }) => {
  await collect("external_card");
  const service = refunds();
  for (const returnSource of ["register", "courier"]) await assert.rejects(service.refund(request({ returnSource })), { status: 409 });
  await archive();
  await db.pool.query("UPDATE archives SET archived_at='2026-10-24 21:51:00.000000' WHERE delivery_id=41");
  const { buildCashClosures } = require("../src/modules/m_cashClosures");
  await buildCashClosures({ clock: () => "2026-10-24 21:52:00.000000" }).mCloseCurrentCashClosure({ shopId: 7, userId: 10 });
  const result = await service.refund(request({ returnSource: "external_card", reason: "Restaurant confirms external terminal refund performed" }));
  assert.equal(result.physicalHolderId, null);
  assert.equal(result.providerVerified, false);
  assert.equal(result.method, "external_card");
  const own = await balance();
  assert.equal(own.remainingDueCents, 0);
  assert.equal(own.receivedCents, 0);
  assert.equal(own.externalCardRefundedCents, 3000);
  const period = await buildCashClosures({ clock: () => "2026-10-24 22:00:00.000000" }).mCloseCurrentCashClosure({ shopId: 7, userId: 10 });
  assert.equal(period.total_revenue, 0);
  assert.equal(period.courier_cash.external_card_refunded_cents, 3000);
  assert.equal(period.courier_cash.cash_refunded_by_register_cents, 0);
  assert.equal(period.courier_cash.cash_refunded_by_courier_cents, 0);
});

test("courier physical return after archive uses original payment and immutable holder not assignee", async ({ db, collect, refunds, archive, balance }) => {
  const collected = await collect();
  await archive();
  await db.pool.query("UPDATE deliveries SET courier_id=NULL WHERE id=41");
  await db.pool.query("UPDATE users SET access=4,status=0 WHERE id=11");
  const result = await refunds().refund(request({ actor: actor(14, 0) }));
  assert.equal(result.collectionId, collected.collectionId);
  assert.equal(result.physicalHolderId, 11);
  assert.equal((await balance()).remainingDueCents, 0);
  const archiveRow = (await db.readRows("SELECT id,payment_status,status FROM archives WHERE delivery_id=41"))[0];
  assert.notEqual(archiveRow.id, 31);
  assert.equal(archiveRow.payment_status, "refunded");
  assert.equal(archiveRow.status, 3);
  assert.equal((await db.readRows("SELECT order_id FROM payments WHERE id=?", [result.paymentId]))[0].order_id, 31);
});

test("HTTP strict refund payload current permissions foreign identities and null-role financial boundaries", async ({ db, collect, http }) => {
  await collect();
  await http(async call => {
    for (const body of [{}, { returnSource: "courier", reason: " ", idempotencyKey: "bad" },
      ...["amountCents", "orderId", "paymentId", "actor", "physicalHolderId", "refundId", "partialFeeCents"].map(key =>
        ({ returnSource: "courier", reason: "Return", idempotencyKey: "bad", [key]: 1 }))]) {
      assert.equal((await call(undefined, { body })).status, 400);
    }
    for (const options of [{ id: 11 }, { id: 12, shopid: 8 }, { id: 15 },
      { claims: { subject_type: "service_point", service_point_id: 1, shopid: 7, access: 2 } },
      { claims: { subject_type: "customer", id: 10, shopid: 7, access: 0 } }]) {
      assert.ok([403, 404].includes((await call(undefined, options)).status));
    }
    await db.pool.query("UPDATE users SET module_permissions='[]' WHERE id=10");
    assert.equal((await call()).status, 403);
    await db.pool.query("UPDATE users SET status=0 WHERE id=14");
    assert.equal((await call(undefined, { id: 14 })).status, 403);
    await db.pool.query("UPDATE users SET status=1,access=NULL WHERE id=14");
    for (const [url, method] of [["/reports/z/current", "GET"], ["/reports/z/close", "POST"], ["/reports/z", "GET"], ["/reports/z/1", "GET"],
      ["/courier/cash-balance", "GET"], ["/delivery/couriers/11/cash-balance", "GET"], ["/delivery/couriers/11/remittances", "POST"],
      ["/delivery/couriers/11/adjustments", "POST"], ["/deliveries/41/refund", "POST"]]) {
      assert.equal((await call(url, { id: 14, access: 0, method })).status, 403, url);
    }
    await db.pool.query("UPDATE users SET access=0 WHERE id=14");
    assert.equal((await call("/deliveries/999/refund", { id: 14 })).status, 404);
    assert.equal((await call(undefined, { id: 14 })).status, 200);
    await db.pool.query("UPDATE users SET status=0 WHERE id=14");
    assert.equal((await call(undefined, { id: 14 })).status, 403, "replay reauthorizes current actor");
  });
});

test("current commercial provider amount and payment eligibility cannot be replaced by refund claims", async ({ db, collect, refunds, balance }) => {
  await collect();
  const service = refunds();
  for (const fields of [{ payment_status: "unpaid" }, { payment_status: "processing" }, { payment_status: "refunded" },
    { payment_provider: "stripe" }, { stripe_payment_intent_id: "pi_claimed" }, { stripe_terminal_payment_id: 9 }]) {
    await db.pool.query("UPDATE orders SET ? WHERE id=31", [fields]);
    await assert.rejects(service.refund(request()), { status: 409 });
    await db.pool.query("UPDATE orders SET payment_status='paid',payment_provider=NULL,stripe_payment_intent_id=NULL,stripe_terminal_payment_id=NULL WHERE id=31");
  }
  for (const fields of [{ amount_cents: 2999 }, { status: "processing" }, { stripe_payment_intent_id: "pi_not_manual" }, { stripe_charge_id: "ch_claimed" }]) {
    const old = (await db.readRows("SELECT amount_cents,status,stripe_payment_intent_id,stripe_charge_id FROM payments WHERE order_id=31"))[0];
    await db.pool.query("UPDATE payments SET ? WHERE order_id=31", [fields]);
    await assert.rejects(service.refund(request()), { status: 409 });
    await db.pool.query("UPDATE payments SET ? WHERE order_id=31", [old]);
  }
  assert.equal((await db.readRows("SELECT COUNT(*) n FROM delivery_manual_refunds"))[0].n, 0);
  assert.equal((await balance()).remainingDueCents, 3000);
});

test("already remitted source cannot return courier funds again but register return stays available", async ({ collect, refunds, balance, remit }) => {
  await collect();
  await remit(2800);
  await assert.rejects(refunds().refund(request()), { code: "DELIVERY_REFUND_CUSTODY_INSUFFICIENT" });
  assert.equal((await balance()).remainingDueCents, 200);
  await refunds().refund(request({ returnSource: "register" }));
  assert.equal((await balance()).remainingDueCents, 200);
});

test("fully remitted source has no courier return capacity and register refund does not create debt", async ({ collect, refunds, balance, remit }) => {
  await collect();
  await remit(3000);
  await assert.rejects(refunds().refund(request()), { code: "DELIVERY_REFUND_CUSTODY_INSUFFICIENT" });
  await refunds().refund(request({ returnSource: "register" }));
  assert.equal((await balance()).remainingDueCents, 0);
});

test("source write-off is not refunded a second time and restored refund cannot recreate custody", async ({ collect, refunds, cash, balance }) => {
  const collected = await collect();
  await cash().adjust({ actor: actor(14, 0), courierId: 11, collectionId: collected.collectionId, remittanceId: null,
    deltaDueCents: -200, reason: "Approved shortage", idempotencyKey: "write-off" });
  await assert.rejects(refunds().refund(request()), { code: "DELIVERY_REFUND_CUSTODY_INSUFFICIENT" });
  assert.equal((await balance()).remainingDueCents, 2800);
  await refunds().refund(request({ returnSource: "register" }));
  assert.equal((await balance()).remainingDueCents, 2800);
});

test("promoted physical holder cannot self-authorize courier return and another admin can confirm", async ({ db, collect, refunds, balance }) => {
  await collect();
  await db.pool.query(`UPDATE users SET access=0,module_permissions='["delivery","cashregister"]' WHERE id=11`);
  await assert.rejects(refunds().refund(request({ actor: actor(11, 0) })), { status: 403 });
  await refunds().refund(request({ actor: actor(14, 0) }));
  assert.equal((await balance()).remainingDueCents, 0);
});

test("same-key concurrent actual refunds preserve exact BIGINT IDs and different payload refuses", async ({ db, collect, refunds, balance }) => {
  for (const table of ["delivery_payment_collections", "delivery_manual_refunds", "courier_cash_refund_impacts"]) await db.pool.query(`ALTER TABLE ${table} AUTO_INCREMENT=9007199254740993`);
  const collected = await collect();
  const service = refunds();
  const results = await Promise.all([service.refund(request()), service.refund(request())]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0].refundId, "9007199254740993");
  assert.equal(results[0].collectionId, collected.collectionId);
  for (const extra of [{ returnSource: "register" }, { reason: "Changed reason" }, { actor: actor(14, 0) }]) {
    await assert.rejects(service.refund(request(extra)), { code: "DELIVERY_IDEMPOTENCY_CONFLICT" });
  }
  await assert.rejects(service.refund(request({ idempotencyKey: "different-key" })), { status: 409 });
  const state = await balance();
  assert.equal(state.remainingDueCents, 0);
  assert.equal(state.refunds[0].refundId, "9007199254740993");
  for (const table of ["delivery_manual_refunds", "courier_cash_refund_impacts"]) assert.equal((await db.readRows(`SELECT COUNT(*) n FROM ${table}`))[0].n, 1);
});

test("different-key concurrent refunds confirm one full return and never over-return", async ({ db, collect, refunds, balance }) => {
  await collect();
  const service = refunds();
  const results = await Promise.allSettled([service.refund(request({ idempotencyKey: "refund-a" })), service.refund(request({ idempotencyKey: "refund-b" }))]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.find(result => result.status === "rejected").reason.status, 409);
  assert.equal((await balance()).remainingDueCents, 0);
  assert.equal((await db.readRows("SELECT COUNT(*) n FROM delivery_manual_refunds"))[0].n, 1);
  assert.equal((await db.readRows("SELECT COUNT(*) n FROM courier_cash_refund_impacts"))[0].n, 1);
});

test("late failures roll back actual refund payment commercial and custody journals together", async ({ db, collect, refunds, cash, balance }) => {
  await collect();
  for (const phase of ["appendRefund", "markRefunded", "applyCashRefund"]) {
    const repository = {};
    if (phase === "appendRefund") repository.appendRefund = async ({ row, connection }) => {
      await connection.query("INSERT INTO delivery_manual_refunds SET ?", [row]);
      throw new Error("Injected refund journal failure");
    };
    if (phase === "markRefunded") repository.markRefunded = async ({ current, payment, now, connection }) => {
      await connection.query("UPDATE orders SET payment_status='refunded' WHERE id=?", [current.order.id]);
      await connection.query("UPDATE payments SET status='refunded',refund_status='succeeded',refunded_at=? WHERE id=?", [now, payment.id]);
      throw new Error("Injected payment failure");
    };
    if (phase === "applyCashRefund") repository.applyCashRefund = async input => {
      await cash().applyConfirmedRefund(input);
      throw new Error("Injected after custody impact");
    };
    await assert.rejects(refunds({ repository }).refund(request()), /Injected/);
    assert.equal((await db.readRows("SELECT payment_status FROM orders WHERE id=31"))[0].payment_status, "paid");
    assert.equal((await db.readRows("SELECT status FROM payments WHERE order_id=31"))[0].status, "succeeded");
    for (const table of ["delivery_manual_refunds", "courier_cash_refund_impacts"]) assert.equal((await db.readRows(`SELECT COUNT(*) n FROM ${table}`))[0].n, 0);
    assert.equal((await balance()).remainingDueCents, 3000);
  }
  await refunds().refund(request());
  assert.equal((await balance()).remainingDueCents, 0);
});

test("adapter requires immutable confirmed proof on caller connection and deduplicates exact refund identity", async ({ db, appPool, collect, refunds, cash, balance }) => {
  await collect();
  const run = require("../src/helpers/withTransaction").createTransactionRunner(appPool);
  await db.pool.query("UPDATE orders SET payment_status='refunded' WHERE id=31");
  await db.pool.query("UPDATE payments SET status='refunded',refund_status='succeeded' WHERE order_id=31");
  await assert.rejects(run(connection => cash().applyConfirmedRefund({ shopId: 7, refundId: "999", connection })), { code: "DELIVERY_REFUND_PROOF_INVALID" });
  assert.equal((await balance()).remainingDueCents, 3000);
  await db.pool.query("UPDATE orders SET payment_status='paid' WHERE id=31");
  await db.pool.query("UPDATE payments SET status='succeeded',refund_status=NULL WHERE order_id=31");
  const refund = await refunds().refund(request());
  const apply = () => run(connection => cash().applyConfirmedRefund({ shopId: 7, refundId: refund.refundId, connection }));
  assert.deepEqual(await apply(), { refundId: refund.refundId, dueReductionCents: 3000 });
  assert.deepEqual(await apply(), { refundId: refund.refundId, dueReductionCents: 3000 });
  await assert.rejects(run(connection => cash().applyConfirmedRefund({ shopId: 8, refundId: refund.refundId, connection })), { code: "DELIVERY_REFUND_PROOF_INVALID" });
  assert.equal((await db.readRows("SELECT COUNT(*) n FROM courier_cash_refund_impacts"))[0].n, 1);
});

test("refund migration up/down/up keeps prior closures and enforces immutable tenant-safe source links", async ({ db, collect, refunds }) => {
  await collect();
  const snapshot = '{"collected_cents":3000,"received_cents":0,"outstanding_cents":3000,"discrepancy_cents":0}';
  await db.pool.query("INSERT INTO cash_closures (shopid,closure_number,closed_at,orders_count,total_revenue,payments_summary,vat_summary,courier_cash) VALUES (7,1,'2026-10-24 21:51:00',1,30,'[]','[]',?)", [snapshot]);
  const source = fs.readFileSync(path.join(__dirname, "../db/migrations/20261016122000_delivery_manual_refunds.sql"), "utf8").split(/^-- migrate:(?:up|down)\s*$/m);
  await db.pool.query(source[2]);
  await db.pool.query(source[1]);
  const stored = (await db.readRows("SELECT courier_cash FROM cash_closures"))[0].courier_cash;
  assert.deepEqual(typeof stored === "string" ? JSON.parse(stored) : stored, JSON.parse(snapshot));
  const result = await refunds().refund(request());
  for (const table of ["delivery_manual_refunds", "courier_cash_refund_impacts"]) {
    await assert.rejects(db.pool.query(`UPDATE ${table} SET created_at=NOW()`), /append-only/);
    await assert.rejects(db.pool.query(`DELETE FROM ${table}`), /append-only/);
  }
  const refund = (await db.readRows("SELECT * FROM delivery_manual_refunds WHERE id=?", [result.refundId]))[0];
  delete refund.id;
  refund.shopid = 8;
  refund.idempotency_key = "foreign-clone";
  if (typeof refund.result !== "string") refund.result = JSON.stringify(refund.result);
  await assert.rejects(db.pool.query("INSERT INTO delivery_manual_refunds SET ?", [refund]), error => error.code === "ER_NO_REFERENCED_ROW_2");
});

test("queued confirmed courier return posts after closure cutoff and freezes prior debt snapshot", async ({ db, collect, refunds, archive }) => {
  await collect();
  await archive();
  await db.pool.query("UPDATE archives SET archived_at='2026-10-24 21:55:00.000000' WHERE delivery_id=41");
  let observed;
  const reached = new Promise(resolve => { observed = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { buildCashClosures } = require("../src/modules/m_cashClosures");
  const closing = buildCashClosures({ clock: async ({ connection }) => {
    observed((await connection.query("SELECT CONNECTION_ID() id"))[0][0].id);
    await gate;
    return "2026-10-24 22:00:00.500123";
  } }).mCloseCurrentCashClosure({ shopId: 7, userId: 10 });
  const blocker = await reached;
  let clocks = 0;
  const pending = refunds({ clock: () => { clocks++; return "2026-10-24 22:00:00.500124"; } }).refund(request());
  try {
    let waits = [];
    const deadline = Date.now() + 5000;
    while (!waits.length && Date.now() < deadline) {
      waits = await db.readRows(`SELECT 1 FROM performance_schema.data_lock_waits w JOIN performance_schema.threads t ON t.THREAD_ID=w.BLOCKING_THREAD_ID WHERE t.PROCESSLIST_ID=?`, [blocker]);
      if (!waits.length) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(waits.length);
    assert.equal(clocks, 0);
  } finally { release(); }
  const first = await closing;
  await pending;
  assert.equal(clocks, 1);
  assert.equal(first.courier_cash.outstanding_cents, 3000);
  const service = buildCashClosures({ clock: () => "2026-10-24 22:00:00.500125" });
  const second = await service.mCloseCurrentCashClosure({ shopId: 7, userId: 10 });
  assert.equal(second.orders_count, 0);
  assert.equal(second.total_revenue, 0);
  assert.equal(second.courier_cash.cash_refunded_by_courier_cents, 3000);
  assert.equal(second.courier_cash.cash_refunded_by_register_cents, 0);
  assert.equal(second.courier_cash.outstanding_cents, 0);
  assert.deepEqual((await service.mGetCashClosureById({ shopId: 7, id: first.id })).courier_cash, first.courier_cash);
});

async function main() {
  let failures = 0;
  for (const { name, work } of tests) {
    if (process.env.TASK7_REFUND_FILTER && !name.includes(process.env.TASK7_REFUND_FILTER)) continue;
    try { await fixture(work); console.log(`PASS SQL ${name}`); }
    catch (error) { failures++; console.error(`FAIL SQL ${name}: ${error.stack}`); }
  }
  if (failures) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
