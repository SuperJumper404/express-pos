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
const stamp = "2026-10-24 21:50:00.123456";

async function fixture(work) {
  return withDeliveryDatabase(async db => {
    await db.seedScenario();
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(path.resolve(__dirname, "../src") + path.sep)) delete require.cache[key];
    }
    const configured = db.pool.pool.config.connectionConfig;
    const appPool = mysql.createPool({ host: configured.host, port: configured.port, user: configured.user,
      password: configured.password, database: db.database, charset: "utf8mb4", timezone: "Z", connectionLimit: 8 });
    require.cache[require.resolve("../src/config/dbPool")] = { exports: appPool };
    require.cache[require.resolve("../src/config/db")] = { exports: appPool.pool };
    try {
    require.cache[require.resolve("../src/config/stripe")] = { exports: { getStripe() { throw new Error("Unexpected provider call"); } } };
    if (Number(process.versions.node.split(".")[0]) < 22) require.cache[require.resolve("nanoid")] = { exports: await import("nanoid") };
    await db.pool.query("DELETE FROM archives WHERE id = 32");
    await db.pool.query(`UPDATE users SET module_permissions = '["delivery","cashregister"]' WHERE id = 10`);
    for (const [id, access] of [[13, 1], [14, 0], [15, 6]]) {
      await db.pool.query(`INSERT INTO users (id,shopid,username,email,password,phone,access,status,created,clearpass,module_permissions)
        VALUES (?,7,? ,?,'fixture','0700000000',?,1,NOW(),'','["delivery","cashregister"]')`, [id, `User ${id}`, `${id}@example.test`, access]);
    }
    await db.pool.query(`UPDATE orders SET subtotal=30,subtotal_before_discount=26,discount_amount=0,status=3,
      payment_status='unpaid',payment='Paiement au comptoir',payment_provider=NULL WHERE id=31`);
    await db.pool.query("UPDATE deliveries SET courier_id=11,delivery_status='in_transit' WHERE id=41");
    await db.pool.query(`INSERT INTO delivery_charge_snapshots (shopid,delivery_id,revision,band_fee_cents,
      free_delivery_applied,fee_cents,total_excl_tax_cents,tax_cents,vat_rate,fiscal_policy)
      VALUES (7,41,1,400,0,400,364,36,10,'{"mode":"configured_rate","vatRate":10}')`);
    await db.pool.query("INSERT INTO orderdetail (orderid,productid,qty,price,total) VALUES (31,21,1,26,26)");
    const collect = async (method = "cash", time = stamp) => require("../src/modules/m_deliveryCollections").buildDeliveryCollections({ clock: () => time }).collect({
      actor: actor(11, 6), deliveryId: "41", method, expectedVersion: 1, idempotencyKey: "collect" });
    const cash = options => require("../src/modules/m_courierCash").buildCourierCash(options);
    const remit = async (service, receivedCents, key = "remit", who = actor()) => service.remit({ actor: who, courierId: 11,
      receivedCents, expectedBalanceVersion: (await service.balance({ actor: who, courierId: 11 })).version, idempotencyKey: key });
    await work({ db, collect, cash, remit });
    } finally { await appPool.end(); }
  });
}

test("3000 collected, 2800 then 200 physically received, immutable allocations and replay", async ({ db, collect, cash, remit }) => {
  const collection = await collect();
  const service = cash({ clock: () => stamp });
  const balance = await service.balance({ actor: actor(), courierId: 11 });
  assert.equal(balance.courierId, 11);
  assert.equal(balance.collectedCents, 3000);
  assert.equal(balance.remainingDueCents, 3000);
  assert.equal(balance.collections[0].collectionId, collection.collectionId);
  const input = { actor: actor(), courierId: 11, receivedCents: 2800, expectedBalanceVersion: balance.version, idempotencyKey: "partial" };
  const first = await service.remit(input);
  assert.equal(first.expectedCents, 3000);
  assert.equal(first.remainingDueCents, 200);
  assert.equal(first.discrepancyCents, -200);
  assert.equal(typeof first.remittanceId, "string");
  assert.deepEqual(await service.remit(input), first);
  await assert.rejects(service.remit({ ...input, receivedCents: 2700 }), { code: "DELIVERY_IDEMPOTENCY_CONFLICT" });
  const second = await remit(service, 200, "remainder");
  assert.equal(second.remainingDueCents, 0);
  assert.equal(second.expectedCents, 200);
  const rows = await db.readRows("SELECT amount_cents FROM courier_cash_remittance_allocations ORDER BY id");
  assert.deepEqual(rows.map(r => Number(r.amount_cents)), [2800, 200]);
  assert.equal((await db.readRows("SELECT subtotal FROM orders WHERE id=31"))[0].subtotal, 30);
  assert.equal((await db.readRows("SELECT COUNT(*) n FROM payments"))[0].n, 1);
  await assert.rejects(db.pool.query("UPDATE courier_cash_remittances SET received_cents=1"), /append-only/);
});

