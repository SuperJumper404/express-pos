const crypto = require("crypto");
const http = require("http");
const https = require("https");
const DomainError = require("../helpers/domainError");
const { normalizeAddress } = require("../helpers/deliveryAddress");
const { validCoordinates } = require("../helpers/deliveryPricing");

const unavailable = () => new DomainError(503, "DELIVERY_GEOCODING_UNAVAILABLE", "Address provider unavailable; retry later");
const invalid = (candidates = []) => new DomainError(422, "DELIVERY_ADDRESS_INVALID", "Select an unambiguous postal address", { candidates });
const requestJson = (url, { timeoutMs = 5000 } = {}) => new Promise((resolve, reject) => {
  const transport = url.protocol === "https:" ? https : http;
  const request = transport.get(url, { headers: { Accept: "application/json" } }, response => {
    if (response.statusCode !== 200) {
      response.resume();
      request.destroy(unavailable());
      return;
    }
    let body = "";
    response.setEncoding("utf8");
    response.on("data", chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) request.destroy(unavailable());
    });
    response.on("error", () => reject(unavailable()));
    response.on("end", () => {
      try { resolve(JSON.parse(body)); } catch (_) { reject(unavailable()); }
    });
  });
  const timer = setTimeout(() => request.destroy(unavailable()), timeoutMs);
  request.on("error", () => reject(unavailable()));
  request.on("close", () => clearTimeout(timer));
});

const buildSqlGeocodingQuota = ({ pool = require("../config/dbPool") } = {}) => async ({ shopId }) => {
  const connection = await pool.getConnection();
  let locked = false;
  let transaction = false;
  let broken = false;
  try {
    // One lock and aggregate across all tenants/instances, never one allowance per shop/IP supplied by a client.
    const [[lock]] = await connection.query("SELECT GET_LOCK('smarteat_delivery_ign_quota', 1) AS acquired");
    if (Number(lock.acquired) !== 1) throw unavailable();
    locked = true;
    await connection.beginTransaction();
    transaction = true;
    const [[window]] = await connection.query("SELECT UTC_TIMESTAMP() AS now, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 SECOND) AS previous");
    // Include both whole-second buckets: conservative at boundaries, <=40 in any rolling second.
    const [[count]] = await connection.query(
      "SELECT COALESCE(SUM(attempts), 0) AS total FROM service_rate_limits WHERE scope = 'delivery_geocoding' AND window_start >= ?", [window.previous],
    );
    if (Number(count.total) >= 40) throw new DomainError(429, "DELIVERY_GEOCODING_RATE_LIMITED", "Address provider quota reached; retry later");
    const subject = crypto.createHash("sha256").update("ign-global").digest("hex");
    await connection.query(
      `INSERT INTO service_rate_limits (shopid, scope, subject_hash, window_start, expires_at, attempts)
       VALUES (?, 'delivery_geocoding', ?, ?, DATE_ADD(?, INTERVAL 2 SECOND), 1)
       ON DUPLICATE KEY UPDATE attempts = attempts + 1`, [shopId, subject, window.now, window.now],
    );
    await connection.query("DELETE FROM service_rate_limits WHERE scope = 'delivery_geocoding' AND expires_at < ?", [window.now]);
    await connection.commit();
    transaction = false;
  } catch (error) {
    if (transaction) {
      try { await connection.rollback(); }
      catch (_) { broken = true; throw unavailable(); }
    }
    if (error instanceof DomainError) throw error;
    broken = true;
    throw unavailable();
  } finally {
    let cleanupFailed = false;
    if (locked) {
      try {
        const [[result]] = await connection.query("SELECT RELEASE_LOCK('smarteat_delivery_ign_quota') AS released");
        cleanupFailed = !result || Number(result.released) !== 1;
      } catch (_) { cleanupFailed = true; }
    }
    if (broken || cleanupFailed) connection.destroy();
    else connection.release();
    if (cleanupFailed) throw unavailable();
  }
};

const buildDeliveryGeocoding = ({
  transport = requestJson, reserveQuota = buildSqlGeocodingQuota(), clock = () => new Date(),
  baseUrl, cache = new Map(),
} = {}) => {
  const inflight = new Map();
  const search = async ({ shopId, postal }) => {
    const key = crypto.createHash("sha256").update(JSON.stringify(postal)).digest("hex");
    const time = new Date(clock()).getTime();
    const cached = cache.get(key);
    if (cached && cached.expiresAt > time) return cached.features;
    if (inflight.has(key)) return inflight.get(key);
    const pending = (async () => {
      let url;
      try {
        url = new URL(`${(baseUrl || require("../helpers/env").getDeliveryConfig().geocodingBaseUrl).replace(/\/$/, "")}/search`);
        if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw unavailable();
      } catch (_) { throw unavailable(); }
      url.searchParams.set("q", `${postal.street} ${postal.postalCode} ${postal.city}`);
      url.searchParams.set("index", "address");
      url.searchParams.set("autocomplete", "0");
      url.searchParams.set("postcode", postal.postalCode);
      url.searchParams.set("limit", "10");
      await reserveQuota({ shopId });
      let data;
      try { data = await transport(url, { timeoutMs: 5000 }); } catch (_) { throw unavailable(); }
      if (!data || data.type !== "FeatureCollection" || !Array.isArray(data.features)) throw unavailable();
      if (data.features.some(feature => !feature || feature.type !== "Feature" || !feature.properties
        || !feature.geometry || feature.geometry.type !== "Point" || !Array.isArray(feature.geometry.coordinates)
        || feature.geometry.coordinates.length !== 2
        || !validCoordinates({ longitude: feature.geometry.coordinates[0], latitude: feature.geometry.coordinates[1] }))) throw unavailable();
      if (cache.size >= 1000) cache.delete(cache.keys().next().value);
      cache.set(key, { features: data.features, expiresAt: time + 900000 });
      return data.features;
    })();
    inflight.set(key, pending);
    try { return await pending; } finally { inflight.delete(key); }
  };
  return {
    async resolve({ shopId, address, candidateId }) {
      const normalized = normalizeAddress(address);
      const postal = { street: normalized.street, postalCode: normalized.postalCode, city: normalized.city, country: normalized.country };
      const features = await search({ shopId, postal });
      const candidates = features.filter(feature => {
        const p = feature && feature.properties;
        const geometry = feature && feature.geometry;
        return feature && feature.type === "Feature" && p && p._type === "address" && p.type === "housenumber"
          && typeof p.id === "string" && typeof p.street === "string" && typeof p.housenumber === "string" && typeof p.city === "string"
          && p.postcode === normalized.postalCode && Number.isFinite(p.score) && p.score >= 0.7
          && geometry && geometry.type === "Point" && Array.isArray(geometry.coordinates) && geometry.coordinates.length === 2
          && validCoordinates({ longitude: geometry.coordinates[0], latitude: geometry.coordinates[1] });
      }).map(feature => ({
        providerId: feature.properties.id, street: `${feature.properties.housenumber} ${feature.properties.street}`,
        postalCode: feature.properties.postcode, city: feature.properties.city, country: "FR",
        longitude: feature.geometry.coordinates[0], latitude: feature.geometry.coordinates[1],
      }));
      const selected = candidateId === undefined
        ? (candidates.length === 1 ? candidates[0] : null)
        : candidates.find(candidate => candidate.providerId === candidateId);
      if (!selected) throw invalid(candidates);
      return { ...normalized, ...selected };
    },
  };
};
module.exports = { buildDeliveryGeocoding, buildSqlGeocodingQuota, requestJson };
