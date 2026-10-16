const crypto = require("crypto");

const createTrackingToken = () => crypto.randomBytes(32).toString("base64url");
const hashTrackingToken = raw => crypto.createHash("sha256").update(raw).digest("hex");

module.exports = { createTrackingToken, hashTrackingToken };
