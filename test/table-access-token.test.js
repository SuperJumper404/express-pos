const assert = require("assert");
const jwt = require("jsonwebtoken");

process.env.JWTKEY = process.env.JWTKEY || "test-secret";

const {
  buildTableAccessPayload,
  signTableAccessToken,
  verifyTableAccessToken,
  signTableSessionToken,
} = require("../src/helpers/tableAccessToken");

const tableUser = {
  id: 12,
  shopid: 8,
  email: "table-1-shop-8@tables.local",
  access: 2,
};
const clickAndCollectUser = {
  id: 13,
  shopid: 8,
  email: "click-and-collect@tables.local",
  access: 3,
};

assert.deepStrictEqual(buildTableAccessPayload(tableUser), {
  id: 12,
  shopid: 8,
  access: 2,
  purpose: "table_access",
});

const firstToken = signTableAccessToken(tableUser);
const secondToken = signTableAccessToken({ ...tableUser });
assert.strictEqual(firstToken, secondToken, "QR token must be stable");
assert.ok(!firstToken.includes(tableUser.email), "QR token must not expose email");
assert.ok(firstToken.length <= 96, "QR token must stay compact for printing");
assert.ok(!firstToken.startsWith("eyJ"), "QR token must not use verbose JWT format");

const decodedQr = verifyTableAccessToken(firstToken);
assert.strictEqual(decodedQr.id, tableUser.id);
assert.strictEqual(decodedQr.shopid, tableUser.shopid);
assert.strictEqual(decodedQr.access, 2);
assert.strictEqual(decodedQr.purpose, "table_access");
assert.throws(
  () => verifyTableAccessToken(firstToken.replace(/.$/, "x")),
  /Invalid table access token/,
);

assert.throws(
  () => signTableAccessToken({ ...tableUser, access: 1 }),
  /client access/,
);

const clickAndCollectToken = signTableAccessToken(clickAndCollectUser);
const decodedClickAndCollect = verifyTableAccessToken(clickAndCollectToken);
assert.strictEqual(decodedClickAndCollect.id, clickAndCollectUser.id);
assert.strictEqual(decodedClickAndCollect.access, 3);
assert.ok(
  !clickAndCollectToken.includes(clickAndCollectUser.email),
  "QR token must not expose click-and-collect email",
);

const sessionToken = signTableSessionToken(tableUser);
const decodedSession = jwt.verify(sessionToken, process.env.JWTKEY);
assert.strictEqual(decodedSession.id, tableUser.id);
assert.strictEqual(decodedSession.email, tableUser.email);
assert.strictEqual(decodedSession.access, 2);
assert.strictEqual(decodedSession.shopid, tableUser.shopid);
assert.ok(
  decodedSession.exp - decodedSession.iat <= 4 * 60 * 60,
  "table session must expire within 4 hours",
);

console.log("table access token tests passed");
