const jwt = require("jsonwebtoken");
const { envJWTKEY } = require("./env");

const TABLE_ACCESS_PURPOSE = "table_access";
const TABLE_SESSION_EXPIRES_IN = "4h";

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
  if (Number(user?.access) !== 2) {
    throw new Error("table access token requires access 2");
  }

  return {
    id: numericId(user.id, "id"),
    shopid: numericId(user.shopid, "shopid"),
    access: 2,
    purpose: TABLE_ACCESS_PURPOSE,
  };
};

const signTableAccessToken = (user, options = {}) =>
  jwt.sign(buildTableAccessPayload(user), requireSigningKey(), {
    noTimestamp: true,
    ...options,
  });

const verifyTableAccessToken = (token) => {
  const decoded = jwt.verify(token, requireSigningKey());
  if (decoded.purpose !== TABLE_ACCESS_PURPOSE) {
    throw new Error("Invalid table access token purpose");
  }
  if (Number(decoded.access) !== 2) {
    throw new Error("Invalid table access token access");
  }
  return decoded;
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
  buildTableAccessPayload,
  signTableAccessToken,
  verifyTableAccessToken,
  signTableSessionToken,
};
