const DomainError = require("./domainError");
const { assertCents } = require("./deliveryMoney");
const { isGoogleReference } = require("./deliveryAddressStorage");

const validCoordinates = (point) => !!point && typeof point.latitude === "number" && Number.isFinite(point.latitude)
  && Math.abs(point.latitude) <= 90 && typeof point.longitude === "number" && Number.isFinite(point.longitude) && Math.abs(point.longitude) <= 180;
const distanceMeters = (origin, destination) => {
  if (!validCoordinates(origin) || !validCoordinates(destination)) throw new DomainError(422, "DELIVERY_ADDRESS_INVALID", "Invalid coordinates");
  const radians = value => value * Math.PI / 180;
  const a = Math.sin(radians(destination.latitude - origin.latitude) / 2) ** 2
    + Math.cos(radians(origin.latitude)) * Math.cos(radians(destination.latitude)) * Math.sin(radians(destination.longitude - origin.longitude) / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(Math.min(1, a)), Math.sqrt(Math.max(0, 1 - a)));
};
const validateDeliverySettings = (settings) => {
  const invalid = () => { throw new DomainError(422, "DELIVERY_SETTINGS_INVALID", "Invalid delivery settings"); };
  if (!settings || typeof settings.enabled !== "boolean" || typeof settings.freeDeliveryEnabled !== "boolean") invalid();
  if (settings.origin !== null && !validCoordinates(settings.origin) && !isGoogleReference(settings.origin)) invalid();
  if (!Number.isInteger(settings.maxDistanceMeters) || settings.maxDistanceMeters < 0 || settings.maxDistanceMeters > 4294967295) invalid();
  try {
    assertCents(settings.minimumItemsCents);
    if (settings.freeDeliveryThresholdCents !== null) assertCents(settings.freeDeliveryThresholdCents);
  } catch (_) { invalid(); }
  if (settings.freeDeliveryEnabled && settings.freeDeliveryThresholdCents === null) invalid();
  if (!settings.fiscalPolicy || settings.fiscalPolicy.mode !== "configured_rate"
    || (settings.fiscalPolicy.vatRate !== null && ![5.5, 10, 20].includes(settings.fiscalPolicy.vatRate))) invalid();
  if (!Array.isArray(settings.bands) || settings.bands.length > 100) invalid();
  let previous = 0;
  for (const band of settings.bands) {
    if (!band || !Number.isInteger(band.upToMeters) || band.upToMeters <= previous || band.upToMeters > settings.maxDistanceMeters
      || Object.keys(band).some(key => !["upToMeters", "feeCents"].includes(key))) invalid();
    try { assertCents(band.feeCents); } catch (_) { invalid(); }
    previous = band.upToMeters;
  }
  if (settings.bands.length && previous !== settings.maxDistanceMeters) invalid();
  if (settings.enabled && ((!validCoordinates(settings.origin) && !isGoogleReference(settings.origin)) || !settings.maxDistanceMeters || !settings.bands.length || settings.fiscalPolicy.vatRate === null)) invalid();
  return settings;
};
const priceDelivery = ({ settings, distanceMeters: distance, itemsNetCents }) => {
  if (!settings || !settings.enabled) throw new DomainError(422, "DELIVERY_DISABLED", "Delivery is disabled");
  validateDeliverySettings(settings);
  if (typeof distance !== "number" || !Number.isFinite(distance) || distance < 0 || distance > Number.MAX_SAFE_INTEGER) throw new DomainError(422, "DELIVERY_ADDRESS_INVALID", "Invalid distance");
  assertCents(itemsNetCents);
  if (distance > settings.maxDistanceMeters) throw new DomainError(422, "DELIVERY_OUT_OF_RANGE", "Address outside delivery radius");
  if (itemsNetCents < settings.minimumItemsCents) throw new DomainError(422, "DELIVERY_MINIMUM_NOT_MET", "Delivery minimum not met");
  const band = settings.bands.find(value => distance <= value.upToMeters);
  const deliveryFeeCents = settings.freeDeliveryEnabled && itemsNetCents >= settings.freeDeliveryThresholdCents ? 0 : band.feeCents;
  return { deliveryFeeCents, grandTotalCents: assertCents(itemsNetCents + deliveryFeeCents) };
};
module.exports = { validCoordinates, distanceMeters, validateDeliverySettings, priceDelivery };
