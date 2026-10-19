const https = require("https");
const { urlToHttpOptions } = require("url");
const DomainError = require("../helpers/domainError");
const { normalizeAddress } = require("../helpers/deliveryAddress");
const { validCoordinates } = require("../helpers/deliveryPricing");

const unavailable = () => new DomainError(503, "DELIVERY_GEOCODING_UNAVAILABLE", "Address provider unavailable; retry later");
const invalid = () => new DomainError(422, "DELIVERY_ADDRESS_INVALID", "Select a precise French postal address");
const validPlaceId = value => typeof value === "string" && value.length > 0 && value.length <= 1024
  && value.trim() === value && !/[\x00-\x20\x7f]/.test(value) && ![".", ".."].includes(value);
const validSessionToken = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const validText = (value, max = 255) => typeof value === "string" && !!value.trim() && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const assertScope = shopId => { if (!Number.isInteger(shopId) || shopId <= 0 || shopId > 2147483647) throw invalid(); };

const requestGoogleJson = (url, { method = "GET", headers, body, timeoutMs = 5000 }) => new Promise((resolve, reject) => {
  // One options object is required by Mailjet's installed HTTP proxy patch.
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  const request = https.request({ ...urlToHttpOptions(url), method,
    headers: { Accept: "application/json", ...headers, ...(encoded ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(encoded) } : {}) } }, response => {
    if (response.statusCode !== 200) { response.resume(); reject(unavailable()); return; }
    const chunks = []; let size = 0;
    response.on("data", chunk => {
      size += chunk.length;
      if (size > 1048576) { response.destroy(); request.destroy(unavailable()); return; }
      chunks.push(chunk);
    });
    response.on("aborted", () => reject(unavailable()));
    response.on("error", () => reject(unavailable()));
    response.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (_) { reject(unavailable()); } });
  });
  const timer = setTimeout(() => request.destroy(unavailable()), timeoutMs);
  request.on("error", () => reject(unavailable()));
  request.on("close", () => clearTimeout(timer));
  request.end(encoded);
});

