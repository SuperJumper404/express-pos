const assert = require('assert');
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
const { withDeliveryDatabase } = require('./helpers/deliveryDatabase');

const tests = [];
const test = (name, run) => tests.push({ name, run });
const actor = { subject: 'staff', id: 10, shopId: 7, access: 1 };
const fee = { bandFeeCents: 400, freeDeliveryApplied: false, feeCents: 400, totalExclTaxCents: 333, taxCents: 67, vatRate: 20,
  fiscalPolicy: { mode: 'configured_rate', vatRate: 20 } };
const vat = [{ vat_rate: 10, total_ht: 18.18, total_vat: 1.82, total_ttc: 20 },
  { vat_rate: 20, total_ht: 3.33, total_vat: 0.67, total_ttc: 4 }];

async function fixture(work, largeIdentity = false) {
  await withDeliveryDatabase(async db => {
    await db.seedScenario();
    for (const key of Object.keys(require.cache)) if (key.startsWith(path.resolve(__dirname, '../src') + path.sep)) delete require.cache[key];
    const config = db.pool.pool.config.connectionConfig;
    const appPool = mysql.createPool({ host: config.host, port: config.port, user: config.user, password: config.password,
      database: db.database, charset: 'utf8mb4', timezone: 'Z', connectionLimit: 8 });
    require.cache[require.resolve('../src/config/dbPool')] = { exports: appPool };
    require.cache[require.resolve('../src/config/db')] = { exports: appPool.pool };
    require.cache[require.resolve('../src/config/stripe')] = { exports: { getStripe() { throw new Error('Forbidden provider call'); } } };
    if (Number(process.versions.node.split('.')[0]) < 22) require.cache[require.resolve('nanoid')] = { exports: await import('nanoid') };
    const logs = [];
    const originalLog = console.log;
    console.log = (...values) => logs.push(values);
    let server;
    const priorDeliverySecret = process.env.DELIVERY_TOKEN_SECRET;
    process.env.DELIVERY_TOKEN_SECRET = 'task15-round1-disposable-signing-fixture-only';
    try {
      await db.pool.query('DELETE FROM archives WHERE id=32');
      // Change the seed identity before inserting the immutable fiscal snapshot.
      if (largeIdentity) {
        await db.pool.query('SET FOREIGN_KEY_CHECKS=0');
        await db.pool.query("UPDATE deliveries SET id='9007199254740993' WHERE id=41");
        await db.pool.query("UPDATE orders SET delivery_id='9007199254740993' WHERE id=31");
        await db.pool.query('SET FOREIGN_KEY_CHECKS=1');
      }
      await db.pool.query(`UPDATE users SET module_permissions='["delivery","cashregister"]' WHERE id=10`);
      await db.pool.query(`UPDATE shop SET activate_tva=1,admin_password='PRIVATE_CREDENTIAL_SENTINEL',shop_printer_ip='PRIVATE_CONFIGURATION_SENTINEL' WHERE id=7`);
      await db.pool.query("ALTER TABLE shop ADD task15_private_configuration VARCHAR(90) DEFAULT 'PRIVATE_UNLISTED_SENTINEL'");
      await db.pool.query(`UPDATE orders SET subtotal=24,subtotal_before_discount=20,discount_amount=0,status=3,
        order_source='web',payment_status='unpaid',payment='Paiement au comptoir',payment_provider=NULL WHERE id=31`);
      await db.pool.query(`UPDATE deliveries SET courier_id=11,delivery_status='in_transit',address_snapshot=? WHERE id=41`,
        [JSON.stringify({ line1: '7 rue Test', instructions: 'PRIVATE_INTERPHONE_SENTINEL' })]);
      await db.pool.query(`INSERT INTO delivery_charge_snapshots (shopid,delivery_id,revision,band_fee_cents,
        free_delivery_applied,fee_cents,total_excl_tax_cents,tax_cents,vat_rate,fiscal_policy)
        VALUES (7,?,1,400,0,400,333,67,20,'{"mode":"configured_rate","vatRate":20}')`,
        [largeIdentity ? '9007199254740993' : '41']);
      await db.pool.query(`INSERT INTO orderdetail (orderid,productid,qty,price,total,vat_rate,unit_price_ht,unit_vat,total_ht,total_vat)
        VALUES (31,21,1,20,20,10,18.18,1.82,18.18,1.82)`);
      const app = express();
      app.use(express.json());
      app.use(require('../src/routers/r_orders'));
      server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
      const call = async (route, method = 'GET', body) => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method,
          headers: { Authorization: `Bearer ${jwt.sign({ id: 10, shopid: 7, access: 1 }, process.env.JWTKEY)}`, 'Content-Type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}) });
        return { status: response.status, body: await response.json() };
      };
      const collect = () => require('../src/modules/m_deliveryCollections').buildDeliveryCollections({ clock: () => '2026-10-24 21:50:00.000001' }).collect({
        actor: { ...actor, id: 11, access: 6 }, deliveryId: '41', method: 'cash', expectedVersion: 1, idempotencyKey: 'task15-collect' });
      const archive = async () => {
        await require('../src/modules/m_orders').mArchiveOrder(31, undefined, 7);
        await db.pool.query("UPDATE archives SET archived_at='2026-10-24 21:55:00' WHERE delivery_id=41");
        return (await db.readRows('SELECT id,token FROM archives WHERE delivery_id=41'))[0];
      };
      const closure = time => require('../src/modules/m_cashClosures').buildCashClosures({ clock: () => time });
      await work({ db, call, collect, archive, logs, closure });
    } finally {
      if (priorDeliverySecret === undefined) delete process.env.DELIVERY_TOKEN_SECRET;
      else process.env.DELIVERY_TOKEN_SECRET = priorDeliverySecret;
      console.log = originalLog;
      if (server) await new Promise(resolve => server.close(resolve));
      await appPool.end();
    }
  });
}

