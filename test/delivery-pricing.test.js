const assert = require("assert");
const { distanceMeters, priceDelivery, validateDeliverySettings } = require("../src/helpers/deliveryPricing");
const { toCents, fromCents, buildDeliveryFinancials, calculateDeliveryDiscount } = require("../src/helpers/deliveryMoney");
const { buildDeliveryTokenCodec, signAddressResolution, validateAddressResolution } = require("../src/helpers/deliveryAddress");

const settings = {
  shopId: 7, revision: 1, enabled: true,
  origin: { latitude: 0, longitude: 0 }, maxDistanceMeters: 6000,
  minimumItemsCents: 1500, freeDeliveryEnabled: true, freeDeliveryThresholdCents: 2500,
  fiscalPolicy: { mode: "configured_rate", vatRate: 10 },
  bands: [{ upToMeters: 3000, feeCents: 200 }, { upToMeters: 6000, feeCents: 400 }],
};
assert.equal(distanceMeters(settings.origin, settings.origin), 0);
assert.ok(Math.abs(distanceMeters(settings.origin, { latitude: 0, longitude: 1 }) - 111195) < 2);
assert.deepEqual(priceDelivery({ settings, distanceMeters: 3000, itemsNetCents: 2000 }), { deliveryFeeCents: 200, grandTotalCents: 2200 });
assert.equal(priceDelivery({ settings, distanceMeters: 3001, itemsNetCents: 2499 }).deliveryFeeCents, 400);
assert.equal(priceDelivery({ settings, distanceMeters: 6000, itemsNetCents: 2500 }).deliveryFeeCents, 0);
assert.throws(() => priceDelivery({ settings, distanceMeters: 6001, itemsNetCents: 2500 }), { code: "DELIVERY_OUT_OF_RANGE" });
assert.throws(() => priceDelivery({ settings, distanceMeters: 0, itemsNetCents: 1499 }), { code: "DELIVERY_MINIMUM_NOT_MET" });
assert.throws(() => priceDelivery({ settings: { ...settings, enabled: false }, distanceMeters: 0, itemsNetCents: 2000 }), { code: "DELIVERY_DISABLED" });
for (const vatRate of [null, 0, undefined, NaN, 7]) {
  assert.throws(() => validateDeliverySettings({ ...settings, fiscalPolicy: { mode: "configured_rate", vatRate } }), { code: "DELIVERY_SETTINGS_INVALID" });
}
for (const bands of [[], [{ upToMeters: 3000, feeCents: 200 }], [...settings.bands].reverse(), [{ upToMeters: 3000, feeCents: -1 }, settings.bands[1]]]) {
  assert.throws(() => validateDeliverySettings({ ...settings, bands }), { code: "DELIVERY_SETTINGS_INVALID" });
}
for (const bad of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1, "100", null]) {
  assert.throws(() => fromCents(bad));
  assert.throws(() => priceDelivery({ settings, distanceMeters: bad, itemsNetCents: 2000 }));
  assert.throws(() => priceDelivery({ settings, distanceMeters: 0, itemsNetCents: bad }));
}
for (const bad of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER, "", null, "oops"]) assert.throws(() => toCents(bad));
assert.equal(toCents("25.00"), 2500);
assert.equal(toCents(1.005), 101);
assert.equal(fromCents(2499), 24.99);
const financials = buildDeliveryFinancials({ itemsTotalCents: 2500, itemsDiscountCents: 1, deliveryFeeCents: 400, vatRate: 10 });
assert.equal(financials.itemsNetCents, 2499);
assert.equal(financials.grandTotalCents, 2899);
assert.deepEqual(financials.chargeSnapshot, {
  feeCents: 400, totalExclTaxCents: 364, taxCents: 36, vatRate: 10,
  fiscalPolicy: { mode: "configured_rate", vatRate: 10 },
});
assert.throws(() => buildDeliveryFinancials({ itemsTotalCents: 1, itemsDiscountCents: 2, deliveryFeeCents: 0, vatRate: 10 }));
assert.throws(() => buildDeliveryFinancials({ itemsTotalCents: Number.MAX_SAFE_INTEGER, itemsDiscountCents: 0, deliveryFeeCents: 1, vatRate: 10 }));
for (const vatRate of [5.5, 10, 20]) {
  const result = buildDeliveryFinancials({ itemsTotalCents: 1500, itemsDiscountCents: 0, deliveryFeeCents: 200, vatRate });
  assert.equal(result.chargeSnapshot.totalExclTaxCents + result.chargeSnapshot.taxCents, 200);
}
const codec = buildDeliveryTokenCodec({ secret: "test-only-delivery-token-secret-32-bytes" });
const now = new Date("2026-10-17T12:00:00Z");
const addressSnapshot = { street: "12 rue de l'Eglise", postalCode: "75013", city: "Paris", country: "FR", complement: "interphone 42", latitude: 48.82, longitude: 2.36, providerId: "fixture" };
const token = signAddressResolution({ shopId: 7, addressSnapshot, now, tokenCodec: codec });
assert.deepEqual(validateAddressResolution(token, now, { tokenCodec: codec, shopId: 7 }), addressSnapshot);
assert.throws(() => validateAddressResolution(token, new Date(now.getTime() + 900000), { tokenCodec: codec, shopId: 7 }), { code: "DELIVERY_ADDRESS_INVALID" });
assert.throws(() => validateAddressResolution(token, now, { tokenCodec: codec, shopId: 8 }), { code: "DELIVERY_ADDRESS_INVALID" });
assert.throws(() => validateAddressResolution(`${token.slice(0, -4)}fake`, now, { tokenCodec: codec }), { code: "DELIVERY_ADDRESS_INVALID" });
assert.throws(() => codec.verify(codec.sign({ kind: "quote", expiresAt: now.toISOString() }) + ".extra"));
assert.throws(() => codec.sign({ payload: "x".repeat(20000) }), { code: "DELIVERY_REQUEST_INVALID" });
assert.equal(typeof calculateDeliveryDiscount, "function", "delivery discount must expose an integer cents helper");
for (const [itemsTotalCents, type, value, expectedDiscount, expectedNet] of [
  [105, "percent", 10, 11, 94],
  [1999, "percent", 12.5, 250, 1749],
  [5000, "percent", 0.01, 1, 4999],
  [105, "percent", 10.01, 11, 94],
  [Number.MAX_SAFE_INTEGER, "percent", 100, Number.MAX_SAFE_INTEGER, 0],
  [Number.MAX_SAFE_INTEGER, "percent", 50, 4503599627370496, 4503599627370495],
  [105, "amount", 0.105, 11, 94],
  [105, "amount", 100, 105, 0],
  [105, "none", 0, 0, 105],
]) {
  assert.deepEqual(calculateDeliveryDiscount({ itemsTotalCents, type, value }), { itemsDiscountCents: expectedDiscount, itemsNetCents: expectedNet });
}
for (const [type, value] of [["percent", 0.001], ["percent", 100.01], ["amount", -1], ["percent", NaN], ["percent", Infinity], ["percent", "10"], ["none", 1], ["other", 0]]) {
  assert.throws(() => calculateDeliveryDiscount({ itemsTotalCents: 105, type, value }), { code: "DELIVERY_REQUEST_INVALID" });
}
console.log("delivery pricing tests passed (distance, bands, money, fiscal snapshot, signed address expiry/scope)");
