const assert = require("assert");
const fs = require("fs");
const jwt = require("jsonwebtoken");
const path = require("path");

process.env.JWTKEY = process.env.JWTKEY || "test-secret";

const helperPath = path.join(
  __dirname,
  "../src/helpers/servicePointAccessToken.js",
);
assert.ok(fs.existsSync(helperPath), "service point access token helper must exist");

const {
  signServicePointAccessToken,
  verifyServicePointAccessToken,
  signServicePointSessionToken,
} = require(helperPath);

const accessToken = signServicePointAccessToken({
  servicePointId: 12,
  shopId: 8,
  source: "table_qr",
  version: 3,
});

assert.strictEqual(
  accessToken,
  signServicePointAccessToken({
    servicePointId: 12,
    shopId: 8,
    source: "table_qr",
    version: 3,
  }),
  "a table QR token must stay stable",
);
assert.ok(!accessToken.startsWith("eyJ"), "the printed QR token must stay compact");
assert.ok(accessToken.length <= 96, "the printed QR token must stay compact");
assert.deepStrictEqual(verifyServicePointAccessToken(accessToken), {
  servicePointId: 12,
  shopId: 8,
  source: "table_qr",
  version: 3,
});
assert.throws(
  () => verifyServicePointAccessToken(accessToken.replace(/.$/, "x")),
  /Invalid service point access token/,
);

const sessionToken = signServicePointSessionToken({
  servicePointId: 12,
  shopId: 8,
  source: "table_qr",
});
const session = jwt.verify(sessionToken, process.env.JWTKEY);
assert.strictEqual(session.subject_type, "service_point");
assert.strictEqual(session.service_point_id, 12);
assert.strictEqual(session.shopid, 8);
assert.strictEqual(session.source, "table_qr");
assert.strictEqual(session.access, 2);
assert.ok(session.exp - session.iat <= 4 * 60 * 60);

console.log("service point access token tests passed");
