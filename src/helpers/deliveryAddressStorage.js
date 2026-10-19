const DomainError = require("./domainError");
const privateFields = ["complement", "building", "floor", "intercom", "instructions"];
const postalFields = ["street", "postalCode", "city", "country"];
const isGoogleReference = value => !!value && value.provider === "google_places" && typeof value.placeId === "string"
  && value.placeId.length > 0 && value.placeId.length <= 1024 && !/[\x00-\x20\x7f]/.test(value.placeId) && ![".", ".."].includes(value.placeId);
const toStoredAddress = (snapshot, { purpose = "transaction" } = {}) => {
  if (!snapshot || snapshot.provider !== "google_places") return snapshot && { ...snapshot };
  if (!isGoogleReference(snapshot) || !["book", "origin", "transaction"].includes(purpose)) throw new DomainError(422, "DELIVERY_ADDRESS_INVALID", "Invalid address reference");
  const fields = purpose === "origin" ? [] : [...privateFields,
    ...(purpose === "transaction" && typeof snapshot.selectedLabel === "string" && snapshot.selectedLabel.trim() ? [...postalFields, "selectedLabel"] : [])];
  return { provider: "google_places", placeId: snapshot.placeId,
    ...Object.fromEntries(fields.filter(key => typeof snapshot[key] === "string").map(key => [key, snapshot[key]])) };
};
const sameDeliveryDestination = (accepted, resolved) => {
  if (!accepted || !resolved) return false;
  if (accepted.provider === "google_places" || resolved.provider === "google_places") {
    return isGoogleReference(accepted) && isGoogleReference(resolved) && accepted.placeId === resolved.placeId;
  }
  try {
    const { normalizeAddress } = require("./deliveryAddress");
    const { validCoordinates } = require("./deliveryPricing");
    const left = normalizeAddress(accepted); const right = normalizeAddress(resolved);
    return postalFields.every(key => typeof accepted[key] === "string" && accepted[key].trim() && left[key] === right[key])
      && validCoordinates(accepted) && validCoordinates(resolved) && accepted.latitude === resolved.latitude && accepted.longitude === resolved.longitude
      && ["providerId", "cityCode", "precision"].every(key => accepted[key] === undefined || accepted[key] === resolved[key]);
  } catch (_) { return false; }
};
const temporary = new Set(["addressResolutionToken", "deliveryQuoteToken", "quoteToken", "selectionToken", "sessionToken", "address_resolution_token", "delivery_quote_token"]);
const sanitizeGoogleDeliveryPayload = value => {
  if (Array.isArray(value)) return value.map(sanitizeGoogleDeliveryPayload);
  if (!value || typeof value !== "object") return value;
  if (value.provider === "google_places") return toStoredAddress(value, { purpose: "transaction" });
  return Object.fromEntries(Object.entries(value).filter(([key]) => !temporary.has(key)).map(([key, child]) => [key, sanitizeGoogleDeliveryPayload(child)]));
};
module.exports = { isGoogleReference, toStoredAddress, sameDeliveryDestination, sanitizeGoogleDeliveryPayload };
