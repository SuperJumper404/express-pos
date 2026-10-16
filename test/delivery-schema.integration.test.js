const assert = require("assert/strict");
const { withDeliveryDatabase } = require("./helpers/deliveryDatabase");

async function paymentStateHasSingleAuthority(readRows) {
  const columns = await readRows(`SELECT TABLE_NAME AS table_name FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'payment_status'
      AND TABLE_NAME IN ('deliveries', 'orders', 'archives') ORDER BY TABLE_NAME`);
  assert.deepEqual(columns.map((column) => column.table_name), ["archives", "orders"],
    "Payment status belongs only to authoritative orders and archives");
}

async function legacyRowsStayLegacyAndLinksSurviveArchive() {
  await withDeliveryDatabase(async ({ pool, readRows, migrateDelivery }) => {
    await paymentStateHasSingleAuthority(readRows);
    const [legacyOrder] = await readRows("SELECT * FROM orders WHERE id = 31");
    const [legacyArchive] = await readRows("SELECT * FROM archives WHERE id = 32");
    const [settingsForShop7] = await readRows("SELECT * FROM shop_delivery_settings WHERE shopid = 7");
    assert.equal(legacyOrder.delivery_id, null);
    assert.equal(legacyOrder.customer_account_id, null);
    assert.equal(legacyOrder.fulfillment_type, "dine_in");
    assert.equal(legacyArchive.fulfillment_type, 'takeaway');
    assert.equal(legacyArchive.customer_account_id, null);
    assert.equal(Boolean(settingsForShop7.enabled), false);
    assert.equal((await readRows("SELECT * FROM shop_delivery_settings")).length, 2);
    assert.equal((await readRows("SELECT * FROM orders WHERE id = 33"))[0].fulfillment_type, "takeaway");
    assert.equal(legacyOrder.subtotal, "12.50");

    await pool.query(`INSERT INTO deliveries
      (id, shopid, origin_order_id, order_reference, address_snapshot, contact_snapshot,
       latitude, longitude, distance_meters, settings_revision, client_order_token,
       confirmation_secret_hash, tracking_token_hash, tracking_expires_at)
      VALUES ('41', 7, 31, 'FIXTURE-31', '{"line1":"Stable address"}', '{"name":"Guest"}',
        48.8566, 2.3522, 1800, 1, 'checkout-31', REPEAT('a',64), REPEAT('b',64), '2026-11-15 12:00:00')`);
    const insertDuplicateDeliveryForOrder31 = () => pool.query(`INSERT INTO deliveries
      (shopid, origin_order_id, order_reference, address_snapshot, contact_snapshot,
       latitude, longitude, distance_meters, settings_revision, client_order_token,
       confirmation_secret_hash, tracking_token_hash, tracking_expires_at)
      SELECT shopid, origin_order_id, order_reference, address_snapshot, contact_snapshot,
        latitude, longitude, distance_meters, settings_revision, 'different-token',
        confirmation_secret_hash, REPEAT('c',64), tracking_expires_at FROM deliveries WHERE id = '41'`);
    await assert.rejects(insertDuplicateDeliveryForOrder31, { code: 'ER_DUP_ENTRY' });
    await pool.query("UPDATE orders SET delivery_id = '41', fulfillment_type = 'delivery' WHERE id = 31");
    await assert.rejects(() => pool.query("UPDATE orders SET delivery_id = '41' WHERE id = 33"), { code: "ER_DUP_ENTRY" });
    await assert.rejects(() => pool.query("UPDATE orders SET shopid = 8 WHERE id = 31"), { code: "ER_NO_REFERENCED_ROW_2" });
    await assert.rejects(() => pool.query("UPDATE deliveries SET courier_id = 12 WHERE id = '41'"), { code: "ER_NO_REFERENCED_ROW_2" });
    await pool.query("UPDATE deliveries SET courier_id = 11 WHERE id = '41'");
    await assert.rejects(() => pool.query("DELETE FROM users WHERE id = 11"), { code: "ER_ROW_IS_REFERENCED_2" });
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query("SELECT id FROM deliveries WHERE shopid = 7 AND id = '41' FOR UPDATE");
      await connection.query(`INSERT INTO archives
        (id, shopid, ordernumber, customer, customerID, subtotal, created, finished, token, delivery_id, fulfillment_type)
        SELECT 34, shopid, ordernumber, customer, customerID, subtotal, created, finished, 'archived-31', delivery_id, fulfillment_type
        FROM orders WHERE id = 31`);
      await connection.query("DELETE FROM orders WHERE id = 31");
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    assert.equal((await readRows("SELECT delivery_id FROM archives WHERE id = 34"))[0].delivery_id, "41");
    await assert.rejects(() => pool.query("UPDATE archives SET delivery_id = '41' WHERE id = 32"), { code: "ER_DUP_ENTRY" });
    await pool.query("DELETE FROM archives WHERE id = 34");
    assert.equal((await readRows("SELECT id FROM deliveries WHERE id = '41'"))[0].id, "41");
    await migrateDelivery("down");
    assert.equal((await readRows("SELECT subtotal, is_takeaway FROM archives WHERE id = 32"))[0].subtotal, "12.50");
    assert.equal((await readRows("SHOW COLUMNS FROM orders LIKE 'delivery_id'")).length, 0);
    await migrateDelivery("up");
    await paymentStateHasSingleAuthority(readRows);
    assert.equal((await readRows("SELECT fulfillment_type FROM archives WHERE id = 32"))[0].fulfillment_type, "takeaway");
    assert.equal((await readRows("SELECT enabled FROM shop_delivery_settings WHERE shopid = 7"))[0].enabled, 0);
  }, { beforeDeliveryMigrations: (db) => db.seedScenario({ legacy: true }) });
  console.log("PASS legacyRowsStayLegacyAndLinksSurviveArchive (including up/down/up)");
}

