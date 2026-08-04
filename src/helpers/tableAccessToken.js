const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { envJWTKEY } = require("./env");

const TABLE_ACCESS_PURPOSE = "table_access";
const TABLE_SESSION_EXPIRES_IN = "4h";
const QR_CLIENT_ACCESSES = [2, 3];
const TABLE_ACCESS_TOKEN_VERSION = "t1";

const requireSigningKey = () => {
  if (!envJWTKEY) {
    throw new Error("JWT signing key is required");
  }
  return envJWTKEY;
};

const numericId = (value, field) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} is required`);
  }
  return parsed;
};

const buildTableAccessPayload = (user) => {
  const access = Number(user?.access);
  if (!QR_CLIENT_ACCESSES.includes(access)) {
    throw new Error("table access token requires client access");
  }

  return {
    id: numericId(user.id, "id"),
    shopid: numericId(user.shopid, "shopid"),
    access,
    purpose: TABLE_ACCESS_PURPOSE,
  };
};

const signCompactPayload = (payload) =>
  crypto
    .createHmac("sha256", requireSigningKey())
    .update(payload)
    .digest("base64url")
    .slice(0, 22);

const signTableAccessToken = (user) => {
  const payload = buildTableAccessPayload(user);
  const tokenPayload = [
    TABLE_ACCESS_TOKEN_VERSION,
    payload.id,
    payload.shopid,
    payload.access,
  ].join(".");
  return `${tokenPayload}.${signCompactPayload(tokenPayload)}`;
};

const verifyTableAccessToken = (token) => {
  const parts = String(token || "").split(".");
  if (parts.length !== 5 || parts[0] !== TABLE_ACCESS_TOKEN_VERSION) {
    throw new Error("Invalid table access token");
  }
  const tokenPayload = parts.slice(0, 4).join(".");
  const expectedSignature = signCompactPayload(tokenPayload);
  if (parts[4] !== expectedSignature) {
    throw new Error("Invalid table access token");
  }

  const id = numericId(parts[1], "id");
  const shopid = numericId(parts[2], "shopid");
  const access = Number(parts[3]);
  if (!QR_CLIENT_ACCESSES.includes(access)) {
    throw new Error("Invalid table access token access");
  }

  return {
    id,
    shopid,
    access,
    purpose: TABLE_ACCESS_PURPOSE,
  };
};

const signTableSessionToken = (user) =>
  jwt.sign(
    {
      id: numericId(user.id, "id"),
      email: user.email,
      access: Number(user.access),
      shopid: numericId(user.shopid, "shopid"),
    },
    requireSigningKey(),
    { expiresIn: TABLE_SESSION_EXPIRES_IN },
  );

module.exports = {
  TABLE_ACCESS_PURPOSE,
  TABLE_SESSION_EXPIRES_IN,
  QR_CLIENT_ACCESSES,
  TABLE_ACCESS_TOKEN_VERSION,
  buildTableAccessPayload,
  signTableAccessToken,
  verifyTableAccessToken,
  signTableSessionToken,
};