const preparePrivateAmendment = async ({ db, call }) => {
  const address = { street: '7 rue Test', postalCode: '75001', city: 'Paris', country: 'FR',
    providerId: 'fixture-address-7', providerLabel: '7 rue Test 75001 Paris', precision: 'housenumber', cityCode: '75056',
    latitude: 48.857, longitude: 2.353 };
  const privateFields = { complement: 'Appartement B', building: 'Batiment C', floor: '2',
    intercom: 'PRIVATE_INTERCOM_FIXTURE', instructions: 'PRIVATE_INSTRUCTIONS_FIXTURE' };
  await db.pool.query(`UPDATE orders SET status=1 WHERE id=31`);
  await db.pool.query(`UPDATE deliveries SET delivery_status='assigned',address_snapshot=?,latitude=?,longitude=? WHERE id=41`,
    [JSON.stringify({ ...address, ...privateFields }), address.latitude, address.longitude]);
  await db.pool.query('UPDATE products SET price=20,vat_rate_takeaway=10 WHERE id=21');
  await db.pool.query(`UPDATE shop_delivery_settings SET enabled=1,revision=1,origin_latitude=48.8566,
    origin_longitude=2.3522,max_distance_meters=5000,minimum_items_cents=0,free_delivery_enabled=0,
    fiscal_mode='configured_rate',vat_rate=20 WHERE shopid=7`);
  await db.pool.query('INSERT INTO shop_delivery_fee_bands (shopid,up_to_meters,fee_cents) VALUES (7,5000,400)');
  const { buildDeliveryTokenCodec, signAddressResolution } = require('../src/helpers/deliveryAddress');
  const tokenCodec = buildDeliveryTokenCodec({ secret: 'task15-round1-disposable-signing-fixture-only' });
  const quotes = require('../src/modules/m_deliveryQuotes').buildDeliveryQuotes({ tokenCodec,
    geocoder: { resolve() { throw new Error('Forbidden geocoding provider call'); } } });
  const editable = await call('/orders/31/edit');
  assert.equal(editable.status, 200);
  const makeBody = async (destination = address, items = [{ productId: 21, quantity: 1, selectedChoiceIds: [] }]) => {
    const resolution = signAddressResolution({ shopId: 7, addressSnapshot: destination, tokenCodec });
    const quote = await quotes.createQuote({ shopId: 7, items, discount: { type: 'amount', value: 2 }, addressResolutionToken: resolution });
    return { content_revision: editable.body.data.content_revision, expected_total: quote.grandTotalCents / 100,
      items: items.map(item => ({ product_id: item.productId, quantity: item.quantity, selected_product_step_choice_ids: item.selectedChoiceIds })),
      delivery_quote_token: quote.quoteToken, address_resolution_token: resolution,
      delivery_expected_version: editable.body.data.order.delivery_version, delivery_idempotency_key: 'task15-round1-edit',
      discount_type: 'amount', discount_value: 2 };
  };
  const readSnapshot = async () => {
    const row = (await db.readRows('SELECT address_snapshot FROM deliveries WHERE id=41'))[0];
    return typeof row.address_snapshot === 'string' ? JSON.parse(row.address_snapshot) : row.address_snapshot;
  };
  return { address, privateFields, makeBody, readSnapshot };
};