test("surplus remains distinct without negative debt or additional sales", async ({ db, collect, cash, remit }) => {
  await collect();
  const service = cash();
  const result = await remit(service, 3200);
  assert.equal(result.discrepancyCents, 200);
  assert.equal(result.remainingDueCents, 0);
  const balance = await service.balance({ actor: actor(), courierId: 11 });
  assert.equal(balance.surplusCents, 200);
  assert.equal(Number((await db.readRows("SELECT SUM(amount_cents) n FROM courier_cash_remittance_allocations"))[0].n), 3000);
  await assert.rejects(remit(service, 1, "no-debt"), { status: 409 });
  assert.equal((await service.balance({ actor: actor(), courierId: 15 })).remainingDueCents, 0);
});

test("external card never creates cash custody", async ({ collect, cash, remit }) => {
  await collect("external_card");
  const service = cash();
  const balance = await service.balance({ actor: actor(), courierId: 11 });
  assert.equal(balance.remainingDueCents, 0);
  assert.equal(balance.collectedCents, 0);
  assert.equal(balance.version, 1);
  await assert.rejects(remit(service, 3000), { status: 409 });
});

test("same balance version admits only one cashier; current version survives barrier wait", async ({ db, collect, cash }) => {
  await collect();
  const service = cash();
  const before = await service.balance({ actor: actor(), courierId: 11 });
  const input = { actor: actor(), courierId: 11, receivedCents: 2800, expectedBalanceVersion: before.version, idempotencyKey: "race-a" };
  const results = await Promise.allSettled([service.remit(input), service.remit({ ...input, actor: actor(13), idempotencyKey: "race-b" })]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.find(r => r.status === "rejected").reason.code, "COURIER_CASH_VERSION_CONFLICT");
  assert.equal((await service.balance({ actor: actor(), courierId: 11 })).remainingDueCents, 200);
  const current = await service.balance({ actor: actor(), courierId: 11 });
  const replayInput = { ...input, receivedCents: 200, expectedBalanceVersion: current.version, idempotencyKey: "race-replay" };
  const sameKey = await Promise.all([service.remit(replayInput), service.remit(replayInput)]);
  assert.deepEqual(sameKey[0], sameKey[1]);
  assert.equal((await db.readRows("SELECT COUNT(*) n FROM courier_cash_remittances"))[0].n, 2);
});

test("admin justified correction is new source-linked evidence; cashier and courier forbidden", async ({ db, collect, cash, remit }) => {
  const collection = await collect();
  const service = cash();
  const first = await remit(service, 2800);
  const input = { actor: actor(14, 0), courierId: 11, collectionId: null, remittanceId: first.remittanceId,
    deltaDueCents: -200, reason: "Approved shortage write-off", idempotencyKey: "write-off" };
  for (const who of [actor(), actor(11, 0)]) await assert.rejects(service.adjust({ ...input, actor: who }), { status: 403 });
  await assert.rejects(service.adjust({ ...input, reason: " " }), { status: 400 });
  await assert.rejects(service.adjust({ ...input, remittanceId: null }), { status: 400 });
  await assert.rejects(service.adjust({ ...input, refundedByCourier: true }), { status: 400 });
  const adjusted = await service.adjust(input);
  assert.equal(adjusted.balance.remainingDueCents, 0);
  assert.deepEqual(await service.adjust(input), adjusted);
  assert.equal((await db.readRows("SELECT subtotal,payment_status FROM orders WHERE id=31"))[0].payment_status, "paid");
  assert.equal(Number((await db.readRows("SELECT delta_due_cents FROM courier_cash_adjustments"))[0].delta_due_cents), -200);
  assert.equal((await service.balance({ actor: actor(), courierId: 11 })).collections[0].collectionId, collection.collectionId);
  await assert.rejects(service.adjust({ ...input, idempotencyKey: "overdraw" }), { status: 409 });
  const restored = await service.adjust({ ...input, deltaDueCents: 200, reason: "Reverse approved write-off", idempotencyKey: "reverse" });
  assert.equal(restored.balance.remainingDueCents, 200);
  assert.equal((await remit(service, 200, "restored-remainder")).remainingDueCents, 0);
  assert.equal(Number((await db.readRows("SELECT SUM(amount_cents) n FROM courier_cash_remittance_allocations"))[0].n), 3000);
});

test("custody follows collection holder through reassignment, suspension and role change; no self-remit", async ({ db, collect, cash, remit }) => {
  await collect();
  const service = cash();
  await db.pool.query("UPDATE deliveries SET courier_id=15 WHERE id=41");
  await db.pool.query("UPDATE users SET access=1,status=0 WHERE id=11");
  assert.equal((await service.balance({ actor: actor(), courierId: 11 })).remainingDueCents, 3000);
  assert.equal((await service.balance({ actor: actor(), courierId: 15 })).remainingDueCents, 0);
  await remit(service, 2800);
  await db.pool.query(`UPDATE users SET status=1,module_permissions='["delivery","cashregister"]' WHERE id=11`);
  await assert.rejects(remit(service, 200, "self", actor(11, 1)), { status: 403 });
  await remit(service, 200, "former-holder");
});

