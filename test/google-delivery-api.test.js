const assert = require("assert/strict");
const { test } = require("node:test");
const express = require("express");
const { buildDeliveryQuotes } = require("../src/modules/m_deliveryQuotes");
const { buildDeliveryTokenCodec, validateAddressResolution } = require("../src/helpers/deliveryAddress");
const { buildDeliveryController } = require("../src/controllers/c_delivery");
const { buildDeliveryRouter } = require("../src/routers/r_delivery");
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
