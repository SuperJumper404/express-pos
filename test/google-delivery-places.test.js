const assert = require("assert/strict");
const { test } = require("node:test");
const { buildGoogleDeliveryPlaces } = require("../src/services/googleDeliveryPlaces");
const sessionToken = "147ab164-bb20-4b99-9a51-19a9832619cb";
const component = (type, longText, shortText = longText) => ({ types: [type], longText, shortText, languageCode: "fr" });
const details = () => ({ id: "fixture-place", formattedAddress: "60 Rue Francois Ier, 75008 Paris, France",
  addressComponents: [component("street_number", "60"), component("route", "Rue Francois Ier"), component("postal_code", "75008"),
    component("locality", "Paris"), component("country", "France", "FR")], location: { latitude: 48.868, longitude: 2.306 } });
const fixture = overrides => {
  const calls = []; const quotas = [];
  const service = buildGoogleDeliveryPlaces({ apiKey: "fixture-key", reserveQuota: async input => quotas.push(input),
    transport: async (url, options) => { calls.push({ url, options }); return url.pathname.endsWith(":autocomplete")
      ? { suggestions: [{ placePrediction: { placeId: "fixture-place", text: { text: "60 Rue Francois Ier, Paris, France" } } }] } : details(); }, ...overrides });
  return { service, calls, quotas };
};
test("Google suggestions use France, postal types and a bounded minimal response contract", async () => {
  const { service, calls, quotas } = fixture();
  try {
    assert.deepEqual(await service.suggest({ shopId: 7, input: "60 rue Francois 1er", sessionToken }), [{ placeId: "fixture-place", label: "60 Rue Francois Ier, Paris, France" }]);
    assert.equal(calls[0].url.href, "https://places.googleapis.com/v1/places:autocomplete");
    assert.deepEqual(calls[0].options.body, { input: "60 rue Francois 1er", sessionToken, languageCode: "fr", regionCode: "fr",
      includedRegionCodes: ["fr"], includedPrimaryTypes: ["street_address", "premise", "subpremise"], includeQueryPredictions: false });
    assert.equal(calls[0].options.headers["X-Goog-FieldMask"], "suggestions.placePrediction.placeId,suggestions.placePrediction.text.text");
    assert.deepEqual(quotas, [{ shopId: 7 }]);
  } finally { service.dispose(); }
});
test("selection resolves numbered French address server-side and always terminates its own session", async () => {
  const { service, calls } = fixture();
  try {
    await service.position({ shopId: 7, placeId: "fixture-place" });
    const result = await service.resolve({ shopId: 7, placeId: "fixture-place", sessionToken });
    assert.equal(result.street, "60 Rue Francois Ier");
    assert.deepEqual([result.country, result.postalCode, result.latitude, result.longitude], ["FR", "75008", 48.868, 2.306]);
    assert.equal(result.provider, "google_places");
    assert.equal(result.placeId, "fixture-place");
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url.searchParams.get("sessionToken"), sessionToken);
    assert.equal(calls[1].options.headers["X-Goog-FieldMask"], "id,addressComponents,formattedAddress,location");
    assert.equal(JSON.stringify(result).includes("fixture-key"), false);
  } finally { service.dispose(); }
});
test("position cache expires at exactly 900000ms without sliding or crossing tenants", async () => {
  let now = 0;
  const { service, calls } = fixture({ clock: () => new Date(now), timers: { setTimeout: () => ({ unref() {} }), clearTimeout() {} } });
  try {
    const point = await service.position({ shopId: 7, placeId: "fixture-place" }); point.latitude = 0;
    now = 899999;
    assert.equal((await service.position({ shopId: 7, placeId: "fixture-place" })).latitude, 48.868);
    assert.equal(calls.length, 1);
    await service.position({ shopId: 8, placeId: "fixture-place" });
    assert.equal(calls.length, 2);
    now = 900000;
    assert.equal(service.purgeExpired(), 1);
    await service.position({ shopId: 7, placeId: "fixture-place" });
    assert.equal(calls.length, 3);
  } finally { service.dispose(); }
});
test("invalid inputs and missing encrypted credentials fail before spending quota", async () => {
  for (const apiKey of ["", "encrypted:fixture"]) {
    const { service, quotas } = fixture({ apiKey });
    await assert.rejects(service.suggest({ shopId: 7, input: "60 rue", sessionToken }), { code: "DELIVERY_GEOCODING_UNAVAILABLE" });
    assert.equal(quotas.length, 0); service.dispose();
  }
  const { service, quotas } = fixture();
  for (const change of [{ input: "ab" }, { input: "a\nb" }, { input: "x".repeat(256) }, { shopId: 0 }, { sessionToken: "invalid" }]) {
    await assert.rejects(service.suggest({ shopId: 7, input: "60 rue", sessionToken, ...change }), { code: "DELIVERY_ADDRESS_INVALID" });
  }
  assert.equal(quotas.length, 0); service.dispose();
});
test("provider errors are redacted and malformed or imprecise addresses never become postal proofs", async () => {
  for (const payload of [null, {}, { ...details(), id: "another-place" }, { ...details(), location: { latitude: 91, longitude: 0 } },
    { ...details(), addressComponents: details().addressComponents.filter(c => !c.types.includes("street_number")) },
    { ...details(), addressComponents: [...details().addressComponents, component("country", "Belgium", "BE")] }]) {
    const { service } = fixture({ transport: async () => payload });
    await assert.rejects(service.resolve({ shopId: 7, placeId: "fixture-place", sessionToken }), error => ["DELIVERY_ADDRESS_INVALID", "DELIVERY_GEOCODING_UNAVAILABLE"].includes(error.code));
    service.dispose();
  }
  const { service } = fixture({ transport: async () => { throw new Error("private-key-and-provider-body"); } });
  await assert.rejects(service.resolve({ shopId: 7, placeId: "fixture-place" }), error => error.code === "DELIVERY_GEOCODING_UNAVAILABLE" && !error.message.includes("private-key"));
  service.dispose();
});
