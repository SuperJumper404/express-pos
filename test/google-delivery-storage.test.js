const assert = require("assert/strict");
const { test } = require("node:test");
const { toStoredAddress, sameDeliveryDestination, sanitizeGoogleDeliveryPayload } = require("../src/helpers/deliveryAddressStorage");
const google = { provider: "google_places", placeId: "fixture-place", street: "60 rue Test", postalCode: "75008", city: "Paris", country: "FR",
  latitude: 48.8, longitude: 2.3, instructions: "Portail B", sessionToken: "never-store", selectedLabel: "60 rue Test, Paris" };
test("Google book and origin retain only references, not postal text, coordinates or provider response", () => {
  assert.deepEqual(toStoredAddress(google, { purpose: "book" }), { provider: "google_places", placeId: "fixture-place", instructions: "Portail B" });
  assert.deepEqual(toStoredAddress(google, { purpose: "origin" }), { provider: "google_places", placeId: "fixture-place" });
  assert.equal(google.latitude, 48.8);
  assert.throws(() => toStoredAddress({ ...google, placeId: "" }, { purpose: "book" }), { code: "DELIVERY_ADDRESS_INVALID" });
});
test("transaction preserves selected postal text but never Google GPS; book hydration cannot invent selection provenance", () => {
  const selected = toStoredAddress(google, { purpose: "transaction" });
  assert.equal(selected.street, "60 rue Test");
  assert.equal(selected.latitude, undefined);
  assert.equal(selected.sessionToken, undefined);
  const { selectedLabel, ...hydrated } = google;
  assert.equal(toStoredAddress(hydrated, { purpose: "transaction" }).street, undefined);
});
test("nested journal results lose Google GPS and temporary proofs without mutating IGN evidence", () => {
  const ign = { provider: "IGN", latitude: 48.8, longitude: 2.3, street: "Legacy" };
  const input = { previous: { delivery: { addressSnapshot: google } }, next: { delivery: { addressSnapshot: google } },
    result: { delivery: { addressSnapshot: google }, quoteToken: "never-store", addressResolutionToken: "never-store" }, ign };
  const stored = sanitizeGoogleDeliveryPayload(input);
  assert.equal(/"(?:latitude|longitude)"/.test(JSON.stringify({ ...stored, ign: undefined })), false);
  assert.equal(JSON.stringify(stored).includes("never-store"), false);
  assert.deepEqual(stored.ign, ign);
  assert.equal(input.previous.delivery.addressSnapshot.latitude, 48.8);
});
test("Google private access fields follow stable place identity, not refreshed GPS", () => {
  const accepted = toStoredAddress(google, { purpose: "transaction" });
  assert.equal(sameDeliveryDestination(accepted, { ...google, latitude: 48.81 }), true);
  assert.equal(sameDeliveryDestination(accepted, { ...google, placeId: "other" }), false);
  const ign = { street: "Legacy", postalCode: "75001", city: "Paris", country: "FR", latitude: 48.8, longitude: 2.3 };
  assert.equal(sameDeliveryDestination(ign, { ...ign }), true);
  assert.equal(sameDeliveryDestination(ign, { ...ign, latitude: 48.81 }), false);
});
