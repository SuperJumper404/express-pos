const assert = require("assert/strict");
const { test } = require("node:test");
const { withDeliveryDatabase } = require("./helpers/deliveryDatabase");
test("SQL permits Google references without GPS but refuses mixed or missing identity and preserves financial guards", async () => {
  await withDeliveryDatabase(async db => {
    await db.seedScenario();
    const snapshot = JSON.stringify({ provider: "google_places", placeId: "fixture-place", instructions: "Portail" });
    await db.pool.query("UPDATE deliveries SET google_place_id=?,address_snapshot=?,latitude=NULL,longitude=NULL WHERE id='41'", ["fixture-place", snapshot]);
    const [stored] = await db.readRows("SELECT latitude,longitude,google_place_id FROM deliveries WHERE id='41'");
    assert.deepEqual([stored.latitude, stored.longitude, stored.google_place_id], [null, null, "fixture-place"]);
    for (const sql of ["UPDATE deliveries SET latitude=48.8 WHERE id='41'", "UPDATE deliveries SET google_place_id='' WHERE id='41'",
      "UPDATE deliveries SET google_place_id=NULL WHERE id='41'", "UPDATE deliveries SET address_snapshot='{}' WHERE id='41'"]) {
      await assert.rejects(db.pool.query(sql));
    }
    await db.pool.query("UPDATE shop_delivery_settings SET origin_google_place_id='fixture-place',origin_latitude=NULL,origin_longitude=NULL,max_distance_meters=3000,vat_rate=10,enabled=1 WHERE shopid=7");
    await assert.rejects(db.pool.query("UPDATE shop_delivery_settings SET origin_google_place_id=NULL WHERE shopid=7"));
    await assert.rejects(db.pool.query("UPDATE shop_delivery_settings SET origin_latitude=48.8,origin_longitude=2.3 WHERE shopid=7"));
    await db.pool.query("INSERT INTO delivery_events (shopid,delivery_id,version,event_type,actor_subject,previous_state,next_state,idempotency_key,request_hash,result) VALUES (7,'41',1,'fixture','staff','{}','{}','google-fixture',REPEAT('a',64),'{}')");
    await assert.rejects(db.pool.query("UPDATE delivery_events SET result='{}' WHERE shopid=7"));
    await assert.rejects(db.pool.query("DELETE FROM delivery_events WHERE shopid=7"));
    process.env.ENV_FILE = "NUL";
    const { createTransactionRunner } = require("../src/helpers/withTransaction");
    const { buildDeliveryTokenCodec, signAddressResolution, validateAddressResolution } = require("../src/helpers/deliveryAddress");
    const { buildCustomers, buildSqlCustomersRepository } = require("../src/modules/m_customers");
    const tokenCodec = buildDeliveryTokenCodec({ secret: "google-fixture-only-signing-secret-32bytes" });
    const resolved = { provider: "google_places", placeId: "fixture-place", street: "60 rue Test", postalCode: "75008", city: "Paris", country: "FR", latitude: 48.8, longitude: 2.3, selectedLabel: "60 rue Test, Paris" };
    let providerCalls = 0;
    const customers = buildCustomers({ repository: buildSqlCustomersRepository({ pool: db.pool }), runInTransaction: createTransactionRunner(db.pool), tokenCodec,
      places: { resolve: async () => { providerCalls++; const { selectedLabel, ...value } = resolved; return value; } } });
    const saved = await customers.saveAddress({ shopId: 7, customerId: "51", addressResolutionToken: signAddressResolution({ shopId: 7, addressSnapshot: resolved, tokenCodec }), instructions: "Portail B" });
    assert.deepEqual(saved.addressSnapshot, { provider: "google_places", placeId: "fixture-place", instructions: "Portail B" });
    await customers.saveAddress({ shopId: 7, customerId: "51", addressId: saved.id, makeDefault: true });
    assert.equal(providerCalls, 0);
    const proof = await customers.resolveStoredAddress({ shopId: 7, customerId: "51", addressId: saved.id });
    const address = validateAddressResolution(proof.addressResolutionToken, new Date(), { tokenCodec, shopId: 7 });
    assert.equal(address.latitude, 48.8);
    assert.equal(address.selectedLabel, undefined);
    assert.equal(address.instructions, "Portail B");
    assert.equal(providerCalls, 1);
    const { buildDeliveryQuotes } = require("../src/modules/m_deliveryQuotes");
    const { buildSqlDeliverySettingsRepository } = require("../src/modules/m_deliverySettings");
    await db.pool.query("INSERT INTO shop_delivery_fee_bands (shopid,up_to_meters,fee_cents) VALUES (7,3000,200)");
    const quotes = buildDeliveryQuotes({ repository: buildSqlDeliverySettingsRepository({ pool: db.pool }), tokenCodec,
      quoteOrderItems: async () => ({ total: 25 }), places: { position: async () => ({ latitude: 48.8, longitude: 2.3 }) } });
    const quote = await quotes.createQuote({ shopId: 7, items: [{ productId: 21, quantity: 1, selectedChoiceIds: [] }], addressResolutionToken: proof.addressResolutionToken });
    assert.equal(quote.grandTotalCents, 2700);
    assert.equal(quote.deliveryFeeCents, 200);
    const [settings] = await db.readRows("SELECT enabled,origin_latitude,origin_longitude,revision FROM shop_delivery_settings WHERE shopid=7");
    assert.deepEqual([settings.enabled, settings.origin_latitude, settings.origin_longitude, settings.revision], [1, null, null, 1]);
    await assert.rejects(db.migrateDelivery("down"), /Google references require a compatible application; rollback refused/);
    assert.deepEqual(await db.readRows("SELECT latitude,longitude,google_place_id FROM deliveries WHERE id='41'"), [stored]);
    assert.equal((await db.readRows("SELECT origin_google_place_id FROM shop_delivery_settings WHERE shopid=7"))[0].origin_google_place_id, "fixture-place");
  });
});
