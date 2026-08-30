const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { envJWTKEY } = require("./env");

const SERVICE_POINT_ACCESS_TOKEN_VERSION = "sp1";
const SERVICE_POINT_SESSION_EXPIRES_IN = "4h";
const PUBLIC_SOURCES = new Set(["table_qr", "web"]);

const requireSigningKey = () => {
  if (!envJWTKEY) throw new Error("JWT signing key is required");
  return envJWTKEY;
};

const numericId = (value, field) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} is required`);
  }
  return parsed;
};

const sourceValue = (value) => {
  if (!PUBLIC_SOURCES.has(value)) {
    throw new Error("Invalid service point source");
  }
  return value;
};

const versionValue = (value) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("service point version is required");
  }
  return parsed;
};

const signCompactPayload = (payload) =>
  crypto
    .createHmac("sha256", requireSigningKey())
    .update(payload)
    .digest("base64url")
    .slice(0, 22);

const signServicePointAccessToken = ({
  servicePointId,
  shopId,
  source,
  version,
}) => {
  const tokenPayload = [
    SERVICE_POINT_ACCESS_TOKEN_VERSION,
    numericId(servicePointId, "service point id"),
    numericId(shopId, "shop id"),
    sourceValue(source),
    versionValue(version),
  ].join(".");
  return `${tokenPayload}.${signCompactPayload(tokenPayload)}`;
};

const verifyServicePointAccessToken = (token) => {
  const parts = String(token || "").split(".");
  if (parts.length !== 6 || parts[0] !== SERVICE_POINT_ACCESS_TOKEN_VERSION) {
    throw new Error("Invalid service point access token");
  }

  const tokenPayload = parts.slice(0, 5).join(".");
  if (parts[5] !== signCompactPayload(tokenPayload)) {
    throw new Error("Invalid service point access token");
  }

  return {
    servicePointId: numericId(parts[1], "service point id"),
    shopId: numericId(parts[2], "shop id"),
    source: sourceValue(parts[3]),
    version: versionValue(parts[4]),
  };
};

const signServicePointSessionToken = ({ servicePointId, shopId, source }) =>
  jwt.sign(
    {
      subject_type: "service_point",
      service_point_id: numericId(servicePointId, "service point id"),
      shopid: numericId(shopId, "shop id"),
      source: sourceValue(source),
      access: 2,
    },
    requireSigningKey(),
    { expiresIn: SERVICE_POINT_SESSION_EXPIRES_IN },
  );

module.exports = {
  SERVICE_POINT_ACCESS_TOKEN_VERSION,
  SERVICE_POINT_SESSION_EXPIRES_IN,
  signServicePointAccessToken,
  verifyServicePointAccessToken,
  signServicePointSessionToken,
};