test("cashier refund state or client refund claims do not prove a courier physical return", async ({ db, collect, cash }) => {
  await collect();
  const service = cash();
  const response = { statusCode: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await require("../src/controllers/c_stripe").refundPaidOrder({ params: { id: "31" }, shopid: 7, id: 10, access: 1, sessionSubject: "staff" }, response);
  assert.equal(response.statusCode, 404, "the actual refund adapter cannot refund a manual courier cash payment");
  assert.equal((await db.readRows("SELECT payment_status FROM orders WHERE id=31"))[0].payment_status, "paid");
  // Characterize separation only: this fixture is explicitly NOT a usable refund adapter.
  await db.pool.query("UPDATE orders SET payment_status='refunded' WHERE id=31");
  assert.equal((await service.balance({ actor: actor(), courierId: 11 })).remainingDueCents, 3000);
  await assert.rejects(service.adjust({ actor: actor(14, 0), courierId: 11, collectionId: "1", remittanceId: null,
    deltaDueCents: -3000, reason: "Claimed refund", idempotencyKey: "claim", refundId: "claimed", physicallyReturnedBy: 11 }), { status: 400 });
});

test("current null role cannot become admin and one cash key cannot change operation", async ({ db, collect, cash, remit }) => {
  await collect();
  const service = cash();
  await db.pool.query("UPDATE users SET access=NULL WHERE id=10");
  await assert.rejects(service.balance({ actor: actor(10, 0), courierId: 11 }), { status: 403 });
  await db.pool.query("UPDATE users SET access=1 WHERE id=10");
  await db.pool.query("UPDATE users SET module_permissions='[]' WHERE id=10");
  await assert.rejects(service.balance({ actor: actor(10, 0), courierId: 11 }), { status: 403 });
  await db.pool.query(`UPDATE users SET module_permissions='["delivery","cashregister"]' WHERE id=10`);
  const first = await remit(service, 2800, "shared-cash-key");
  await assert.rejects(service.adjust({ actor: actor(14, 0), courierId: 11, collectionId: null, remittanceId: first.remittanceId,
    deltaDueCents: -200, reason: "Approved correction", idempotencyKey: "shared-cash-key" }), { code: "DELIVERY_IDEMPOTENCY_CONFLICT" });
});

test("real allocation failure rolls back receipt and totals; correction failure rolls back its journal", async ({ db, collect, cash, remit }) => {
  await collect();
  const broken = cash({ repository: { appendAllocation: async ({ row, connection }) => {
    await connection.query("INSERT INTO courier_cash_remittance_allocations SET ?", [row]);
    throw new Error("Injected after actual allocation");
  } } });
  await assert.rejects(remit(broken, 2800), /Injected after actual allocation/);
  for (const table of ["courier_cash_remittances", "courier_cash_remittance_allocations", "courier_cash_allocation_totals"]) {
    assert.equal((await db.readRows(`SELECT COUNT(*) n FROM ${table}`))[0].n, 0);
  }
  const first = await remit(cash(), 2800);
  const input = { actor: actor(14, 0), courierId: 11, collectionId: null, remittanceId: first.remittanceId,
    deltaDueCents: -200, reason: "Approved correction", idempotencyKey: "rollback-adjust" };
  const correction = cash({ repository: { appendAdjustment: async ({ row, connection }) => {
    await connection.query("INSERT INTO courier_cash_adjustments SET ?", [row]);
    throw new Error("Injected after actual correction");
  } } });
  await assert.rejects(correction.adjust(input), /Injected after actual correction/);
  assert.equal((await db.readRows("SELECT COUNT(*) n FROM courier_cash_adjustments"))[0].n, 0);
  assert.equal((await cash().balance({ actor: actor(), courierId: 11 })).remainingDueCents, 200);
  assert.equal((await cash().adjust(input)).balance.remainingDueCents, 0);
});

test("exact BIGINT cash identities survive production driver defaults and source-linked correction", async ({ db, collect, cash, remit }) => {
  for (const table of ["delivery_payment_collections", "courier_cash_remittances", "courier_cash_adjustments"]) {
    await db.pool.query(`ALTER TABLE ${table} AUTO_INCREMENT=9007199254740993`);
  }
  const collection = await collect();
  assert.equal(collection.collectionId, "9007199254740993");
  const service = cash();
  const first = await remit(service, 2800);
  assert.equal(first.remittanceId, "9007199254740993");
  const input = { actor: actor(14, 0), courierId: 11, collectionId: collection.collectionId, remittanceId: first.remittanceId,
    deltaDueCents: -200, reason: "Approved shortage", idempotencyKey: "exact-adjustment" };
  const adjusted = await service.adjust(input);
  assert.equal(adjusted.adjustmentId, "9007199254740993");
  assert.deepEqual(await service.adjust(input), adjusted);
  const view = await service.balance({ actor: actor(), courierId: 11 });
  assert.equal(view.collections[0].collectionId, collection.collectionId);
  assert.equal(view.remittances[0].remittanceId, first.remittanceId);
  assert.equal(view.adjustments[0].adjustmentId, adjusted.adjustmentId);
});

test("R5 sale closes once; next physical-only period persists and reads immutable running debt", async ({ db, collect, cash, remit }) => {
  await collect();
  const orders = require("../src/modules/m_orders");
  await orders.mArchiveOrder(31, undefined, 7);
  await db.pool.query("UPDATE archives SET archived_at='2026-10-24 21:55:00.000000' WHERE delivery_id=41");
  const { buildCashClosures } = require("../src/modules/m_cashClosures");
  const firstService = buildCashClosures({ clock: () => "2026-10-24 22:00:00.000000" });
  const first = await firstService.mCloseCurrentCashClosure({ shopId: 7, userId: 10 });
  assert.equal(first.total_revenue, 30);
  assert.equal(first.courier_cash.collected_cents, 3000);
  assert.equal(first.courier_cash.received_cents, 0);
  assert.equal(first.courier_cash.outstanding_cents, 3000);
  assert.equal(first.courier_cash.courier_cash_sales_cents, 3000);
  assert.equal(first.courier_cash.register_cash_sales_cents, 0);
  const handed = await remit(cash({ clock: () => "2026-10-25 01:10:00.000001" }), 2800);
  const secondService = buildCashClosures({ clock: () => "2026-10-25 01:15:00.000000" });
  const second = await secondService.mCloseCurrentCashClosure({ shopId: 7, userId: 10 });
  assert.equal(second.orders_count, 0);
  assert.equal(second.total_revenue, 0);
  assert.deepEqual(second.payments_summary, []);
  assert.equal(second.courier_cash.collected_cents, 0);
  assert.equal(second.courier_cash.received_cents, 2800);
  assert.equal(second.courier_cash.outstanding_cents, 200);
  assert.equal(second.courier_cash.discrepancy_cents, -200);
  assert.deepEqual((await secondService.mGetCashClosureById({ shopId: 7, id: first.id })).courier_cash, first.courier_cash);
  assert.deepEqual((await secondService.mGetCashClosures(7)).find(row => row.id === second.id).courier_cash, second.courier_cash);
  await assert.rejects(secondService.mCloseCurrentCashClosure({ shopId: 7, userId: 10 }), { statusCode: 400 });
  await cash({ clock: () => "2026-10-25 01:20:00.000000" }).adjust({ actor: actor(14, 0), courierId: 11,
    collectionId: null, remittanceId: handed.remittanceId, deltaDueCents: -200, reason: "Approved shortage", idempotencyKey: "later-write-off" });
  const third = await buildCashClosures({ clock: () => "2026-10-25 01:25:00.000000" }).mCloseCurrentCashClosure({ shopId: 7, userId: 10 });
  assert.equal(third.total_revenue, 0);
  assert.equal(third.orders_count, 0);
  assert.equal(third.courier_cash.received_cents, 0);
  assert.equal(third.courier_cash.adjusted_due_cents, -200);
  assert.equal(third.courier_cash.outstanding_cents, 0);
  assert.deepEqual((await secondService.mGetCashClosureById({ shopId: 7, id: second.id })).courier_cash, second.courier_cash);
});

test("collection before closure and archive next period retain courier sales source", async ({ db, collect, cash, remit }) => {
  await collect();
  await remit(cash({ clock: () => "2026-10-24 21:59:00.000000" }), 3000);
  const { buildCashClosures } = require("../src/modules/m_cashClosures");
  const first = await buildCashClosures({ clock: () => "2026-10-24 22:00:00.000000" }).mCloseCurrentCashClosure({ shopId: 7, userId: 10 });
  assert.equal(first.orders_count, 0);
  await require("../src/modules/m_orders").mArchiveOrder(31, undefined, 7);
  await db.pool.query("UPDATE archives SET archived_at='2026-10-25 01:00:00.000000' WHERE delivery_id=41");
  const second = await buildCashClosures({ clock: () => "2026-10-25 02:00:00.000000" }).mCloseCurrentCashClosure({ shopId: 7, userId: 10 });
  assert.equal(second.total_revenue, 30);
  assert.equal(second.courier_cash.collected_cents, 0);
  assert.equal(second.courier_cash.courier_cash_sales_cents, 3000);
  assert.equal(second.courier_cash.register_cash_sales_cents, 0);
});

test("actual queued close/remittance takes posting clock after shop barrier at submillisecond cutoff", async ({ db, collect, cash, remit }) => {
  await collect();
  await require("../src/modules/m_orders").mArchiveOrder(31, undefined, 7);
  let reached;
  const observed = new Promise(resolve => { reached = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const close = require("../src/modules/m_cashClosures").buildCashClosures({ clock: async ({ connection }) => {
    const [rows] = await connection.query("SELECT CONNECTION_ID() id");
    reached(rows[0].id);
    await gate;
    return "2026-10-24 22:00:00.500123";
  } });
  const closing = close.mCloseCurrentCashClosure({ shopId: 7, userId: 10 });
  const blockerId = await observed;
  let clocks = 0;
  const service = cash({ clock: () => { clocks++; return "2026-10-24 22:00:00.500124"; } });
  // Read version before starting the queued mutation: balance itself takes the barrier.
  const pending = service.remit({ actor: actor(), courierId: 11, receivedCents: 3000, expectedBalanceVersion: 2, idempotencyKey: "queued" });
  try {
    let waits = [];
    const deadline = Date.now() + 5000;
    while (!waits.length && Date.now() < deadline) {
      waits = await db.readRows(`SELECT w.REQUESTING_ENGINE_TRANSACTION_ID FROM performance_schema.data_lock_waits w
        JOIN performance_schema.threads t ON t.THREAD_ID=w.BLOCKING_THREAD_ID WHERE t.PROCESSLIST_ID=?`, [blockerId]);
      if (!waits.length) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(waits.length, "remittance actually waits on close's shop barrier");
    assert.equal(clocks, 0);
  } finally { release(); }
  const first = await closing;
  await pending;
  assert.equal(clocks, 1);
  assert.equal(first.courier_cash.received_cents, 0);
  const second = await require("../src/modules/m_cashClosures").buildCashClosures({ clock: () => "2026-10-24 22:00:00.500125" }).mCloseCurrentCashClosure({ shopId: 7, userId: 10 });
  assert.equal(second.courier_cash.received_cents, 3000);
  assert.equal(second.courier_cash.outstanding_cents, 0);
  assert.equal((await db.readRows("SELECT DATE_FORMAT(created_at,'%Y-%m-%d %H:%i:%s.%f') t FROM courier_cash_remittances"))[0].t, "2026-10-24 22:00:00.500124");
});

test("production DB UTC clocks retain queued submillisecond receipt and refuse non-UTC delivery history even when disabled", async ({ db, collect, cash }) => {
  await collect();
  await require("../src/modules/m_orders").mArchiveOrder(31, undefined, 7);
  const { createTransactionRunner } = require("../src/helpers/withTransaction");
  const run = createTransactionRunner(require("../src/config/dbPool"));
  let reached;
  const observed = new Promise(resolve => { reached = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { buildCashClosures } = require("../src/modules/m_cashClosures");
  const closing = buildCashClosures({ runInTransaction: work => run(async connection => {
    await connection.query("SET timestamp=UNIX_TIMESTAMP('2026-10-24 22:00:00.500123')");
    try {
      const result = await work(connection);
      const [rows] = await connection.query("SELECT CONNECTION_ID() blocker,DATE_FORMAT(closed_at,'%Y-%m-%d %H:%i:%s.%f') cutoff FROM cash_closures WHERE id=?", [result.id]);
      reached(rows[0]);
      await gate;
      return result;
    } finally { await connection.query("SET timestamp=DEFAULT"); }
  }) }).mCloseCurrentCashClosure({ shopId: 7, userId: 10 });
  const { blocker, cutoff } = await observed;
  let postingCalls = 0;
  const pending = cash({ runInTransaction: work => run(async connection => {
    await connection.query("SET timestamp=UNIX_TIMESTAMP('2026-10-24 22:00:00.500124')");
    try { return await work(new Proxy(connection, { get(target, key) {
      if (key === "query") return (sql, values) => {
        if (typeof sql === "string" && sql.includes("SELECT DATE_FORMAT(UTC_TIMESTAMP(6)")) postingCalls++;
        return target.query(sql, values);
      };
      const value = target[key];
      return typeof value === "function" ? value.bind(target) : value;
    } })); }
    finally { await connection.query("SET timestamp=DEFAULT"); }
  }) }).remit({ actor: actor(), courierId: 11, receivedCents: 3000, expectedBalanceVersion: 2, idempotencyKey: "db-queued" });
  try {
    let waited = false;
    const deadline = Date.now() + 5000;
    while (!waited && Date.now() < deadline) {
      waited = (await db.readRows(`SELECT 1 FROM performance_schema.data_lock_waits w JOIN performance_schema.threads t
        ON t.THREAD_ID=w.BLOCKING_THREAD_ID WHERE t.PROCESSLIST_ID=?`, [blocker])).length > 0;
      if (!waited) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(waited);
    assert.equal(postingCalls, 0);
  } finally { release(); }
  await closing;
  await pending;
  assert.equal(postingCalls, 1);
  const posted = (await db.readRows("SELECT DATE_FORMAT(created_at,'%Y-%m-%d %H:%i:%s.%f') posted FROM courier_cash_remittances"))[0].posted;
  assert.equal(cutoff, "2026-10-24 22:00:00.500123");
  assert.equal(posted, "2026-10-24 22:00:00.500124");
  assert.ok(posted > cutoff);
  const next = await buildCashClosures({ clock: () => "2026-10-24 22:00:00.500125" }).mCloseCurrentCashClosure({ shopId: 7, userId: 10 });
  assert.equal(next.courier_cash.received_cents, 3000);
  const shifted = buildCashClosures({ runInTransaction: work => run(async connection => {
    await connection.query("SET time_zone='+02:00'");
    try { return await work(connection); }
    finally { await connection.query("SET time_zone='+00:00'"); }
  }) });
  const before = await db.readRows("SELECT *,DATE_FORMAT(closed_at,'%Y-%m-%d %H:%i:%s.%f') exact_cutoff FROM cash_closures ORDER BY id");
  assert.equal((await db.readRows("SELECT enabled FROM shop_delivery_settings WHERE shopid=7"))[0].enabled, 0);
  await assert.rejects(shifted.mGetCurrentCashClosure(7), /Delivery.*UTC database session/);
  await assert.rejects(shifted.mCloseCurrentCashClosure({ shopId: 7, userId: 10 }), /Delivery.*UTC database session/);
  await db.pool.query("DELETE FROM shop_delivery_settings WHERE shopid=7");
  await assert.rejects(shifted.mGetCurrentCashClosure(7), /Delivery.*UTC database session/);
  assert.deepEqual(await db.readRows("SELECT *,DATE_FORMAT(closed_at,'%Y-%m-%d %H:%i:%s.%f') exact_cutoff FROM cash_closures ORDER BY id"), before);
});

for (const settingsPresent of [false, true]) {
test(`non-UTC ordinary archived counter HTTP preview and close preserve session periods (${settingsPresent ? "disabled" : "missing"} delivery settings)`, async ({ db }) => {
  if (!settingsPresent) await db.pool.query("DELETE FROM shop_delivery_settings WHERE shopid=7");
  await db.pool.query(`UPDATE users SET module_permissions='["cashregister"]' WHERE id=10`);
  await db.pool.query(`INSERT INTO cash_closures (shopid,closure_number,closed_at,orders_count,total_revenue,payments_summary,vat_summary)
    VALUES (7,1,'2026-10-24 23:59:59.123456',1,9,'[{"historic":true}]','[]')`);
  const { buildCashClosures } = require("../src/modules/m_cashClosures");
  const run = require("../src/helpers/withTransaction").createTransactionRunner(require("../src/config/dbPool"));
  const shiftedRun = work => run(async connection => {
    await connection.query("SET time_zone='+02:00'");
    await connection.query("SET timestamp=UNIX_TIMESTAMP('2026-10-25 00:00:00.500123')");
    try { return await work(connection); }
    finally { await connection.query("SET timestamp=DEFAULT"); await connection.query("SET time_zone='+00:00'"); }
  });
  await shiftedRun(async connection => {
    for (const [id, archivedAt] of [[50, "2026-10-24 23:59:59.123456"], [51, null],
      [52, "2026-10-25 00:00:00.500124"], [53, "2026-10-24 23:59:59.123457"]]) {
      await connection.query(`INSERT INTO archives
        (id,shopid,ordernumber,customer,customerID,operator,subtotal,created,finished,token,is_takeaway,payment,archived_at)
        VALUES (?,7,?,'Counter guest',10,10,?,'2026-10-16','2026-10-16',?,1,'cash',COALESCE(?,CURRENT_TIMESTAMP(6)))`,
      [id, `COUNTER-${id}`, id === 50 ? 100 : id === 52 ? 200 : 12.5, `counter-${id}`, archivedAt]);
    }
  });
  const historic = await db.readRows("SELECT *,DATE_FORMAT(closed_at,'%Y-%m-%d %H:%i:%s.%f') exact_cutoff FROM cash_closures");
  const archives = await db.readRows("SELECT *,DATE_FORMAT(archived_at,'%Y-%m-%d %H:%i:%s.%f') exact_archive FROM archives ORDER BY id");
  Object.assign(require.cache[require.resolve("../src/modules/m_cashClosures")].exports, buildCashClosures({ runInTransaction: shiftedRun }));
  const app = express();
  app.use(express.json());
  app.use(require("../src/routers/r_orders"));
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const http = async (url, method = "GET") => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { method,
      headers: { Authorization: `Bearer ${jwt.sign({ id: 10, shopid: 7, access: 0 }, process.env.JWTKEY)}` } });
    return { status: response.status, body: await response.json() };
  };
  try {
    await db.pool.query("UPDATE users SET status=0 WHERE id=10");
    assert.equal((await http("/reports/z/current")).status, 403);
    assert.equal((await http("/reports/z/close", "POST")).status, 403);
    await db.pool.query(`UPDATE users SET status=1,module_permissions='["delivery"]' WHERE id=10`);
    assert.equal((await http("/reports/z/current")).status, 403);
    assert.equal((await http("/reports/z/close", "POST")).status, 403);
    await db.pool.query(`UPDATE users SET module_permissions='["cashregister"]' WHERE id=10`);
    const preview = await http("/reports/z/current");
    assert.equal(preview.status, 200, JSON.stringify(preview));
    assert.equal(preview.body.data.opened_at, "2026-10-24 23:59:59.123456");
    assert.equal(preview.body.data.closed_at, "2026-10-25 00:00:00.500123");
    assert.equal(preview.body.data.orders_count, 2);
    assert.equal(preview.body.data.total_revenue, 25);
    assert.equal(preview.body.data.courier_cash.register_cash_sales_cents, 2500);
    assert.equal(preview.body.data.courier_cash.outstanding_cents, 0);
    const closed = await http("/reports/z/close", "POST");
    assert.equal(closed.status, 201, JSON.stringify(closed));
    assert.equal(closed.body.data.closed_by_user_id, 10);
    assert.equal(closed.body.data.closure_number, 2);
    assert.equal(closed.body.data.orders_count, 2);
    assert.equal(closed.body.data.total_revenue, 25);
    assert.deepEqual(closed.body.data.courier_cash, preview.body.data.courier_cash);
    const stored = await db.readRows("SELECT DATE_FORMAT(opened_at,'%Y-%m-%d %H:%i:%s.%f') opened_at,DATE_FORMAT(closed_at,'%Y-%m-%d %H:%i:%s.%f') closed_at FROM cash_closures WHERE closure_number=2");
    assert.deepEqual(stored, [{ opened_at: preview.body.data.opened_at, closed_at: preview.body.data.closed_at }]);
    assert.equal((await http("/reports/z/current")).body.data.orders_count, 0);
    assert.deepEqual(await db.readRows("SELECT *,DATE_FORMAT(closed_at,'%Y-%m-%d %H:%i:%s.%f') exact_cutoff FROM cash_closures WHERE closure_number=1"), historic);
    assert.deepEqual(await db.readRows("SELECT *,DATE_FORMAT(archived_at,'%Y-%m-%d %H:%i:%s.%f') exact_archive FROM archives ORDER BY id"), archives);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
}

test("non-UTC delivery requirement covers enabled settings and external-card financial history", async ({ db, collect }) => {
  const run = require("../src/helpers/withTransaction").createTransactionRunner(require("../src/config/dbPool"));
  const shifted = require("../src/modules/m_cashClosures").buildCashClosures({ runInTransaction: work => run(async connection => {
    await connection.query("SET time_zone='+02:00'");
    try { return await work(connection); }
    finally { await connection.query("SET time_zone='+00:00'"); }
  }) });
  await db.pool.query("UPDATE shop_delivery_settings SET enabled=1,origin_latitude=48.8566,origin_longitude=2.3522,max_distance_meters=6000,vat_rate=10 WHERE shopid=7");
  await assert.rejects(shifted.mGetCurrentCashClosure(7), /UTC database session/);
  await db.pool.query("UPDATE shop_delivery_settings SET enabled=0 WHERE shopid=7");
  assert.equal((await shifted.mGetCurrentCashClosure(7)).orders_count, 0);
  await collect("external_card");
  await assert.rejects(shifted.mGetCurrentCashClosure(7), /Delivery.*UTC database session/);
  await assert.rejects(shifted.mCloseCurrentCashClosure({ shopId: 7, userId: 10 }), /Delivery.*UTC database session/);
  assert.equal((await db.readRows("SELECT COUNT(*) n FROM cash_closures"))[0].n, 0);
});

test("non-UTC delivery activation refuses before settings or revision writes on the same SQL connection", async ({ db }) => {
  const { buildSqlDeliverySettingsRepository } = require("../src/modules/m_deliverySettings");
  const settings = { enabled: true, origin: { latitude: 48.8566, longitude: 2.3522 }, maxDistanceMeters: 6000,
    minimumItemsCents: 0, freeDeliveryEnabled: false, freeDeliveryThresholdCents: null,
    fiscalPolicy: { mode: "configured_rate", vatRate: 10 }, bands: [{ upToMeters: 6000, feeCents: 400 }] };
  const connection = await db.pool.getConnection();
  let writes = 0;
  const observed = new Proxy(connection, { get(target, key) {
    if (key === "release") return () => {};
    if (key === "query") return (sql, values) => { if (/^(INSERT|UPDATE|DELETE)\b/i.test(sql)) writes++; return target.query(sql, values); };
    const value = target[key];
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const repository = buildSqlDeliverySettingsRepository({ pool: { getConnection: async () => observed } });
  try {
    await connection.query("SET time_zone='+02:00'");
    await db.pool.query("DELETE FROM shop_delivery_settings WHERE shopid=8");
    const before = await db.readRows("SELECT * FROM shop_delivery_settings ORDER BY shopid");
    for (const [shopId, expectedRevision] of [[7, 1], [8, 0]]) {
      writes = 0;
      await assert.rejects(repository.saveSettings({ shopId, expectedRevision, settings }), { code: "DELIVERY_UTC_SESSION_REQUIRED" });
      assert.equal(writes, 0);
      assert.deepEqual(await db.readRows("SELECT * FROM shop_delivery_settings ORDER BY shopid"), before);
      assert.deepEqual(await db.readRows("SELECT * FROM shop_delivery_fee_bands"), []);
    }
    const disabled = await repository.saveSettings({ shopId: 7, expectedRevision: 1, settings: { ...settings, enabled: false } });
    assert.equal(disabled.revision, 2);
    assert.equal(disabled.enabled, false);
    await connection.query("SET time_zone='+00:00'");
    const enabled = await repository.saveSettings({ shopId: 7, expectedRevision: 2, settings });
    assert.equal(enabled.revision, 3);
    assert.equal(enabled.enabled, true);
  } finally { await connection.query("SET time_zone='+00:00'"); connection.release(); }
});

test("additive migration up/down/up preserves historic null snapshots and journal constraints", async ({ db }) => {
  const source = fs.readFileSync(path.join(__dirname, "../db/migrations/20261016121000_delivery_cash_closures.sql"), "utf8").split(/^-- migrate:(?:up|down)\s*$/m);
  await db.pool.query("INSERT INTO cash_closures (shopid,closure_number,closed_at,orders_count,total_revenue,payments_summary,vat_summary) VALUES (7,1,'2026-10-01',1,12,'[]','[]')");
  await db.pool.query(source[2]);
  await db.pool.query(source[1]);
  const historic = await require("../src/modules/m_cashClosures").mGetCashClosures(7);
  assert.equal(historic[0].courier_cash, null);
  const precision = await db.readRows(`SELECT DATETIME_PRECISION FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('delivery_payment_collections','courier_cash_remittances','courier_cash_remittance_allocations','courier_cash_adjustments') AND COLUMN_NAME='created_at'`);
  assert.deepEqual(precision.map(row => row.DATETIME_PRECISION), [6, 6, 6, 6]);
});

test("actual HTTP trusted own balance, operator handovers, strict payloads and four Z boundaries", async ({ db, collect }) => {
  await collect("cash", new Date());
  const app = express();
  app.use(express.json());
  app.use(require("../src/routers/r_courier"));
  app.use(require("../src/routers/r_delivery"));
  app.use(require("../src/routers/r_orders"));
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const http = async (url, { id = 11, shopid = 7, access = 6, claims, method = "GET", body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { method,
      headers: { Authorization: `Bearer ${jwt.sign(claims || { id, shopid, access }, process.env.JWTKEY)}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const raw = await response.text();
    return { status: response.status, data: raw.startsWith("{") ? JSON.parse(raw) : raw, cache: response.headers.get("cache-control") };
  };
  try {
    const own = await http("/courier/cash-balance?courierId=12&shopId=8", { access: 0 });
    assert.equal(own.status, 200);
    assert.equal(own.cache, "no-store");
    assert.equal(own.data.data.courierId, 11);
    assert.equal(own.data.data.shopId, 7);
    assert.equal(own.data.data.remainingDueCents, 3000);
    assert.ok(!JSON.stringify(own.data).includes("address"));
    assert.equal((await http("/courier/cash-balance", { id: 12, shopid: 8 })).data.data.remainingDueCents, 0);
    assert.equal((await http("/courier/cash-balance", { id: 10 })).status, 403);
    await db.pool.query("UPDATE users SET status=0 WHERE id=11");
    assert.equal((await http("/courier/cash-balance")).status, 403);
    assert.equal((await http("/delivery/couriers/11/cash-balance", { id: 10 })).data.data.remainingDueCents, 3000);
    await db.pool.query("UPDATE users SET status=1 WHERE id=11");
    const balance = await http("/delivery/couriers/11/cash-balance", { id: 10 });
    assert.equal(balance.status, 200);
    assert.equal((await http("/delivery/couriers/12/cash-balance", { id: 10 })).status, 404);
    const input = { receivedCents: 2800, expectedBalanceVersion: balance.data.data.version, idempotencyKey: "http-remit" };
    for (const receivedCents of [-1, 1.5, "2800", null, 9007199254740992]) {
      assert.equal((await http("/delivery/couriers/11/remittances", { id: 10, method: "POST", body: { ...input, receivedCents } })).status, 400);
    }
    assert.equal((await http("/delivery/couriers/11/remittances", { id: 10, method: "POST", body: { ...input, actor: actor(14, 0) } })).status, 400);
    const handed = await http("/delivery/couriers/11/remittances", { id: 10, method: "POST", body: input });
    assert.equal(handed.status, 200);
    assert.equal(handed.data.data.remainingDueCents, 200);
    assert.equal((await http("/delivery/couriers/11/adjustments", { id: 10, method: "POST", body: { collectionId: null,
      remittanceId: handed.data.data.remittanceId, deltaDueCents: -200, reason: "write-off", idempotencyKey: "no-admin" } })).status, 403);
    for (const [url, method] of [["/reports/z/current", "GET"], ["/reports/z/close", "POST"], ["/reports/z", "GET"], ["/reports/z/999", "GET"]]) {
      for (const options of [{}, { claims: { subject_type: "service_point", service_point_id: 1, shopid: 7, access: 2 } }, { id: 13 }]) {
        if (options.id === 13) await db.pool.query("UPDATE users SET status=0 WHERE id=13");
        assert.equal((await http(url, { ...options, method })).status, 403, `${method} ${url}`);
      }
      const authorized = await http(url, { id: 10, method });
      assert.equal(authorized.status, url.endsWith("999") ? 404 : url.endsWith("close") ? 201 : 200, JSON.stringify(authorized));
    }
    const corrected = await http("/delivery/couriers/11/adjustments", { id: 14, access: 1, method: "POST", body: { collectionId: null,
      remittanceId: handed.data.data.remittanceId, deltaDueCents: -200, reason: "Approved shortage", idempotencyKey: "http-admin" } });
    assert.equal(corrected.status, 200);
    assert.equal(corrected.data.data.balance.remainingDueCents, 0);
    assert.equal((await db.readRows("SELECT actor_id FROM courier_cash_adjustments"))[0].actor_id, 14);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

async function main() {
  let failures = 0;
  for (const { name, work } of tests) {
    if (process.env.TASK7_FILTER && !name.includes(process.env.TASK7_FILTER)) continue;
    try { await fixture(work); console.log(`PASS SQL ${name}`); }
    catch (error) { failures++; console.error(`FAIL SQL ${name}: ${error.stack}`); }
  }
  if (failures) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
