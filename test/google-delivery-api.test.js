const assert = require("assert/strict");
const { test } = require("node:test");
const express = require("express");
const { buildDeliveryQuotes } = require("../src/modules/m_deliveryQuotes");
const { buildDeliveryTokenCodec, validateAddressResolution } = require("../src/helpers/deliveryAddress");
const { buildDeliveryController } = require("../src/controllers/c_delivery");
const { buildDeliveryRouter } = require("../src/routers/r_delivery");
const { buildDeliveryGeocoding } = require("../src/services/deliveryGeocoding");
const { quoteDeliveryOrder } = require("../src/modules/m_orderQuote");
const DomainError = require("../src/helpers/domainError");
const sessionToken = "147ab164-bb20-4b99-9a51-19a9832619cb";
const resolved = { provider: "google_places", placeId: "fixture-place", street: "60 Rue Francois Ier", postalCode: "75008", city: "Paris", country: "FR", latitude: 48.8, longitude: 2.3 };
const fixture = () => {
  const calls = []; let now = new Date("2026-10-19T12:00:00Z");
  const tokenCodec = buildDeliveryTokenCodec({ secret: "fixture-google-selection-signing-32-bytes" });
  const places = { suggest: async input => { calls.push(input); return [{ placeId: "fixture-place", label: "60 Rue Francois Ier, Paris" }]; },
    resolve: async input => { calls.push(input); return resolved; } };
  const quotes = buildDeliveryQuotes({ repository: {}, quoteOrderItems: async () => ({}), geocoder: {}, places, clock: () => now, tokenCodec });
  return { quotes, calls, tokenCodec, expire() { now = new Date("2026-10-19T12:15:00Z"); } };
};
test("postal display hydrates a reference without GPS or persistence and degrades individually", async () => {
  const { buildDeliveryAddressViews } = require("../src/services/deliveryAddressViews");
  let calls = 0;
  const views = buildDeliveryAddressViews({ places: { resolve: async () => { calls++; return resolved; } } });
  const ref = { provider: "google_places", placeId: "fixture-place", instructions: "Private" };
  const result = await views.hydrate({ shopId: 7, addressSnapshot: ref });
  assert.equal(result.addressSnapshot.street, "60 Rue Francois Ier");
  assert.equal(result.addressSnapshot.latitude, undefined);
  assert.equal(result.addressSnapshot.selectedLabel, undefined);
  assert.equal(result.addressSnapshot.instructions, "Private");
  assert.equal(ref.street, undefined);
  await views.hydrate({ shopId: 7, addressSnapshot: { ...ref, street: "Selected address" } });
  assert.equal(calls, 1);
  const offline = buildDeliveryAddressViews({ places: { resolve: async () => { throw new Error("offline"); } } });
  assert.equal((await offline.hydrate({ shopId: 7, addressSnapshot: ref })).displayStatus, "unavailable");
});
test("selection proofs bind restaurant, kind and expiry before any Google Details call", async () => {
  const f = fixture();
  const search = await f.quotes.suggestAddresses({ shopId: 7, input: "60 rue Francois 1er", sessionToken });
  const { selectionToken } = search.suggestions[0];
  assert.equal(typeof selectionToken, "string");
  const result = await f.quotes.resolveAddress({ shopId: 7, selectionToken });
  assert.equal(result.addressSnapshot.street, "60 Rue Francois Ier");
  assert.equal(result.addressSnapshot.selectedLabel, "60 Rue Francois Ier, Paris");
  assert.equal(validateAddressResolution(result.addressResolutionToken, new Date("2026-10-19T12:00:01Z"), { shopId: 7, tokenCodec: f.tokenCodec }).latitude, 48.8);
  await assert.rejects(f.quotes.resolveAddress({ shopId: 8, selectionToken }), { code: "DELIVERY_ADDRESS_INVALID" });
  await assert.rejects(f.quotes.resolveAddress({ shopId: 7, selectionToken: result.addressResolutionToken }), { code: "DELIVERY_ADDRESS_INVALID" });
  await assert.rejects(f.quotes.resolveAddress({ shopId: 7, selectionToken: selectionToken.slice(0, -2) + "xx" }), { code: "DELIVERY_ADDRESS_INVALID" });
  f.expire();
  await assert.rejects(f.quotes.resolveAddress({ shopId: 7, selectionToken }), { code: "DELIVERY_ADDRESS_INVALID" });
  assert.equal(f.calls.length, 2);
});
test("staff lookup rejects courier and untrusted scope or coordinates before provider work", async () => {
  const f = fixture();
  const controller = buildDeliveryController({ quotes: f.quotes, settings: {}, dispatch: {}, cash: {}, refunds: {}, tracking: {} });
  const auth = (req, res, next) => { Object.assign(req, { id: 10, shopid: 7, access: req.headers["x-fixture-role"] === "courier" ? 6 : 1, sessionSubject: "staff" }); next(); };
  const app = express(); app.use(express.json()); app.use(buildDeliveryRouter({ controller, authentication: auth }));
  const server = await new Promise(resolve => { const value = app.listen(0, "127.0.0.1", () => resolve(value)); });
  try {
    const send = (path, body, role) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "x-fixture-role": role || "staff" }, body: JSON.stringify(body) });
    const searchBody = { input: "60 rue Francois 1er", sessionToken };
    assert.equal((await send("/delivery/address-suggestions", searchBody, "courier")).status, 403);
    for (const extra of [{ shopId: 8 }, { latitude: 1 }, { placeId: "free-id" }]) assert.equal((await send("/delivery/address-suggestions", { ...searchBody, ...extra })).status, 400);
    assert.equal(f.calls.length, 0);
    const response = await send("/delivery/address-suggestions", searchBody);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const data = await response.json();
    const selectionToken = data.data.suggestions[0].selectionToken;
    assert.equal((await send("/delivery/address-resolutions", { selectionToken, address: {} })).status, 400);
    assert.equal((await send("/delivery/address-resolutions", { selectionToken })).status, 200);
    assert.equal(f.calls.length, 2);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("French fallback returns a signed precise result and delivery distance without a cart", async () => {
  const settings = { enabled: true, origin: { latitude: 48.8, longitude: 2.3 }, maxDistanceMeters: 1000, minimumItemsCents: 500,
    freeDeliveryEnabled: false, freeDeliveryThresholdCents: null, fiscalPolicy: { mode: "configured_rate", vatRate: 10 },
    bands: [{ upToMeters: 1000, feeCents: 200 }] };
  const geocoder = buildDeliveryGeocoding({
    baseUrl: "https://fixture.invalid/geocodage",
    reserveQuota: async () => {},
    transport: async url => {
      assert.equal(url.searchParams.get("autocomplete"), "1");
      assert.equal(url.searchParams.get("lon"), "2.3");
      return { type: "FeatureCollection", features: [
        { type: "Feature", geometry: { type: "Point", coordinates: [2.32, 48.8] },
          properties: { _type: "address", type: "housenumber", id: "fixture", housenumber: "7", street: "Rue Test", name: "7 Rue Test", label: "7 Rue Test 75008 Paris", postcode: "75008", city: "Paris" } },
      ] };
    },
  });
  const quotes = buildDeliveryQuotes({
    repository: { getSettings: async () => settings }, geocoder, tokenCodec: fixture().tokenCodec,
    places: { suggest: async () => { throw new DomainError(503, "DELIVERY_GEOCODING_UNAVAILABLE"); } },
    quoteOrderItems: async () => assert.fail("Preview must not quote a cart"),
  });
  const { suggestions: [suggestion] } = await quotes.suggestAddresses({ shopId: 7, input: "7 Rue Test", sessionToken, includeDistance: true });
  assert.equal(suggestion.provider, "ign");
  assert.ok(suggestion.distanceMeters > 1000);
  await assert.rejects(quotes.resolveAddress({ shopId: 8, selectionToken: suggestion.selectionToken }), { code: "DELIVERY_ADDRESS_INVALID" });
  const proof = await quotes.resolveAddress({ shopId: 7, selectionToken: suggestion.selectionToken });
  assert.equal(proof.addressSnapshot.street, "7 Rue Test");
  const preview = await quotes.previewAddress({ shopId: 7, addressResolutionToken: proof.addressResolutionToken });
  assert.equal(preview.distanceMeters, suggestion.distanceMeters);
  assert.equal(preview.inRange, false);
  assert.deepEqual(preview.feeOptionsCents, [200]);
});

