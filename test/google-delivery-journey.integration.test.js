const assert = require("assert/strict");
const crypto = require("crypto");
const { test } = require("node:test");
const { withDeliveryDatabase } = require("./helpers/deliveryDatabase");

test("Google checkout and revision journals contain no coordinates; outage preserves archive, replay and authorization", async () => {
  await withDeliveryDatabase(async db => {
    await db.seedScenario();
    require.cache[require.resolve("../src/config/dbPool")] = { exports: db.pool };
    require.cache[require.resolve("../src/config/db")] = { exports: db.pool.pool };
    require.cache[require.resolve("nanoid")] = { exports: await import("nanoid") };
    const { createTransactionRunner } = require("../src/helpers/withTransaction");
    const { buildCheckoutModule } = require("../src/modules/m_checkout");
    const { buildDeliveryQuotes } = require("../src/modules/m_deliveryQuotes");
    const { buildSqlDeliverySettingsRepository } = require("../src/modules/m_deliverySettings");
    const { buildDeliveryTokenCodec } = require("../src/helpers/deliveryAddress");
    const { buildGoogleDeliveryPlaces } = require("../src/services/googleDeliveryPlaces");
    const { buildOrderEditingModule } = require("../src/modules/m_orderEditing");
    const { buildDeliveryDispatch } = require("../src/modules/m_deliveryDispatch");
    const { buildDeliveryAddressViews } = require("../src/services/deliveryAddressViews");
    const { buildDeliveryTracking } = require("../src/modules/m_deliveryTracking");
    const runInTransaction = createTransactionRunner(db.pool);
    let time = new Date("2026-10-19T12:00:00Z");
    const clock = () => time;
    let calls = 0; let offline = false;
    const component = (type, longText, shortText = longText) => ({ types: [type], longText, shortText });
    const places = buildGoogleDeliveryPlaces({ apiKey: "fixture-key", clock, reserveQuota: async () => {},
      transport: async url => {
        calls++;
        if (offline) throw new Error("Provider outage fixture");
        if (url.pathname.endsWith(":autocomplete")) return { suggestions: [{ placePrediction: { placeId: "destination", text: { text: "60 rue Test, Paris" } } }] };
        return { id: decodeURIComponent(url.pathname.split("/").pop()), location: { latitude: 48.857, longitude: 2.353 },
          addressComponents: [component("street_number", "60"), component("route", "rue Test"), component("postal_code", "75008"), component("locality", "Paris"), component("country", "France", "FR")] };
      } });
    try {
      const tokenCodec = buildDeliveryTokenCodec({ secret: "google-journey-fixture-signing-secret-only" });
      const quotes = buildDeliveryQuotes({ repository: buildSqlDeliverySettingsRepository({ pool: db.pool }), clock, tokenCodec, places });
      await db.pool.query("UPDATE products SET price=20,track_stock=1,vat_rate_takeaway=5.5 WHERE id=21");
      await db.pool.query("INSERT INTO service_points (id,shopid,name,type,system_key,created) VALUES (70,7,'Counter','counter','counter',NOW())");
      await db.pool.query("UPDATE users SET courier_available=1,module_permissions='[\"delivery\"]' WHERE shopid=7");
      await db.pool.query("UPDATE shop_delivery_settings SET origin_google_place_id='origin',origin_latitude=NULL,origin_longitude=NULL,max_distance_meters=5000,vat_rate=10,enabled=1 WHERE shopid=7");
      await db.pool.query("INSERT INTO shop_delivery_fee_bands (shopid,up_to_meters,fee_cents) VALUES (7,5000,400)");
      const { suggestions } = await quotes.suggestAddresses({ shopId: 7, input: "60 rue Test", sessionToken: "147ab164-bb20-4b99-9a51-19a9832619cb" });
      const resolved = await quotes.resolveAddress({ shopId: 7, selectionToken: suggestions[0].selectionToken });
      const makeAttempt = async (key, quantity = 1) => {
        const items = [{ productId: 21, quantity, selectedChoiceIds: [] }];
        const quote = await quotes.createQuote({ shopId: 7, items, addressResolutionToken: resolved.addressResolutionToken });
        return { shopId: 7, actorId: 10, customer: { id: 70, name: "Guest", phone: "0700000000" }, items,
          expectedTotal: quote.grandTotalCents / 100, discountType: "none", discountValue: 0, isTakeaway: false, paymentMode: "cash",
          clientOrderToken: key, fulfillmentType: "delivery", deliveryQuoteToken: quote.quoteToken,
          addressResolutionToken: resolved.addressResolutionToken, deliveryConfirmationSecret: "0123456789abcdef".repeat(4) };
      };
      const checkout = buildCheckoutModule({ withTransaction: runInTransaction, deliveryQuotes: quotes, now: clock });
      const attempt = await makeAttempt("google-create-1");
      const first = await checkout.createCheckout(attempt);
      const trackingToken = first.tracking_url.split("#")[1];
      const recovery = { ...attempt };
      for (const key of ["deliveryQuoteToken", "addressResolutionToken"]) recovery[key] = "sha256:" + crypto.createHash("sha256").update(attempt[key]).digest("hex");
      assert.equal((await checkout.createCheckout(recovery)).orderId, first.orderId);
      await assert.rejects(checkout.createCheckout({ ...recovery, expectedTotal: 25 }), { code: "DELIVERY_IDEMPOTENCY_CONFLICT" });
      await assert.rejects(checkout.createCheckout({ ...recovery, addressResolutionToken: attempt.addressResolutionToken }), { code: "CHECKOUT_REQUEST_INVALID" });
      await assert.rejects(checkout.createCheckout({ ...recovery, clientOrderToken: "never-created" }), { code: "DELIVERY_CHECKOUT_RECOVERY_REQUIRED" });
      const editing = buildOrderEditingModule({ withTransaction: runInTransaction, deliveryQuotes: quotes, now: clock });
      const editable = await editing.getEditableOrder({ orderId: first.orderId, shopId: 7 });
      const next = await makeAttempt("google-edit", 2);
      const edit = { orderId: first.orderId, shopId: 7, operatorId: 10, contentRevision: editable.content_revision,
        items: next.items, expectedTotal: 44, discountType: "none", discountValue: 0,
        deliveryQuoteToken: next.deliveryQuoteToken, addressResolutionToken: next.addressResolutionToken,
        deliveryExpectedVersion: 1, deliveryIdempotencyKey: "google-revision-1" };
      const amended = await editing.amendOrder(edit);
      assert.equal(amended.total, 44);
      const addressViews = buildDeliveryAddressViews({ places });
      const dispatch = buildDeliveryDispatch({ runInTransaction, clock, addressViews });
      const operator = { subject: "staff", id: 10, shopId: 7, access: 1 };
      const courier = { subject: "staff", id: 11, shopId: 7, access: 6 };
      const mutation = (actor, expectedVersion, idempotencyKey, extra = {}) => ({ actor, deliveryId: first.delivery.id, expectedVersion, idempotencyKey, ...extra });
      await dispatch.assign(mutation(operator, 2, "google-assign-1", { courierId: 11 }));
      const view = await dispatch.get({ actor: courier, deliveryId: first.delivery.id });
      assert.equal(view.addressSnapshot.street, "60 rue Test");
      await db.pool.query("UPDATE orders SET status=3 WHERE id=?", [first.orderId]);
      const { buildOrderArchiveModule } = require("../src/modules/m_orders");
      await buildOrderArchiveModule({ withTransaction: runInTransaction }).mArchiveOrder(first.orderId, "cash", 7, {}, 10);
      await dispatch.pickup(mutation(courier, 3, "google-pickup-1"));
      await dispatch.deliver(mutation(courier, 4, "google-deliver-1"));
      const closed = await dispatch.get({ actor: courier, deliveryId: first.delivery.id });
      assert.equal(closed.addressSnapshot, undefined);
      const readEvidence = async () => ({
        deliveries: await db.readRows("SELECT * FROM deliveries WHERE id=?", [first.delivery.id]),
        events: await db.readRows("SELECT previous_state,next_state,result FROM delivery_events WHERE delivery_id=?", [first.delivery.id]),
        charges: await db.readRows("SELECT * FROM delivery_charge_snapshots WHERE delivery_id=?", [first.delivery.id]),
        stocks: await db.readRows("SELECT * FROM stocks WHERE productid=21"),
        archives: await db.readRows("SELECT * FROM archives WHERE delivery_id=?", [first.delivery.id]),
      });
      const before = await readEvidence();
      assert.equal(before.deliveries[0].latitude, null);
      assert.equal(before.deliveries[0].longitude, null);
      assert.equal(before.deliveries[0].charge_revision, 2);
      assert.equal(before.charges.length, 2);
      const decode = value => typeof value === "string" ? JSON.parse(value) : value;
      const evidence = [decode(before.deliveries[0].address_snapshot), ...before.events.map(event => Object.fromEntries(Object.entries(event).map(([key, value]) => [key, decode(value)])))];
      assert.equal(/"(?:latitude|longitude|addressResolutionToken|deliveryQuoteToken|quoteToken|address_resolution_token|delivery_quote_token|sessionToken|selectionToken)"\s*:/.test(JSON.stringify(evidence)), false);
      assert.equal(JSON.stringify(evidence).includes("fixture-key"), false);
      time = new Date("2026-10-19T12:16:00Z");
      places.purgeExpired(); offline = true;
      const callsBefore = calls;
      assert.equal((await checkout.createCheckout(recovery)).orderId, first.orderId);
      assert.equal((await editing.amendOrder(edit)).total, 44);
      await assert.rejects(editing.amendOrder({ ...edit, operatorId: 11 }), { code: "DELIVERY_FORBIDDEN" });
      assert.equal((await dispatch.get({ actor: operator, deliveryId: first.delivery.id })).addressSnapshot.street, "60 rue Test");
      const tracked = await buildDeliveryTracking({ clock, addressViews }).read({ token: trackingToken });
      assert.equal(tracked.payment.totalCents, 4400);
      assert.equal(tracked.addressSnapshot.street, "60 rue Test");
      assert.equal(tracked.addressSnapshot.instructions, undefined);
      assert.equal(calls, callsBefore, "Replays, closed courier reads and transaction text must not contact Google");
      assert.deepEqual(await readEvidence(), before);
      await assert.rejects(db.pool.query("UPDATE delivery_events SET result='{}' WHERE delivery_id=?", [first.delivery.id]));
      await assert.rejects(db.pool.query("DELETE FROM delivery_charge_snapshots WHERE delivery_id=?", [first.delivery.id]));
    } finally { places.dispose(); }
  });
});