async function financialJournalIsTenantScopedImmutableAndCapped() {
  await withDeliveryDatabase(async ({ pool, seedScenario, readRows }) => {
    await seedScenario();
    const [delivery] = await readRows("SELECT * FROM deliveries WHERE id = '41'");
    assert.equal(typeof delivery.id, "string");
    const address = typeof delivery.address_snapshot === "string" ? JSON.parse(delivery.address_snapshot) : delivery.address_snapshot;
    assert.equal(address.instructions, "Sonnette \u00c9t\u00e9 \ud83d\ude9a");
    await pool.query("UPDATE deliveries SET version = version + 1 WHERE id = '41' AND version = 1");
    const [stale] = await pool.query("UPDATE deliveries SET version = version + 1 WHERE id = '41' AND version = 1");
    assert.equal(stale.affectedRows, 0);
    await pool.query(`INSERT INTO delivery_charge_snapshots
      (id, shopid, delivery_id, revision, band_fee_cents, free_delivery_applied,
       fee_cents, total_excl_tax_cents, tax_cents, vat_rate, fiscal_policy)
      VALUES ('9007199254740993', 7, '41', 1, 250, 0, 250, 227, 23, 10, '{"mode":"configured_rate","vatRate":10}')`);
    assert.equal((await readRows("SELECT id FROM delivery_charge_snapshots"))[0].id, "9007199254740993");
    await assert.rejects(() => pool.query(`INSERT INTO delivery_charge_snapshots
      (shopid, delivery_id, revision, band_fee_cents, free_delivery_applied, fee_cents, total_excl_tax_cents, tax_cents, vat_rate, fiscal_policy)
      VALUES (7, '41', 2, -1, 0, -1, 0, -1, 10, '{}')`), { errno: 3819 });
    await assert.rejects(() => pool.query("INSERT INTO shop_delivery_fee_bands (shopid, up_to_meters, fee_cents) VALUES (7, 2000, -1)"), { errno: 3819 });
    await assert.rejects(() => pool.query("UPDATE shop_delivery_settings SET minimum_items_cents = 9007199254740992 WHERE shopid = 7"), { errno: 3819 });
    await assert.rejects(() => pool.query("UPDATE shop_delivery_settings SET enabled = 1 WHERE shopid = 7"), { errno: 3819 });
    await pool.query(`INSERT INTO delivery_events
      (shopid, delivery_id, version, event_type, actor_subject, actor_id, previous_state, next_state,
       idempotency_key, request_hash, result)
      VALUES (7, '41', 2, 'assigned', 'staff', '10', '{}', '{"courierId":11}', 'assign-41', REPEAT('a',64), '{"version":2}')`);
    await assert.rejects(() => pool.query(`INSERT INTO delivery_events
      (shopid, delivery_id, version, event_type, actor_subject, actor_id, previous_state, next_state, idempotency_key, request_hash, result)
      VALUES (7, '41', 3, 'assigned', 'staff', '10', '{}', '{}', 'assign-41', REPEAT('a',64), '{}')`), { code: "ER_DUP_ENTRY" });
    await pool.query(`INSERT INTO payments
      (id, order_id, shop_id, stripe_payment_intent_id, amount, amount_cents, application_fee_amount, status, created)
      VALUES (61, 31, 7, 'manual-delivery-fixture', 12.50, 1250, 0, 'paid', '2026-10-16 12:00:00'),
        (62, 31, 8, 'other-shop-fixture', 12.50, 1250, 0, 'paid', '2026-10-16 12:00:00')`);
    await pool.query(`INSERT INTO delivery_payment_collections
      (id, shopid, delivery_id, courier_id, payment_id, method, amount_cents, idempotency_key, request_hash, result)
      VALUES ('71', 7, '41', 11, 61, 'cash', 1250, 'collect-41', REPEAT('a',64), '{"collectionId":"71"}')`);
    await assert.rejects(() => pool.query("UPDATE delivery_payment_collections SET payment_id = 62 WHERE id = '71'"), { code: "ER_SIGNAL_EXCEPTION" });
    await assert.rejects(() => pool.query(`INSERT INTO delivery_payment_collections
      (shopid, delivery_id, courier_id, payment_id, method, amount_cents, idempotency_key, request_hash, result)
      VALUES (7, '41', 11, 62, 'cash', 1250, 'wrong-payment', REPEAT('a',64), '{}')`), { code: "ER_NO_REFERENCED_ROW_2" });
    await pool.query(`INSERT INTO courier_cash_remittances
      (id, shopid, courier_id, cashier_id, expected_cents, received_cents, discrepancy_cents,
       expected_balance_version, idempotency_key, request_hash, result)
      VALUES ('81', 7, 11, 10, 1250, 1000, -250, 1, 'remit-81', REPEAT('a',64), '{}'),
        ('82', 7, 11, 10, 250, 250, 0, 1, 'remit-82', REPEAT('b',64), '{}')`);
    await assert.rejects(() => pool.query(`INSERT INTO courier_cash_remittances
      (shopid, courier_id, cashier_id, expected_cents, received_cents, discrepancy_cents,
       expected_balance_version, idempotency_key, request_hash, result)
      VALUES (7, 11, 10, 1250, 1000, -250, 1, 'remit-81', REPEAT('a',64), '{}')`), { code: "ER_DUP_ENTRY" });
    const allocate = (remittance, amount, executor = pool) => executor.query(`INSERT INTO courier_cash_remittance_allocations
      (shopid, remittance_id, collection_id, amount_cents) VALUES (7, ?, '71', ?)`, [remittance, amount]);
    await allocate("81", 1000);
    await assert.rejects(() => allocate("81", 1), { code: "ER_SIGNAL_EXCEPTION" });
    await assert.rejects(() => allocate("82", 251), { code: "ER_SIGNAL_EXCEPTION" });
    await allocate("82", 250);
    assert.equal((await readRows("SELECT SUM(amount_cents) AS total FROM courier_cash_remittance_allocations"))[0].total, "1250");
    await pool.query(`INSERT INTO payments
      (id, order_id, shop_id, stripe_payment_intent_id, amount, amount_cents, application_fee_amount, status, created)
      VALUES (63, 31, 7, 'concurrent-cash-fixture', 2.50, 250, 0, 'paid', '2026-10-16 12:00:00')`);
    await pool.query(`INSERT INTO delivery_payment_collections
      (id, shopid, delivery_id, courier_id, payment_id, method, amount_cents, idempotency_key, request_hash, result)
      VALUES ('72', 7, '41', 11, 63, 'cash', 250, 'collect-72', REPEAT('a',64), '{}')`);
    await pool.query(`INSERT INTO courier_cash_remittances
      (id, shopid, courier_id, cashier_id, expected_cents, received_cents, discrepancy_cents,
       expected_balance_version, idempotency_key, request_hash, result)
      VALUES ('83', 7, 11, 10, 250, 250, 0, 1, 'remit-83', REPEAT('a',64), '{}'),
        ('84', 7, 11, 10, 250, 250, 0, 1, 'remit-84', REPEAT('b',64), '{}')`);
    const first = await pool.getConnection();
    const second = await pool.getConnection();
    try {
      await first.beginTransaction();
      await second.beginTransaction();
      // Pin an old REPEATABLE READ snapshot before the competing insert commits.
      await second.query("SELECT * FROM courier_cash_remittance_allocations");
      await first.query(`INSERT INTO courier_cash_remittance_allocations
        (shopid, remittance_id, collection_id, amount_cents) VALUES (7, '83', '72', 200)`);
      const competing = second.query(`INSERT INTO courier_cash_remittance_allocations
        (shopid, remittance_id, collection_id, amount_cents) VALUES (7, '84', '72', 200)`)
        .then(() => null, (error) => error);
      await first.commit();
      assert.equal((await competing).code, "ER_SIGNAL_EXCEPTION");
      await second.rollback();
    } finally {
      await first.rollback();
      await second.rollback();
      first.release();
      second.release();
    }
    assert.equal((await readRows("SELECT SUM(amount_cents) AS total FROM courier_cash_remittance_allocations WHERE collection_id = '72'"))[0].total, "200");
    await assert.rejects(() => pool.query(`INSERT INTO courier_cash_remittance_allocations
      (shopid, remittance_id, collection_id, amount_cents) VALUES (7, '83', '72', 1)`), { code: "ER_DUP_ENTRY" });
    assert.equal((await readRows("SELECT allocated_cents FROM courier_cash_allocation_totals WHERE collection_id = '72'"))[0].allocated_cents, "200");
    assert.equal((await readRows("SELECT allocated_cents FROM courier_cash_allocation_totals WHERE remittance_id = '83'"))[0].allocated_cents, "200");
    await pool.query(`INSERT IGNORE INTO courier_cash_remittance_allocations
      (shopid, remittance_id, collection_id, amount_cents) VALUES (7, '83', '72', 1)`);
    assert.equal((await readRows("SELECT allocated_cents FROM courier_cash_allocation_totals WHERE collection_id = '72'"))[0].allocated_cents, "200");
    await pool.query(`INSERT INTO courier_cash_adjustments
      (shopid, courier_id, collection_id, remittance_id, delta_due_cents, reason, actor_id, idempotency_key, request_hash, result)
      VALUES (7, 11, '71', NULL, -100, 'Confirmed customer refund', 10, 'adjust-71', REPEAT('c',64), '{}')`);
    await assert.rejects(() => pool.query(`INSERT INTO courier_cash_adjustments
      (shopid, courier_id, delta_due_cents, reason, actor_id, idempotency_key, request_hash, result)
      VALUES (7, 11, -100, 'Missing source', 10, 'bad-adjust', REPEAT('c',64), '{}')`), { errno: 3819 });
    for (const table of ["delivery_charge_snapshots", "delivery_events", "delivery_payment_collections", "courier_cash_remittances", "courier_cash_remittance_allocations", "courier_cash_adjustments"]) {
      await assert.rejects(() => pool.query(`UPDATE ${table} SET shopid = shopid`), { code: "ER_SIGNAL_EXCEPTION" });
      await assert.rejects(() => pool.query(`DELETE FROM ${table}`), { code: "ER_SIGNAL_EXCEPTION" });
    }
    await pool.query(`INSERT INTO service_rate_limits (shopid, scope, subject_hash, window_start, expires_at, attempts)
      VALUES (7, 'geocoder', REPEAT('d',64), '2026-10-16 12:00:00', '2026-10-16 13:00:00', 1)
      ON DUPLICATE KEY UPDATE attempts = attempts + 1`);
    await pool.query(`INSERT INTO service_rate_limits (shopid, scope, subject_hash, window_start, expires_at, attempts)
      VALUES (7, 'geocoder', REPEAT('d',64), '2026-10-16 12:00:00', '2026-10-16 13:00:00', 1)
      ON DUPLICATE KEY UPDATE attempts = attempts + 1`);
    assert.equal((await readRows("SELECT attempts FROM service_rate_limits WHERE shopid = 7"))[0].attempts, 2);
  });
  console.log("PASS financialJournalIsTenantScopedImmutableAndCapped");
}

(async () => {
  await legacyRowsStayLegacyAndLinksSurviveArchive();
  await financialJournalIsTenantScopedImmutableAndCapped();
})().catch((error) => { console.error(error); process.exitCode = 1; });
