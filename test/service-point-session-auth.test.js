const assert = require("assert");

process.env.JWTKEY = process.env.JWTKEY || "test-secret";

const { signServicePointSessionToken } = require("../src/helpers/servicePointAccessToken");
const { authentication, authAdmin } = require("../src/helpers/middleware/auth");

const response = () => ({
  statusCode: null,
  payload: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.payload = payload;
    return payload;
  },
});

const req = {
  headers: {
    authorization: `Bearer ${signServicePointSessionToken({
      servicePointId: 12,
      shopId: 8,
      source: "table_qr",
    })}`,
  },
};
const res = response();
let authenticated = false;
authentication(req, res, () => {
  authenticated = true;
});

assert.strictEqual(authenticated, true);
assert.strictEqual(req.sessionSubject, "service_point");
assert.strictEqual(req.servicePointId, 12);
assert.strictEqual(req.orderSource, "table_qr");
assert.strictEqual(req.shopid, 8);
assert.strictEqual(req.id, null);

let adminNext = false;
const adminResponse = response();
authAdmin(req, adminResponse, () => {
  adminNext = true;
});
assert.strictEqual(adminNext, false);
assert.strictEqual(adminResponse.statusCode, 403);

console.log("service point session auth tests passed");