test("cashier override stays signed through repricing and is refused for a web order", async () => {
  const settings = { revision: 1, enabled: true, origin: { latitude: 48.8, longitude: 2.3 }, maxDistanceMeters: 1000, minimumItemsCents: 0,
    freeDeliveryEnabled: false, freeDeliveryThresholdCents: null, fiscalPolicy: { mode: "configured_rate", vatRate: 10 },
    bands: [{ upToMeters: 1000, feeCents: 200 }] };
  const quoteItems = async () => ({ total: 25, resolvedItems: [{ lineTotal: 25, quantity: 1, vatRate: 10 }] });
  const quotes = buildDeliveryQuotes({
    repository: { getSettings: async () => settings }, tokenCodec: fixture().tokenCodec,
    geocoder: { resolve: async () => resolved }, quoteOrderItems: quoteItems,
  });
  const { addressResolutionToken } = await quotes.resolveAddress({ shopId: 7, address: resolved });
  const items = [{ productId: 21, quantity: 1, selectedChoiceIds: [] }];
  const input = { shopId: 7, items, addressResolutionToken };
  assert.equal((await quotes.createQuote(input)).deliveryFeeCents, 200);
  await assert.rejects(quotes.createQuote({ ...input, deliveryFeeOverrideCents: -1 }), { code: "DELIVERY_MONEY_INVALID" });
  for (const cents of [0, 500]) {
    const quote = await quotes.createQuote({ ...input, deliveryFeeOverrideCents: cents });
    assert.equal(quote.suggestedFeeCents, 200);
    assert.equal(quote.deliveryFeeCents, cents);
    assert.equal(quote.chargeSnapshot.bandFeeCents, 200);
    assert.equal(quote.chargeSnapshot.manualFeeOverride, true);
    const checkout = { ...input, expectedTotal: quote.grandTotalCents / 100, discountType: "none", discountValue: 0, deliveryQuoteToken: quote.quoteToken };
    await assert.rejects(quoteDeliveryOrder({ checkout, deliveryQuotes: quotes, quoteItems }), { code: "DELIVERY_FORBIDDEN" });
    assert.equal((await quoteDeliveryOrder({ checkout, deliveryQuotes: quotes, quoteItems, allowFeeOverride: true })).total, (2500 + cents) / 100);
  }
  const controller = buildDeliveryController({ quotes, settings: {}, dispatch: {}, cash: {}, refunds: {}, tracking: {} });
  const response = () => ({ set() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } });
  const web = response();
  const body = { items: [{ product_id: 21, quantity: 1 }], address_resolution_token: addressResolutionToken, delivery_fee_override_cents: 0 };
  await controller.createQuote({ shopid: 7, sessionSubject: "service_point", servicePointId: 71, body }, web);
  assert.equal(web.statusCode, 403);
  const staff = response();
  await controller.createQuote({ shopid: 7, sessionSubject: "staff", id: 10, access: 1, body }, staff);
  assert.equal(staff.statusCode, 200);
  assert.equal(staff.body.data.deliveryFeeCents, 0);
});
