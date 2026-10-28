const crypto = require("crypto");

const unavailable = () => Object.assign(new Error("PIN vault unavailable"), { code: "PIN_VAULT_UNAVAILABLE" });
const key = () => {
  const encoded = process.env.PIN_ENCRYPTION_KEY;
  if (typeof encoded !== "string" || encoded.length !== 44) throw unavailable();
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== encoded) throw unavailable();
  return decoded;
};
const aad = (context) => {
  const { kind, shopId, loginId } = context || {};
  if (!["staff", "kiosk"].includes(kind) || !/^[1-9]\d{0,9}$/.test(String(shopId)) ||
      Number(shopId) > 2147483647 || !/^[A-Z0-9]{6}$/.test(loginId || "")) throw unavailable();
  return Buffer.from(JSON.stringify(["pin-v1", kind, String(shopId), loginId]));
};
const decode = (value, length) => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw unavailable();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== length || bytes.toString("base64url") !== value) throw unavailable();
  return bytes;
};

const encryptPin = (pin, context) => {
  try {
    if (typeof pin !== "string" || !/^\d{4}$/.test(pin)) throw unavailable();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
    cipher.setAAD(aad(context));
    const ciphertext = Buffer.concat([cipher.update(pin, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
  } catch (_) { throw unavailable(); }
};

const decryptPin = (encrypted, context) => {
  try {
    if (typeof encrypted !== "string" || encrypted.length > 128) throw unavailable();
    const parts = encrypted.split(".");
    if (parts.length !== 4 || parts[0] !== "v1") throw unavailable();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key(), decode(parts[1], 12));
    decipher.setAAD(aad(context));
    decipher.setAuthTag(decode(parts[2], 16));
    const pin = Buffer.concat([decipher.update(decode(parts[3], 4)), decipher.final()]).toString("utf8");
    if (!/^\d{4}$/.test(pin)) throw unavailable();
    return pin;
  } catch (_) { throw unavailable(); }
};

module.exports = { encryptPin, decryptPin };