test('Round1 authorized price revision retains locked private address fields, fiscal revision, audit and exact replay', async ({ db, call, logs }) => {
  const { address, privateFields, makeBody, readSnapshot } = await preparePrivateAmendment({ db, call });
  const stock = await db.readRows('SELECT stock FROM products WHERE id=21');
  const body = await makeBody({ ...address, providerLabel: 'Equivalent canonical label' });
  const result = await call('/orders/31/items', 'PATCH', body);
  assert.equal(result.status, 200, result.body.message);
  assert.equal(result.body.data.total, 22);
  assert.deepStrictEqual(await readSnapshot(), { ...address, providerLabel: 'Equivalent canonical label', ...privateFields });
  const state = (await db.readRows('SELECT version,charge_revision FROM deliveries WHERE id=41'))[0];
  assert.deepStrictEqual({ ...state }, { version: 2, charge_revision: 2 });
  assert.deepStrictEqual(result.body.data.delivery.financials, {
    items_total: 20, items_discount: 2, delivery_fee: 4, grand_total: 22, delivery_charge: fee,
  });
  const detail = (await db.readRows('SELECT total,total_ht,total_vat FROM orderdetail WHERE orderid=31'))[0];
  assert.equal(Number(detail.total), 18);
  assert.equal(Number(detail.total_ht), 16.36);
  assert.equal(Number(detail.total_vat), 1.64);
  assert.deepStrictEqual(await db.readRows('SELECT stock FROM products WHERE id=21'), stock);
  const events = await db.readRows("SELECT previous_state,next_state FROM delivery_events WHERE delivery_id=41 AND event_type='checkout_revised'");
  assert.equal(events.length, 1);
  for (const field of ['previous_state', 'next_state']) {
    const event = typeof events[0][field] === 'string' ? JSON.parse(events[0][field]) : events[0][field];
    assert.deepStrictEqual(event.delivery.addressSnapshot.instructions, privateFields.instructions);
    assert.equal(event.delivery.addressSnapshot.complement, privateFields.complement);
  }
  await db.pool.query('UPDATE shop_delivery_settings SET enabled=0,revision=2 WHERE shopid=7');
  const replay = await call('/orders/31/items', 'PATCH', body);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.data.idempotent_replay, true);
  assert.deepStrictEqual(replay.body.data.delivery, result.body.data.delivery);
  const expanded = await call('/orders/31/items', 'PATCH', { ...body,
    delivery_address_details: { instructions: 'UNTRUSTED_NEW_DETAIL' } });
  assert.equal(expanded.status, 400);
  assert.equal((await db.readRows('SELECT COUNT(*) n FROM delivery_charge_snapshots WHERE delivery_id=41'))[0].n, 2);
  assert.equal((await db.readRows("SELECT COUNT(*) n FROM delivery_events WHERE delivery_id=41 AND event_type='checkout_revised'"))[0].n, 1);
  assert.deepStrictEqual(await readSnapshot(), { ...address, providerLabel: 'Equivalent canonical label', ...privateFields });
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE_|UNTRUSTED_NEW_DETAIL/);
});

test('Round1 changed canonical destination refuses and rolls back price items stock charge and audit', async ({ db, call }) => {
  const { address, makeBody } = await preparePrivateAmendment({ db, call });
  const tables = ['orders', 'orderdetail', 'deliveries', 'delivery_charge_snapshots', 'delivery_events',
    'products', 'order_stock_reservations', 'stocks'];
  const snapshot = () => Promise.all(tables.map(table => db.readRows(`SELECT * FROM ${table} ORDER BY id`)));
  const before = await snapshot();
  for (const destination of [{ ...address, street: '9 rue Test' }, { ...address, latitude: 48.858 },
    { ...address, providerId: 'another-verified-destination' }, { ...address, country: '' }]) {
    const body = await makeBody(destination, [{ productId: 21, quantity: 2, selectedChoiceIds: [] }]);
    const result = await call('/orders/31/items', 'PATCH', body);
    assert.equal(result.status, 409);
    assert.equal(result.body.data.code, 'DELIVERY_ADDRESS_CHANGE_NOT_ALLOWED');
    assert.deepStrictEqual(await snapshot(), before);
  }
});