const buildGoogleDeliveryPlaces = ({
  transport = requestGoogleJson,
  reserveQuota = input => require("./deliveryGeocoding").buildSqlGeocodingQuota()(input),
  apiKey, clock = () => new Date(), timers = { setTimeout, clearTimeout },
} = {}) => {
  const cache = new Map(); const inflight = new Map();
  let disposed = false;
  const remove = key => { const entry = cache.get(key); if (entry) timers.clearTimeout(entry.timer); cache.delete(key); };
  const purgeExpired = () => {
    let count = 0;
    for (const [key, entry] of cache) if (entry.until <= new Date(clock()).getTime()) { remove(key); count++; }
    return count;
  };
  const remember = (shopId, placeId, point) => {
    if (disposed) return;
    purgeExpired();
    const key = JSON.stringify([shopId, placeId]);
    remove(key);
    if (cache.size >= 1000) remove(cache.keys().next().value);
    const entry = { point: { ...point }, until: new Date(clock()).getTime() + 900000 };
    entry.timer = timers.setTimeout(() => { if (cache.get(key) === entry) remove(key); }, 900000);
    if (entry.timer && entry.timer.unref) entry.timer.unref();
    cache.set(key, entry);
  };
  const call = async (shopId, url, options) => {
    const key = apiKey === undefined ? require("../helpers/env").getDeliveryConfig().googlePlacesApiKey : apiKey;
    if (disposed || typeof key !== "string" || !key.trim() || /[\x00-\x20\x7f]/.test(key) || key.startsWith("encrypted:")) throw unavailable();
    await reserveQuota({ shopId });
    try {
      return await transport(url, { ...options, timeoutMs: 5000, headers: { ...options.headers, "X-Goog-Api-Key": key } });
    } catch (_) { throw unavailable(); }
  };
  const getDetails = async ({ shopId, placeId, sessionToken }, fields) => {
    assertScope(shopId);
    if (!validPlaceId(placeId) || (sessionToken !== undefined && !validSessionToken(sessionToken))) throw invalid();
    const url = new URL(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`);
    url.searchParams.set("languageCode", "fr");
    url.searchParams.set("regionCode", "fr");
    if (sessionToken !== undefined) url.searchParams.set("sessionToken", sessionToken);
    const data = await call(shopId, url, { method: "GET", headers: { "X-Goog-FieldMask": fields } });
    if (!data || data.id !== placeId || !validCoordinates(data.location)) throw unavailable();
    return data;
  };
  return {
    async suggest({ shopId, input, sessionToken }) {
      assertScope(shopId);
      if (!validText(input) || input.trim().length < 3 || !validSessionToken(sessionToken)) throw invalid();
      const data = await call(shopId, new URL("https://places.googleapis.com/v1/places:autocomplete"), {
        method: "POST", headers: { "X-Goog-FieldMask": "suggestions.placePrediction.placeId,suggestions.placePrediction.text.text" },
        body: { input: input.trim().normalize("NFC"), sessionToken, languageCode: "fr", regionCode: "fr", includedRegionCodes: ["fr"],
          includedPrimaryTypes: ["street_address", "premise", "subpremise"], includeQueryPredictions: false },
      });
      if (!data || typeof data !== "object" || Array.isArray(data) || (data.suggestions !== undefined && !Array.isArray(data.suggestions))) throw unavailable();
      return (data.suggestions || []).slice(0, 5).map(item => {
        const prediction = item && item.placePrediction;
        if (!prediction || !validPlaceId(prediction.placeId) || !prediction.text || !validText(prediction.text.text, 1024)) throw unavailable();
        return { placeId: prediction.placeId, label: prediction.text.text.trim() };
      });
    },
    async resolve(input) {
      const data = await getDetails(input, "id,addressComponents,formattedAddress,location");
      if (!Array.isArray(data.addressComponents)) throw unavailable();
      const parts = data.addressComponents;
      if (parts.some(part => !part || !Array.isArray(part.types) || !validText(part.longText))) throw unavailable();
      const get = (type, short = false) => {
        const values = parts.filter(part => part.types.includes(type)).map(part => short ? part.shortText : part.longText);
        if (values.some(value => !validText(value)) || new Set(values).size > 1) throw invalid();
        return values[0] || "";
      };
      const number = get("street_number"); const route = get("route");
      if (!number || !route || !/^\d/.test(number) || get("country", true) !== "FR") throw invalid();
      const address = normalizeAddress({ street: `${number} ${route}`, postalCode: get("postal_code"), city: get("locality") || get("postal_town"), country: "FR" });
      const point = { latitude: data.location.latitude, longitude: data.location.longitude };
      remember(input.shopId, input.placeId, point);
      return { ...address, provider: "google_places", placeId: input.placeId, precision: "housenumber", ...point };
    },
    async position(input) {
      assertScope(input.shopId);
      if (!validPlaceId(input.placeId)) throw invalid();
      purgeExpired();
      const key = JSON.stringify([input.shopId, input.placeId]);
      const cached = cache.get(key);
      if (cached) return { ...cached.point };
      if (!inflight.has(key)) {
        if (inflight.size >= 1000) throw unavailable();
        const pending = getDetails({ shopId: input.shopId, placeId: input.placeId }, "id,location").then(data => {
          const point = { latitude: data.location.latitude, longitude: data.location.longitude };
          remember(input.shopId, input.placeId, point); return point;
        });
        inflight.set(key, pending);
      }
      const pending = inflight.get(key);
      try { return { ...await pending }; } finally { if (inflight.get(key) === pending) inflight.delete(key); }
    },
    purgeExpired,
    dispose() { disposed = true; for (const key of cache.keys()) remove(key); inflight.clear(); },
  };
};
const googleDeliveryPlaces = buildGoogleDeliveryPlaces();
module.exports = { buildGoogleDeliveryPlaces, googleDeliveryPlaces, requestGoogleJson, validPlaceId, validSessionToken };
