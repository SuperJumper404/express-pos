const crypto = require("crypto");
const DomainError = require("./domainError");
const { validCoordinates } = require("./deliveryPricing");

const addressInvalid = () => new DomainError(422, "DELIVERY_ADDRESS_INVALID", "Invalid or expired address resolution");
const normalizeAddress = (address = {}) => {
  if (!address || typeof address !== "object" || Array.isArray(address)) throw addressInvalid();
  const result = {};
  for (const key of ["street", "postalCode", "city", "country", "complement", "building", "floor", "intercom", "instructions"]) {
    const value = address[key];
    if (value !== undefined && (typeof value !== "string" || value.length > (key === "instructions" ? 1000 : 255) || /[\r\n\x00-\x1f]/.test(value))) throw addressInvalid();
    result[key] = (value || "").trim().normalize("NFC");
  }
  result.country = result.country.toUpperCase() || "FR";
  if (!result.street || !/^\d{5}$/.test(result.postalCode) || !result.city || result.country !== "FR") throw addressInvalid();
  return result;
};
const buildDeliveryTokenCodec = ({ secret } = {}) => {
  const key = () => {
    const value = secret === undefined ? require("./env").getDeliveryConfig().tokenSecret : secret;
    if (typeof value !== "string" || Buffer.byteLength(value) < 32) throw new DomainError(503, "DELIVERY_UNAVAILABLE", "Delivery signing is not configured");
    return value;
  };
  return {
    sign(payload) {
      const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
      if (data.length + 44 > 20000) throw new DomainError(400, "DELIVERY_REQUEST_INVALID", "Delivery token payload too large");
      return `${data}.${crypto.createHmac("sha256", key()).update(data).digest("base64url")}`;
    },
    verify(token) {
      if (typeof token !== "string" || token.length > 20000) throw addressInvalid();
      const parts = token.split(".");
      if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) throw addressInvalid();
      const expected = crypto.createHmac("sha256", key()).update(parts[0]).digest("base64url");
      if (expected.length !== parts[1].length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts[1]))) throw addressInvalid();
      try { return JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); } catch (_) { throw addressInvalid(); }
    },
  };
};
const validTokenTime = (payload, now, ttl) => {
  const start = Date.parse(payload.issuedAt);
  const expiry = Date.parse(payload.expiresAt);
  const time = new Date(now).getTime();
  return Number.isFinite(time) && Number.isFinite(start) && expiry - start === ttl && start <= time && time < expiry;
};
const signAddressResolution = ({ shopId, addressSnapshot, now = new Date(), tokenCodec = buildDeliveryTokenCodec() }) => {
  if (!validCoordinates(addressSnapshot)) throw addressInvalid();
  return tokenCodec.sign({ kind: "address", shopId, addressSnapshot, issuedAt: new Date(now).toISOString(), expiresAt: new Date(new Date(now).getTime() + 900000).toISOString() });
};
const validateAddressResolution = (token, now = new Date(), { tokenCodec = buildDeliveryTokenCodec(), shopId } = {}) => {
  const payload = tokenCodec.verify(token);
  if (!payload || payload.kind !== "address" || !validTokenTime(payload, now, 900000)
    || (shopId !== undefined && String(payload.shopId) !== String(shopId)) || !validCoordinates(payload.addressSnapshot)) throw addressInvalid();
  return payload.addressSnapshot;
};
const validatePlaceClaims = (payload, shopId) => {
  const { isGoogleReference } = require("./deliveryAddressStorage");
  const { validSessionToken } = require("../services/googleDeliveryPlaces");
  if (!payload || payload.kind !== "place_selection" || !isGoogleReference({ provider: "google_places", placeId: payload.placeId })
    || String(payload.shopId) !== String(shopId) || !validSessionToken(payload.sessionToken)
    || typeof payload.label !== "string" || !payload.label.trim() || payload.label.length > 1024 || /[\x00-\x1f\x7f]/.test(payload.label)) throw addressInvalid();
};
const signPlaceSelection = ({ shopId, placeId, label, sessionToken, now = new Date(), tokenCodec = buildDeliveryTokenCodec() }) => {
  const payload = { kind: "place_selection", shopId, placeId, label, sessionToken,
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(new Date(now).getTime() + 900000).toISOString() };
  validatePlaceClaims(payload, shopId);
  return tokenCodec.sign(payload);
};
const validatePlaceSelection = (token, now = new Date(), { tokenCodec = buildDeliveryTokenCodec(), shopId } = {}) => {
  const payload = tokenCodec.verify(token);
  validatePlaceClaims(payload, shopId);
  if (!validTokenTime(payload, now, 900000)) throw addressInvalid();
  return payload;
};
module.exports = { normalizeAddress, buildDeliveryTokenCodec, validTokenTime, signAddressResolution, validateAddressResolution, signPlaceSelection, validatePlaceSelection };