test('actual HTTP active list and detail project exact delivery identity and accepted fee', async ({ db, call }) => {
  const identity = '9007199254740993';
  for (const route of ['/orders', '/detailorder/31']) {
    const result = await call(route);
    assert.equal(result.status, 200, JSON.stringify(result));
    const row = result.body.data.find(row => row.id === 31);
    assert.equal(row.delivery_id, identity);
    assert.deepStrictEqual(row.delivery_charge, fee);
    assert.equal(row.financials.grand_total, 24);
    assert.equal(row.financials.items_total, 20);
  }
});
test('public HTTP receipt allowlist excludes credential and private configuration from response and logs', async ({ db, collect, archive, call, logs }) => {
  await collect();
  const saved = await archive();
  const result = await call(`/orderbytoken/${saved.token}`);
  assert.equal(result.status, 200);
  assert.equal(result.body.data.shopInfo[0].shop_name, 'Delivery fixture 7');
  assert.equal(result.body.data.shopInfo[0].activate_tva, 1);
  assert.deepStrictEqual(result.body.data.orderDetail[0].delivery_charge, fee);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|admin_password|shop_printer_ip|task15_private_configuration/);
  const admin = await require('../src/modules/m_shop').mGetShopInfo(7);
  assert.equal(admin[0].admin_password, 'PRIVATE_CREDENTIAL_SENTINEL');
  assert.equal(admin[0].task15_private_configuration, 'PRIVATE_UNLISTED_SENTINEL');
  await db.pool.query(`INSERT INTO archives
    (id,shopid,ordernumber,customer,customerID,operator,subtotal,created,finished,token,is_takeaway)
    VALUES (99,7,'LEGACY-99','Fictional guest',10,10,20,'2026-10-16 12:00:00','2026-10-16 12:00:00','legacy-receipt-fixture',1)`);
  await db.pool.query('INSERT INTO archivesdetail (orderId,productid,qty,price,total) VALUES (99,21,1,20,20)');
  const legacy = await call('/orderbytoken/legacy-receipt-fixture');
  assert.equal(legacy.status, 200);
  assert.equal(Number(legacy.body.data.orderDetail[0].subtotal), 20);
  assert.equal(legacy.body.data.orderDetail[0].delivery_charge, undefined);
  assert.equal(legacy.body.data.shopInfo[0].shop_name, 'Delivery fixture 7');
  assert.ok(!JSON.stringify(logs).includes(saved.token));
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE_/);
});
test('archive reprint and HTTP metrics retain original sale fee VAT after settings change and full refund', async ({ db, collect, archive, call, logs }) => {
  await collect();
  const saved = await archive();
  await db.pool.query('UPDATE shop_delivery_settings SET enabled=0,vat_rate=5.5 WHERE shopid=7');
  await require('../src/modules/m_deliveryRefunds').buildDeliveryRefunds({ clock: () => '2026-10-25 01:10:00.000001' }).refund({
    actor, deliveryId: '41', returnSource: 'register', reason: 'Fictional full return', idempotencyKey: 'task15-refund' });
  for (const route of ['/orders/archives', `/detailorder/archive/${saved.id}`, `/orderbytoken/${saved.token}`]) {
    const result = await call(route);
    assert.equal(result.status, 200, JSON.stringify(result));
    const rows = result.body.data.orderDetail || result.body.data;
    const row = rows.find(row => row.delivery_id === '41');
    assert.equal(Number(row.subtotal), 24);
    assert.equal(row.payment_status, 'refunded');
    assert.deepStrictEqual(row.delivery_charge, fee);
  }
  const result = await call('/metrics?from=2026-10-16&to=2026-10-16');
  assert.equal(result.status, 200);
  assert.equal(result.body.data.totalRevenue, 24);
  assert.equal(result.body.data.totalOrders, 1);
  assert.equal(result.body.data.deliveryFees, 4);
  assert.equal(result.body.data.refundedSales, 24);
  assert.deepStrictEqual(result.body.data.vatSummary, vat);
  assert.equal(result.body.data.topProducts.length, 1);
  assert.equal(result.body.data.topProducts[0].qty, 1);
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE_/);
});
test('SQL closures include fee VAT once and separate later physical refund and remittance with zero orders', async ({ db, collect, archive, closure }) => {
  await db.pool.query('UPDATE orderdetail SET price=10,total=10,unit_price_ht=9.09,unit_vat=0.91,total_ht=9.09,total_vat=0.91 WHERE orderid=31');
  await db.pool.query(`INSERT INTO orderdetail (orderid,productid,qty,price,total,vat_rate,unit_price_ht,unit_vat,total_ht,total_vat)
    VALUES (31,21,1,10,10,10,9.09,0.91,9.09,0.91)`);
  await db.pool.query(`INSERT INTO delivery_charge_snapshots (shopid,delivery_id,revision,band_fee_cents,
    free_delivery_applied,fee_cents,total_excl_tax_cents,tax_cents,vat_rate,fiscal_policy)
    VALUES (7,41,2,400,0,400,333,67,20,'{"mode":"configured_rate","vatRate":20}')`);
  await db.pool.query('UPDATE deliveries SET charge_revision=2 WHERE id=41');
  await collect();
  await archive();
  const firstService = closure('2026-10-24 22:00:00.000000');
  const first = await firstService.mCloseCurrentCashClosure({ shopId: 7, userId: 10 });
  assert.equal(first.total_revenue, 24);
  assert.deepStrictEqual(first.vat_summary.map(row => ({ ...row, vat_rate: Number(row.vat_rate) })), vat);
  assert.equal(first.courier_cash.register_cash_sales_cents, 0);
  assert.equal(first.courier_cash.courier_cash_sales_cents, 2400);
  await db.pool.query('UPDATE shop_delivery_settings SET enabled=0,vat_rate=5.5 WHERE shopid=7');
  const persisted = await firstService.mGetCashClosureById({ shopId: 7, id: first.id });
  assert.equal(persisted.total_revenue, 24);
  assert.deepStrictEqual(persisted.vat_summary.map(row => ({ ...row, vat_rate: Number(row.vat_rate) })), vat);
  const [storedJson] = await db.readRows('SELECT vat_summary FROM cash_closures WHERE id=?', [first.id]);
  const storedVat = typeof storedJson.vat_summary === 'string' ? JSON.parse(storedJson.vat_summary) : storedJson.vat_summary;
  assert.deepStrictEqual(storedVat.map(row => ({ ...row, vat_rate: Number(row.vat_rate) })), vat);
  await require('../src/modules/m_deliveryRefunds').buildDeliveryRefunds({ clock: () => '2026-10-25 01:10:00.000001' }).refund({
    actor, deliveryId: '41', returnSource: 'register', reason: 'Fictional full return', idempotencyKey: 'task15-refund' });
  const second = await closure('2026-10-25 01:15:00.000000').mCloseCurrentCashClosure({ shopId: 7, userId: 10 });
  assert.equal(second.orders_count, 0);
  assert.equal(second.total_revenue, 0);
  assert.deepStrictEqual(second.vat_summary, []);
  assert.equal(second.courier_cash.cash_refunded_by_register_cents, 2400);
  assert.equal(second.courier_cash.outstanding_cents, 2400);
  const cash = require('../src/modules/m_courierCash').buildCourierCash({ clock: () => '2026-10-25 01:20:00.000001' });
  const balance = await cash.balance({ actor, courierId: 11 });
  await cash.remit({ actor, courierId: 11, receivedCents: 2400, expectedBalanceVersion: balance.version, idempotencyKey: 'task15-remit' });
  const third = await closure('2026-10-25 01:25:00.000000').mCloseCurrentCashClosure({ shopId: 7, userId: 10 });
  assert.equal(third.orders_count, 0);
  assert.equal(third.total_revenue, 0);
  assert.deepStrictEqual(third.vat_summary, []);
  assert.equal(third.courier_cash.received_cents, 2400);
  assert.equal(third.courier_cash.register_cash_sales_cents, 0);
  assert.equal(third.courier_cash.courier_cash_sales_cents, 0);
  const reloaded = await firstService.mGetCashClosureById({ shopId: 7, id: first.id });
  for (const key of Object.keys(first)) assert.deepStrictEqual(reloaded[key], first[key], key);
  assert.equal((await db.readRows('SELECT COUNT(*) n FROM archives WHERE delivery_id=41'))[0].n, 1);
});

(async () => {
  let failed = 0;
  for (const { name, run } of tests.filter(test => !process.env.TASK15_REPORT_FILTER || test.name.includes(process.env.TASK15_REPORT_FILTER))) {
    try { await fixture(run, name.startsWith('actual HTTP active')); console.log(`PASS ${name}`); } catch (error) { failed++; console.error(`FAIL ${name}: ${error.stack}`); }
  }
  process.exitCode = failed ? 1 : 0;
})();
